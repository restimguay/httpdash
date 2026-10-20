'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { startServer } = require('./helpers');
const { execute } = require('../src/core/executor');
const runner = require('../src/core/runner');
const { makeLookup, tokenState } = require('../src/core/dependency');
const { newRequestDef, newCollection, newRequestItem, newFolder } = require('../src/core/model');

let srv;
test.before(async () => { srv = await startServer(); });
test.after(() => srv.server.close());

// A collection whose requests use Bearer {{token}} and depend on a "Login" request.
function setup(depOverrides = {}, loginQuery = '') {
  const col = newCollection('Deps');
  col.auth = { type: 'bearer', bearer: { token: '{{token}}' } };
  const login = newRequestItem('Login', { method: 'POST', url: `${srv.base}/login${loginQuery}`, auth: { type: 'none' } });
  const folder = newFolder('API');
  const protectedReq = newRequestItem('Protected', { url: `${srv.base}/protected` });
  folder.items.push(protectedReq);
  col.items.push(login, folder);
  col.dependency = {
    mode: 'enabled', requestId: login.id, when: 'expired', tokenVar: 'token', tokenPath: 'data.access_token',
    expiresInPath: 'data.expires_in', expiryVar: 'tokenExpiresAt', scope: 'environment', skewSeconds: 30, retryOn401: true, ...depOverrides,
  };
  const lookup = makeLookup(col);
  const run = (env, item = protectedReq) => {
    const { chain } = lookup(item.id);
    return execute({ request: item.request, chain, lookup, scopes: { globals: {}, collection: {}, environment: env, data: {} }, info: { requestId: item.id, requestName: item.name } });
  };
  return { col, login, protectedReq, run };
}
const logins = async () => JSON.parse((await execute({ request: newRequestDef({ url: `${srv.base}/stats` }), scopes: { environment: {} } })).response.bodyText).logins;

test('runs the login request when the token is missing and stores token + expiry', async () => {
  const { run } = setup();
  const before = Date.now();
  const res = await run({});
  assert.strictEqual(res.error, undefined);
  assert.strictEqual(res.response.status, 200);
  assert.strictEqual(res.dependencyRuns.length, 1);
  assert.strictEqual(res.dependencyRuns[0].reason, 'missing');
  assert.match(res.scopes.environment.token, /^tok-\d+$/);
  const exp = Number(res.scopes.environment.tokenExpiresAt);
  assert.ok(exp >= before + 3600e3 && exp <= Date.now() + 3600e3);
});

test('skips the login request while the token is still valid', async () => {
  const { run } = setup();
  const first = await run({});
  const n = await logins();
  const second = await run(first.scopes.environment);
  assert.strictEqual(second.response.status, 200);
  assert.strictEqual(second.dependencyRuns.length, 0);
  assert.strictEqual(await logins(), n);
});

test('refreshes when the stored expiry has passed (or is within the skew)', async () => {
  const { run } = setup();
  const first = await run({});
  const env = { ...first.scopes.environment, tokenExpiresAt: String(Date.now() + 10e3) }; // inside the 30s skew
  const res = await run(env);
  assert.strictEqual(res.dependencyRuns[0].reason, 'expired');
  assert.notStrictEqual(res.scopes.environment.token, first.scopes.environment.token);
  assert.strictEqual(res.response.status, 200);
});

test('reads expiry from a JWT exp claim when there is no expiry variable', () => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const jwt = (exp) => `${b64({ alg: 'none' })}.${b64({ exp })}.sig`;
  const cfg = { tokenVar: 'token', skewSeconds: 0 };
  assert.strictEqual(tokenState(cfg, { token: jwt(Math.floor(Date.now() / 1000) - 5) }).reason, 'expired');
  assert.strictEqual(tokenState(cfg, { token: jwt(Math.floor(Date.now() / 1000) + 600) }).valid, true);
  assert.strictEqual(tokenState(cfg, { token: 'opaque' }).valid, true);
  assert.strictEqual(tokenState(cfg, { token: '' }).reason, 'missing');
});

test('retries once after refreshing the token when the request returns 401', async () => {
  const { run } = setup();
  const first = await run({});
  await execute({ request: newRequestDef({ url: `${srv.base}/revoke` }), scopes: { environment: {} } });
  const res = await run(first.scopes.environment);
  assert.strictEqual(res.response.status, 200);
  assert.strictEqual(res.dependencyRuns.length, 1);
  assert.strictEqual(res.dependencyRuns[0].reason, '401');
});

test('does not retry on 401 when retryOn401 is off', async () => {
  const { run } = setup({ retryOn401: false });
  const first = await run({});
  await execute({ request: newRequestDef({ url: `${srv.base}/revoke` }), scopes: { environment: {} } });
  const res = await run(first.scopes.environment);
  assert.strictEqual(res.response.status, 401);
  assert.strictEqual(res.dependencyRuns.length, 0);
});

test('a failing login stops the request with a clear error', async () => {
  const { run } = setup({}, '?fail=1');
  const res = await run({});
  assert.match(res.error, /Auth dependency "Login" failed: returned 401/);
  assert.strictEqual(res.response, undefined);
  const bad = setup({ tokenPath: 'nope.token' });
  const res2 = await bad.run({});
  assert.match(res2.error, /no value at "nope.token"/);
});

test('"always" runs the dependency before every request; the login request never depends on itself', async () => {
  const { run, login } = setup({ when: 'always' });
  const a = await run({});
  const b = await run(a.scopes.environment);
  assert.strictEqual(b.dependencyRuns[0].reason, 'always');
  const self = await run({}, login);
  assert.strictEqual(self.dependencyRuns.length, 0);
  assert.strictEqual(self.response.status, 200);
});

test('a request can opt out, and folders can override the collection', async () => {
  const { col, protectedReq, run } = setup();
  protectedReq.request.dependency = { mode: 'none' };
  const res = await run({});
  assert.strictEqual(res.dependencyRuns.length, 0);
  assert.strictEqual(res.response.status, 401);
  delete protectedReq.request.dependency;
  col.items[1].dependency = { mode: 'none' };
  assert.strictEqual((await run({})).dependencyRuns.length, 0);
});

test('collection runner logs in once and reuses the token across iterations', async () => {
  const { col, login } = setup();
  const n = await logins();
  const env = {};
  const summary = await runner.run({ collection: col, excluded: [login.id], iterations: 3, scopes: { globals: {}, environment: env }, jar: [] });
  assert.strictEqual(summary.requests, 3);
  assert.deepStrictEqual(summary.results.map((r) => r.status), [200, 200, 200]);
  assert.deepStrictEqual(summary.results.map((r) => r.dependencyRuns.length), [1, 0, 0]);
  assert.strictEqual(await logins(), n + 1);
  assert.match(env.token, /^tok-/);
});

test('re-importing a native collection keeps dependencies pointing at the copied login request', () => {
  const postman = require('../src/core/postman');
  const { col, login } = setup();
  const { data } = postman.importAny(JSON.parse(JSON.stringify(col)));
  const newLogin = data.items.find((i) => i.name === 'Login');
  assert.notStrictEqual(newLogin.id, login.id);
  assert.strictEqual(data.dependency.requestId, newLogin.id);
});
