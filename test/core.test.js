'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startServer } = require('./helpers');
const { execute, prepare } = require('../src/core/executor');
const { resolve } = require('../src/core/variables');
const { parseCurl } = require('../src/core/curl');
const { generate, targets } = require('../src/core/codegen');
const postman = require('../src/core/postman');
const runner = require('../src/core/runner');
const { newRequestDef, newCollection, newRequestItem, newFolder } = require('../src/core/model');
const cookies = require('../src/core/cookies');

let srv;
test.before(async () => { srv = await startServer(); });
test.after(() => srv.server.close());

const scopes = (env = {}) => ({ globals: {}, collection: {}, environment: env, data: {} });

test('variables resolve with precedence, nesting and dynamic values', () => {
  assert.strictEqual(resolve('{{a}}-{{b}}', { a: '1', b: '{{a}}2' }), '1-12');
  assert.match(resolve('{{$guid}}', {}), /^[0-9a-f-]{36}$/);
  assert.strictEqual(resolve('{{missing}}', {}), '{{missing}}');
});

test('GET with params, headers and environment variables', async () => {
  const request = newRequestDef({ url: '{{base}}/echo?x={{val}}', headers: [{ key: 'X-Test', value: '{{val}}', enabled: true }, { key: 'X-Off', value: '1', enabled: false }] });
  const res = await execute({ request, scopes: scopes({ base: srv.base, val: 'hello' }) });
  assert.strictEqual(res.error, undefined);
  const body = JSON.parse(res.response.bodyText);
  assert.strictEqual(body.query.x, 'hello');
  assert.strictEqual(body.headers['x-test'], 'hello');
  assert.strictEqual(body.headers['x-off'], undefined);
});

test('JSON, urlencoded, multipart and graphql bodies', async () => {
  const tmp = path.join(os.tmpdir(), `httpdash-${process.pid}.txt`);
  fs.writeFileSync(tmp, 'file-contents');
  try {
    const raw = await execute({ request: newRequestDef({ method: 'POST', url: `${srv.base}/echo`, body: { mode: 'raw', raw: '{"a":1}', rawLanguage: 'json' } }), scopes: scopes() });
    let b = JSON.parse(raw.response.bodyText);
    assert.strictEqual(b.headers['content-type'], 'application/json');
    assert.strictEqual(b.body, '{"a":1}');

    const form = await execute({ request: newRequestDef({ method: 'POST', url: `${srv.base}/echo`, body: { mode: 'urlencoded', urlencoded: [{ key: 'a b', value: 'c&d', enabled: true }] } }), scopes: scopes() });
    b = JSON.parse(form.response.bodyText);
    assert.strictEqual(b.body, 'a%20b=c%26d');

    const multi = await execute({ request: newRequestDef({ method: 'POST', url: `${srv.base}/echo`, body: { mode: 'formdata', formdata: [{ key: 'f', value: 'v', type: 'text', enabled: true }, { key: 'file', type: 'file', src: tmp, enabled: true }] } }), scopes: scopes() });
    b = JSON.parse(multi.response.bodyText);
    assert.match(b.headers['content-type'], /^multipart\/form-data; boundary=/);
    assert.match(b.body, /name="f"\r\n\r\nv/);
    assert.match(b.body, /filename="httpdash-\d+\.txt"[\s\S]*file-contents/);

    const gql = await execute({ request: newRequestDef({ method: 'POST', url: `${srv.base}/echo`, body: { mode: 'graphql', graphql: { query: '{ me { id } }', variables: '{"x": 1}' } } }), scopes: scopes() });
    b = JSON.parse(gql.response.bodyText);
    assert.deepStrictEqual(JSON.parse(b.body), { query: '{ me { id } }', variables: { x: 1 } });
  } finally {
    fs.unlinkSync(tmp);
  }
});

