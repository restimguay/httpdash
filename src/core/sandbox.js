'use strict';

/**
 * Runs pre-request and test scripts with a Postman-compatible `pm` API, inside QuickJS: a separate
 * JavaScript engine compiled to WebAssembly. A script can't reach Node, the file system, other
 * processes or HttpDash itself. It only has the API in sandbox-guest.js, which talks to the outside
 * through the host functions below, and its results come back as plain JSON.
 *
 * Every script gets a fresh engine with limits on time, memory and stack depth.
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

// Evaluated once per script: builds the runtime around the host functions, then puts the script's
// globals in place. The host and input are passed through temporary globals and removed at once.
const boot = (guest) => `(function (host, input) {
  delete globalThis.__host;
  delete globalThis.__input;
  ${guest}
  var rt = createRuntime(host, JSON.parse(input));
  for (var k of Object.keys(rt.globals)) {
    Object.defineProperty(globalThis, k, { value: rt.globals[k], writable: true, configurable: true, enumerable: false });
  }
  return { complete: rt.complete, finish: rt.finish };
})(globalThis.__host, globalThis.__input)`;

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

/**
 * ctx: {
 *   event: 'prerequest' | 'test',
 *   scopes: { globals, collection, environment, data, local } (updated in place),
 *   request: request definition (updated in place by pre-request scripts),
 *   response: { status, statusText, headers, bodyText, time, size } (test scripts only),
 *   cookies: cookie jar array,
 *   info: { requestName, requestId, iteration, iterationCount },
 *   sendRequest: async (req) => response,
 *   log: (level, message) => void,
 *   timeoutMs, memoryLimitBytes: optional, to lower the limits (used by tests),
 * }
 */
async function runScript(code, ctx) {
  const result = { tests: [], error: null, nextRequest: undefined, visualizer: null };
  if (!code || !code.trim()) return result;

  const QuickJS = await loadQuickJS();
  const src = loadSources();
  const log = (level, message) => ctx.log && ctx.log(level, message);
  const timeoutMs = ctx.timeoutMs || SCRIPT_TIMEOUT_MS;
  const memoryLimit = ctx.memoryLimitBytes || MEMORY_LIMIT_BYTES;
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(memoryLimit);
  runtime.setMaxStackSize(STACK_LIMIT_BYTES);
  const deadline = Date.now() + timeoutMs;
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(deadline));
  const vm = runtime.newContext();

  const pending = new Map(); // op id -> { promise, cancel }
  const handles = [];
  let scriptError = null;
  let interrupted = false;
  const fail = (err) => {
    let msg = errorMessage(err);
    if (msg === 'interrupted') { interrupted = true; msg = `Script timed out after ${timeoutMs / 1000} seconds`; }
    else if (/out of memory/i.test(msg)) msg = `Script ran out of memory (limit ${Math.round(memoryLimit / 1024 / 1024)} MB)`;
    scriptError = scriptError || msg;
  };

  try {
    // Host functions. They only receive and return strings and numbers.
    const hostApi = {
      log: (level, message) => { log(String(level), String(message)); },
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
        if (pending.size >= MAX_PENDING_OPS) throw new Error('Too many timers');
        let timer;
        const promise = new Promise((done) => { timer = setTimeout(() => done({ id, ok: true, value: '' }), Math.min(Math.max(Number(ms) || 0, 0), timeoutMs)); });
        pending.set(id, { promise, cancel: () => clearTimeout(timer) });
      },
      cancel: (id) => {
        const op = pending.get(id);
        if (op && op.cancel) { op.cancel(); pending.delete(id); }
      },
    };
    const hostObj = vm.newObject();
    handles.push(hostObj);
    for (const [name, fn] of Object.entries(hostApi)) {
      const fnHandle = vm.newFunction(name, (...args) => {
        const out = fn(...args.map((h) => vm.dump(h)));
        return out === undefined ? undefined : vm.newString(out);
      });
      vm.setProp(hostObj, name, fnHandle);
      fnHandle.dispose();
    }
    vm.setProp(vm.global, '__host', hostObj);
    const inputHandle = vm.newString(JSON.stringify({
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
    vm.setProp(vm.global, '__input', inputHandle);
    inputHandle.dispose();

    const booted = vm.evalCode(boot(src.guest), 'sandbox-boot.js');
    if (booted.error) {
      const err = vm.dump(booted.error);
      booted.error.dispose();
      throw new Error(`Script sandbox failed to start: ${errorMessage(err)}`);
    }
    const rt = booted.value;
    handles.push(rt);
    const completeFn = vm.getProp(rt, 'complete');
    const finishFn = vm.getProp(rt, 'finish');
    handles.push(completeFn, finishFn);

    // Run the script, then keep running its promise jobs until no host call is left in progress.
    const ran = vm.evalCode(code, `${ctx.event}-script.js`);
    if (ran.error) { fail(vm.dump(ran.error)); ran.error.dispose(); } else ran.value.dispose();

    for (;;) {
      const jobs = runtime.executePendingJobs();
      if (jobs.error) { fail(vm.dump(jobs.error)); jobs.error.dispose(); }
      if (!pending.size || interrupted) break;
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
      const args = [vm.newNumber(done.id), done.ok ? vm.true : vm.false, vm.newString(done.value)];
      const called = vm.callFunction(completeFn, vm.undefined, ...args);
      args[0].dispose();
      args[2].dispose();
      if (called.error) { fail(vm.dump(called.error)); called.error.dispose(); } else called.value.dispose();
    }

    // Collect the results, with a short new deadline in case the script used up its time.
    runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + 2000));
    const finished = vm.callFunction(finishFn, vm.undefined);
    if (finished.error) {
      fail(vm.dump(finished.error));
      finished.error.dispose();
    } else {
      const out = JSON.parse(vm.getString(finished.value));
      finished.value.dispose();
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
    }
  } catch (e) {
    fail(e);
  } finally {
    for (const op of pending.values()) if (op.cancel) op.cancel();
    for (const h of handles) if (h.alive) h.dispose();
    try { vm.dispose(); runtime.dispose(); } catch { /* leftover objects from an interrupted script */ }
  }

  if (scriptError) {
    result.error = scriptError;
    log('error', `${ctx.event === 'test' ? 'Test' : 'Pre-request'} script error: ${scriptError}`);
  }
  return result;
}

module.exports = { runScript, SCRIPT_TIMEOUT_MS, MEMORY_LIMIT_BYTES };
