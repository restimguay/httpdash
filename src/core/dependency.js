'use strict';

/**
 * Auth dependencies: run another request (e.g. "Login") before a request when the
 * token it relies on is missing or expired, and store the token from its response.
 *
 * Config (on a request definition, folder or collection, as `dependency`):
 * {
 *   mode: 'inherit' | 'none' | 'enabled',
 *   requestId,               // request in the same collection to run first
 *   when: 'expired' | 'always',
 *   tokenVar: 'token',       // variable that holds the token
 *   tokenPath: 'access_token', // optional JSON path in the dependency response to store into tokenVar
 *   expiresInPath: 'expires_in', // optional JSON path (seconds) used to compute expiryVar
 *   expiryVar: 'tokenExpiresAt', // optional variable holding the expiry (epoch ms or a date string)
 *   scope: 'environment' | 'collection' | 'globals', // where extracted values are stored
 *   skewSeconds: 30,         // refresh this long before the expiry
 *   retryOn401: true,        // run the dependency and retry once if the request returns 401
 * }
 */
const { mergeScopes } = require('./variables');

const MAX_DEPTH = 3;

// Finds the effective dependency config: request -> nearest folder -> collection.
function effectiveDependency(request, chain) {
  const nodes = [...(chain || [])];
  const own = request && request.dependency;
  if (own && own.mode && own.mode !== 'inherit') return own.mode === 'enabled' ? own : null;
  for (let i = nodes.length - 1; i >= 0; i--) {
    const d = nodes[i] && nodes[i].dependency;
    if (d && d.mode && d.mode !== 'inherit') return d.mode === 'enabled' ? d : null;
  }
  return null;
}

