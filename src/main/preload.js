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
  exportWorkspace: invoke('export:workspace'),
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
  syncDiscovery: invoke('discovery:sync'),
  openExternal: invoke('shell:openExternal'),
  onMenu: (fn) => ipcRenderer.on('menu', (_e, cmd) => fn(cmd)),
});
