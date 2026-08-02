/**
 * @mun/desktop — Electron main entry
 *
 * Creates the application window, wires the IPC backend, handles power
 * management (sleep → pause monitoring; wake → force reconnect + resume), and
 * enforces a single instance.
 */

import { app, BrowserWindow, shell, powerMonitor, Menu } from 'electron';
import { join } from 'node:path';
import { createBackend } from './ipc.js';
import type { MunBackend } from './backend.js';

let mainWindow: BrowserWindow | null = null;
let backend: MunBackend | null = null;

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 832,
    minWidth: 900,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    title: 'SAFE MUN 2026',
    icon: join(__dirname, '..', '..', 'build', 'icon.png'),
    backgroundColor: '#020617',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => win.show());

  // Block navigation away from the app (security).
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  // Load the renderer (dev server in dev, packaged file in prod).
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(join(process.resourcesPath, 'renderer', 'index.html'));
  }

  return win;
}

app.whenReady().then(() => {
  // Single instance in production only. In dev, allow multiple instances so a
  // tester can run a delegate window and a chair/admin window simultaneously
  // (each role is on its own laptop at a real conference).
  if (app.isPackaged) {
    const gotLock = app.requestSingleInstanceLock();
    if (!gotLock) {
      app.quit();
      return;
    }
    app.on('second-instance', () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        mainWindow.focus();
      }
    });
  }

  Menu.setApplicationMenu(null);
  mainWindow = createWindow();
  backend = createBackend(mainWindow);

  // Auto-resume a persisted session (after restart/crash).
  void backend.init();

  // Power management: pause on sleep, reconnect + resume on wake.
  powerMonitor.on('suspend', () => {
    backend?.getMonitoring(); // engine auto-pauses via its own timer; no-op here
  });
  powerMonitor.on('resume', () => {
    // A stale WebSocket is replaced; monitoring resumes if still active.
    // The backend exposes reconnect via the realtime client through state.
    void backend?.refreshSession();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
      // Re-create backend for the new window.
      backend = createBackend(mainWindow);
      void backend.init();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  backend?.dispose();
});
