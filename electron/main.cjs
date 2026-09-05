/* ===========================================================================
 * BIKLI — Electron main process (Phase 1)
 * ---------------------------------------------------------------------------
 * Responsibilities in this phase:
 *   1. Enforce a single running instance.
 *   2. Launch the existing Node backend (server.ts, bundled to dist/server.cjs)
 *      silently as a child process — no console window, no browser tab.
 *   3. Show a splash window while the backend boots, then load the real UI
 *      (http://localhost:3000) into the main application window.
 *   4. Clean up the backend (and its child Python agent) on quit.
 *
 * Tray, window-state persistence, close-to-tray and notifications arrive in
 * Phase 2; installer/auto-update/PyInstaller in later phases. The backend and
 * AI logic are reused verbatim — nothing here reimplements chat/memory/voice.
 * ========================================================================= */

'use strict';

const {
  app,
  BrowserWindow,
  Menu,
  shell,
  dialog,
  desktopCapturer,
  session,
  ipcMain,
} = require('electron');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');

// Help media capture + wake-word speech work reliably in packaged builds.
try {
  // WebRTC Audio Processing Module (AEC3 acoustic echo cancellation, noise suppression, AGC)
  app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer,WebRtcApmDownmixCaptureAudioMethod');
  app.commandLine.appendSwitch('enable-webrtc-apm-in-audio-service');
  // Allow AudioContext / speech after wake word without an extra click.
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  // Reduce Chromium media-device flakiness on Windows and disable Media Foundation on Windows N (missing mf.dll).
  app.commandLine.appendSwitch(
    'disable-features',
    'HardwareMediaKeyHandling,MediaFoundationVideoCapture,MediaFoundationVideoPlayback,MediaFoundationD3D11VideoCapture',
  );
  // Screen / desktop capture reliability (Share Screen / Screen Vision)
  app.commandLine.appendSwitch('enable-usermedia-screen-capturing');
  app.commandLine.appendSwitch('allow-http-screen-capture');
  // Suppress internal Chromium network upload stream and Media Foundation DLL warnings
  app.commandLine.appendSwitch('log-level', '3');
} catch {
  /* ignore */
}

