'use strict';

/**
 * Full-workspace backup: create, strip secrets, detect and restore (merge or replace).
 */
const crypto = require('crypto');

const FORMAT = 'httpdash-backup';
const VERSION = 1;
const clone = (o) => JSON.parse(JSON.stringify(o));
const isVarRef = (v) => /^\s*\{\{[^{}]+\}\}\s*$/.test(String(v || ''));

// Auth fields that hold credentials. Values that only reference a variable ({{token}}) are kept.
const SECRET_AUTH_FIELDS = {
  basic: ['password'],
  bearer: ['token'],
  apikey: ['value'],
  digest: ['password'],
  oauth2: ['accessToken', 'refreshToken', 'clientSecret', 'password'],
  awsv4: ['secretKey', 'sessionToken'],
};

function stripAuth(auth) {
  if (!auth || !SECRET_AUTH_FIELDS[auth.type] || !auth[auth.type]) return;
  for (const f of SECRET_AUTH_FIELDS[auth.type]) {
    if (auth[auth.type][f] && !isVarRef(auth[auth.type][f])) auth[auth.type][f] = '';
  }
}

/**
 * Removes credentials from a workspace copy (mutates it):
 * secret variables, variables that hold auth-dependency tokens, literal auth credentials,
 * discovery registry tokens, the proxy password and cookies.
 */
function stripSecrets(ws) {
  const tokenVars = new Set();
  const visit = (node) => {
    const dep = node.type === 'request' ? node.request && node.request.dependency : node.dependency;
    if (dep && dep.mode === 'enabled') {
      tokenVars.add(dep.tokenVar || 'token');
      if (dep.expiryVar) tokenVars.add(dep.expiryVar);
    }
    stripAuth(node.type === 'request' ? node.request && node.request.auth : node.auth);
    for (const ex of node.examples || []) if (ex.request) stripAuth(ex.request.auth);
    (node.items || []).forEach(visit);
  };
  (ws.collections || []).forEach(visit);
  const blank = (list) => (list || []).forEach((v) => { if (v.secret || tokenVars.has(v.key)) v.value = ''; });
  (ws.collections || []).forEach((c) => blank(c.variables));
  (ws.environments || []).forEach((e) => blank(e.values));
  blank(ws.globals);
  for (const h of ws.history || []) if (h.request) stripAuth(h.request.auth);
  for (const s of ws.discoverySources || []) {
    s.token = '';
    for (const hd of s.headers || []) if (/authorization|token|key|secret/i.test(hd.key || '')) hd.value = '';
  }
  if (ws.settings && ws.settings.proxy) ws.settings.proxy.password = '';
  delete ws.cookies;
  return ws;
}

function makeBackup(workspace, cookies, { excludeSecrets = false, appVersion = '' } = {}) {
  const ws = clone({
    collections: workspace.collections || [],
    environments: workspace.environments || [],
    globals: workspace.globals || [],
    history: workspace.history || [],
    discoverySources: workspace.discoverySources || [],
    settings: workspace.settings || {},
    activeEnvironmentId: workspace.activeEnvironmentId || null,
    cookies: cookies || [],
  });
  if (excludeSecrets) stripSecrets(ws);
  return { format: FORMAT, version: VERSION, exportedAt: new Date().toISOString(), app: `HttpDash ${appVersion}`.trim(), secretsIncluded: !excludeSecrets, workspace: ws };
}

const isBackup = (json) => !!json && json.format === FORMAT && json.workspace && typeof json.workspace === 'object';

function summarize(ws) {
  let requests = 0;
  const walk = (n) => { if (n.type === 'request') requests++; (n.items || []).forEach(walk); };
  (ws.collections || []).forEach(walk);
  return {
    collections: (ws.collections || []).length,
    requests,
    environments: (ws.environments || []).length,
    globals: (ws.globals || []).filter((v) => v.key).length,
    history: (ws.history || []).length,
    discoverySources: (ws.discoverySources || []).length,
    cookies: (ws.cookies || []).length,
  };
}

