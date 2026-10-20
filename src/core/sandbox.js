'use strict';

/**
 * Runs pre-request and test scripts with a Postman-compatible `pm` API.
 *
 * Note: node:vm is not a security boundary. Scripts run with the same trust as
 * the user who wrote or imported them, just like in Postman.
 */
const vm = require('vm');
const util = require('util');
const chai = require('chai');
const CryptoJS = require('./crypto-shim');
const { resolve, mergeScopes } = require('./variables');

const SCRIPT_TIMEOUT_MS = 30000;

// ---- Property lists (headers, query params) -------------------------------------------------

class PropertyList {
  constructor(items, onChange) {
    this._items = items;
    this._onChange = onChange || (() => {});
  }
  _find(key) {
    const lower = String(key).toLowerCase();
    return this._items.find((i) => String(i.key).toLowerCase() === lower && i.enabled !== false);
  }
  get(key) { const i = this._find(key); return i ? i.value : undefined; }
  has(key, value) { const i = this._find(key); return !!i && (value === undefined || i.value === value); }
  add(item) { this._items.push(normalizeItem(item)); this._onChange(); }
  upsert(item) {
    const n = normalizeItem(item);
    const existing = this._find(n.key);
    if (existing) existing.value = n.value; else this._items.push(n);
    this._onChange();
  }
  remove(predicate) {
    const fn = typeof predicate === 'function' ? predicate : (i) => String(i.key).toLowerCase() === String(predicate).toLowerCase();
    for (let i = this._items.length - 1; i >= 0; i--) if (fn(this._items[i])) this._items.splice(i, 1);
    this._onChange();
  }
  clear() { this._items.splice(0); this._onChange(); }
  each(fn) { this._items.filter((i) => i.enabled !== false).forEach(fn); }
  map(fn) { return this._items.filter((i) => i.enabled !== false).map(fn); }
  filter(fn) { return this._items.filter((i) => i.enabled !== false).filter(fn); }
  all() { return this._items.filter((i) => i.enabled !== false); }
  count() { return this.all().length; }
  toObject() {
    const o = {};
    this.each((i) => { o[i.key] = i.value; });
    return o;
  }
  toJSON() { return this.all(); }
}

function normalizeItem(item) {
  if (typeof item === 'string') {
    const idx = item.indexOf(':');
    return { key: item.slice(0, idx).trim(), value: item.slice(idx + 1).trim(), enabled: true };
  }
  return { key: item.key, value: item.value == null ? '' : String(item.value), enabled: item.disabled ? false : true };
}

// ---- Variable scopes ------------------------------------------------------------------------

function makeScope(store, name, allScopes) {
  return {
    name,
    get: (k) => store[k],
    set: (k, v) => { store[k] = v; },
    unset: (k) => { delete store[k]; },
    has: (k) => Object.prototype.hasOwnProperty.call(store, k),
    clear: () => { for (const k of Object.keys(store)) delete store[k]; },
    toObject: () => ({ ...store }),
    replaceIn: (s) => resolve(s, mergeScopes(allScopes)),
  };
}

// ---- pm.request ---------------------------------------------------------------------------

