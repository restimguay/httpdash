'use strict';

/**
 * Runs pre-request and test scripts with a Postman-compatible `pm` API, inside QuickJS: a separate
 * JavaScript engine compiled to WebAssembly. A script can't reach Node, the file system, other
 * processes or HttpDash itself. It only has the API in sandbox-guest.js, which talks to the outside
 * through the host functions below, and its results come back as plain JSON.
 *
 * Scripts run in a session: one QuickJS runtime for one request (with its collection and folder
 * scripts and auth dependencies) or one collection run. The session loads the shared parts once,
 * and every script gets a fresh context with its own globals, limited in time, memory and stack.
 */
const fs = require('fs');
const crypto = require('crypto');
const { newQuickJSWASMModuleFromVariant, shouldInterruptAfterDeadline } = require('quickjs-emscripten-core');
const releaseVariant = require('@jitl/quickjs-wasmfile-release-sync');
const { resolve } = require('./variables');

const SCRIPT_TIMEOUT_MS = 30000;
const MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;
const STACK_LIMIT_BYTES = 1024 * 1024;
const MAX_PENDING_OPS = 500;
const HASHES = new Set(['md5', 'sha1', 'sha224', 'sha256', 'sha384', 'sha512']);
const URL_SETTERS = new Set(['href', 'protocol', 'username', 'password', 'host', 'hostname', 'port', 'pathname', 'search', 'hash']);

let quickjs;
const loadQuickJS = () => quickjs || (quickjs = newQuickJSWASMModuleFromVariant(releaseVariant.default || releaseVariant));
let sources;
const loadSources = () => sources || (sources = {
  guest: fs.readFileSync(require.resolve('./sandbox-guest.js'), 'utf8'),
  chai: fs.readFileSync(require.resolve('./vendor/chai.min.js'), 'utf8'),
});

// Evaluated once per session in the library context. The host functions are passed through a
// temporary global and removed at once.
const boot = (guest) => `(function (host) {
  delete globalThis.__host;
  ${guest}
  return createSandbox(host);
})(globalThis.__host)`;

const toJSON = (url) => JSON.stringify({
  href: url.href, origin: url.origin, protocol: url.protocol, username: url.username, password: url.password,
  host: url.host, hostname: url.hostname, port: url.port, pathname: url.pathname, search: url.search, hash: url.hash,
});

// Copies JSON data into an existing object, keeping its identity (callers hold references to it).
// Keys are defined rather than assigned, so a "__proto__" key can't change the object's prototype.
function replaceContents(target, source) {
  for (const k of Object.keys(target)) delete target[k];
  if (!source || typeof source !== 'object') return;
  for (const k of Object.keys(source)) Object.defineProperty(target, k, { value: source[k], enumerable: true, writable: true, configurable: true });
}

function syncScopes(target, source) {
  if (!source || typeof source !== 'object') return;
  for (const name of Object.keys(target)) if (source[name] && typeof source[name] === 'object') replaceContents(target[name], source[name]);
}

const errorMessage = (err) => (err && typeof err === 'object' && 'message' in err ? String(err.message) : String(err));

class ScriptSession {
  /** opts: { timeoutMs, memoryLimitBytes } to lower the limits (used by tests). */
  constructor(opts = {}) {
    this.timeoutMs = opts.timeoutMs || SCRIPT_TIMEOUT_MS;
    this.memoryLimit = opts.memoryLimitBytes || MEMORY_LIMIT_BYTES;
    this.current = null; // the script that is running: { ctx, pending }
    this.ready = null;
  }