// Gives a collection and everything in it new ids, keeping auth dependencies pointing inside it.
function reIdCollection(col) {
  const ids = new Map();
  const walk = (n) => { const id = crypto.randomUUID(); ids.set(n.id, id); n.id = id; (n.items || []).forEach(walk); };
  walk(col);
  const remap = (n) => {
    const dep = n.type === 'request' ? n.request && n.request.dependency : n.dependency;
    if (dep && ids.has(dep.requestId)) dep.requestId = ids.get(dep.requestId);
    (n.items || []).forEach(remap);
  };
  remap(col);
  return col;
}

/**
 * Restores a backup into the current workspace.
 * mode 'replace': the backup's data replaces collections, environments, globals, history,
 *                 discovery sources and settings.
 * mode 'merge':   adds everything; items whose id already exists are added as copies with new ids
 *                 (" (imported)" appended); globals are added only for keys not already present.
 * Returns { workspace: <fields to assign>, cookies, mode, added: summary }.
 */
function restore(current, backup, mode) {
  if (!isBackup(backup)) throw new Error('Not an HttpDash backup file');
  const b = clone(backup.workspace);
  if (mode === 'replace') {
    return {
      mode,
      workspace: {
        collections: b.collections || [],
        environments: b.environments || [],
        globals: b.globals || [],
        history: b.history || [],
        discoverySources: b.discoverySources || [],
        settings: { ...(current.settings || {}), ...(b.settings || {}) },
        activeEnvironmentId: (b.environments || []).some((e) => e.id === b.activeEnvironmentId) ? b.activeEnvironmentId : null,
      },
      cookies: b.cookies || null,
      added: summarize(b),
    };
  }

  const cur = clone({
    collections: current.collections || [], environments: current.environments || [], globals: current.globals || [],
    history: current.history || [], discoverySources: current.discoverySources || [],
  });
  const added = { collections: 0, requests: 0, environments: 0, globals: 0, history: 0, discoverySources: 0, cookies: (b.cookies || []).length };

  const colIds = new Set(cur.collections.map((c) => c.id));
  for (const col of b.collections || []) {
    if (colIds.has(col.id)) { reIdCollection(col); col.name = `${col.name} (imported)`; }
    cur.collections.push(col);
    added.collections++;
    added.requests += summarize({ collections: [col] }).requests;
  }

  const envIdMap = new Map();
  const envIds = new Set(cur.environments.map((e) => e.id));
  for (const env of b.environments || []) {
    if (envIds.has(env.id)) {
      const id = crypto.randomUUID();
      envIdMap.set(env.id, id);
      env.id = id;
      env.name = `${env.name} (imported)`;
    }
    cur.environments.push(env);
    added.environments++;
  }

  const globalKeys = new Set(cur.globals.map((g) => g.key));
  for (const g of b.globals || []) {
    if (g.key && !globalKeys.has(g.key)) { cur.globals.push(g); added.globals++; }
  }

  const srcIds = new Set(cur.discoverySources.map((s) => s.id));
  for (const s of b.discoverySources || []) {
    if (srcIds.has(s.id)) {
      const oldId = s.id;
      s.id = crypto.randomUUID();
      s.name = `${s.name} (imported)`;
      // Rows the source created in its (copied) environment now belong to the new source id.
      const env = cur.environments.find((e) => e.id === (envIdMap.get(s.environmentId) || s.environmentId));
      if (env) for (const v of env.values || []) if (v.discovered === oldId) v.discovered = s.id;
    }
    if (envIdMap.has(s.environmentId)) s.environmentId = envIdMap.get(s.environmentId);
    cur.discoverySources.push(s);
    added.discoverySources++;
  }

  const histIds = new Set(cur.history.map((x) => x.id));
  for (const hEntry of b.history || []) {
    if (!histIds.has(hEntry.id)) { cur.history.push(hEntry); added.history++; }
  }
  cur.history.sort((x, y) => (y.time || 0) - (x.time || 0));

  return { mode: 'merge', workspace: cur, cookies: b.cookies || null, added };
}

// Cookie jar merge: backup cookies replace same name/domain/path, others are kept.
function mergeCookies(jar, incoming) {
  const key = (c) => `${c.name}\u0000${c.domain}\u0000${c.path}`;
  const map = new Map(jar.map((c) => [key(c), c]));
  for (const c of incoming || []) map.set(key(c), c);
  return [...map.values()];
}

module.exports = { makeBackup, isBackup, restore, stripSecrets, summarize, mergeCookies, FORMAT };
