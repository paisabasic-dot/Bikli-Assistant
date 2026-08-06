/* ===========================================================================
 * BIKLI — Electron preload
 * ---------------------------------------------------------------------------
 * Exposes a small safe API to the renderer:
 *   - isDesktop flag
 *   - getScreenSources() for reliable packaged screen capture
 * ========================================================================= */

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bikli', {
  isDesktop: true,
  platform: process.platform,
  version: process.versions.electron,
  /**
   * List desktop screens/windows for capture.
   * Used by Share Screen in the packaged app (getDisplayMedia alone is flaky).
   * @returns {Promise<Array<{ id: string, name: string }>>}
   */
  getScreenSources: () => ipcRenderer.invoke('bikli:get-screen-sources'),
  /**
   * Subscribe to main-window focus events (re-arm wake word after unfocus).
   * @param {() => void} cb
   * @returns {() => void} unsubscribe
   */
  /**
   * Ask Electron to quit the whole app (used by voice "bye" command).
   */
  quit: () => ipcRenderer.send('bikli:quit'),
  onWindowFocus: (cb) => {
    if (typeof cb !== 'function') return () => {};
    const handler = () => {
      try {
        cb();
      } catch {
        /* ignore */
      }
    };
    ipcRenderer.on('bikli:window-focus', handler);
    return () => {
      try {
        ipcRenderer.removeListener('bikli:window-focus', handler);
      } catch {
        /* ignore */
      }
    };
  },
});
