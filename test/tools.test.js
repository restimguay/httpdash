'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { startServer } = require('./helpers');
const { main: cli } = require('../bin/httpdash');
const { startMockServer, matchRoute, buildRoutes } = require('../src/core/mock');
const { scanWorkspace } = require('../src/core/secrets');
const { AuditLog, safeTarget } = require('../src/core/audit');
const { makeBackup } = require('../src/core/backup');
const postman = require('../src/core/postman');
const { newCollection, newRequestItem, newEnvironment, newFolder } = require('../src/core/model');

let srv;
test.before(async () => { srv = await startServer(); });
test.after(() => srv.server.close());
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hd-tools-'));

// ---- CLI ----------------------------------------------------------------------------------

function fixtureWorkspace() {
  const col = newCollection('CLI Demo');
  col.variables = [{ key: 'base', value: srv.base, enabled: true }];
  col.items.push(
    newRequestItem('Echo', { url: '{{base}}/echo?user={{user}}', testScript: "pm.test('user echoed', () => pm.expect(pm.response.json().query.user).to.eql(pm.variables.get('user')));" }),
    newRequestItem('Created', { url: '{{base}}/status/201', testScript: "pm.test('is 201', () => pm.response.to.have.status(201));" }),
  );
  const env = newEnvironment('Local');
  env.values = [{ key: 'user', value: 'alice', enabled: true }];
  return { col, env, ws: { collections: [col], environments: [env], globals: [] } };
}
const capture = () => { const lines = []; return { lines, io: { out: (s) => lines.push(s), err: (s) => lines.push(`ERR ${s}`) } }; };

test('CLI runs a collection from an HttpDash backup with an environment by name', async () => {
  const dir = tmp();
  const { ws } = fixtureWorkspace();
  const file = path.join(dir, 'backup.json');
  fs.writeFileSync(file, JSON.stringify(makeBackup(ws, [])));
  const { lines, io } = capture();
  const code = await cli(['run', file, '-e', 'Local', '--no-color', '-r', 'cli,json,junit', '--reporter-json-export', path.join(dir, 'r.json'), '--reporter-junit-export', path.join(dir, 'r.xml')], io);
  assert.strictEqual(code, 0, lines.join('\n'));
  assert.ok(lines.some((l) => l.includes('✓ user echoed')));
  assert.match(lines.join('\n'), /PASSED/);
  const report = JSON.parse(fs.readFileSync(path.join(dir, 'r.json'), 'utf8'));
  assert.strictEqual(report.summary.passed, 2);
  const xml = fs.readFileSync(path.join(dir, 'r.xml'), 'utf8');
  assert.match(xml, /<testsuites name="CLI Demo" tests="2" failures="0" errors="0">/);
  assert.strictEqual((xml.match(/<testcase /g) || []).length, 2);
});

test('CLI exits 1 on a failing test, writes a JUnit failure, and honours --env-var and data files', async () => {
  const dir = tmp();
  const { col } = fixtureWorkspace();
  const pmFile = path.join(dir, 'col.json');
  fs.writeFileSync(pmFile, JSON.stringify(postman.exportCollection(col)));
  const dataFile = path.join(dir, 'users.csv');
  fs.writeFileSync(dataFile, 'user\nbob\ncarol\n');
  const { lines, io } = capture();
  const ok = await cli(['run', pmFile, '-d', dataFile, '--no-color'], io);
  assert.strictEqual(ok, 0, lines.join('\n'));
  assert.ok(lines.some((l) => l.includes('Iteration 2')));

  col.items[1].request.testScript = "pm.test('is 200', () => pm.response.to.have.status(200));";
  fs.writeFileSync(pmFile, JSON.stringify(postman.exportCollection(col)));
  const out = capture();
  const code = await cli(['run', pmFile, '--env-var', 'user=dave', '--no-color', '-r', 'cli,junit', '--reporter-junit-export', path.join(dir, 'j.xml')], out.io);
  assert.strictEqual(code, 1);
  assert.match(out.lines.join('\n'), /✗ is 200: expected response to have status code 200 but got 201/);
  assert.match(fs.readFileSync(path.join(dir, 'j.xml'), 'utf8'), /<failure message="expected response to have status code 200 but got 201"/);
});