// Provide Google API key to Chromium services so speech/network services authenticate properly
try {
  if (!process.env.GOOGLE_API_KEY) {
    const rootEnv = path.join(__dirname, '..', '.env');
    if (fs.existsSync(rootEnv)) {
      const content = fs.readFileSync(rootEnv, 'utf8');
      const m = content.match(/GEMINI_API_KEY\s*=\s*([^\r\n]+)/);
      if (m && m[1]) {
        process.env.GOOGLE_API_KEY = m[1].trim().replace(/^["']|["']$/g, '');
      }
    }
  }
} catch {
  /* ignore */
}

// --- Constants -------------------------------------------------------------
const SERVER_PORT = 3000;
const SERVER_ORIGIN = `http://localhost:${SERVER_PORT}`;
// The backend binds 127.0.0.1 (IPv4 loopback) only. "localhost" resolves to ::1
// first on many Windows boxes, so internal probes address the bound interface
// directly instead of depending on DNS ordering. The window keeps the localhost
// origin — changing it would key localStorage to a new origin and appear to
// wipe the user's saved settings.
const SERVER_PROBE_ORIGIN = `http://127.0.0.1:${SERVER_PORT}`;
const SERVER_READY_TIMEOUT_MS = 40_000;

// In development we run from the repo root; when packaged the app files live inside
// `resources/app/` when asar is disabled, or inside `app.asar` with the bundled
// backend unpacked to `app.asar.unpacked/` when asar is enabled (older builds).
// The SPAWNED backend needs the REAL filesystem path, so resolve whichever layout
// is actually present rather than assuming one.
const APP_ROOT = app.isPackaged
  ? (fs.existsSync(path.join(process.resourcesPath, 'app.asar.unpacked'))
      ? path.join(process.resourcesPath, 'app.asar.unpacked')
      : path.join(process.resourcesPath, 'app'))
  : path.join(__dirname, '..');
const SERVER_ENTRY = path.join(APP_ROOT, 'dist', 'server.cjs');

/** @type {import('child_process').ChildProcess | null} */
let serverProcess = null;
/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {BrowserWindow | null} */
let splashWindow = null;
let isQuitting = false;
// True once THIS instance has successfully spawned the backend. A second
// instance that loses the single-instance lock also quits and runs stopBackend;
// without this flag it would taskkill the running instance's desktop agent.
let didStartBackend = false;
/** Tail of the backend's stderr, surfaced in the failure dialog. */
const recentBackendErrors = [];

// ---------------------------------------------------------------------------
// Single-instance guard — second launches focus the existing window instead of
// starting a second backend on the same port.
// ---------------------------------------------------------------------------
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
  // Renderer asks to quit the whole app (voice "bye" command).
  ipcMain.on('bikli:quit', () => {
    isQuitting = true;
    app.quit();
  });

  app.whenReady().then(bootstrap);
}

// ---------------------------------------------------------------------------
// Backend lifecycle
// ---------------------------------------------------------------------------
function startBackend() {
  if (!fs.existsSync(SERVER_ENTRY)) {
    throw new Error(
      `Backend bundle not found at ${SERVER_ENTRY}. Run "npm run build" first.`,
    );
  }

  // Use the Node runtime bundled with Electron (ELECTRON_RUN_AS_NODE) so the
  // machine does not need a separate Node install once packaged.
  // Data (memories, settings, secrets, logs) must live in a writable per-user
  // folder — the install dir under Program Files is read-only.
  const dataDir = app.getPath('userData');

  // Frozen Python desktop agent (bundled as an extraResource when packaged).
  // In development this file won't exist, so the backend falls back to running
  // the agent from source with a local Python interpreter.
  const agentExe = app.isPackaged
    ? path.join(process.resourcesPath, 'agent', 'bikli-agent.exe')
    : path.join(APP_ROOT, 'agent_dist', 'bikli-agent', 'bikli-agent.exe');

  // NODE_PATH ensures the spawned process can resolve external dependencies
  // (express, ws, @google/genai) from the ASAR-bundled node_modules.
  const nodeModulesPath = path.join(APP_ROOT, 'node_modules');
  const existingNodePath = process.env.NODE_PATH || '';
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    ELECTRON_RUN_AS_NODE: '1',
    BIKLI_LAUNCHED_BY: 'electron',
    BIKLI_DATA_DIR: dataDir,
    BIKLI_APP_ROOT: APP_ROOT,
    NODE_PATH: existingNodePath
      ? `${nodeModulesPath}${path.delimiter}${existingNodePath}`
      : nodeModulesPath,
  };
  if (fs.existsSync(agentExe)) {
    env.BIKLI_AGENT_EXE = agentExe;
  }

  // Ensure the per-user logs dir exists BEFORE opening the boot log stream.
  // On a clean profile it does not exist, and an unhandled ENOENT on the first
  // write would crash the app before the backend even boots.
  try {
    fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
  } catch {
    /* best-effort */
  }

  // Log backend output to file for debugging startup failures.
  const logStream = fs.createWriteStream(path.join(dataDir, 'logs', 'backend-boot.log'), { flags: 'a' });
  logStream.on('error', (err) => {
    console.error('[backend-boot.log] write failed:', err);
  });
  logStream.write(`\n[${new Date().toISOString()}] Starting backend: ${SERVER_ENTRY}\n`);

  serverProcess = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: APP_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  // A spawn failure (EACCES / EMFILE / blocked ELECTRON_RUN_AS_NODE) emits an
  // 'error' event, not 'exit' — handle it or it becomes an uncaught exception.
  serverProcess.on('error', (err) => {
    logStream.write(`[${new Date().toISOString()}] Backend spawn error: ${err.message}\n`);
    if (!isQuitting) {
      dialog.showErrorBox(
        'BIKLI failed to start',
        `Could not start the backend process: ${err.message}\n\nSee ${path.join(dataDir, 'logs', 'backend-boot.log')} for details.`,
      );
      app.quit();
    }
  });

  serverProcess.stdout?.on('data', (d) => {
    const s = d.toString();
    process.stdout.write(`[server] ${s}`);
    logStream.write(`[stdout] ${s}`);
  });
  serverProcess.stderr?.on('data', (d) => {
    const s = d.toString();
    process.stderr.write(`[server] ${s}`);
    logStream.write(`[stderr] ${s}`);
    const lines = s
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.includes('chunked_data_pipe_upload_data_stream.cc') && !line.includes('mf_initializer.cc'));
    recentBackendErrors.push(...lines);
    if (recentBackendErrors.length > 8) {
      recentBackendErrors.splice(0, recentBackendErrors.length - 8);
    }
  });
  serverProcess.on('exit', (code, signal) => {
    logStream.end(`[${new Date().toISOString()}] Backend exited code=${code} signal=${signal}\n`);
    if (!isQuitting) {
      const reason = recentBackendErrors.length
        ? `\n\nLast messages from the backend:\n${recentBackendErrors.join('\n')}`
        : '';
      dialog.showErrorBox(
        'BIKLI backend stopped',
        `The BIKLI backend process exited unexpectedly (code ${code}, signal ${signal}).${reason}` +
          `\n\nFull log: ${path.join(dataDir, 'logs', 'backend-boot.log')}`,
      );
      app.quit();
    }
  });

  didStartBackend = true;
}

