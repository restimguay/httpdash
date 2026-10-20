'use strict';

/* Workspace state, persistence and tree helpers. */
(() => {
  const S = (HD.S = {
    ws: null, // the persisted workspace
    responses: new Map(), // tabId -> last response (kept in memory only)
    sending: new Map(), // tabId -> true while a request is in flight
    senders: new Map(), // tabId -> send() of the rendered request view
    consoleLogs: [],
  });

  HD.newRequestDef = (o = {}) => ({
    method: 'GET', url: '', params: [], pathVariables: [], headers: [],
    body: { mode: 'none', raw: '', rawLanguage: 'json', urlencoded: [], formdata: [], binary: '', graphql: { query: '', variables: '' } },
    auth: { type: 'inherit' }, preRequestScript: '', testScript: '', description: '', settings: {},
    ...o,
  });
  HD.newRequestItem = (name = 'New Request', req = {}) => ({ id: HD.uid(), type: 'request', name, request: HD.newRequestDef(req), examples: [] });
  HD.newFolder = (name = 'New Folder') => ({ id: HD.uid(), type: 'folder', name, description: '', items: [], auth: { type: 'inherit' }, preRequestScript: '', testScript: '' });
  HD.newCollection = (name = 'New Collection') => ({ id: HD.uid(), type: 'collection', name, description: '', items: [], variables: [], auth: { type: 'none' }, preRequestScript: '', testScript: '' });
  HD.newEnvironment = (name = 'New Environment') => ({ id: HD.uid(), name, values: [] });

  // ---- Persistence ------------------------------------------------------------------------

  const persist = HD.debounce(async () => {
    try {
      await window.api.saveWorkspace(S.ws);
    } catch (e) {
      if (!/locked/i.test(e.message)) HD.toast(`Could not save workspace: ${e.message}`, 'error');
    }
  }, 400);
  HD.save = () => persist();
  // Saves immediately (used before locking).
  HD.saveNow = () => window.api.saveWorkspace(S.ws);

  HD.load = async () => {
    S.ws = await window.api.loadWorkspace();
    const ws = S.ws;
    ws.collections = ws.collections || [];
    ws.environments = ws.environments || [];
    ws.globals = ws.globals || [];
    ws.history = ws.history || [];
    ws.tabs = ws.tabs || [];
    ws.ui = { sidebarWidth: 300, sidebarTab: 'collections', layout: 'vertical', consoleOpen: false, ...(ws.ui || {}) };
    ws.settings = ws.settings || {};
    ws.settings.proxy = ws.settings.proxy || { enabled: false, host: '', port: 8080 };
  };

  // ---- Tree helpers -----------------------------------------------------------------------

  // Returns { node, collection, parents (folders, outermost first), siblings } or null.
  HD.find = (id) => {
    if (!id) return null;
    for (const col of S.ws.collections) {
      if (col.id === id) return { node: col, collection: col, parents: [], siblings: S.ws.collections };
      const stack = [[col.items, []]];
      while (stack.length) {
        const [items, parents] = stack.pop();
        for (const it of items) {
          if (it.id === id) return { node: it, collection: col, parents, siblings: items };
          if (it.type === 'folder') stack.push([it.items, [...parents, it]]);
        }
      }
    }
    return null;
  };

  HD.walk = (items, fn, parents = []) => {
    for (const it of items) {
      fn(it, parents);
      if (it.type === 'folder') HD.walk(it.items, fn, [...parents, it]);
    }
  };

  HD.countRequests = (node) => {
    let n = 0;
    HD.walk(node.items || [], (it) => { if (it.type === 'request') n++; });
    return n;
  };

  // Deep-copies a node, giving it and its descendants fresh ids.
  HD.duplicate = (node) => {
    const copy = HD.clone(node);
    const ids = new Map();
    const reId = (n) => { const id = HD.uid(); ids.set(n.id, id); n.id = id; (n.items || []).forEach(reId); };
    reId(copy);
    delete copy.team; // a copy of a shared collection starts unshared
    // Auth dependencies that point inside the copy follow it to the copied request.
    const remap = (n) => {
      const dep = n.type === 'request' ? n.request.dependency : n.dependency;
      if (dep && ids.has(dep.requestId)) dep.requestId = ids.get(dep.requestId);
      (n.items || []).forEach(remap);
    };
    remap(copy);
    return copy;
  };

  HD.activeEnvironment = () => S.ws.environments.find((e) => e.id === S.ws.activeEnvironmentId) || null;

  // ---- Variables --------------------------------------------------------------------------

  const listToObject = (list) => {
    const o = {};
    for (const v of list || []) if (v && v.key && v.enabled !== false) o[v.key] = v.value == null ? '' : v.value;
    return o;
  };
  HD.listToObject = listToObject;

  // Builds the variable scopes for a tab's request context.
  HD.scopesFor = (collection) => {
    const env = HD.activeEnvironment();
    return {
      globals: listToObject(S.ws.globals),
      collection: collection ? listToObject(collection.variables) : {},
      environment: env ? listToObject(env.values) : {},
      data: {},
    };
  };

  // Variable info for highlighting/tooltips: name -> { value, scope, secret }.
  HD.variableInfoFor = (collection) => {
    const info = {};
    const add = (list, scope) => { for (const v of list || []) if (v.key && v.enabled !== false) info[v.key] = { value: String(v.value == null ? '' : v.value), scope, secret: !!v.secret }; };
    add(S.ws.globals, 'Global');
    if (collection) add(collection.variables, `Collection: ${collection.name}`);
    const env = HD.activeEnvironment();
    if (env) add(env.values, `Environment: ${env.name}`);
    return info;
  };

  /**
   * Writes script changes to a variable scope back into its [{key, value, enabled}] list.
   * `before` is the object the scripts started from; keys that disappeared were unset by a script.
   * Disabled rows are left alone. Returns true if anything changed.
   */
  HD.applyScope = (list, before, after) => {
    let changed = false;
    const str = (v) => (v == null ? '' : typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v));
    for (const [k, v] of Object.entries(after)) {
      if (Object.prototype.hasOwnProperty.call(before, k) && str(before[k]) === str(v)) continue;
      const row = list.find((r) => r.key === k && r.enabled !== false);
      if (row) row.value = str(v); else list.push({ key: k, value: str(v), enabled: true });
      changed = true;
    }
    for (const k of Object.keys(before)) {
      if (!Object.prototype.hasOwnProperty.call(after, k)) {
        const i = list.findIndex((r) => r.key === k && r.enabled !== false);
        if (i !== -1) { list.splice(i, 1); changed = true; }
      }
    }
    return changed;
  };

  // Applies the scopes returned by the main process to globals, environment and collection.
  HD.applyScopes = (before, after, collection) => {
    let changed = HD.applyScope(S.ws.globals, before.globals, after.globals);
    const env = HD.activeEnvironment();
    if (env) changed = HD.applyScope(env.values, before.environment, after.environment) || changed;
    else if (Object.keys(after.environment).length) {
      HD.toast('A script set environment variables, but no environment is selected.', 'warn');
    }
    if (collection) changed = HD.applyScope(collection.variables, before.collection, after.collection) || changed;
    if (changed) { HD.save(); HD.emit('variables'); }
  };

  // ---- Tiny event bus ---------------------------------------------------------------------

  const listeners = {};
  HD.on = (evt, fn) => { (listeners[evt] = listeners[evt] || []).push(fn); };
  HD.off = (evt, fn) => { listeners[evt] = (listeners[evt] || []).filter((f) => f !== fn); };
  HD.emit = (evt, ...args) => (listeners[evt] || []).forEach((fn) => fn(...args));

  // ---- History ----------------------------------------------------------------------------

  HD.addHistory = (entry) => {
    const ws = S.ws;
    ws.history.unshift({ id: HD.uid(), time: Date.now(), ...entry });
    const limit = ws.settings.historyLimit || 200;
    if (ws.history.length > limit) ws.history.length = limit;
    HD.save();
    HD.emit('history');
  };

  // ---- Console ----------------------------------------------------------------------------

  HD.log = (level, message, extra) => {
    S.consoleLogs.push({ level, message, time: Date.now(), extra });
    if (S.consoleLogs.length > 2000) S.consoleLogs.splice(0, S.consoleLogs.length - 2000);
    HD.emit('console');
  };
})();
