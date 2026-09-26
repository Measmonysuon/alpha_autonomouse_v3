const { app, BrowserWindow, Tray, Menu, shell, Notification } = require('electron');
const path = require('path');
const http = require('http');

let mainWindow = null;
let tray = null;
let serverStarted = false;

const PORT = process.env.PORT || 5000;
const HOST = '127.0.0.1';

function checkServerReady() {
  return new Promise((resolve) => {
    const req = http.get(`http://${HOST}:${PORT}/health`, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(1000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function startBackendServer() {
  if (serverStarted) return;
  serverStarted = true;
  try {
    console.log('🚀 [ELECTRON] Starting embedded Client v3 backend server...');
    process.env.NODE_ENV = 'production';
    process.env.PORT = String(PORT);

    // Require compiled dist entrypoint
    require('../dist/index.js');
    console.log('✅ [ELECTRON] Client v3 backend loaded successfully.');
  } catch (err) {
    console.error('❌ [ELECTRON] Failed to start backend server:', err.message);
  }
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 700,
    title: 'Alpha Autonomous Client v3.0.0 — Decibel DEX Trading Hub',
    backgroundColor: '#090d16',
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false,
    },
  });

  // Remove default menu bar
  Menu.setApplicationMenu(null);

  // Poll until backend HTTP server is ready
  let isReady = false;
  let attempts = 0;
  while (!isReady && attempts < 30) {
    attempts++;
    isReady = await checkServerReady();
    if (!isReady) await new Promise((r) => setTimeout(r, 500));
  }

  const targetUrl = `http://${HOST}:${PORT}`;
  console.log(`🌐 [ELECTRON] Loading dashboard at ${targetUrl}...`);
  mainWindow.loadURL(targetUrl);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    console.log('✅ [ELECTRON] Desktop window displayed.');
  });

  // Minimize to tray on close instead of exiting 24/7 engine
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
      if (Notification.isSupported()) {
        new Notification({
          title: 'Alpha Client v3',
          body: 'Trading Engine is running 24/7 in the background tray.',
        }).show();
      }
    }
    return false;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });
}

function createTray() {
  try {
    const iconPath = path.join(__dirname, '../dashboard/favicon.ico');
    tray = new Tray(iconPath);
  } catch {
    return;
  }

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '🟢 Open Alpha Trading Hub',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    {
      label: '🌾 Execute Harvest All',
      click: () => {
        http.request({ hostname: HOST, port: PORT, path: '/api/harvester/harvest', method: 'POST' }).end();
      },
    },
    { type: 'separator' },
    {
      label: '❌ Quit Alpha Client v3',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setToolTip('Alpha Autonomous Client v3.0.0 (Trading Active)');
  tray.setContextMenu(contextMenu);
  tray.on('click', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// Ensure single instance lock
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    await startBackendServer();
    createTray();
    await createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else if (mainWindow) mainWindow.show();
    });
  });

  app.on('before-quit', () => {
    app.isQuitting = true;
  });

  app.on('window-all-closed', (e) => {
    // Keep app running in background tray
    e.preventDefault();
  });
}
