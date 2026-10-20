'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeTheme } = require('electron');
const fs = require('fs');
const path = require('path');
const { JsonStore } = require('./store');
const { execute, prepare } = require('../core/executor');
const { mergeScopes } = require('../core/variables');
const codegen = require('../core/codegen');
const { parseCurl } = require('../core/curl');
const postman = require('../core/postman');
const runner = require('../core/runner');
const { makeLookup } = require('../core/dependency');
const httpClient = require('../core/http-client');
const { seedWorkspace } = require('./seed');

const dataDir = process.env.HTTPDASH_DATA_DIR || app.getPath('userData');
const workspaceStore = new JsonStore(path.join(dataDir, 'workspace.json'), seedWorkspace);
const cookieStore = new JsonStore(path.join(dataDir, 'cookies.json'), () => ({ cookies: [] }));
let jar = cookieStore.load().cookies;
const saveJar = () => cookieStore.save({ cookies: jar });

let win;
const inflight = new Map();
let activeRun = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'HttpDash',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1f22' : '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  // Open external links in the system browser instead of inside the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

function buildMenu() {
  const send = (cmd) => () => {
    // On macOS the app keeps running with no window; reopen one before dispatching.
    if (!win || win.isDestroyed()) {
      createWindow();
      win.webContents.once('did-finish-load', () => win.webContents.send('menu', cmd));
    } else win.webContents.send('menu', cmd);
  };
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Request', accelerator: 'CmdOrCtrl+T', registerAccelerator: false, click: send('new-request') },
        { label: 'New Collection', click: send('new-collection') },
        { label: 'New Environment', click: send('new-environment') },
        { type: 'separator' },
        { label: 'Import…', accelerator: 'CmdOrCtrl+O', registerAccelerator: false, click: send('import') },
        { label: 'Save Request', accelerator: 'CmdOrCtrl+S', registerAccelerator: false, click: send('save') },
        { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', registerAccelerator: false, click: send('close-tab') },
        { type: 'separator' },
        { label: 'Settings', accelerator: 'CmdOrCtrl+,', registerAccelerator: false, click: send('settings') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+\\', registerAccelerator: false, click: send('toggle-sidebar') },
        { label: 'Toggle Console', accelerator: 'CmdOrCtrl+Alt+C', registerAccelerator: false, click: send('toggle-console') },
        { type: 'separator' },
        { role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Tools',
      submenu: [
        { label: 'Send Request', accelerator: 'CmdOrCtrl+Enter', registerAccelerator: false, click: send('send') },
        { label: 'Collection Runner', click: send('runner') },
        { label: 'Cookies', click: send('cookies') },
        { label: 'Generate Code', click: send('codegen') },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ---- IPC ----------------------------------------------------------------------------------

const handle = (channel, fn) => ipcMain.handle(channel, async (_e, ...args) => fn(...args));

handle('workspace:load', () => workspaceStore.load());
handle('workspace:save', (data) => { workspaceStore.save(data); return true; });
handle('app:info', () => ({ version: app.getVersion(), platform: process.platform, dataDir, dark: nativeTheme.shouldUseDarkColors }));

handle('request:send', async ({ id, request, chain, scopes, settings, info, collection }) => {
  const controller = new AbortController();
  inflight.set(id, controller);
  const logs = [];
  try {
    const res = await execute({
      request, chain, scopes, settings, info, jar,
      lookup: makeLookup(collection),
      signal: controller.signal,
      log: (level, message) => logs.push({ level, message, time: Date.now() }),
    });
    res.logs = logs;
    return res;
  } finally {
    inflight.delete(id);
    saveJar();
  }
});
handle('request:cancel', (id) => { const c = inflight.get(id); if (c) c.abort(); return !!c; });

handle('codegen:targets', () => codegen.targets());
handle('codegen:generate', ({ target, request, chain, scopes }) => {
  const p = prepare(request, { chain, vars: mergeScopes(scopes), defaultHeaders: false });
  return codegen.generate(target, p, request);
});

handle('import:curl', (text) => parseCurl(text));
handle('import:text', (text) => postman.importAny(JSON.parse(text)));
handle('import:files', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Import', properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Collections, environments, OpenAPI', extensions: ['json'] }, { name: 'All files', extensions: ['*'] }],
  });
  if (r.canceled) return [];
  return r.filePaths.map((f) => {
    try {
      return { file: path.basename(f), ...postman.importAny(JSON.parse(fs.readFileSync(f, 'utf8'))) };
    } catch (e) {
      return { file: path.basename(f), error: e.message };
    }
  });
});