test('auth: basic, bearer, api key in query, inherited from folder', async () => {
  const folder = { auth: { type: 'bearer', bearer: { token: '{{tok}}' } } };
  const res = await execute({ request: newRequestDef({ url: `${srv.base}/echo` }), chain: [{ auth: { type: 'none' } }, folder], scopes: scopes({ tok: 'T1' }) });
  assert.strictEqual(JSON.parse(res.response.bodyText).headers.authorization, 'Bearer T1');

  const basic = await execute({ request: newRequestDef({ url: `${srv.base}/echo`, auth: { type: 'basic', basic: { username: 'u', password: 'p' } } }), scopes: scopes() });
  assert.strictEqual(JSON.parse(basic.response.bodyText).headers.authorization, 'Basic ' + Buffer.from('u:p').toString('base64'));

  const key = await execute({ request: newRequestDef({ url: `${srv.base}/echo`, auth: { type: 'apikey', apikey: { key: 'api_key', value: 'K', in: 'query' } } }), scopes: scopes() });
  assert.strictEqual(JSON.parse(key.response.bodyText).query.api_key, 'K');
});

test('digest auth retries with a computed challenge response', async () => {
  const res = await execute({ request: newRequestDef({ url: `${srv.base}/digest`, auth: { type: 'digest', digest: { username: 'user', password: 'pass' } } }), scopes: scopes() });
  assert.strictEqual(res.response.status, 200);
  assert.strictEqual(JSON.parse(res.response.bodyText).authenticated, true);
});

test('redirects, gzip and cookie jar', async () => {
  const red = await execute({ request: newRequestDef({ url: `${srv.base}/redirect` }), scopes: scopes() });
  assert.strictEqual(red.response.status, 200);
  assert.strictEqual(red.response.redirects.length, 1);
  const noFollow = await execute({ request: newRequestDef({ url: `${srv.base}/redirect` }), scopes: scopes(), settings: { followRedirects: false } });
  assert.strictEqual(noFollow.response.status, 302);

  const gz = await execute({ request: newRequestDef({ url: `${srv.base}/gzip` }), scopes: scopes() });
  assert.deepStrictEqual(JSON.parse(gz.response.bodyText), { compressed: true });

  const jar = [];
  await execute({ request: newRequestDef({ url: `${srv.base}/set-cookie` }), scopes: scopes(), jar });
  assert.strictEqual(jar.length, 2);
  const echo = await execute({ request: newRequestDef({ url: `${srv.base}/echo` }), scopes: scopes(), jar });
  assert.strictEqual(JSON.parse(echo.response.bodyText).headers.cookie, 'session=abc123; theme=dark');
});

test('timeouts and connection errors are reported', async () => {
  const slow = await execute({ request: newRequestDef({ url: `${srv.base}/slow` }), scopes: scopes(), settings: { timeout: 100 } });
  assert.match(slow.error, /timed out/);
  const refused = await execute({ request: newRequestDef({ url: 'http://127.0.0.1:1/' }), scopes: scopes() });
  assert.match(refused.error, /refused/i);
});

test('pre-request and test scripts with the pm API', async () => {
  const request = newRequestDef({
    method: 'POST',
    url: `${srv.base}/echo`,
    preRequestScript: `
      pm.environment.set('fromPre', 'yes');
      pm.request.headers.add({ key: 'X-Pre', value: pm.variables.get('val') });
      pm.request.url.query.add({ key: 'q', value: '1' });
      pm.variables.set('localVar', 'L');
      pm.request.body.update('{"local":"{{localVar}}"}');
      const sig = CryptoJS.HmacSHA256('msg', 'key').toString(CryptoJS.enc.Hex);
      pm.environment.set('sig', sig);
      console.log('pre ran');
    `,
    testScript: `
      pm.test('status ok', () => pm.response.to.have.status(200));
      pm.test('json', () => pm.expect(pm.response.json().headers['x-pre']).to.eql('hello'));
      pm.test('body', () => pm.expect(pm.response.json().body).to.eql('{"local":"L"}'));
      pm.test('query', () => pm.response.to.have.jsonBody('query.q', '1'));
      pm.test('header', () => pm.response.to.have.header('Content-Type'));
      pm.test('schema', () => pm.response.to.have.jsonSchema({ type: 'object', required: ['method'], properties: { method: { type: 'string' } } }));
      pm.test('fails', () => pm.expect(1).to.equal(2));
      pm.test.skip('skipped');
      tests['legacy'] = responseCode.code === 200;
      pm.collectionVariables.set('c', 1);
      pm.environment.unset('val');
      pm.sendRequest('${srv.base}/status/201', (err, r) => { pm.environment.set('async', r.code); });
    `,
  });
  const logs = [];
  const res = await execute({ request, scopes: scopes({ val: 'hello' }), log: (l, m) => logs.push(m) });
  const byName = Object.fromEntries(res.tests.map((t) => [t.name, t]));
  for (const n of ['status ok', 'json', 'body', 'query', 'header', 'schema', 'legacy']) assert.ok(byName[n].passed, `${n}: ${byName[n].error}`);
  assert.strictEqual(byName.fails.passed, false);
  assert.match(byName.fails.error, /expected 1 to equal 2/);
  assert.strictEqual(byName.skipped.skipped, true);
  assert.strictEqual(res.scopes.environment.fromPre, 'yes');
  assert.strictEqual(res.scopes.environment.val, undefined);
  assert.strictEqual(res.scopes.environment.async, 201);
  assert.strictEqual(res.scopes.environment.sig, require('crypto').createHmac('sha256', 'key').update('msg').digest('hex'));
  assert.strictEqual(res.scopes.collection.c, 1);
  assert.ok(logs.includes('pre ran'));
});

