"""
Application control: launch and close Windows applications.

Launch strategy (in order) so ANY installed app can open, not only a hard-coded list:
  1. Known shortcuts (notepad, chrome, …) — instant
  2. Exact PATH / App Paths executable
  3. Start Menu .lnk shortcuts (user + common)
  4. PowerShell Get-StartApps (UWP / Store apps)
  5. Windows Search (Win+S → type name → Enter) — human-style, best for
     "LM Viewer", Store apps, etc. Soft-ok even if nothing launches.
  6. Shell `start` fallback with the raw name

Closing uses taskkill on the best-known process image name.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from .registry import ToolError, register

# Debounce identical app opens so Gemini double-fires do not spawn many windows.
_LAST_OPEN_APP_KEY: str = ""
_LAST_OPEN_APP_AT: float = 0.0
_OPEN_APP_DEBOUNCE_SEC = 10.0

# Canonical app key -> launch spec
#   exe   : executable name or full path
#   shell : cmd shell verb
#   uwp   : protocol / shell:AppsFolder id
#   image : process image for taskkill
#   label : friendly name
APP_COMMANDS: Dict[str, Dict[str, str]] = {
    "notepad": {"exe": "notepad.exe", "image": "notepad.exe", "label": "Notepad"},
    "chrome": {"exe": "chrome.exe", "image": "chrome.exe", "label": "Google Chrome"},
    "google chrome": {"exe": "chrome.exe", "image": "chrome.exe", "label": "Google Chrome"},
    "edge": {"exe": "msedge.exe", "image": "msedge.exe", "label": "Microsoft Edge"},
    "microsoft edge": {"exe": "msedge.exe", "image": "msedge.exe", "label": "Microsoft Edge"},
    "firefox": {"exe": "firefox.exe", "image": "firefox.exe", "label": "Firefox"},
    "brave": {"exe": "brave.exe", "image": "brave.exe", "label": "Brave"},
    "opera": {"exe": "opera.exe", "image": "opera.exe", "label": "Opera"},
    "vscode": {"exe": "code.cmd", "image": "Code.exe", "label": "Visual Studio Code"},
    "code": {"exe": "code.cmd", "image": "Code.exe", "label": "Visual Studio Code"},
    "visual studio code": {"exe": "code.cmd", "image": "Code.exe", "label": "Visual Studio Code"},
    "vs code": {"exe": "code.cmd", "image": "Code.exe", "label": "Visual Studio Code"},
    "calculator": {"shell": "calc", "image": "CalculatorApp.exe", "label": "Calculator"},
    "calc": {"shell": "calc", "image": "CalculatorApp.exe", "label": "Calculator"},
    "file explorer": {"shell": "explorer", "image": "explorer.exe", "label": "File Explorer"},
    "explorer": {"shell": "explorer", "image": "explorer.exe", "label": "File Explorer"},
    "windows explorer": {"shell": "explorer", "image": "explorer.exe", "label": "File Explorer"},
    "task manager": {"shell": "taskmgr", "image": "Taskmgr.exe", "label": "Task Manager"},
    "taskmanager": {"shell": "taskmgr", "image": "Taskmgr.exe", "label": "Task Manager"},
    "settings": {"uwp": "ms-settings:", "image": "SystemSettings.exe", "label": "Settings"},
    "windows settings": {"uwp": "ms-settings:", "image": "SystemSettings.exe", "label": "Settings"},
    "command prompt": {"exe": "cmd.exe", "image": "cmd.exe", "label": "Command Prompt"},
    "cmd": {"exe": "cmd.exe", "image": "cmd.exe", "label": "Command Prompt"},
    "powershell": {"exe": "powershell.exe", "image": "powershell.exe", "label": "PowerShell"},
    "terminal": {"exe": "wt.exe", "image": "WindowsTerminal.exe", "label": "Windows Terminal"},
    "windows terminal": {"exe": "wt.exe", "image": "WindowsTerminal.exe", "label": "Windows Terminal"},
    "wordpad": {"shell": "write", "image": "wordpad.exe", "label": "WordPad"},
    "paint": {"shell": "mspaint", "image": "mspaint.exe", "label": "Paint"},
    "snipping tool": {"uwp": "ms-screenclip:", "image": "ScreenClippingHost.exe", "label": "Snipping Tool"},
    "snip": {"uwp": "ms-screenclip:", "image": "ScreenClippingHost.exe", "label": "Snipping Tool"},
    "discord": {"exe": "Discord.exe", "image": "Discord.exe", "label": "Discord"},
    "spotify": {"exe": "Spotify.exe", "image": "Spotify.exe", "label": "Spotify"},
    # YouTube — Microsoft Store UWP app. Launched via AppsFolder AUMID so the
    # "open in the YouTube app" intent (vs the website) actually opens the
    # installed YouTube app, not chrome/youtube.com.
    "youtube": {
        "uwp": "shell:AppsFolder\\Microsoft.YouTube_8wekyb3d8bbwe!App",
        "image": "Youtube.exe",
        "label": "YouTube",
    },
    "youtube app": {
        "uwp": "shell:AppsFolder\\Microsoft.YouTube_8wekyb3d8bbwe!App",
        "image": "Youtube.exe",
        "label": "YouTube",
    },
    "steam": {"exe": "steam.exe", "image": "steam.exe", "label": "Steam"},
    "slack": {"exe": "slack.exe", "image": "slack.exe", "label": "Slack"},
    "telegram": {"exe": "Telegram.exe", "image": "Telegram.exe", "label": "Telegram"},
    "whatsapp": {"uwp": "whatsapp:", "image": "WhatsApp.exe", "label": "WhatsApp"},
    "zoom": {"exe": "Zoom.exe", "image": "Zoom.exe", "label": "Zoom"},
    "teams": {"exe": "ms-teams.exe", "image": "ms-teams.exe", "label": "Microsoft Teams"},
    "microsoft teams": {"exe": "ms-teams.exe", "image": "ms-teams.exe", "label": "Microsoft Teams"},
    "word": {"shell": "winword", "image": "WINWORD.EXE", "label": "Microsoft Word"},
    "excel": {"shell": "excel", "image": "EXCEL.EXE", "label": "Microsoft Excel"},
    "powerpoint": {"shell": "powerpnt", "image": "POWERPNT.EXE", "label": "Microsoft PowerPoint"},
    "outlook": {"shell": "outlook", "image": "OUTLOOK.EXE", "label": "Microsoft Outlook"},
    "photoshop": {"exe": "Photoshop.exe", "image": "Photoshop.exe", "label": "Adobe Photoshop"},
    "premiere pro": {"exe": "Adobe Premiere Pro.exe", "image": "Adobe Premiere Pro.exe", "label": "Adobe Premiere Pro"},
    "adobe premiere pro": {"exe": "Adobe Premiere Pro.exe", "image": "Adobe Premiere Pro.exe", "label": "Adobe Premiere Pro"},
    "vlc": {"exe": "vlc.exe", "image": "vlc.exe", "label": "VLC Media Player"},
    "control panel": {"shell": "control", "image": "control.exe", "label": "Control Panel"},
    "device manager": {"shell": "devmgmt.msc", "image": "mmc.exe", "label": "Device Manager"},
    "services": {"shell": "services.msc", "image": "mmc.exe", "label": "Services"},
    "registry editor": {"exe": "regedit.exe", "image": "regedit.exe", "label": "Registry Editor"},
    "regedit": {"exe": "regedit.exe", "image": "regedit.exe", "label": "Registry Editor"},
    "resource monitor": {"exe": "resmon.exe", "image": "resmon.exe", "label": "Resource Monitor"},
    "system information": {"exe": "msinfo32.exe", "image": "msinfo32.exe", "label": "System Information"},
    "character map": {"exe": "charmap.exe", "image": "charmap.exe", "label": "Character Map"},
    "magnifier": {"exe": "magnify.exe", "image": "Magnify.exe", "label": "Magnifier"},
    "narrator": {"exe": "narrator.exe", "image": "Narrator.exe", "label": "Narrator"},
    "camera": {"uwp": "microsoft.windows.camera:", "image": "WindowsCamera.exe", "label": "Camera"},
    "photos": {"uwp": "ms-photos:", "image": "Photos.exe", "label": "Photos"},
    "store": {"uwp": "ms-windows-store:", "image": "WinStore.App.exe", "label": "Microsoft Store"},
    "microsoft store": {"uwp": "ms-windows-store:", "image": "WinStore.App.exe", "label": "Microsoft Store"},
    "clock": {"uwp": "ms-clock:", "image": "Time.exe", "label": "Clock"},
    "alarm": {"uwp": "ms-clock:", "image": "Time.exe", "label": "Clock"},
    "calendar": {"uwp": "outlookcal:", "image": "HxCalendarAppImm.exe", "label": "Calendar"},
    "mail": {"uwp": "outlookmail:", "image": "HxOutlook.exe", "label": "Mail"},
    "maps": {"uwp": "bingmaps:", "image": "Maps.exe", "label": "Maps"},
    "notepad++": {"exe": "notepad++.exe", "image": "notepad++.exe", "label": "Notepad++"},
    "obs": {"exe": "obs64.exe", "image": "obs64.exe", "label": "OBS Studio"},
    "obs studio": {"exe": "obs64.exe", "image": "obs64.exe", "label": "OBS Studio"},
}


def _norm(name: str) -> str:
    return re.sub(r"\s+", " ", (name or "").strip().lower())


def _creation_flags_gui() -> int:
    """Flags for launching visible GUI apps (do NOT hide the window)."""
    return int(
        getattr(subprocess, "DETACHED_PROCESS", 0)
        | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    )


def _popen_detached(args: List[str] | str, *, shell: bool = False) -> None:
    kwargs: Dict[str, Any] = {
        "shell": shell,
        "close_fds": True,
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
    }
    if os.name == "nt":
        kwargs["creationflags"] = _creation_flags_gui()
    if shell and isinstance(args, str):
        subprocess.Popen(args, **kwargs)
    else:
        subprocess.Popen(args if isinstance(args, list) else [args], **kwargs)


def _launch_spec(spec: Dict[str, str]) -> None:
    try:
        if "exe" in spec:
            exe = spec["exe"]
            resolved = shutil.which(exe) or (exe if os.path.isfile(exe) else None)
            if resolved:
                _popen_detached([resolved], shell=False)
            else:
                # PATH / App Paths resolution via shell start
                _popen_detached(f'start "" "{exe}"', shell=True)
        elif "shell" in spec:
            _popen_detached(f'start "" {spec["shell"]}', shell=True)
        elif "uwp" in spec:
            _popen_detached(f'start "" {spec["uwp"]}', shell=True)
        elif "lnk" in spec:
            _popen_detached(f'start "" "{spec["lnk"]}"', shell=True)
        else:
            raise ToolError(f"App spec for {spec.get('label')} is incomplete.")
    except ToolError:
        raise
    except Exception as e:  # noqa: BLE001
        raise ToolError(f"Could not launch {spec.get('label')}: {e}") from e


def _known_spec(name: str) -> Optional[Dict[str, str]]:
    norm = _norm(name)
    if norm in APP_COMMANDS:
        return dict(APP_COMMANDS[norm])
    # Partial key match: "google chrome browser" -> chrome
    for key, spec in APP_COMMANDS.items():
        if key in norm or norm in key:
            return dict(spec)
    return None


def _find_exe_on_path(name: str) -> Optional[str]:
    candidates = []
    bare = name.strip().strip('"')
    if bare.lower().endswith(".exe"):
        candidates.append(bare)
    else:
        candidates.append(f"{bare}.exe")
        candidates.append(bare)
    for c in candidates:
        hit = shutil.which(c)
        if hit:
            return hit
        if os.path.isfile(c):
            return c
    # Common install roots
    roots = [
        os.environ.get("ProgramFiles", r"C:\Program Files"),
        os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"),
        os.environ.get("LOCALAPPDATA", ""),
        os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs"),
    ]
    needle = bare.lower().replace(".exe", "")
    for root in roots:
        if not root or not os.path.isdir(root):
            continue
        try:
            for dirpath, _dirnames, filenames in os.walk(root):
                # Bound depth for speed
                depth = dirpath[len(root) :].count(os.sep)
                if depth > 4:
                    continue
                for fn in filenames:
                    if not fn.lower().endswith(".exe"):
                        continue
                    stem = fn[:-4].lower()
                    if stem == needle or needle in stem:
                        return os.path.join(dirpath, fn)
        except Exception:
            continue
    return None


def _start_menu_roots() -> List[Path]:
    roots: List[Path] = []
    appdata = os.environ.get("APPDATA")
    progdata = os.environ.get("PROGRAMDATA")
    if appdata:
        roots.append(Path(appdata) / "Microsoft" / "Windows" / "Start Menu" / "Programs")
    if progdata:
        roots.append(Path(progdata) / "Microsoft" / "Windows" / "Start Menu" / "Programs")
    return [r for r in roots if r.is_dir()]


def _find_start_menu_lnk(name: str) -> Optional[Tuple[str, str]]:
    """Return (lnk_path, label) for the best Start Menu shortcut match."""
    needle = _norm(name)
    if not needle:
        return None
    best: Optional[Tuple[int, str, str]] = None  # score, path, label
    for root in _start_menu_roots():
        try:
            for p in root.rglob("*.lnk"):
                label = p.stem
                lab = _norm(label)
                if lab == needle:
                    score = 100
                elif lab.startswith(needle) or needle.startswith(lab):
                    score = 80
                elif needle in lab or lab in needle:
                    score = 60
                else:
                    # token overlap
                    nt = set(needle.split())
                    lt = set(lab.split())
                    if nt and nt.issubset(lt):
                        score = 70
                    elif nt & lt:
                        score = 40 + 10 * len(nt & lt)
                    else:
                        continue
                # Prefer shorter names at same score (more specific)
                score = score * 1000 - len(lab)
                if best is None or score > best[0]:
                    best = (score, str(p), label)
        except Exception:
            continue
    if best:
        return best[1], best[2]
    return None


def _find_start_apps_uwp(name: str) -> Optional[Tuple[str, str]]:
    """
    Use PowerShell Get-StartApps to resolve Store/UWP apps.
    Returns (AppID, Name) or None.
    """
    needle = _norm(name)
    if not needle:
        return None
    # Escape for single-quoted PowerShell string
    safe = name.replace("'", "''")
    ps = (
        f"$n = '{safe}'.ToLower(); "
        "$apps = Get-StartApps | Select-Object Name, AppID; "
        "$exact = $apps | Where-Object { $_.Name.ToLower() -eq $n } | Select-Object -First 1; "
        "if ($exact) { Write-Output ($exact.Name + '|' + $exact.AppID); exit 0 }; "
        "$hit = $apps | Where-Object { $_.Name.ToLower().Contains($n) -or $n.Contains($_.Name.ToLower()) } "
        "| Select-Object -First 1; "
        "if ($hit) { Write-Output ($hit.Name + '|' + $hit.AppID) }"
    )
    try:
        out = subprocess.check_output(
            [
                "powershell",
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                ps,
            ],
            text=True,
            timeout=20,
            stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        ).strip()
        if out and "|" in out:
            label, app_id = out.split("|", 1)
            if app_id.strip():
                return app_id.strip(), label.strip()
    except Exception:
        return None
    return None


def _launch_uwp_app_id(app_id: str) -> None:
    # shell:AppsFolder\<AppID>
    _popen_detached(f'start "" "shell:AppsFolder\\{app_id}"', shell=True)


def _launch_by_shell_start(name: str) -> None:
    """Last-resort: Windows shell start with the given name."""
    safe = name.strip().strip('"')
    _popen_detached(f'start "" "{safe}"', shell=True)


def _press_win_s() -> None:
    """Open Windows Search (Win+S)."""
    try:
        import pyautogui

        pyautogui.hotkey("win", "s")
        return
    except Exception:
        pass
    try:
        import ctypes

        VK_LWIN, VK_S = 0x5B, 0x53
        KEYEVENTF_KEYUP = 0x0002
        user32 = ctypes.windll.user32
        user32.keybd_event(VK_LWIN, 0, 0, 0)
        time.sleep(0.03)
        user32.keybd_event(VK_S, 0, 0, 0)
        time.sleep(0.03)
        user32.keybd_event(VK_S, 0, KEYEVENTF_KEYUP, 0)
        time.sleep(0.03)
        user32.keybd_event(VK_LWIN, 0, KEYEVENTF_KEYUP, 0)
    except Exception as e:  # noqa: BLE001
        raise ToolError(f"Could not open Windows Search: {e}") from e


def _type_text_reliable(text: str) -> None:
    """Type into the focused field; clipboard paste is most reliable on Windows."""
    text = str(text)
    try:
        import pyperclip
        import pyautogui

        old = None
        try:
            old = pyperclip.paste()
        except Exception:
            old = None
        pyperclip.copy(text)
        time.sleep(0.08)
        pyautogui.hotkey("ctrl", "v")
        time.sleep(0.08)
        if old is not None:
            try:
                pyperclip.copy(old)
            except Exception:
                pass
        return
    except Exception:
        pass
    try:
        import pyautogui

        pyautogui.typewrite(text, interval=0.03)
        return
    except Exception:
        pass
    safe = text.replace("'", "''")
    ps = (
        "Add-Type -AssemblyName System.Windows.Forms; "
        f"[System.Windows.Forms.SendKeys]::SendWait('{safe}')"
    )
    subprocess.run(
        [
            "powershell",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            ps,
        ],
        capture_output=True,
        timeout=10,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )


def _press_enter() -> None:
    try:
        import pyautogui

        pyautogui.press("enter")
        return
    except Exception:
        pass
    try:
        import ctypes

        VK_RETURN = 0x0D
        KEYEVENTF_KEYUP = 0x0002
        ctypes.windll.user32.keybd_event(VK_RETURN, 0, 0, 0)
        time.sleep(0.03)
        ctypes.windll.user32.keybd_event(VK_RETURN, 0, KEYEVENTF_KEYUP, 0)
    except Exception:
        subprocess.run(
            [
                "powershell",
                "-NoProfile",
                "-Command",
                "Add-Type -AssemblyName System.Windows.Forms; "
                "[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')",
            ],
            capture_output=True,
            timeout=8,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )


def _open_via_windows_search(query: str) -> Dict[str, str]:
    """
    Human-style open: Win+S → type app name → Enter.
    Soft success even if the app is not installed (search still ran).
    """
    q = (query or "").strip()
    if not q:
        raise ToolError("Empty app name for Windows Search.")

    _press_win_s()
    time.sleep(0.55)
    try:
        import pyautogui

        pyautogui.hotkey("ctrl", "a")
        time.sleep(0.05)
    except Exception:
        pass
    _type_text_reliable(q)
    time.sleep(0.9)  # let search results populate
    _press_enter()
    time.sleep(0.35)
    return {
        "label": q,
        "method": "windows_search",
        "note": "Used Windows Search (Win+S → type → Enter).",
    }


def _resolve_and_launch(
    name: str,
    *,
    prefer_search: bool = False,
    new_window: bool = False,
) -> Dict[str, str]:
    """
    Resolve `name` to something launchable and start it.
    Returns {label, method[, note]} for the success response.

    Default: if the app is already running, focus its window (no second instance).
    Only when new_window=True do we always launch a fresh process/window.
    """
    raw = (name or "").strip()
    if not raw:
        raise ToolError("Parameter 'name' (application name) is required.")

    # Reuse existing window first (all apps — Chrome, Notepad, Settings, …).
    if not new_window:
        spec = _known_spec(raw)
        if spec and spec.get("image"):
            if _focus_running_by_image(spec["image"]):
                return {
                    "label": spec.get("label", raw),
                    "method": "focused",
                    "note": "Already running — focused existing window.",
                }
        # Also try raw name as process image (e.g. "discord", "spotify")
        image_guess, label_guess = _image_for_close(raw)
        if image_guess and _focus_running_by_image(image_guess):
            return {
                "label": label_guess,
                "method": "focused",
                "note": "Already running — focused existing window.",
            }

    # Force Windows Search (multi-word / uncommon apps like "lm viewer")
    if prefer_search:
        try:
            return _open_via_windows_search(raw)
        except Exception:
            # Fall through to other strategies
            pass

    # 1) Exact catalog key only (avoid weak partial matches for custom names)
    norm = _norm(raw)
    if norm in APP_COMMANDS:
        try:
            spec = dict(APP_COMMANDS[norm])
            _launch_spec(spec)
            return {"label": spec.get("label", raw), "method": "catalog"}
        except Exception:
            pass

    # 2) Direct executable path / PATH
    exe = _find_exe_on_path(raw)
    if exe:
        try:
            _popen_detached([exe], shell=False)
            return {"label": Path(exe).stem, "method": "path"}
        except Exception:
            pass

    # 3) Start Menu shortcuts
    lnk = _find_start_menu_lnk(raw)
    if lnk:
        path, label = lnk
        try:
            _launch_spec({"lnk": path, "label": label})
            return {"label": label, "method": "start_menu"}
        except Exception:
            pass

    # 4) UWP / Store apps
    uwp = _find_start_apps_uwp(raw)
    if uwp:
        app_id, label = uwp
        try:
            _launch_uwp_app_id(app_id)
            return {"label": label, "method": "uwp"}
        except Exception:
            pass

    # 5) Windows Search — human style (Win+S, type, Enter)
    try:
        return _open_via_windows_search(raw)
    except Exception as search_err:  # noqa: BLE001
        # 6) Shell start last resort
        try:
            _launch_by_shell_start(raw)
            return {
                "label": raw,
                "method": "shell_start",
                "note": f"Windows Search failed ({search_err}); used shell start.",
            }
        except Exception as e:  # noqa: BLE001
            # Soft success — search was attempted; app may simply not exist
            return {
                "label": raw,
                "method": "windows_search_attempted",
                "note": (
                    f"Tried Windows Search and shell start for '{raw}'. "
                    f"If nothing opened, the app may not be installed. ({e})"
                ),
            }


def _image_for_close(name: str) -> Tuple[str, str]:
    """Return (image_name, label) for taskkill."""
    spec = _known_spec(name)
    if spec and "image" in spec:
        return spec["image"], spec.get("label", name)
    # Best-effort: treat name as process image
    img = name.strip()
    if not img.lower().endswith(".exe"):
        img = f"{img}.exe"
    return img, name


def _focus_running_by_image(image: str) -> bool:
    """If a process with this image is running, focus its main window and return True.

    Used so "open Chrome / Notepad / Settings" reuses the existing window
    instead of launching a second instance (unless the user asked for new).
    """
    if os.name != "nt":
        return False
    img = (image or "").strip()
    if not img:
        return False
    img_l = img.lower()
    if not img_l.endswith(".exe"):
        img_l = f"{img_l}.exe"
        img = f"{img}.exe" if not img.lower().endswith(".exe") else img

    # explorer.exe always has many processes — handled by navigate_or_open_explorer.
    if img_l == "explorer.exe":
        return False

    try:
        import win32gui  # type: ignore[import-not-found]
        import win32process  # type: ignore[import-not-found]
        import win32con  # type: ignore[import-not-found]
        import psutil  # type: ignore[import-not-found]

        pids = set()
        for p in psutil.process_iter(["pid", "name"]):
            try:
                if (p.info.get("name") or "").lower() == img_l:
                    pids.add(int(p.info["pid"]))
            except Exception:
                continue
        if not pids:
            return False

        matches: List[int] = []

        def _cb(hwnd, _):  # type: ignore[no-untyped-def]
            try:
                if not win32gui.IsWindowVisible(hwnd):
                    return True
                title = win32gui.GetWindowText(hwnd) or ""
                if not title.strip():
                    return True
                # Skip tool/popup windows without a real client area
                if win32gui.GetWindow(hwnd, win32con.GW_OWNER):
                    return True
                _tid, pid = win32process.GetWindowThreadProcessId(hwnd)
                if pid in pids:
                    matches.append(hwnd)
            except Exception:
                pass
            return True

        win32gui.EnumWindows(_cb, None)
        if not matches:
            return False

        hwnd = matches[0]
        try:
            # Only restore when minimized — never SW_RESTORE/SW_SHOW on maximized
            # or fullscreen windows (shrinks Chrome/YouTube — user-reported bug).
            if win32gui.IsIconic(hwnd):
                win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
            try:
                win32gui.SetForegroundWindow(hwnd)
            except Exception:
                try:
                    import ctypes

                    user32 = ctypes.windll.user32
                    user32.keybd_event(0x12, 0, 0, 0)
                    user32.keybd_event(0x12, 0, 2, 0)
                    win32gui.SetForegroundWindow(hwnd)
                except Exception:
                    return False
        except Exception:
            return False
        return True
    except Exception:
        # PowerShell fallback
        try:
            ps = f"""
