import { app, BrowserWindow, session } from 'electron';
import path from 'node:path';
import started from 'electron-squirrel-startup';

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit();
}

// Electron denies every permission request by default. Phase 3's renderer
// calls getUserMedia() for mic/line-in capture (see
// apps/desktop/src/audio/*.ts) -- without explicitly allowing the 'media'
// permission here, that call rejects immediately with NotAllowedError
// regardless of what the OS-level mic permission (macOS TCC, etc.) would
// have allowed. This handler is Electron's *own* additional permission
// layer on top of the OS prompt, not a replacement for it -- the OS-level
// prompt (and the Info.plist NSMicrophoneUsageDescription string set in
// forge.config.ts) still applies separately on macOS.
function configureMediaPermissions(): void {
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media');
  });
  session.defaultSession.setPermissionCheckHandler(
    (_webContents, permission) => permission === 'media',
  );
}

const createWindow = () => {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  // and load the index.html of the app.
  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }

  // DevTools only when running from source (`pnpm start`) -- an installed,
  // packaged build must not pop DevTools open on every launch. Still
  // reachable there via the View menu / Ctrl+Shift+I (Cmd+Opt+I on macOS).
  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools();
  }
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', () => {
  configureMediaPermissions();
  createWindow();
});

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and import them here.