test('script errors are surfaced and stop the request', async () => {
  const res = await execute({ request: newRequestDef({ url: `${srv.base}/echo`, preRequestScript: 'throw new Error("boom")' }), scopes: scopes() });
  assert.match(res.error, /boom/);
  assert.strictEqual(res.response, undefined);
});

test('cURL import', () => {
  const r = parseCurl(`curl -X POST 'https://api.example.com/v1/items?limit=5' \\
    -H 'Content-Type: application/json' -H "Authorization: Bearer abc" \\
    --data-raw '{"name":"x"}' -u admin:secret`);
  assert.strictEqual(r.method, 'POST');
  assert.strictEqual(r.url, 'https://api.example.com/v1/items?limit=5');
  assert.deepStrictEqual(r.params.map((p) => [p.key, p.value]), [['limit', '5']]);
  assert.strictEqual(r.headers.length, 2);
  assert.strictEqual(r.body.mode, 'raw');
  assert.strictEqual(r.body.raw, '{"name":"x"}');
  assert.deepStrictEqual(r.auth, { type: 'basic', basic: { username: 'admin', password: 'secret' } });

  const f = parseCurl("curl https://x.io/up -F 'name=val' -F 'file=@/tmp/a.png'");
  assert.strictEqual(f.method, 'POST');
  assert.strictEqual(f.body.formdata[1].type, 'file');
  const d = parseCurl("curl https://x.io -d 'a=1&b=2'");
  assert.strictEqual(d.body.mode, 'urlencoded');
});