function makeRequestApi(req) {
  req.headers = req.headers || [];
  const headers = new PropertyList(req.headers);

  const parseQuery = () => {
    const q = req.url.indexOf('?');
    if (q === -1) return [];
    return req.url.slice(q + 1).split('&').filter(Boolean).map((p) => {
      const i = p.indexOf('=');
      return { key: decodeSafe(i === -1 ? p : p.slice(0, i)), value: i === -1 ? '' : decodeSafe(p.slice(i + 1)), enabled: true };
    });
  };
  const writeQuery = (items) => {
    const base = req.url.split('?')[0];
    const qs = items.filter((i) => i.enabled !== false).map((i) => `${encodeURIComponent(i.key)}=${encodeURIComponent(i.value)}`).join('&');
    req.url = qs ? `${base}?${qs}` : base;
    req.params = items.map((i) => ({ key: i.key, value: i.value, enabled: true }));
  };

  const urlApi = {
    toString: () => req.url,
    getHost: () => { try { return new URL(req.url).hostname; } catch { return ''; } },
    getPath: () => { try { return new URL(req.url).pathname; } catch { return ''; } },
    getQueryString: () => (req.url.split('?')[1] || ''),
    update: (s) => { req.url = String(s); },
    get query() {
      const items = parseQuery();
      return new PropertyList(items, () => writeQuery(items));
    },
  };

  return {
    get url() { return urlApi; },
    set url(v) { req.url = String(v); },
    get method() { return req.method; },
    set method(v) { req.method = String(v).toUpperCase(); },
    headers,
    get body() {
      const b = req.body || { mode: 'none' };
      return {
        mode: b.mode,
        raw: b.raw,
        get urlencoded() { b.urlencoded = b.urlencoded || []; return new PropertyList(b.urlencoded); },
        get formdata() { b.formdata = b.formdata || []; return new PropertyList(b.formdata); },
        graphql: b.graphql,
        toString: () => (b.mode === 'raw' ? b.raw || '' : ''),
        update: (v) => {
          req.body = req.body || {};
          if (typeof v === 'string') { req.body.mode = 'raw'; req.body.raw = v; } else Object.assign(req.body, v);
        },
      };
    },
    set body(v) { req.body = v; },
    get auth() { return req.auth; },
    addHeader: (h) => headers.add(h),
    removeHeader: (k) => headers.remove(k),
    upsertHeader: (h) => headers.upsert(h),
    toJSON: () => req,
  };
}

function decodeSafe(s) {
  try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; }
}

// ---- pm.response --------------------------------------------------------------------------

class PmResponse {
  constructor(res) {
    this._res = res;
    this.code = res.status;
    this.status = res.statusText;
    this.responseTime = res.time;
    this.responseSize = res.size;
    this.headers = new PropertyList((res.headers || []).map(([key, value]) => ({ key, value, enabled: true })));
  }
  text() { return this._res.bodyText != null ? this._res.bodyText : ''; }
  json() { return JSON.parse(this.text()); }
  reason() { return this.status; }
  // Enables Postman-style assertions: pm.response.to.have.status(200)
  get to() { return chai.expect(this).to; }
  get not() { return chai.expect(this).not; }
}