function decodeJwtExpiry(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

function parseExpiry(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (Number.isFinite(n)) return n < 1e11 ? n * 1000 : n; // seconds or milliseconds since epoch
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

/**
 * Returns { valid, reason, expiresAt } for the token described by cfg.
 * reason: 'missing' | 'expired' | 'valid' | 'always'
 */
function tokenState(cfg, vars, now = Date.now()) {
  const token = vars[cfg.tokenVar || 'token'];
  if (token === undefined || token === null || String(token).trim() === '') return { valid: false, reason: 'missing', expiresAt: null };
  const skew = (cfg.skewSeconds == null ? 30 : Number(cfg.skewSeconds)) * 1000;
  let expiresAt = cfg.expiryVar ? parseExpiry(vars[cfg.expiryVar]) : null;
  if (expiresAt === null) expiresAt = decodeJwtExpiry(token);
  if (expiresAt !== null && now >= expiresAt - skew) return { valid: false, reason: 'expired', expiresAt };
  return { valid: true, reason: 'valid', expiresAt };
}

// Reads a value from parsed JSON with a path like "data.tokens[0].access_token".
function getPath(obj, path) {
  if (!path) return undefined;
  const parts = String(path).replace(/\[(\d+)\]/g, '.$1').replace(/^\$\.?/, '').split('.').filter(Boolean);
  let v = obj;
  for (const p of parts) {
    if (v === null || v === undefined) return undefined;
    v = v[p];
  }
  return v;
}

// Stores the token (and expiry) from the dependency's response into the configured scope.
function extractToken(cfg, response, scopes, now = Date.now()) {
  const stored = {};
  if (!cfg.tokenPath && !cfg.expiresInPath) return stored;
  let json;
  try { json = JSON.parse(response.bodyText || ''); } catch { throw new Error('response is not JSON, so the token could not be extracted'); }
  const target = scopes[cfg.scope || 'environment'] || scopes.environment;
  if (cfg.tokenPath) {
    const token = getPath(json, cfg.tokenPath);
    if (token === undefined || token === null || token === '') throw new Error(`no value at "${cfg.tokenPath}" in the response`);
    target[cfg.tokenVar || 'token'] = typeof token === 'string' ? token : JSON.stringify(token);
    stored[cfg.tokenVar || 'token'] = target[cfg.tokenVar || 'token'];
  }
  if (cfg.expiryVar) {
    const expiresIn = cfg.expiresInPath ? Number(getPath(json, cfg.expiresInPath)) : NaN;
    let expiresAt = Number.isFinite(expiresIn) ? now + expiresIn * 1000 : null;
    if (expiresAt === null) expiresAt = decodeJwtExpiry(target[cfg.tokenVar || 'token']);
    if (expiresAt !== null) {
      target[cfg.expiryVar] = String(expiresAt);
      stored[cfg.expiryVar] = target[cfg.expiryVar];
    }
  }
  return stored;
}

/**
 * Runs the dependency if needed. `runRequest(item, chain, ctx)` executes a request and returns
 * the executor result; `lookup(id)` returns { item, chain } for a request in the collection.
 * Mutates `scopes` with the dependency's variable changes. Returns a run record or null.
 */
async function runDependency({ cfg, scopes, lookup, runRequest, selfId, depth = 0, force = false, reasonOverride, log }) {
  if (!cfg || !cfg.requestId || !lookup) return null;
  if (cfg.requestId === selfId) return null; // The auth request never depends on itself.
  const state = tokenState(cfg, mergeScopes(scopes));
  const reason = reasonOverride || (cfg.when === 'always' ? 'always' : state.reason);
  if (!force && cfg.when !== 'always' && state.valid) return null;

  const target = lookup(cfg.requestId);
  if (!target) {
    return { name: '(missing request)', reason, error: 'The auth dependency points to a request that no longer exists.' };
  }
  if (depth >= MAX_DEPTH) {
    return { name: target.item.name, reason, error: `Auth dependencies are nested more than ${MAX_DEPTH} levels deep.` };
  }
  if (log) log('info', `Running auth dependency "${target.item.name}" (${reasonText(reason)})`);
  const res = await runRequest(target.item, target.chain, depth + 1);
  for (const k of ['globals', 'collection', 'environment']) {
    for (const key of Object.keys(scopes[k])) delete scopes[k][key];
    Object.assign(scopes[k], res.scopes[k]);
  }
  const record = {
    id: target.item.id,
    name: target.item.name,
    reason,
    status: res.response ? res.response.status : null,
    statusText: res.response ? res.response.statusText : '',
    time: res.response ? res.response.time : 0,
    url: res.sentRequest ? res.sentRequest.url : '',
    method: res.sentRequest ? res.sentRequest.method : target.item.request.method,
    tests: res.tests,
    stored: {},
    error: res.error || null,
  };
  if (!record.error && res.response && res.response.status >= 400) {
    record.error = `returned ${res.response.status} ${res.response.statusText}`;
  }
  if (!record.error && res.response) {
    try {
      record.stored = extractToken(cfg, res.response, scopes);
    } catch (e) {
      record.error = e.message;
    }
  }
  if (!record.error) {
    const after = tokenState(cfg, mergeScopes(scopes));
    if (!after.valid && after.reason === 'missing') {
      record.error = `the variable "${cfg.tokenVar || 'token'}" is still empty. Set "Save token from" or store it in the dependency's test script.`;
    }
  }
  if (log) log(record.error ? 'error' : 'info', `Auth dependency "${record.name}" ${record.error ? `failed: ${record.error}` : `finished: ${record.status} ${record.statusText}`}`);
  return record;
}

function reasonText(reason) {
  return { missing: 'token missing', expired: 'token expired', always: 'runs before every request', 401: 'request returned 401' }[reason] || reason;
}

// Builds a lookup over a collection: id -> { item, chain: [collection, ...folders] }.
function makeLookup(collection) {
  const map = new Map();
  if (!collection) return () => null;
  const walk = (items, chain) => {
    for (const it of items || []) {
      if (it.type === 'folder') walk(it.items, [...chain, it]);
      else map.set(it.id, { item: it, chain });
    }
  };
  walk(collection.items, [collection]);
  return (id) => map.get(id) || null;
}

module.exports = { effectiveDependency, tokenState, extractToken, runDependency, makeLookup, getPath, decodeJwtExpiry, reasonText };