test('CLI usage errors exit 2 with a helpful message', async () => {
  const dir = tmp();
  const { ws } = fixtureWorkspace();
  ws.collections.push(newCollection('Second'));
  const file = path.join(dir, 'b.json');
  fs.writeFileSync(file, JSON.stringify(makeBackup(ws, [])));
  let c = capture();
  assert.strictEqual(await cli(['run', file, '--no-color'], c.io), 2);
  assert.match(c.lines.join(), /2 collections; choose one with --collection/);
  c = capture();
  assert.strictEqual(await cli(['run', file, '-c', 'Nope', '--no-color'], c.io), 2);
  c = capture();
  assert.strictEqual(await cli(['run', path.join(dir, 'missing.json')], c.io), 2);
  c = capture();
  assert.strictEqual(await cli(['list', file], c.io), 0);
  assert.match(c.lines.join('\n'), /Collections: "CLI Demo", "Second"/);
});

// ---- Mock server --------------------------------------------------------------------------

const get = (url, headers = {}, method = 'GET') => new Promise((resolve, reject) => {
  const req = http.request(url, { method, headers }, (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
  });
  req.on('error', reject);
  req.end();
});

function mockCollection() {
  const col = newCollection('Mocked');
  const users = newFolder('Users');
  const one = newRequestItem('Get user', { url: '{{BASE_URL}}/api/users/:id' });
  one.examples = [
    { id: 'e1', name: 'Found', status: 200, statusText: 'OK', headers: [['Content-Type', 'application/json'], ['Content-Length', '999']], body: '{"id":1}' },
    { id: 'e2', name: 'Missing', status: 404, statusText: 'Not Found', headers: [['Content-Type', 'application/json']], body: '{"error":"nope"}' },
  ];
  const me = newRequestItem('Me', { url: 'https://api.example.com/api/users/me' });
  me.examples = [{ id: 'e3', name: 'Me', status: 200, headers: [], body: 'me' }];
  const create = newRequestItem('Create', { method: 'POST', url: '{{BASE_URL}}/api/users' });
  users.items.push(one, me, create);
  col.items.push(users);
  return col;
}

test('mock routes: variables and :params are wildcards, literal segments win', () => {
  const routes = buildRoutes(mockCollection());
  assert.deepStrictEqual(routes.map((r) => `${r.method} ${r.path}`), ['GET /api/users/:id', 'GET /api/users/me', 'POST /api/users']);
  assert.strictEqual(matchRoute(routes, 'GET', '/api/users/42').name, 'Get user');
  assert.strictEqual(matchRoute(routes, 'GET', '/api/users/me').name, 'Me');
  assert.strictEqual(matchRoute(routes, 'DELETE', '/api/users/42'), null);
});

test('mock server serves examples, honours x-mock-response-name/code, CORS and missing routes', async () => {
  const log = [];
  const mock = await startMockServer({ collection: mockCollection(), onRequest: (e) => log.push(e) });
  try {
    let r = await get(`${mock.url}/api/users/7`);
    assert.deepStrictEqual([r.status, r.body, r.headers['content-type'], r.headers['access-control-allow-origin']], [200, '{"id":1}', 'application/json', '*']);
    assert.strictEqual(r.headers['content-length'], '8'); // recomputed, not the stale example value
    r = await get(`${mock.url}/api/users/7`, { 'x-mock-response-code': '404' });
    assert.strictEqual(r.status, 404);
    r = await get(`${mock.url}/api/users/7`, { 'x-mock-response-name': 'Missing' });
    assert.strictEqual(r.body, '{"error":"nope"}');
    r = await get(`${mock.url}/api/users`, {}, 'POST');
    assert.strictEqual(r.status, 501);
    r = await get(`${mock.url}/nothing`);
    assert.strictEqual(r.status, 404);
    assert.match(r.body, /GET \/api\/users\/:id/);
    r = await get(`${mock.url}/api/users/7`, {}, 'OPTIONS');
    assert.strictEqual(r.status, 204);
    assert.strictEqual(log[0].route, 'Get user');
    assert.strictEqual(log[0].example, 'Found');
  } finally {
    await mock.close();
  }
});