let chaiExtended = false;
function extendChai() {
  if (chaiExtended) return;
  chaiExtended = true;
  chai.use((_chai, utils) => {
    const { Assertion } = _chai;
    const isResp = (o) => o instanceof PmResponse;

    Assertion.addMethod('status', function (expected) {
      const r = this._obj;
      if (typeof expected === 'number') {
        this.assert(r.code === expected, `expected response to have status code #{exp} but got #{act}`, `expected response to not have status code #{act}`, expected, r.code);
      } else {
        this.assert(r.status === expected, `expected response to have status reason #{exp} but got #{act}`, `expected response to not have status reason #{act}`, expected, r.status);
      }
    });
    Assertion.addMethod('header', function (name, value) {
      const r = this._obj;
      const has = r.headers.has(name);
      if (value === undefined) {
        this.assert(has, `expected response to have header ${name}`, `expected response to not have header ${name}`);
      } else {
        const actual = r.headers.get(name);
        this.assert(actual === value, `expected response header ${name} to be #{exp} but got #{act}`, `expected response header ${name} to not be #{exp}`, value, actual);
      }
    });
    Assertion.addMethod('body', function (expected) {
      const r = this._obj;
      const text = r.text();
      if (expected === undefined) this.assert(text.length > 0, 'expected response to have a body', 'expected response to not have a body');
      else if (expected instanceof RegExp) this.assert(expected.test(text), `expected response body to match ${expected}`, `expected response body to not match ${expected}`);
      else if (typeof expected === 'string') this.assert(text === expected, 'expected response body to equal #{exp}', 'expected response body to not equal #{exp}', expected, text);
      else new Assertion(r.json()).to.deep.equal(expected);
    });
    Assertion.addMethod('jsonBody', function (path, value) {
      const r = this._obj;
      let json;
      try { json = r.json(); } catch { this.assert(false, 'expected response body to be valid JSON'); }
      if (path === undefined) return;
      if (typeof path === 'object') { new Assertion(json).to.deep.equal(path); return; }
      const got = String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), json);
      if (value === undefined) this.assert(got !== undefined, `expected response JSON to have path ${path}`, `expected response JSON to not have path ${path}`);
      else new Assertion(got).to.deep.equal(value);
    });
    Assertion.addMethod('jsonSchema', function (schema) {
      const errors = validateSchema(this._obj instanceof PmResponse ? this._obj.json() : this._obj, schema, '$');
      this.assert(errors.length === 0, `expected data to satisfy schema but found errors: ${errors.join('; ')}`, 'expected data to not satisfy schema');
    });

    const statusProp = (name, test, label) => {
      Assertion.overwriteProperty(name, (_super) => function () {
        if (isResp(this._obj)) {
          const c = this._obj.code;
          this.assert(test(c), `expected response to be ${label} but got status ${c}`, `expected response to not be ${label}`);
        } else _super.call(this);
      });
    };
    statusProp('ok', (c) => c === 200, 'ok (200)');
    for (const [name, test, label] of [
      ['success', (c) => c >= 200 && c < 300, '2XX'],
      ['info', (c) => c >= 100 && c < 200, '1XX'],
      ['redirection', (c) => c >= 300 && c < 400, '3XX'],
      ['clientError', (c) => c >= 400 && c < 500, '4XX'],
      ['serverError', (c) => c >= 500, '5XX'],
      ['error', (c) => c >= 400, '4XX or 5XX'],
      ['accepted', (c) => c === 202, '202'],
      ['badRequest', (c) => c === 400, '400'],
      ['unauthorized', (c) => c === 401, '401'],
      ['forbidden', (c) => c === 403, '403'],
      ['notFound', (c) => c === 404, '404'],
      ['rateLimited', (c) => c === 429, '429'],
    ]) {
      Assertion.addProperty(name, function () {
        const c = this._obj.code;
        this.assert(test(c), `expected response to be ${label} but got status ${c}`, `expected response to not be ${label}`);
      });
    }
    Assertion.addProperty('json', function () {
      let ok = true;
      try { this._obj.json(); } catch { ok = false; }
      this.assert(ok, 'expected response body to be JSON', 'expected response body to not be JSON');
    });
    Assertion.addProperty('withBody', function () {
      this.assert(this._obj.text().length > 0, 'expected response to have a body', 'expected response to not have a body');
    });
    utils.addProperty(Assertion.prototype, 'response', function () { return this; });
  });
}

// Minimal JSON Schema validator (type, properties, required, items, enum, min/max, pattern).
function validateSchema(data, schema, path) {
  const errors = [];
  if (!schema || typeof schema !== 'object') return errors;
  const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
  if (schema.type) {
    const types = [].concat(schema.type);
    const t = typeOf(data);
    if (!types.some((x) => x === t || (x === 'number' && t === 'integer'))) {
      errors.push(`${path} should be ${types.join('|')} but is ${t}`);
      return errors;
    }
  }
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(data))) errors.push(`${path} should be one of ${JSON.stringify(schema.enum)}`);
  if (typeof data === 'number') {
    if (schema.minimum !== undefined && data < schema.minimum) errors.push(`${path} should be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && data > schema.maximum) errors.push(`${path} should be <= ${schema.maximum}`);
  }
  if (typeof data === 'string') {
    if (schema.minLength !== undefined && data.length < schema.minLength) errors.push(`${path} should have length >= ${schema.minLength}`);
    if (schema.maxLength !== undefined && data.length > schema.maxLength) errors.push(`${path} should have length <= ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(data)) errors.push(`${path} should match ${schema.pattern}`);
  }
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    for (const r of schema.required || []) if (!(r in data)) errors.push(`${path}.${r} is required`);
    for (const [k, sub] of Object.entries(schema.properties || {})) {
      if (k in data) errors.push(...validateSchema(data[k], sub, `${path}.${k}`));
    }
  }
  if (Array.isArray(data)) {
    if (schema.minItems !== undefined && data.length < schema.minItems) errors.push(`${path} should have >= ${schema.minItems} items`);
    if (schema.maxItems !== undefined && data.length > schema.maxItems) errors.push(`${path} should have <= ${schema.maxItems} items`);
    if (schema.items) data.forEach((d, i) => errors.push(...validateSchema(d, schema.items, `${path}[${i}]`)));
  }
  return errors;
}