async function saveJson(defaultName, data) {
  const r = await dialog.showSaveDialog(win, { defaultPath: defaultName, filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, JSON.stringify(data, null, 2));
  return r.filePath;
}
const safeName = (s) => String(s || 'export').replace(/[^\w.-]+/g, '_');
handle('export:collection', (col) => saveJson(`${safeName(col.name)}.postman_collection.json`, postman.exportCollection(col)));
handle('export:environment', (env) => saveJson(`${safeName(env.name)}.postman_environment.json`, postman.exportEnvironment(env)));
handle('export:globals', (values) => saveJson('globals.postman_globals.json', { ...postman.exportEnvironment({ id: 'globals', name: 'Globals', values }), _postman_variable_scope: 'globals' }));
handle('export:json', ({ name, data }) => saveJson(name, data));
handle('export:workspace', () => saveJson('httpdash-workspace.json', workspaceStore.load()));

handle('response:save', async ({ name, bodyText, bodyBase64 }) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: name || 'response' });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, bodyBase64 ? Buffer.from(bodyBase64, 'base64') : bodyText || '');
  return r.filePath;
});

handle('dialog:openFile', async ({ multi, filters } = {}) => {
  const r = await dialog.showOpenDialog(win, { properties: multi ? ['openFile', 'multiSelections'] : ['openFile'], filters });
  return r.canceled ? [] : r.filePaths;
});
handle('runner:readData', (file) => {
  const rows = runner.parseDataFile(fs.readFileSync(file, 'utf8'), file);
  return { file: path.basename(file), rows };
});

handle('runner:start', async (opts) => {
  if (activeRun) throw new Error('A collection run is already in progress');
  const controller = new AbortController();
  activeRun = controller;
  try {
    const summary = await runner.run({
      ...opts,
      jar: opts.useCookies === false ? [] : jar,
      signal: controller.signal,
      onEvent: (evt) => win && !win.isDestroyed() && win.webContents.send('runner:event', evt),
    });
    return summary;
  } finally {
    activeRun = null;
    saveJar();
  }
});
handle('runner:stop', () => { if (activeRun) activeRun.abort(); return true; });

handle('cookies:list', () => jar);
handle('cookies:delete', ({ name, domain, path: p }) => {
  jar = jar.filter((c) => !(c.name === name && c.domain === domain && (p === undefined || c.path === p)));
  saveJar();
  return jar;
});
handle('cookies:clearDomain', (domain) => { jar = jar.filter((c) => c.domain !== domain); saveJar(); return jar; });
handle('cookies:clear', () => { jar = []; saveJar(); return jar; });
handle('cookies:upsert', (cookie) => {
  jar = jar.filter((c) => !(c.name === cookie.name && c.domain === cookie.domain && c.path === cookie.path));
  jar.push({ path: '/', hostOnly: false, secure: false, httpOnly: false, expires: null, ...cookie });
  saveJar();
  return jar;
});

// OAuth 2.0 token retrieval (client credentials and password grants).
handle('oauth2:getToken', async ({ config, scopes, settings }) => {
  const { resolve } = require('../core/variables');
  const vars = mergeScopes(scopes || {});
  const r = (v) => resolve(v || '', vars);
  const form = new URLSearchParams();
  form.set('grant_type', config.grantType || 'client_credentials');
  if (config.scope) form.set('scope', r(config.scope));
  if (config.grantType === 'password') {
    form.set('username', r(config.username));
    form.set('password', r(config.password));
  }
  const headers = [['Content-Type', 'application/x-www-form-urlencoded'], ['Accept', 'application/json']];
  if (config.clientAuth === 'body') {
    form.set('client_id', r(config.clientId));
    if (config.clientSecret) form.set('client_secret', r(config.clientSecret));
  } else {
    headers.push(['Authorization', 'Basic ' + Buffer.from(`${encodeURIComponent(r(config.clientId))}:${encodeURIComponent(r(config.clientSecret))}`).toString('base64')]);
  }
  const body = Buffer.from(form.toString());
  const res = await httpClient.send({
    method: 'POST', url: r(config.accessTokenUrl), headers, body,
    timeout: (settings && settings.timeout) || 30000, verifySSL: !settings || settings.verifySSL !== false, followRedirects: true,
    proxy: settings && settings.proxy,
  });
  const text = res.body.toString('utf8');
  let json;
  try { json = JSON.parse(text); } catch { json = Object.fromEntries(new URLSearchParams(text)); }
  if (res.status >= 400 || !json.access_token) {
    throw new Error(`Token request failed (${res.status}): ${json.error_description || json.error || text.slice(0, 300)}`);
  }
  return json;
});

handle('shell:openExternal', (url) => { if (/^https?:/.test(url)) shell.openExternal(url); });

app.whenReady().then(() => {
  buildMenu();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