function killImage(imageName) {
  if (process.platform !== 'win32') return;
  try {
    spawnSync('taskkill', ['/F', '/IM', imageName, '/T'], {
      stdio: 'ignore',
      windowsHide: true,
      timeout: 3000,
    });
  } catch {
    /* best-effort */
  }
}

function killOrphanedPortProcess(port) {
  if (process.platform !== 'win32') return;
  try {
    const res = spawnSync('netstat', ['-ano', '-p', 'tcp'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3000,
    });
    if (!res.stdout) return;
    const lines = res.stdout.split('\n');
    for (const line of lines) {
      if (line.includes(`:${port}`) && line.includes('LISTENING')) {
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (pid && /^\d+$/.test(pid) && pid !== '0' && Number(pid) !== process.pid) {
          console.warn(`[BIKLI] Cleaning up orphaned process holding port ${port} (PID ${pid})`);
          spawnSync('taskkill', ['/pid', pid, '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
            timeout: 3000,
          });
        }
      }
    }
  } catch {
    /* best-effort */
  }
}

function stopBackend() {
  if (serverProcess && !serverProcess.killed) {
    try {
      if (process.platform === 'win32') {
        // Synchronously kill the whole process tree so port 3000 is cleanly freed immediately.
        spawnSync('taskkill', ['/pid', String(serverProcess.pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
          timeout: 3000,
        });
      } else {
        // POSIX: the backend is spawned WITHOUT detached:true, so it shares
        // Electron's process group — process.kill(-pid) would signal that whole
        // group and take the app down with it. Signal the child directly.
        serverProcess.kill('SIGTERM');
      }
    } catch {
      /* best-effort */
    }
  }
  serverProcess = null;
  // Only kill bikli-agent.exe when THIS instance actually started the backend.
  // A second launch that lost the single-instance lock also quits and would
  // otherwise force-kill the running instance's desktop agent (image-name match).
  if (didStartBackend) {
    killImage('bikli-agent.exe');
    didStartBackend = false;
  }
}

/**
 * Detect a BIKLI backend that is already serving this port — a developer's
 * `npm start`, or a previous launch whose backend outlived its window. Without
 * this the shell spawns a second backend, that one dies with EADDRINUSE, and
 * the user gets a "backend stopped" dialog even though a working backend is
 * right there. Checks the /api/config shape so an unrelated dev server on 3000
 * is not mistaken for BIKLI.
 */
function probeExistingBackend() {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    const req = http.get(`${SERVER_PROBE_ORIGIN}/api/config`, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        done(false);
        return;
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
        if (body.length > 8192) {
          req.destroy();
          done(false);
        }
      });
      res.on('end', () => {
        try {
          done(typeof JSON.parse(body).hasApiKey === 'boolean');
        } catch {
          done(false);
        }
      });
    });
    req.on('error', () => done(false));
    req.setTimeout(2000, () => {
      req.destroy();
      done(false);
    });
  });
}