// ---- Runner -------------------------------------------------------------------------------

/**
 * ctx: {
 *   event: 'prerequest' | 'test',
 *   scopes: { globals, collection, environment, data, local } (mutated in place),
 *   request: request definition (mutated in place by pre-request scripts),
 *   response: { status, statusText, headers, bodyText, time, size } (test scripts only),
 *   cookies: cookie jar array,
 *   info: { requestName, requestId, iteration, iterationCount },
 *   sendRequest: async (req) => response,
 *   log: (level, message) => void,
 * }
 */
async function runScript(code, ctx) {
  extendChai();
  const result = { tests: [], error: null, nextRequest: undefined, visualizer: null };
  if (!code || !code.trim()) return result;

  const pending = new Set();
  const track = (p) => {
    pending.add(p);
    p.finally(() => pending.delete(p));
    return p;
  };
  const timers = new Set();
  const log = (level) => (...args) => ctx.log && ctx.log(level, args.map(formatArg).join(' '));

  const scopes = ctx.scopes;
  const environment = makeScope(scopes.environment, 'environment', scopes);
  const globals = makeScope(scopes.globals, 'globals', scopes);
  const collectionVariables = makeScope(scopes.collection, 'collection', scopes);
  const iterationData = makeScope(scopes.data, 'data', scopes);
  const local = makeScope(scopes.local, 'local', scopes);
  const variables = {
    ...local,
    get: (k) => mergeScopes(scopes)[k],
    has: (k) => k in mergeScopes(scopes),
    toObject: () => mergeScopes(scopes),
    replaceIn: (s) => resolve(s, mergeScopes(scopes)),
  };

  const response = ctx.response ? new PmResponse(ctx.response) : null;
  const requestApi = makeRequestApi(ctx.request);

  const test = (name, fn) => {
    const entry = { name: String(name), passed: true, skipped: false, error: null };
    result.tests.push(entry);
    try {
      const out = fn && fn();
      if (out && typeof out.then === 'function') {
        track(Promise.resolve(out).catch((e) => { entry.passed = false; entry.error = e && e.message ? e.message : String(e); }));
      }
    } catch (e) {
      entry.passed = false;
      entry.error = e && e.message ? e.message : String(e);
    }
  };
  test.skip = (name) => result.tests.push({ name: String(name), passed: true, skipped: true, error: null });

  const cookieApi = {
    get: (name) => { const c = (ctx.cookies || []).find((x) => x.name === name); return c ? c.value : undefined; },
    has: (name) => (ctx.cookies || []).some((x) => x.name === name),
    toObject: () => Object.fromEntries((ctx.cookies || []).map((c) => [c.name, c.value])),
    all: () => (ctx.cookies || []).slice(),
  };

  const sendRequest = (req, cb) => {
    const p = Promise.resolve().then(() => ctx.sendRequest(typeof req === 'string' ? { url: req, method: 'GET' } : req));
    const wrapped = p.then(
      (res) => { const r = new PmResponse(res); if (cb) safeCallback(() => cb(null, r)); return r; },
      (err) => { if (cb) safeCallback(() => cb(err, null)); else throw err; },
    );
    return track(wrapped);
  };
  const safeCallback = (fn) => {
    try { fn(); } catch (e) { result.error = result.error || (e && e.message) || String(e); log('error')(e && e.stack ? e.stack : String(e)); }
  };

  const pm = {
    info: { eventName: ctx.event, iteration: ctx.info.iteration || 0, iterationCount: ctx.info.iterationCount || 1, requestName: ctx.info.requestName, requestId: ctx.info.requestId },
    environment,
    globals,
    collectionVariables,
    iterationData,
    variables,
    request: requestApi,
    response,
    cookies: cookieApi,
    test,
    expect: chai.expect,
    sendRequest,
    setNextRequest: (name) => { result.nextRequest = name; },
    execution: { setNextRequest: (name) => { result.nextRequest = name; }, skipRequest: () => { result.skipRequest = true; } },
    visualizer: { set: (template, data) => { result.visualizer = { template: String(template), data: data || {} }; }, clear: () => { result.visualizer = null; } },
  };

  const legacyTests = {};
  const sandbox = {
    pm,
    postman: {
      setEnvironmentVariable: environment.set,
      getEnvironmentVariable: environment.get,
      clearEnvironmentVariable: environment.unset,
      setGlobalVariable: globals.set,
      getGlobalVariable: globals.get,
      clearGlobalVariable: globals.unset,
      setNextRequest: pm.setNextRequest,
      getResponseHeader: (k) => (response ? response.headers.get(k) : undefined),
    },
    tests: legacyTests,
    environment: scopes.environment,
    globals: scopes.globals,
    data: scopes.data,
    iteration: pm.info.iteration,
    request: { url: ctx.request.url, method: ctx.request.method, headers: Object.fromEntries((ctx.request.headers || []).map((h) => [h.key, h.value])) },
    responseBody: response ? response.text() : undefined,
    responseCode: response ? { code: response.code, name: response.status } : undefined,
    responseTime: response ? response.responseTime : undefined,
    responseHeaders: response ? response.headers.toObject() : undefined,
    console: { log: log('log'), info: log('info'), warn: log('warn'), error: log('error'), debug: log('debug') },
    CryptoJS,
    require: (name) => {
      if (name === 'chai') return chai;
      if (name === 'crypto-js') return CryptoJS;
      if (name === 'util') return util;
      if (name === 'url') return { URL, URLSearchParams };
      throw new Error(`Module '${name}' is not available in the sandbox`);
    },
    setTimeout: (fn, ms, ...args) => {
      let handle;
      const p = new Promise((res) => {
        handle = setTimeout(() => { timers.delete(handle); safeCallback(() => fn(...args)); res(); }, ms);
      });
      timers.add(handle);
      track(p);
      return handle;
    },
    clearTimeout: (h) => { clearTimeout(h); timers.delete(h); },
    atob: (s) => Buffer.from(String(s), 'base64').toString('latin1'),
    btoa: (s) => Buffer.from(String(s), 'latin1').toString('base64'),
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    Buffer,
  };

  try {
    const context = vm.createContext(sandbox);
    new vm.Script(code, { filename: `${ctx.event}-script.js` }).runInContext(context, { timeout: SCRIPT_TIMEOUT_MS });
    const deadline = Date.now() + SCRIPT_TIMEOUT_MS;
    while (pending.size) {
      if (Date.now() > deadline) throw new Error('Script timed out waiting for async operations');
      await Promise.race([Promise.allSettled([...pending]), new Promise((r) => setTimeout(r, 100))]);
    }
  } catch (e) {
    result.error = e && e.message ? e.message : String(e);
    log('error')(`${ctx.event === 'test' ? 'Test' : 'Pre-request'} script error: ${result.error}`);
  } finally {
    for (const t of timers) clearTimeout(t);
  }

  for (const [name, passed] of Object.entries(legacyTests)) {
    result.tests.push({ name, passed: !!passed, skipped: false, error: passed ? null : 'Assertion failed' });
  }
  return result;
}

function formatArg(a) {
  if (typeof a === 'string') return a;
  if (a instanceof PmResponse) return `Response ${a.code} ${a.status}`;
  return util.inspect(a, { depth: 4, breakLength: 120 });
}

module.exports = { runScript, PropertyList, validateSchema };
