'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { runScript } = require('../src/core/sandbox');

// Runs a script with a fresh context and returns the result plus everything it touched.
async function run(code, extra = {}) {
  const logs = [];
  const ctx = {
    event: 'prerequest',
    scopes: { globals: {}, collection: {}, environment: {}, data: {}, local: {} },
    request: { method: 'GET', url: 'https://api.example.com/items?a=1', headers: [{ key: 'Accept', value: 'application/json' }], body: { mode: 'none' } },
    cookies: [],
    info: { requestName: 'Req', requestId: 'r1' },
    sendRequest: async (req) => ({ status: 200, statusText: 'OK', headers: [['Content-Type', 'application/json']], bodyText: JSON.stringify({ echo: req }), time: 5, size: 20 }),
    log: (level, msg) => logs.push(`${level}: ${msg}`),
    ...extra,
  };
  const result = await runScript(code, ctx);
  return { result, ctx, logs, env: ctx.scopes.environment };
}

// ---- Isolation --------------------------------------------------------------------------------

test('scripts cannot reach Node, the host or the file system', async () => {
  const { env, result } = await run(`
    pm.environment.set('process', typeof process);
    pm.environment.set('nodeRequire', typeof globalThis.process === 'undefined' && typeof module === 'undefined');
    pm.environment.set('host', typeof __host + typeof __input + typeof createRuntime);
    pm.environment.set('escape', (function () { try { return typeof pm.constructor.constructor('return process')(); } catch (e) { return e.name; } })());
    pm.environment.set('escape2', typeof this.constructor.constructor('return this')().process);
    pm.environment.set('escape3', typeof pm.test.constructor('return globalThis')().require);
    try { require('fs'); } catch (e) { pm.environment.set('fs', e.message); }
    try { require('child_process'); } catch (e) { pm.environment.set('cp', e.message); }
  `);
  assert.strictEqual(result.error, null);
  assert.strictEqual(env.process, 'undefined');
  assert.strictEqual(env.nodeRequire, true);
  assert.strictEqual(env.host, 'undefinedundefinedundefined');
  assert.strictEqual(env.escape, 'ReferenceError'); // process is not defined
  assert.strictEqual(env.escape2, 'undefined');
  assert.strictEqual(env.escape3, 'function'); // the sandbox's own require, not Node's
  assert.match(env.fs, /not available in the sandbox/);
  assert.match(env.cp, /not available in the sandbox/);
});

test('dynamic import is not available', async () => {
  const { env } = await run("import('fs').then(() => pm.environment.set('x', 'loaded'), (e) => pm.environment.set('x', 'refused'));");
  assert.notStrictEqual(env.x, 'loaded');
});

test('an endless loop is stopped by the time limit', async () => {
  const started = Date.now();
  const { result } = await run('while (true) {}', { timeoutMs: 300 });
  assert.match(result.error, /timed out/);
  assert.ok(Date.now() - started < 3000);
});

test('a memory bomb is stopped by the memory limit', async () => {
  const { result } = await run('const a = []; for (;;) a.push(new Array(100000).fill("xxxxxxxx"));', { memoryLimitBytes: 16 * 1024 * 1024 });
  assert.match(result.error, /memory/);
});

test('deep recursion fails cleanly', async () => {
  const { result } = await run('function f() { return f() + 1; } f();');
  assert.match(result.error, /stack/i);
});

test('variables set before an error are kept', async () => {
  const { env, result } = await run("pm.environment.set('before', 'yes'); throw new Error('boom');");
  assert.strictEqual(result.error, 'boom');
  assert.strictEqual(env.before, 'yes');
});

test('a "__proto__" variable cannot change prototypes in HttpDash', async () => {
  const { env } = await run("pm.environment.set('__proto__', { polluted: true }); pm.environment.set('ok', 1);");
  assert.strictEqual(Object.getPrototypeOf(env), Object.prototype);
  assert.strictEqual(({}).polluted, undefined);
  assert.strictEqual(env.ok, 1);
});

test('overriding JSON in a script does not lose its results', async () => {
  const { env, result } = await run("pm.environment.set('kept', 'yes'); JSON.stringify = () => 'nope'; pm.test('t', () => {});");
  assert.strictEqual(env.kept, 'yes');
  assert.strictEqual(result.tests.length, 1);
});

// ---- Async ------------------------------------------------------------------------------------

test('timers run in order and cleared timers do not hold up the script', async () => {
  const started = Date.now();
  const { env } = await run(`
    const order = [];
    setTimeout(() => { order.push('b'); pm.environment.set('order', order.join('')); }, 30);
    setTimeout(() => order.push('a'), 10);
    const t = setTimeout(() => pm.environment.set('cleared', 'ran'), 20000);
    clearTimeout(t);
  `);
  assert.strictEqual(env.order, 'ab');
  assert.strictEqual(env.cleared, undefined);
  assert.ok(Date.now() - started < 2000);
});