/** Poll the backend until it answers, or reject on timeout. */
function waitForBackend(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get(SERVER_PROBE_ORIGIN, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() > deadline) {
          reject(new Error('Backend did not become ready in time.'));
        } else {
          setTimeout(tryOnce, 400);
        }
      });
      req.setTimeout(2000, () => req.destroy());
    };
    tryOnce();
  });
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------
const appIconPath = fs.existsSync(path.join(__dirname, 'icon.png'))
  ? path.join(__dirname, 'icon.png')
  : path.join(__dirname, '../build/icon.ico');

function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 420,
    height: 330,
    frame: false,
    transparent: true,
    resizable: false,
    center: true,
    show: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#00000000',
    icon: appIconPath,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  splashWindow.loadFile(path.join(__dirname, 'splash.html'));
  splashWindow.on('closed', () => (splashWindow = null));
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 600,
    show: false, // revealed on ready-to-show to avoid a white flash
    backgroundColor: '#0a0a0f',
    autoHideMenuBar: true,
    title: 'BIKLI',
    icon: appIconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true,
      // Keep SpeechRecognition + timers alive when window is unfocused
      // (otherwise wake word dies in the background).
      backgroundThrottling: false,
    },
  });

  Menu.setApplicationMenu(null);

  try {
    mainWindow.webContents.setBackgroundThrottling(false);
  } catch {
    /* older Electron */
  }

  // Open external links (http/https to non-local hosts) in the real browser
  // instead of navigating the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http') && !url.startsWith(SERVER_ORIGIN)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  // Block in-window navigation away from the app origin. Without this, a
  // server redirect or in-page link that navigates the window to an external
  // site would load that page WITH the preload bridge (getScreenSources,
  // quit) and auto-granted capture permissions still attached.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('http') && !url.startsWith(SERVER_ORIGIN)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.once('ready-to-show', () => {
    if (splashWindow) splashWindow.close();
    mainWindow?.show();
    mainWindow?.focus();
  });

  // When user focuses the app again, nudge renderer to re-arm wake word.
  mainWindow.on('focus', () => {
    try {
      mainWindow?.webContents.send('bikli:window-focus');
    } catch {
      /* ignore */
    }
  });

  mainWindow.on('closed', () => (mainWindow = null));

  mainWindow.loadURL(SERVER_ORIGIN);
}

// ---------------------------------------------------------------------------
// Screen share + media permissions
// ---------------------------------------------------------------------------
const MEDIA_PERMISSIONS = new Set([
  'media',
  'mediaKeySystem',
  'display-capture',
  'fullscreen',
  'notifications',
  'clipboard-read',
  'clipboard-sanitized-write',
  // Web Speech API (wake word) + capture
  'speechRecognition',
  'audioCapture',
  'videoCapture',
  // Some Electron/Chromium builds use these strings
  'desktopCapture',
  'desktop-capture',
]);

/**
 * List screens/windows for the renderer (packaged Share Screen path).
 * Serializes only plain fields — DesktopCapturerSource objects can't cross IPC.
 */
async function listScreenSources() {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: false,
  });
  return sources.map((s) => ({
    id: String(s.id),
    name: String(s.name || 'Screen'),
    display_id: s.display_id != null ? String(s.display_id) : '',
    // Prefer screens over windows when auto-picking
    isScreen: String(s.id).startsWith('screen:'),
  }));
}

/**
 * Electron blocks navigator.mediaDevices.getDisplayMedia unless a
 * setDisplayMediaRequestHandler is registered. Without this, Share Screen
 * fails with NotAllowedError / NotSupportedError in the packaged app.
 *
 * Also exposes bikli:get-screen-sources so the renderer can use the more
 * reliable chromeMediaSource desktop capture path when getDisplayMedia fails.
 */
