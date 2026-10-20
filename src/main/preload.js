'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel) => (...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('api', {
  loadWorkspace: invoke('workspace:load'),
  saveWorkspace: invoke('workspace:save'),
  appInfo: invoke('app:info'),

  send: invoke('request:send'),
  cancel: invoke('request:cancel'),

  codegenTargets: invoke('codegen:targets'),
  generateCode: invoke('codegen:generate'),

  importCurl: invoke('import:curl'),
  importText: invoke('import:text'),
  importFiles: invoke('import:files'),
  exportCollection: invoke('export:collection'),
  exportEnvironment: invoke('export:environment'),
  exportGlobals: invoke('export:globals'),
  exportJson: invoke('export:json'),
  exportAll: invoke('export:all'),
  restoreBackup: invoke('backup:restore'),
  saveResponse: invoke('response:save'),
  openFile: invoke('dialog:openFile'),

  readDataFile: invoke('runner:readData'),
  runCollection: invoke('runner:start'),
  stopRun: invoke('runner:stop'),
  onRunnerEvent: (fn) => ipcRenderer.on('runner:event', (_e, evt) => fn(evt)),

  cookies: {
    list: invoke('cookies:list'),
    remove: invoke('cookies:delete'),
    clearDomain: invoke('cookies:clearDomain'),
    clear: invoke('cookies:clear'),
    upsert: invoke('cookies:upsert'),
  },

  getOAuth2Token: invoke('oauth2:getToken'),
  refreshOAuth2Token: invoke('oauth2:refresh'),
  cancelOAuth2: invoke('oauth2:cancel'),
  clearOAuth2Sessions: invoke('oauth2:clearSessions'),
  syncDiscovery: invoke('discovery:sync'),
  openExternal: invoke('shell:openExternal'),
  lock: {
    status: invoke('lock:status'),
    getConfig: invoke('lock:getConfig'),
    setConfig: invoke('lock:setConfig'),
    test: invoke('lock:test'),
    enable: invoke('lock:enable'),
    update: invoke('lock:update'),
    lock: invoke('lock:lock'),
    unlock: invoke('lock:unlock'),
    recover: invoke('lock:recover'),
    disable: invoke('lock:disable'),
  },
  runMonitor: invoke('monitor:run'),
  mock: {
    start: invoke('mock:start'),
    update: invoke('mock:update'),
    stop: invoke('mock:stop'),
    list: invoke('mock:list'),
    onLog: (fn) => ipcRenderer.on('mock:log', (_e, entry) => fn(entry)),
  },
  scanSecrets: invoke('secrets:scan'),
  audit: {
    read: invoke('audit:read'),
    clear: invoke('audit:clear'),
    export: invoke('audit:export'),
  },
  team: {
    gitVersion: invoke('team:gitVersion'),
    setToken: invoke('team:setToken'),
    tokenInfo: invoke('team:tokenInfo'),
    sync: invoke('team:sync'),
    resolve: invoke('team:resolve'),
    apply: invoke('team:apply'),
    scan: invoke('team:scan'),
    abort: invoke('team:abort'),
    log: invoke('team:log'),
    remove: invoke('team:remove'),
  },
  onMenu: (fn) => ipcRenderer.on('menu', (_e, cmd) => fn(cmd)),
});