  // Creates the runtime and the library context, with the shared parts of the sandbox.
  async init() {
    const QuickJS = await loadQuickJS();
    const src = loadSources();
    const runtime = QuickJS.newRuntime();
    runtime.setMemoryLimit(this.memoryLimit);
    runtime.setMaxStackSize(STACK_LIMIT_BYTES);
    runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + 5000));
    const lib = runtime.newContext();
    const cur = () => {
      if (!this.current) throw new Error('No script is running');
      return this.current;
    };
    // Host functions. They only receive and return strings and numbers.
    const hostApi = {
      log: (level, message) => { const { ctx } = cur(); if (ctx.log) ctx.log(String(level), String(message)); },
      resolve: (s, vars) => String(resolve(String(s), JSON.parse(vars))),
      hash: (alg, dataB64) => {
        if (!HASHES.has(alg)) throw new Error(`Unsupported hash: ${alg}`);
        return crypto.createHash(alg).update(Buffer.from(String(dataB64), 'base64')).digest('base64');
      },
      hmac: (alg, dataB64, keyB64) => {
        if (!HASHES.has(alg)) throw new Error(`Unsupported hash: ${alg}`);
        return crypto.createHmac(alg, Buffer.from(String(keyB64), 'base64')).update(Buffer.from(String(dataB64), 'base64')).digest('base64');
      },
      randomBytes: (n) => crypto.randomBytes(Math.min(Math.max(Number(n) || 0, 0), 65536)).toString('base64'),
      parseUrl: (url, base) => {
        try { return toJSON(base ? new URL(String(url), String(base)) : new URL(String(url))); } catch { throw new TypeError(`Invalid URL: ${url}`); }
      },
      setUrl: (href, prop, value) => {
        if (!URL_SETTERS.has(prop)) throw new Error(`Cannot set URL.${prop}`);
        const url = new URL(String(href));
        url[prop] = String(value);
        return toJSON(url);
      },
      chaiSource: () => src.chai,
      send: (id, payload) => {
        const { ctx, pending } = cur();
        if (pending.size >= MAX_PENDING_OPS) throw new Error('Too many requests in progress');
        const { request, scopes } = JSON.parse(payload);
        syncScopes(ctx.scopes, scopes);
        const promise = Promise.resolve()
          .then(() => ctx.sendRequest(request))
          .then(
            (res) => ({ id, ok: true, value: JSON.stringify({ status: res.status, statusText: res.statusText, headers: res.headers, bodyText: res.bodyText, time: res.time, size: res.size }) }),
            (err) => ({ id, ok: false, value: (err && err.message) || String(err) }),
          );
        pending.set(id, { promise });
      },
      sleep: (id, ms) => {
        const { pending } = cur();
        if (pending.size >= MAX_PENDING_OPS) throw new Error('Too many timers');
        let timer;
        const promise = new Promise((done) => { timer = setTimeout(() => done({ id, ok: true, value: '' }), Math.min(Math.max(Number(ms) || 0, 0), this.timeoutMs)); });
        pending.set(id, { promise, cancel: () => clearTimeout(timer) });
      },
      cancel: (id) => {
        const { pending } = cur();
        const op = pending.get(id);
        if (op && op.cancel) { op.cancel(); pending.delete(id); }
      },
    };
    const hostObj = lib.newObject();
    for (const [name, fn] of Object.entries(hostApi)) {
      const fnHandle = lib.newFunction(name, (...args) => {
        const out = fn(...args.map((h) => lib.dump(h)));
        return out === undefined ? undefined : lib.newString(out);
      });
      lib.setProp(hostObj, name, fnHandle);
      fnHandle.dispose();
    }
    lib.setProp(lib.global, '__host', hostObj);
    hostObj.dispose();
    const booted = lib.evalCode(boot(src.guest), 'sandbox-boot.js');
    if (booted.error) {
      const err = lib.dump(booted.error);
      booted.error.dispose();
      lib.dispose();
      runtime.dispose();
      throw new Error(`Script sandbox failed to start: ${errorMessage(err)}`);
    }
    this.runtime = runtime;
    this.lib = lib;
    this.api = booted.value;
    this.createScript = lib.getProp(this.api, 'createScript');
    this.complete = lib.getProp(this.api, 'complete');
  }

  /** Runs one script. ctx: see runScript. Returns { tests, error, nextRequest, visualizer, skipRequest }. */
  async run(code, ctx) {
    const result = { tests: [], error: null, nextRequest: undefined, visualizer: null };
    if (!code || !code.trim()) return result;
    if (!this.ready) this.ready = this.init();
    await this.ready;
    const { runtime, lib } = this;
    const log = (level, message) => ctx.log && ctx.log(level, message);
    const deadline = Date.now() + this.timeoutMs;
    runtime.setInterruptHandler(shouldInterruptAfterDeadline(deadline));

    const pending = new Map(); // op id -> { promise, cancel }
    this.current = { ctx, pending };
    const handles = [];
    let scriptError = null;
    let broken = false; // the runtime is in an unknown state and must not be reused
    const fail = (err) => {
      let msg = errorMessage(err);
      if (msg === 'interrupted') { broken = true; msg = `Script timed out after ${this.timeoutMs / 1000} seconds`; }
      else if (/out of memory/i.test(msg)) { broken = true; msg = `Script ran out of memory (limit ${Math.round(this.memoryLimit / 1024 / 1024)} MB)`; }
      scriptError = scriptError || msg;
    };
    const call = (fn, ...args) => {
      const r = lib.callFunction(fn, lib.undefined, ...args);
      if (r.error) { const err = lib.dump(r.error); r.error.dispose(); throw Object.assign(new Error(errorMessage(err)), { fromScript: true }); }
      return r.value;
    };

    let scriptCtx;
    try {
      // The script's globals are built in the library context, then placed in a fresh context.
      const input = lib.newString(JSON.stringify({
        event: ctx.event,
        scopes: ctx.scopes,
        request: ctx.request,
        response: ctx.response ? {
          status: ctx.response.status, statusText: ctx.response.statusText, headers: ctx.response.headers,
          bodyText: ctx.response.bodyText, time: ctx.response.time, size: ctx.response.size,
        } : null,
        cookies: ctx.cookies || [],
        info: ctx.info || {},
      }));
      const script = call(this.createScript, input);
      input.dispose();
      handles.push(script);
      const globals = lib.getProp(script, 'globals');
      const namesHandle = lib.getProp(script, 'names');
      const finishFn = lib.getProp(script, 'finish');
      handles.push(globals, namesHandle, finishFn);
      scriptCtx = runtime.newContext();
      for (const name of lib.dump(namesHandle)) {
        const value = lib.getProp(globals, name);
        scriptCtx.setProp(scriptCtx.global, name, value);
        value.dispose();
      }

      // Run the script, then keep running promise jobs until no host call is left in progress.
      const ran = scriptCtx.evalCode(code, `${ctx.event}-script.js`);
      if (ran.error) { fail(scriptCtx.dump(ran.error)); ran.error.dispose(); } else ran.value.dispose();

      for (;;) {
        const jobs = runtime.executePendingJobs();
        if (jobs.error) { fail(lib.dump(jobs.error)); jobs.error.dispose(); }
        if (!pending.size || broken) break;
        const remaining = deadline - Date.now();
        if (remaining <= 0) { fail(new Error('Script timed out waiting for async operations')); break; }
        let timer;
        const done = await Promise.race([
          ...[...pending.values()].map((op) => op.promise),
          new Promise((r) => { timer = setTimeout(() => r(null), remaining); }),
        ]);
        clearTimeout(timer);
        if (!done || !pending.has(done.id)) continue;
        pending.delete(done.id);
        const args = [lib.newNumber(done.id), done.ok ? lib.true : lib.false, lib.newString(done.value)];
        try { call(this.complete, ...args).dispose(); } catch (e) { fail(e); }
        args[0].dispose();
        args[2].dispose();
      }

      // Collect the results, with a short new deadline in case the script used up its time.
      runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + 2000));
      const finished = call(finishFn);
      const out = JSON.parse(lib.getString(finished));
      finished.dispose();
      syncScopes(ctx.scopes, out.scopes);
      if (ctx.request && out.request) replaceContents(ctx.request, out.request);
      const r = out.result || {};
      result.tests = (Array.isArray(r.tests) ? r.tests : []).map((t) => ({
        name: String(t.name), passed: !!t.passed, skipped: !!t.skipped, error: t.error == null ? null : String(t.error),
      }));
      result.error = r.error == null ? null : String(r.error);
      if (r.nextRequest !== undefined) result.nextRequest = r.nextRequest === null ? null : String(r.nextRequest);
      if (r.visualizer) result.visualizer = { template: String(r.visualizer.template), data: r.visualizer.data || {} };
      if (r.skipRequest) result.skipRequest = true;
    } catch (e) {
      fail(e);
      if (!e.fromScript) broken = true;
    } finally {
      for (const op of pending.values()) if (op.cancel) op.cancel();
      for (const h of handles) if (h.alive) h.dispose();
      if (scriptCtx) { try { scriptCtx.dispose(); } catch { broken = true; } }
      this.current = null;
      if (broken) this.reset();
    }

    if (scriptError) {
      result.error = scriptError;
      log('error', `${ctx.event === 'test' ? 'Test' : 'Pre-request'} script error: ${scriptError}`);
    }
    return result;
  }

  // Throws the runtime away; the next script starts a new one.
  reset() {
    const { runtime, lib } = this;
    this.ready = null;
    this.runtime = null;
    this.lib = null;
    try {
      for (const h of [this.createScript, this.complete, this.api]) if (h && h.alive) h.dispose();
      if (lib) lib.dispose();
      if (runtime) runtime.dispose();
    } catch { /* leftover objects from an interrupted script; the memory goes with the runtime */ }
  }

  dispose() { if (this.ready) this.reset(); }
}

/**
 * Runs one script.
 * ctx: {
 *   event: 'prerequest' | 'test',
 *   scopes: { globals, collection, environment, data, local } (updated in place),
 *   request: request definition (updated in place by pre-request scripts),
 *   response: { status, statusText, headers, bodyText, time, size } (test scripts only),
 *   cookies: cookie jar array,
 *   info: { requestName, requestId, iteration, iterationCount },
 *   sendRequest: async (req) => response,
 *   log: (level, message) => void,
 *   session: a ScriptSession to reuse (otherwise one is made for this script),
 *   timeoutMs, memoryLimitBytes: optional, to lower the limits when no session is given (tests),
 * }
 */
async function runScript(code, ctx) {
  if (ctx.session) return ctx.session.run(code, ctx);
  if (!code || !code.trim()) return { tests: [], error: null, nextRequest: undefined, visualizer: null };
  const session = new ScriptSession({ timeoutMs: ctx.timeoutMs, memoryLimitBytes: ctx.memoryLimitBytes });
  try {
    return await session.run(code, ctx);
  } finally {
    session.dispose();
  }
}

module.exports = { runScript, ScriptSession, SCRIPT_TIMEOUT_MS, MEMORY_LIMIT_BYTES };