function setupMediaPermissions() {
  const ses = session.defaultSession;

  // Only grant media/capture/speech permissions to BIKLI's own window (the app
  // origin or the local splash). Without this, any page loaded into the window
  // would inherit auto-approved capture.
  const isTrustedWebContents = (wc) => {
    if (!wc) return false;
    try {
      const url = String(wc.getURL() || '');
      return (
        url.startsWith(SERVER_ORIGIN) ||
        url.startsWith('http://127.0.0.1:3000') ||
        url.startsWith('file://')
      );
    } catch {
      return false;
    }
  };

  // Auto-allow mic / camera / display-capture / speech-recognition for the app origin.
  ses.setPermissionRequestHandler((wc, permission, callback) => {
    const ok =
      isTrustedWebContents(wc) &&
      (MEDIA_PERMISSIONS.has(permission) ||
        /media|capture|display|audio|video|speech/i.test(String(permission || '')));
    console.log(`[permissions] request: ${permission} → ${ok}`);
    callback(ok);
  });

  // Permission *checks* often run before requests; denying them blocks capture
  // even when the request handler would allow it.
  ses.setPermissionCheckHandler((wc, permission) => {
    return (
      isTrustedWebContents(wc) &&
      (MEDIA_PERMISSIONS.has(permission) ||
        /media|capture|display|audio|video|speech/i.test(String(permission || '')))
    );
  });

  // Bridge getDisplayMedia → desktopCapturer (required on Windows/Linux Electron).
  // Must not block mic (getUserMedia) — display capture and mic are independent.
  ses.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen', 'window'],
        thumbnailSize: { width: 320, height: 180 },
        fetchWindowIcons: false,
      });

      if (!sources.length) {
        console.error('[screen-share] No desktop sources available');
        callback({});
        return;
      }

      // Prefer a full screen source; fall back to the first window.
      const preferred =
        sources.find((s) => String(s.id).startsWith('screen:')) || sources[0];

      console.log(`[screen-share] Granting capture of: ${preferred.name} (${preferred.id})`);
      // Pass plain {id,name} — matches Electron Streams.Video shape and is more
      // reliable than passing the full DesktopCapturerSource in some builds.
      // video only — keep system audio free so the live mic can open after share
      callback({
        video: { id: preferred.id, name: preferred.name },
      });
    } catch (err) {
      console.error('[screen-share] setDisplayMediaRequestHandler failed:', err);
      callback({});
    }
  });

  // Renderer IPC: list sources for chromeMediaSource capture (packaged EXE).
  ipcMain.removeHandler('bikli:get-screen-sources');
  ipcMain.handle('bikli:get-screen-sources', async () => {
    try {
      return await listScreenSources();
    } catch (err) {
      console.error('[screen-share] get-screen-sources failed:', err);
      return [];
    }
  });
}

// ---------------------------------------------------------------------------
// Bootstrap sequence
// ---------------------------------------------------------------------------
async function bootstrap() {
  app.setAppUserModelId('com.bikli.desktop');
  setupMediaPermissions();
  createSplashWindow();

  // A healthy BIKLI backend may already own the port (developer `npm start`, or
  // a previous run whose backend outlived its window). Attach to it rather than
  // spawning a duplicate that would immediately die with EADDRINUSE.
  // didStartBackend stays false, so quitting will not kill a backend we
  // did not start.
  if (await probeExistingBackend()) {
    console.log('[BIKLI] Backend already running on port 3000 — reusing it.');
    createMainWindow();
    return;
  }

  // Verify server bundle exists before trying to start it.
  if (!fs.existsSync(SERVER_ENTRY)) {
    if (splashWindow) splashWindow.close();
    const searchPath = app.isPackaged
      ? `${SERVER_ENTRY} (inside ${APP_ROOT})`
      : SERVER_ENTRY;
    dialog.showErrorBox(
      'BIKLI failed to start',
      `Backend bundle not found at:\n${searchPath}\n\nTry rebuilding:\n  npm run build`,
    );
    app.quit();
    return;
  }

  try {
    killOrphanedPortProcess(SERVER_PORT);
    startBackend();
    await waitForBackend(SERVER_READY_TIMEOUT_MS);
    createMainWindow();
  } catch (err) {
    if (splashWindow) splashWindow.close();
    const dataDir = app.getPath('userData');
    dialog.showErrorBox(
      'BIKLI failed to start',
      `${err instanceof Error ? err.message : String(err)}\n\nCheck logs at:\n${path.join(dataDir, 'logs', 'backend-boot.log')}\n${path.join(dataDir, 'logs', 'startup.log')}`,
    );
    app.quit();
  }
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});

app.on('window-all-closed', () => {
  // Phase 2 introduces close-to-tray; for now quitting when all windows close
  // is the expected behaviour on Windows.
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  isQuitting = true;
  stopBackend();
});

process.on('exit', stopBackend);
