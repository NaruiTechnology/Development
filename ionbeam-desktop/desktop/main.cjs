const { app, BrowserWindow, dialog, session, shell, ipcMain } = require('electron');
const { scanMode } = require('./deep-link.cjs');
const { installNativeBridge } = require('./native-bridge.cjs');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
require('../runtime/ionbeam-web/backend/node_modules/dotenv').config({ path: path.join(app.getPath('userData'), 'desktop.env') });

const root = path.resolve(__dirname, '..');
const siteRoot = process.env.IONBEAM_SITE_ROOT || path.join(app.getPath('home'), 'IobeamPlatform', 'Development');
require('../runtime/ionbeam-web/backend/node_modules/dotenv').config({
  path: path.join(siteRoot, 'ionbeam-web/backend/.env'),
});
let backend;
let window;
let quitting = false;
const port = Number(process.env.IONBEAM_DESKTOP_PORT || 14000);
const origin = `http://127.0.0.1:${port}`;
const instance = crypto.randomUUID();
let initialMode = process.argv.map(scanMode).find(Boolean) || 'raster';
const webUrl = process.env.IONBEAM_WEB_URL || 'http://127.0.0.1:4000/control';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
if (process.env.IONBEAM_DESKTOP_SMOKE === '1') app.disableHardwareAcceleration();

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('open-url', (event, url) => {
    event.preventDefault();
    const mode = scanMode(url);
    if (mode) selectMode(mode);
    if (window) { window.restore(); window.focus(); }
  });
  app.on('second-instance', (_event, argv) => {
    const mode = argv.map(scanMode).find(Boolean);
    if (mode) selectMode(mode);
    if (window) { window.restore(); window.focus(); }
  });
  app.whenReady().then(start).catch(error => {
    dialog.showErrorBox('Ion Beam Desktop could not start', error.message);
    app.quit();
  });
}

function selectMode(mode) {
  initialMode = mode;
  if (window && !window.isDestroyed() && !window.webContents.isLoading()) {
    window.webContents.send('desktop:mode-change', mode);
  }
}

async function start() {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('IONBEAM_DESKTOP_PORT must be 1024–65535');
  const logDir = path.join(app.getPath('userData'), 'logs');
  fs.mkdirSync(logDir, { recursive: true });
  const log = fs.openSync(path.join(logDir, 'backend.log'), 'a', 0o600);
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    PORT: String(port),
    IONBEAM_DESKTOP_INSTANCE: instance,
    PROXY_TARGET_HTTP: process.env.IONBEAM_SERVICE_URL || 'http://127.0.0.1:8765',
    STATIC_DIR: path.join(root, 'runtime/ionbeam-web/frontend/dist'),
  };
  for (const [key, relative] of Object.entries({
    GLASGOW_CONFIG: 'GlasgowDataIO/Json/streamData.json',
    SBC_VACUUM_CONFIG: 'GlasgowDataIO/Json/vacuumSystem.json',
    SAMPLE_STAGE_CONFIG: 'GlasgowDataIO/Json/sampleStageSystem.json',
    IOBEAM_ADMIN_CONFIG: 'IobeamAdmin/Json/IobeamAdmin.json',
    IOBEAM_ADMIN_DB_CONFIG: 'IobeamAdmin/Json/IobeamAdminDb.json',
    IOBEAM_OPERATION_DB_CONFIG: 'OperationData/Json/OperationDataDb.json',
  })) {
    const filename = path.join(siteRoot, relative);
    if (!env[key] && fs.existsSync(filename)) env[key] = filename;
  }
  backend = spawn(process.execPath, [path.join(root, 'runtime/ionbeam-web/backend/dist/server.js')], {
    cwd: root, env, stdio: ['ignore', log, log], windowsHide: true,
  });
  fs.closeSync(log);
  let failure;
  backend.once('error', error => { failure = error; });
  backend.once('exit', code => {
    failure = new Error(`Desktop backend exited (${code}). See ${logDir}/backend.log`);
    if (window && !quitting) { dialog.showErrorBox('Desktop backend stopped', failure.message); app.quit(); }
  });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (failure) throw failure;
    try {
      const response = await fetch(`${origin}/desktop-health`, { signal: AbortSignal.timeout(500) });
      const health = await response.json();
      if (health.instance !== instance) throw new Error(`Port ${port} belongs to another process; choose IONBEAM_DESKTOP_PORT`);
      ready = true; break;
    } catch (error) {
      if (error.message.includes('belongs to another process')) throw error;
    }
    await sleep(100);
  }
  if (!ready) throw new Error(`Desktop backend did not start. See ${logDir}/backend.log`);
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window = new BrowserWindow({
    width: 1500, height: 980, minWidth: 1000, minHeight: 700,
    title: 'Ion Beam Desktop', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  installNativeBridge(ipcMain, window, origin);
  const rendererPerfLog = path.join(logDir, 'renderer-perf.log');
  window.webContents.on('console-message', (...args) => {
    const details = args[1];
    const message = details && typeof details === 'object' ? details.message : args[2];
    if (typeof message !== 'string' || !message.startsWith('[scan-perf]')) return;
    fs.appendFile(rendererPerfLog, `${new Date().toISOString()} ${message}\n`, { mode: 0o600 }, () => {});
  });
  window.setMenuBarVisibility(false);
  window.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).pathname === '/desktop-open-web') {
      event.preventDefault();
      const target = new URL(webUrl);
      if (target.protocol === 'https:' || (target.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(target.hostname))) void shell.openExternal(target.href);
      return;
    }
    if (new URL(url).origin !== origin) event.preventDefault();
  });
  window.webContents.on('did-finish-load', () => {
    // Deep links can arrive while Chromium is still loading. Sending the
    // latest selection here makes that launch deterministic without reloading
    // the control UI or interrupting an active scan.
    window.webContents.send('desktop:mode-change', initialMode);
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.once('ready-to-show', () => window.show());
  await window.loadURL(`${origin}/control?desktopMode=${initialMode}`);
  if (process.env.IONBEAM_DESKTOP_SMOKE === '1') {
    await sleep(2500);
    const result = await window.webContents.executeJavaScript(`({ title: document.title, controls: document.querySelectorAll('button').length, configuration: !!document.querySelector('[aria-label="Settings"]') })`);
    const output = process.env.IONBEAM_DESKTOP_SMOKE_OUTPUT;
    if (output) {
      fs.writeFileSync(`${output}.json`, JSON.stringify(result, null, 2));
      const capture = await Promise.race([window.webContents.capturePage(), sleep(5000).then(() => null)]);
      if (capture) fs.writeFileSync(`${output}.png`, capture.toPNG());
    }
    app.quit();
  }
}

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  quitting = true;
  // Only stop our own proxy. The shared device service stays running.
  if (backend && backend.exitCode === null) {
    backend.kill('SIGTERM');
    const child = backend;
    setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 3000).unref();
  }
});