test('pm.sendRequest works with callbacks, promises and async tests', async () => {
  const { env, result } = await run(`
    pm.environment.set('token', 'abc');
    pm.sendRequest('https://api.example.com/a', (err, res) => pm.environment.set('cb', res.json().echo));
    pm.sendRequest({ url: 'https://api.example.com/b', method: 'POST' }).then((res) => pm.environment.set('promise', res.code));
    pm.test('async passes', async () => { const r = await pm.sendRequest('https://x.test'); pm.expect(r.code).to.equal(200); });
    pm.test('async fails', async () => { const r = await pm.sendRequest('https://x.test'); pm.expect(r.code).to.equal(500); });
  `, { event: 'test' });
  assert.strictEqual(env.cb, 'https://api.example.com/a');
  assert.strictEqual(env.promise, 200);
  const byName = Object.fromEntries(result.tests.map((t) => [t.name, t]));
  assert.strictEqual(byName['async passes'].passed, true);
  assert.strictEqual(byName['async fails'].passed, false);
  assert.match(byName['async fails'].error, /expected 200 to equal 500/);
});

test('pm.sendRequest sees variables set earlier in the script', async () => {
  let seen;
  const scopes = { globals: {}, collection: {}, environment: {}, data: {}, local: {} };
  await run("pm.environment.set('token', 'abc'); pm.sendRequest('https://x.test');", {
    scopes,
    sendRequest: async () => { seen = { ...scopes.environment }; return { status: 204, headers: [] }; },
  });
  assert.strictEqual(seen.token, 'abc');
});

test('a failed pm.sendRequest passes the error to the callback', async () => {
  const { env } = await run("pm.sendRequest('https://down.test', (err, res) => pm.environment.set('err', err.message + '|' + res));", {
    sendRequest: async () => { throw new Error('connect ECONNREFUSED'); },
  });
  assert.strictEqual(env.err, 'connect ECONNREFUSED|null');
});

// ---- Built-ins scripts rely on -------------------------------------------------------------------

test('CryptoJS hashes and HMACs match Node', async () => {
  const { env } = await run(`
    pm.environment.set('md5', CryptoJS.MD5('hello').toString());
    pm.environment.set('sha1', CryptoJS.SHA1('hello').toString());
    pm.environment.set('sha256', CryptoJS.SHA256('héllo ✓').toString());
    pm.environment.set('sha512b64', CryptoJS.SHA512('x').toString(CryptoJS.enc.Base64));
    pm.environment.set('hmac', CryptoJS.HmacSHA256('msg', 'key').toString());
    pm.environment.set('roundtrip', CryptoJS.enc.Utf8.stringify(CryptoJS.enc.Base64.parse(CryptoJS.enc.Base64.stringify(CryptoJS.enc.Utf8.parse('ünïcode ✓')))));
    pm.environment.set('random', CryptoJS.lib.WordArray.random(16).toString().length);
    pm.environment.set('viaRequire', require('crypto-js').SHA1('a').toString());
  `);
  const h = (alg, s) => crypto.createHash(alg).update(s).digest('hex');
  assert.strictEqual(env.md5, h('md5', 'hello'));
  assert.strictEqual(env.sha1, h('sha1', 'hello'));
  assert.strictEqual(env.sha256, h('sha256', 'héllo ✓'));
  assert.strictEqual(env.sha512b64, crypto.createHash('sha512').update('x').digest('base64'));
  assert.strictEqual(env.hmac, crypto.createHmac('sha256', 'key').update('msg').digest('hex'));
  assert.strictEqual(env.roundtrip, 'ünïcode ✓');
  assert.strictEqual(env.random, 32);
  assert.strictEqual(env.viaRequire, h('sha1', 'a'));
});

test('Buffer, atob, btoa and TextEncoder behave like Node', async () => {
  const { env } = await run(`
    pm.environment.set('b64', Buffer.from('user:pässword').toString('base64'));
    pm.environment.set('fromB64', Buffer.from('aGVsbG8gd29ybGQ=', 'base64').toString());
    pm.environment.set('hex', Buffer.from('hi').toString('hex'));
    pm.environment.set('concat', Buffer.concat([Buffer.from('a'), Buffer.from('b')]).toString());
    pm.environment.set('btoa', btoa('user:pass'));
    pm.environment.set('atob', atob('dXNlcjpwYXNz'));
    pm.environment.set('te', new TextDecoder().decode(new TextEncoder().encode('✓ ok')));
    pm.environment.set('len', Buffer.byteLength('✓'));
  `);
  assert.strictEqual(env.b64, Buffer.from('user:pässword').toString('base64'));
  assert.strictEqual(env.fromB64, 'hello world');
  assert.strictEqual(env.hex, '6869');
  assert.strictEqual(env.concat, 'ab');
  assert.strictEqual(env.btoa, 'dXNlcjpwYXNz');
  assert.strictEqual(env.atob, 'user:pass');
  assert.strictEqual(env.te, '✓ ok');
  assert.strictEqual(env.len, 3);
});