test('code generation for every target', () => {
  const def = newRequestDef({ method: 'POST', url: 'https://api.example.com/x?y=1', headers: [{ key: 'X-A', value: "it's", enabled: true }], body: { mode: 'raw', raw: '{"a":1}', rawLanguage: 'json' } });
  const p = prepare(def, { defaultHeaders: false });
  for (const t of targets()) {
    const code = generate(t.id, p, def);
    assert.ok(code.includes('api.example.com'), t.id);
  }
  assert.match(generate('curl', p, def), /--header 'X-A: it'\\''s'/);
});

test('Postman collection round-trip', () => {
  const col = newCollection('Round trip');
  col.variables = [{ key: 'base', value: 'http://x', enabled: true }];
  col.auth = { type: 'bearer', bearer: { token: 't' } };
  const folder = newFolder('F');
  folder.testScript = 'pm.test("a", () => {});';
  const req = newRequestItem('R', { method: 'PUT', url: '{{base}}/a/:id?q=1', params: [{ key: 'q', value: '1', enabled: true }], pathVariables: [{ key: 'id', value: '7', enabled: true }], body: { ...newRequestDef().body, mode: 'urlencoded', urlencoded: [{ key: 'k', value: 'v', enabled: false }] } });
  folder.items.push(req);
  col.items.push(folder);
  const exported = postman.exportCollection(col);
  assert.strictEqual(exported.info.schema, 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json');
  const { kind, data } = postman.importAny(exported);
  assert.strictEqual(kind, 'collection');
  assert.strictEqual(data.name, 'Round trip');
  assert.strictEqual(data.auth.bearer.token, 't');
  const r = data.items[0].items[0];
  assert.strictEqual(data.items[0].testScript, 'pm.test("a", () => {});');
  assert.strictEqual(r.request.method, 'PUT');
  assert.strictEqual(r.request.url, '{{base}}/a/:id?q=1');
  assert.strictEqual(r.request.pathVariables[0].value, '7');
  assert.strictEqual(r.request.body.urlencoded[0].enabled, false);
  assert.strictEqual(r.request.auth.type, 'inherit');
});

test('OpenAPI import', () => {
  const { data } = postman.importAny({
    openapi: '3.0.0', info: { title: 'Pets' }, servers: [{ url: 'https://pets.io/v1' }],
    paths: { '/pets/{id}': { get: { tags: ['pets'], summary: 'Get pet', parameters: [{ name: 'id', in: 'path' }] }, post: { requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' } } } } } } } } },
  });
  assert.strictEqual(data.variables[0].value, 'https://pets.io/v1');
  assert.strictEqual(data.items[0].name, 'pets');
  assert.strictEqual(data.items[0].items[0].request.url, '{{baseUrl}}/pets/:id');
  assert.deepStrictEqual(JSON.parse(data.items[1].request.body.raw), { name: 'string' });
});

test('collection runner with data file, iterations and setNextRequest', async () => {
  const col = newCollection('Run');
  col.items.push(
    newRequestItem('First', { url: `${srv.base}/echo?user={{user}}`, testScript: "pm.test('user', () => pm.expect(pm.response.json().query.user).to.eql(pm.iterationData.get('user'))); pm.environment.set('count', (pm.environment.get('count') || 0) + 1);" }),
    newRequestItem('Skipped', { url: `${srv.base}/status/500`, testScript: "pm.test('never', () => {})" }),
    newRequestItem('Last', { url: `${srv.base}/status/201`, testScript: "pm.test('created', () => pm.response.to.have.status(201));" }),
  );
  col.items[0].request.testScript += " pm.setNextRequest('Last');";
  const data = runner.parseDataFile('user\nalice\n"bob, jr"\n', 'data.csv');
  assert.deepStrictEqual(data, [{ user: 'alice' }, { user: 'bob, jr' }]);
  const env = {};
  const events = [];
  const summary = await runner.run({ collection: col, scopes: { globals: {}, environment: env }, data, jar: [], onEvent: (e) => events.push(e.type) });
  assert.strictEqual(summary.iterations, 2);
  assert.strictEqual(summary.requests, 4);
  assert.strictEqual(summary.failed, 0);
  assert.strictEqual(summary.passed, 4);
  assert.strictEqual(env.count, 2);
  assert.ok(events.includes('done'));
});

test('cookie parsing respects domain and path', () => {
  const jar = [];
  cookies.storeFromResponse(jar, [['Set-Cookie', 'a=1; Domain=example.com; Path=/api'], ['Set-Cookie', 'b=2; Domain=evil.com']], 'https://www.example.com/api/x');
  assert.strictEqual(jar.length, 1);
  assert.strictEqual(cookies.cookieHeader(jar, 'https://example.com/api/y'), 'a=1');
  assert.strictEqual(cookies.cookieHeader(jar, 'https://example.com/other'), '');
});

test('browser-restricted headers (Referer, Origin, User-Agent, Host) are sent verbatim', async () => {
  const headers = [
    ['Referer', 'https://www.google.com/search?q=spoofed'],
    ['Origin', 'https://evil.example'],
    ['User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'],
    ['Host', 'virtual.example.com'],
    ['Cookie', 'manual=1'],
  ].map(([key, value]) => ({ key, value, enabled: true }));
  const res = await execute({ request: newRequestDef({ url: `${srv.base}/echo`, headers }), scopes: scopes() });
  const got = JSON.parse(res.response.bodyText).headers;
  assert.strictEqual(got.referer, 'https://www.google.com/search?q=spoofed');
  assert.strictEqual(got.origin, 'https://evil.example');
  assert.strictEqual(got['user-agent'], 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)');
  assert.strictEqual(got.host, 'virtual.example.com');
  assert.strictEqual(got.cookie, 'manual=1');
});

test('Referer survives redirects', async () => {
  const headers = [{ key: 'Referer', value: 'https://ref.example/', enabled: true }];
  const res = await execute({ request: newRequestDef({ url: `${srv.base}/redirect`, headers }), scopes: scopes() });
  assert.strictEqual(JSON.parse(res.response.bodyText).headers.referer, 'https://ref.example/');
});
