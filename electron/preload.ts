import { contextBridge, ipcRenderer } from 'electron';

/**
 * Secure IPC bridge exposed to the renderer as `window.ollamaSetup`.
 * The renderer process cannot access Node/Electron APIs directly because
 * contextIsolation is enabled; all native operations go through this bridge.
 */
contextBridge.exposeInMainWorld('ollamaSetup', {
  /** Returns true when the Ollama binary is present on this machine. */
  checkInstalled: (): Promise<boolean> =>
    ipcRenderer.invoke('ollama:check'),

  /**
   * Download and open the platform-specific Ollama installer.
   * Resolves with `{ success: true }` once the installer has been launched, or
   * `{ success: false, error: string }` if something went wrong.
   */
  install: (): Promise<{ success: boolean; error?: string }> =>
    ipcRenderer.invoke('ollama:install'),

  /**
   * Subscribe to progress messages emitted by the installer download.
   * Returns an unsubscribe function that should be called when the component
   * no longer needs updates (e.g. on unmount or after install completes).
   */
  onProgress: (callback: (msg: string) => void): (() => void) => {
    const listener = (_event: Electron.IpcRendererEvent, msg: string) =>
      callback(msg);
    ipcRenderer.on('ollama:progress', listener);
    return () => ipcRenderer.removeListener('ollama:progress', listener);
  },

  /** The current OS platform string, e.g. "darwin", "win32", "linux". */
  platform: process.platform as string,
});