$ErrorActionPreference='SilentlyContinue'
$img='{img_l.replace("'", "''")}'
$procs = Get-Process | Where-Object {{ $_.ProcessName -eq ($img -replace '\\.exe$','') -and $_.MainWindowHandle -ne 0 }}
if (-not $procs) {{ Write-Output 'none'; exit 0 }}
$h = [int64]$procs[0].MainWindowHandle
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class BikliFocusApp {{
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
}}
"@
$ptr = [IntPtr]$h
if ([BikliFocusApp]::IsIconic($ptr)) {{ [void][BikliFocusApp]::ShowWindow($ptr, 9) }}
[void][BikliFocusApp]::SetForegroundWindow($ptr)
Write-Output 'focused'
"""
            r = subprocess.run(
                [
                    "powershell",
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-Command",
                    ps,
                ],
                capture_output=True,
                text=True,
                timeout=10,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            return "focused" in (r.stdout or "").lower()
        except Exception:
            return False


def _is_file_explorer_name(name: str) -> bool:
    n = _norm(name)
    return n in (
        "file explorer",
        "explorer",
        "windows explorer",
        "explorer.exe",
        "this pc",
        "my computer",
        "computer",
    )


def _want_new_window_flag(args: Dict[str, Any]) -> bool:
    if args.get("new_window") is True or args.get("new") is True:
        return True
    for key in ("new_window", "new", "mode", "window", "open_mode"):
        v = str(args.get(key) or "").strip().lower().replace("-", " ").replace("_", " ")
        if v in ("new", "new window", "newwindow", "true", "1", "yes", "open in new", "open new"):
            return True
    return False


@register("openApplication")
def open_application(args: Dict[str, Any]) -> Dict[str, Any]:
    global _LAST_OPEN_APP_KEY, _LAST_OPEN_APP_AT
    name = args.get("name") or args.get("application") or args.get("app")
    if not name:
        raise ToolError("Parameter 'name' (application name) is required.")

    raw = str(name).strip()
    new_window = _want_new_window_flag(args)
    app_key = re.sub(r"\s+", " ", raw.lower().replace(".exe", "")).strip()
    now = time.time()
    # Skip duplicate launches (same app within debounce window) unless new_window
    if (
        not new_window
        and app_key
        and app_key == _LAST_OPEN_APP_KEY
        and (now - _LAST_OPEN_APP_AT) < _OPEN_APP_DEBOUNCE_SEC
    ):
        return {
            "result": f"{raw} was just opened — skipped duplicate so only one window opens.",
            "label": raw,
            "method": "debounced",
            "requested": raw,
            "ok": True,
            "debounced": True,
            "mode": "debounced",
        }
    _LAST_OPEN_APP_KEY = app_key
    _LAST_OPEN_APP_AT = now

    # File Explorer: reuse the existing window unless user asked for a new one.
    if _is_file_explorer_name(raw):
        from .tools_files import navigate_or_open_explorer

        new_window = _want_new_window_flag(args)
        out = navigate_or_open_explorer(None, new_window=new_window, focus_only=not new_window)
        mode = out.get("mode", "opened")
        if mode == "focused":
            msg = "File Explorer was already open — brought it to the front."
        elif mode == "new":
            msg = "Opened a new File Explorer window."
        else:
            msg = "Opened File Explorer."
        return {
            "result": msg,
            "label": "File Explorer",
            "method": f"explorer_{mode}",
            "requested": raw,
            "ok": True,
            "mode": mode,
        }

    method_hint = str(args.get("method") or args.get("via") or "").strip().lower()
    prefer_search = method_hint in ("search", "windows_search", "start", "winsearch")
    if args.get("search") is True:
        prefer_search = True
    # Multi-word / uncommon names → Windows Search first (e.g. "lm viewer")
    if not prefer_search and len(raw.split()) >= 2 and _norm(raw) not in APP_COMMANDS:
        prefer_search = True

    info = _resolve_and_launch(raw, prefer_search=prefer_search, new_window=new_window)
    label = info.get("label", raw)
    method = info.get("method", "unknown")
    note = info.get("note", "")

    if method == "focused":
        msg = f"{label} was already open — brought it to the front."
    elif method == "windows_search":
        msg = (
            f"Opened Windows Search for '{label}', typed the name, and pressed Enter. "
            "If the app did not open, it may not be installed or named differently."
        )
    elif method == "windows_search_attempted":
        msg = note or f"Tried to open '{label}' via Windows Search."
    else:
        msg = f"Opened {label}."
        if note:
            msg = f"{msg} {note}"

    return {
        "result": msg,
        "label": label,
        "method": method,
        "requested": raw,
        "ok": True,
        "mode": "focused" if method == "focused" else ("new" if new_window else "opened"),
    }


@register("closeApplication")
def close_application(args: Dict[str, Any]) -> Dict[str, Any]:
    name = args.get("name") or args.get("application") or args.get("app")
    force = bool(args.get("force", False))
    if not name:
        raise ToolError("Parameter 'name' (application name) is required.")
    image, label = _image_for_close(str(name))

    def _taskkill(extra: List[str]) -> None:
        # Args passed as a list WITHOUT shell=True — a crafted image name
        # (quotes / & / | / cmd metacharacters) is passed literally and can
        # never inject extra commands.
        subprocess.run(
            ["taskkill", "/IM", image, *extra],
            shell=False,
            capture_output=True,
            timeout=12,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )

    try:
        # Graceful close (no /F) first unless force requested
        if not force:
            _taskkill([])
            # If still running, force on second try after a short wait
            time.sleep(0.35)
            _taskkill(["/F"])
        else:
            _taskkill(["/F"])
    except Exception as e:  # noqa: BLE001
        raise ToolError(f"Could not close {label}: {e}") from e
    time.sleep(0.15)
    return {"result": f"Closed {label}."}


__all__ = ["open_application", "close_application", "APP_COMMANDS"]
