import { app, BrowserWindow, Menu, ipcMain, shell } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync, execFileSync } from 'child_process';
import https from 'https';
import http from 'http';
import fs from 'fs';
import { tmpdir } from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow: BrowserWindow | null = null;

// Check if we're in development
const isDev = process.env.NODE_ENV === 'development' || process.argv.includes('--dev');

// ── Ollama detection ──────────────────────────────────────────────────────────

/**
 * Returns true when the Ollama CLI binary can be found on the current machine.
 * Checks PATH first, then a handful of well-known installation directories.
 */
function isOllamaInstalled(): boolean {
  // 1. Check if the binary is on PATH
  try {
    const cmd = process.platform === 'win32' ? 'where ollama' : 'which ollama';
    execSync(cmd, { stdio: 'ignore' });
    return true;
  } catch {
    // Not on PATH – fall through
  }

  // 2. Check common installation paths per platform
  const homedir = process.env.HOME ?? process.env.USERPROFILE ?? '';
  const candidates: string[] =
    process.platform === 'darwin'
      ? [
          '/usr/local/bin/ollama',
          '/opt/homebrew/bin/ollama',
          path.join(homedir, '.ollama', 'bin', 'ollama'),
        ]
      : process.platform === 'win32'
      ? [
          path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Ollama', 'ollama.exe'),
          path.join(process.env.PROGRAMFILES ?? '', 'Ollama', 'ollama.exe'),
        ]
      : ['/usr/local/bin/ollama', '/usr/bin/ollama'];

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return true;
    } catch {
      // ignore permission errors etc.
    }
  }
  return false;
}

// ── Ollama installer download ─────────────────────────────────────────────────

/**
 * Download a file from `url` to `destPath`, calling `onProgress` with the
 * completion percentage (0–100) as each chunk arrives.
 * Follows HTTP 301/302 redirects automatically.
 */
function downloadFile(
  url: string,
  destPath: string,
  onProgress?: (pct: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const fetchUrl = (reqUrl: string) => {
      const client = reqUrl.startsWith('https://') ? https : http;
      client.get(reqUrl, (res) => {
        // Follow redirect
        if (
          (res.statusCode === 301 || res.statusCode === 302) &&
          res.headers.location
        ) {
          res.resume();
          fetchUrl(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`Download failed: HTTP ${res.statusCode}`));
          return;
        }
        const total = parseInt(res.headers['content-length'] ?? '0', 10);
        let downloaded = 0;
        const file = fs.createWriteStream(destPath);
        // Write chunks manually so we can track progress without a separate
        // data listener racing against pipe().
        res.on('data', (chunk: Buffer) => {
          downloaded += chunk.length;
          file.write(chunk);
          if (total > 0) onProgress?.(Math.floor((downloaded / total) * 100));
        });
        res.on('end', () => { file.end(); });
        file.on('finish', () => resolve());
        file.on('error', reject);
        res.on('error', reject);
      }).on('error', reject);
    };
    fetchUrl(url);
  });
}

/**
 * Download the platform-appropriate Ollama installer and launch it.
 * Progress strings are emitted via `sendProgress` as the download proceeds.
 */
async function downloadAndInstallOllama(
  sendProgress: (msg: string) => void,
): Promise<{ success: boolean; error?: string }> {
  const platform = process.platform;

  try {
    if (platform === 'linux') {
      // Linux: open the download page; automated install requires sudo/curl
      sendProgress('Opening Ollama download page…');
      await shell.openExternal('https://ollama.com/download/linux');
      sendProgress('Please follow the instructions on the Ollama website.');
      return { success: true };
    }

    const isWin = platform === 'win32';
    const downloadUrl = isWin
      ? 'https://ollama.com/download/OllamaSetup.exe'
      : 'https://ollama.com/download/Ollama-darwin.zip';
    const fileName = isWin ? 'OllamaSetup.exe' : 'Ollama-darwin.zip';
    const destPath = path.join(tmpdir(), fileName);

    sendProgress('Downloading Ollama…');
    await downloadFile(downloadUrl, destPath, pct => {
      sendProgress(`Downloading Ollama… ${pct}%`);
    });
    sendProgress('Download complete. Launching installer…');

    if (isWin) {
      // Windows: run the installer executable directly
      await shell.openPath(destPath);
    } else {
      // macOS: unzip and open Ollama.app (it installs itself on first launch)
      const extractDir = path.join(tmpdir(), 'ollama-install');
      fs.mkdirSync(extractDir, { recursive: true });
      // Use execFileSync (not execSync) to avoid shell injection via path names
      execFileSync('unzip', ['-o', destPath, '-d', extractDir]);
      const appPath = path.join(extractDir, 'Ollama.app');
      if (fs.existsSync(appPath)) {
        await shell.openPath(appPath);
      } else {
        // Fallback: show the extracted folder in Finder
        await shell.openPath(extractDir);
      }
    }

    sendProgress('Installer launched. Follow the on-screen setup instructions.');
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message ?? String(err) };
  }
}

// ── Window creation ───────────────────────────────────────────────────────────

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: 'Local LM',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  const startUrl = isDev
    ? 'http://localhost:3000'
    : `file://${path.join(__dirname, '../dist/index.html')}`;

  mainWindow.loadURL(startUrl);

  if (isDev) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
};

app.on('ready', createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

// ── IPC handlers ──────────────────────────────────────────────────────────────

/** Check whether Ollama is installed on this machine. */
ipcMain.handle('ollama:check', (): boolean => isOllamaInstalled());

/** Download and launch the Ollama installer, streaming progress to the renderer. */
ipcMain.handle('ollama:install', async (): Promise<{ success: boolean; error?: string }> => {
  const sendProgress = (msg: string) => {
    mainWindow?.webContents.send('ollama:progress', msg);
  };
  return downloadAndInstallOllama(sendProgress);
});

// ── Application menu ──────────────────────────────────────────────────────────

const template: Electron.MenuItemConstructorOptions[] = [
  {
    label: 'File',
    submenu: [
      {
        label: 'Exit',
        accelerator: 'CmdOrCtrl+Q',
        click: () => {
          app.quit();
        },
      },
    ],
  },
  {
    label: 'Edit',
    submenu: [
      { label: 'Undo', accelerator: 'CmdOrCtrl+Z', role: 'undo' },
      { label: 'Redo', accelerator: 'CmdOrCtrl+Y', role: 'redo' },
      { type: 'separator' },
      { label: 'Cut', accelerator: 'CmdOrCtrl+X', role: 'cut' },
      { label: 'Copy', accelerator: 'CmdOrCtrl+C', role: 'copy' },
      { label: 'Paste', accelerator: 'CmdOrCtrl+V', role: 'paste' },
    ],
  },
];

const menu = Menu.buildFromTemplate(template);
Menu.setApplicationMenu(menu);