test('mock server reports a busy port clearly', async () => {
  const first = await startMockServer({ collection: mockCollection() });
  try {
    await assert.rejects(startMockServer({ collection: mockCollection(), port: first.port }), /already in use/);
  } finally {
    await first.close();
  }
});

// ---- Secret scanner -----------------------------------------------------------------------

test('secret scanner finds plain-text credentials and offers fixes, ignoring variable references', () => {
  const col = newCollection('Leaky');
  const r1 = newRequestItem('Login', {
    url: 'https://admin:hunter2@api.example.com/login?api_key=abcdef123456',
    headers: [{ key: 'Authorization', value: 'Token 1234567890abcdef', enabled: true }, { key: 'X-Trace', value: 'AKIAABCDEFGHIJKLMNOP', enabled: true }, { key: 'X-Api-Key', value: '{{apiKey}}', enabled: true }],
    auth: { type: 'bearer', bearer: { token: 'literal-token-value' } },
    body: { mode: 'raw', raw: '{"key":"sk_live_abcdefghijklmnop1234"}' },
    testScript: "const t = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';",
  });
  const r2 = newRequestItem('Safe', { url: '{{base}}/x', headers: [{ key: 'Authorization', value: 'Bearer {{token}}', enabled: true }], auth: { type: 'bearer', bearer: { token: '{{token}}' } } });
  col.items.push(r1, r2);
  const env = newEnvironment('Prod');
  env.values = [
    { key: 'password', value: 'p@ss', enabled: true },
    { key: 'apiKey', value: 'k', enabled: true, secret: true },
    { key: 'orders_url', value: 'http://x', enabled: true, discovered: 's' },
    { key: 'base', value: 'http://x', enabled: true },
  ];
  const f = scanWorkspace({ collections: [col], environments: [env], globals: [] });
  const types = f.map((x) => x.type);
  for (const t of ['Password in URL', '"api_key" query parameter', 'Plain-text Authorization header', 'AWS access key', 'Plain-text bearer token', 'Stripe key', 'GitHub token', 'Sensitive-looking variable not marked secret']) {
    assert.ok(types.includes(t), `missing ${t}: ${types.join(' | ')}`);
  }
  assert.ok(!f.some((x) => x.where.includes('Safe')), 'variable references must not be flagged');
  assert.ok(!f.some((x) => x.field === 'Variable apiKey' || x.field === 'Variable orders_url' || x.field === 'Variable base'));
  assert.strictEqual(f[0].severity, 'high');
  const header = f.find((x) => x.type === 'Plain-text Authorization header');
  assert.deepStrictEqual(header.fix, { kind: 'move-to-variable', nodeId: r1.id, target: 'header', index: 0, suggestedName: 'login_authorization' });
  assert.ok(!JSON.stringify(f).includes('hunter2') && !JSON.stringify(f).includes('literal-token-value'), 'previews must be masked');
});

// ---- Audit log ----------------------------------------------------------------------------

test('audit log appends, filters, rotates and never stores query values', () => {
  const file = path.join(tmp(), 'audit.log');
  const log = new AuditLog(file, { maxBytes: 400, user: () => 'resti' });
  log.append('lock.unlock', { ok: true });
  log.append('request.send', { method: 'GET', target: safeTarget('https://api.x.com:8443/v1/users?token=SECRET'), status: 200 });
  const all = log.read();
  assert.strictEqual(all[0].event, 'request.send');
  assert.strictEqual(all[0].target, 'api.x.com:8443/v1/users');
  assert.strictEqual(all[1].user, 'resti');
  assert.ok(!fs.readFileSync(file, 'utf8').includes('SECRET'));
  for (let i = 0; i < 20; i++) log.append('request.send', { i });
  assert.ok(fs.existsSync(`${file}.1`));
  assert.strictEqual(log.read({ event: 'lock' }).length <= 1, true);
  assert.ok(log.read({ text: '"i":19' }).length === 1);
  log.clear();
  assert.strictEqual(log.read().length, 0);
});