test('URL and URLSearchParams follow the WHATWG rules', async () => {
  const { env } = await run(`
    const u = new URL('https://user:pw@api.example.com:8443/v1/items?a=1&b=two#frag');
    pm.environment.set('parts', [u.protocol, u.username, u.hostname, u.port, u.pathname, u.search, u.hash, u.origin].join('|'));
    u.searchParams.append('c', 'x y');
    u.pathname = '/v2';
    pm.environment.set('href', u.href);
    pm.environment.set('rel', new URL('../up?q=1', 'https://a.test/x/y/z').toString());
    const p = new URLSearchParams({ q: 'a&b', n: 1 });
    p.set('q', 'c');
    pm.environment.set('qs', p.toString());
    try { new URL('not a url'); } catch (e) { pm.environment.set('bad', e.message); }
    pm.environment.set('host', pm.request.url.getHost());
  `);
  assert.strictEqual(env.parts, 'https:|user|api.example.com|8443|/v1/items|?a=1&b=two|#frag|https://api.example.com:8443');
  assert.strictEqual(env.href, 'https://user:pw@api.example.com:8443/v2?a=1&b=two&c=x+y#frag');
  assert.strictEqual(env.rel, 'https://a.test/x/up?q=1');
  assert.strictEqual(env.qs, 'q=c&n=1');
  assert.match(env.bad, /Invalid URL/);
  assert.strictEqual(env.host, 'api.example.com');
});

test('console output is formatted like Node', async () => {
  const { logs } = await run(`
    console.log('plain', 1, true, null, undefined);
    console.info({ a: 1, list: [1, 'two'], nested: { deep: { er: { est: 1 } } } });
    console.warn('%s is %d years', 'Ann', 42);
    const o = { name: 'loop' }; o.self = o; console.log(o);
  `);
  assert.deepStrictEqual(logs, [
    'log: plain 1 true null undefined',
    "info: { a: 1, list: [ 1, 'two' ], nested: { deep: { er: { est: 1 } } } }",
    'warn: Ann is 42 years',
    "log: { name: 'loop', self: [Circular] }",
  ]);
});

test('variables.replaceIn resolves variables and dynamic values', async () => {
  const { env } = await run(`
    pm.environment.set('host', 'api.test');
    pm.variables.set('id', 7);
    pm.environment.set('out', pm.variables.replaceIn('https://{{host}}/items/{{id}}'));
    pm.environment.set('guid', pm.variables.replaceIn('{{$guid}}'));
  `);
  assert.strictEqual(env.out, 'https://api.test/items/7');
  assert.match(env.guid, /^[0-9a-f-]{36}$/);
});

test('pre-request scripts can change the request', async () => {
  const { ctx } = await run(`
    pm.request.headers.upsert({ key: 'Accept', value: 'text/plain' });
    pm.request.addHeader('X-Sig: abc');
    pm.request.url.query.add({ key: 'b', value: 'two words' });
    pm.request.method = 'post';
    pm.request.body.update('{"x":1}');
  `);
  assert.strictEqual(ctx.request.method, 'POST');
  assert.strictEqual(ctx.request.url, 'https://api.example.com/items?a=1&b=two%20words');
  assert.deepStrictEqual(ctx.request.headers.map((h) => `${h.key}=${h.value}`), ['Accept=text/plain', 'X-Sig=abc']);
  assert.deepStrictEqual(ctx.request.body, { mode: 'raw', raw: '{"x":1}' });
});

test('flow control, visualizer and legacy globals come back to HttpDash', async () => {
  const { result, env } = await run(`
    pm.setNextRequest('Last');
    pm.visualizer.set('<b>{{name}}</b>', { name: 'Ann' });
    tests['legacy ok'] = responseCode.code === 201;
    postman.setEnvironmentVariable('legacy', responseBody);
    pm.test('header', () => pm.response.to.have.header('content-type'));
    pm.test('ok', () => pm.response.to.be.success);
  `, { event: 'test', response: { status: 201, statusText: 'Created', headers: [['Content-Type', 'text/plain']], bodyText: 'made', time: 3, size: 4 } });
  assert.strictEqual(result.nextRequest, 'Last');
  assert.deepStrictEqual(result.visualizer, { template: '<b>{{name}}</b>', data: { name: 'Ann' } });
  assert.strictEqual(env.legacy, 'made');
  assert.deepStrictEqual(result.tests.map((t) => [t.name, t.passed]), [['header', true], ['ok', true], ['legacy ok', true]]);
});

test('pm.execution.skipRequest is reported', async () => {
  const { result } = await run('pm.execution.skipRequest();');
  assert.strictEqual(result.skipRequest, true);
});
