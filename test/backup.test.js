'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { makeBackup, restore, stripSecrets, mergeCookies } = require('../src/core/backup');
const postman = require('../src/core/postman');
const { newCollection, newRequestItem, newEnvironment } = require('../src/core/model');

function workspace() {
  const col = newCollection('Shop');
  col.auth = { type: 'bearer', bearer: { token: '{{token}}' } };
  const login = newRequestItem('Login', { auth: { type: 'basic', basic: { username: 'me', password: 'hunter2' } } });
  const other = newRequestItem('Keyed', { auth: { type: 'apikey', apikey: { key: 'X-Key', value: 'literal-key', in: 'header' } } });
  col.items.push(login, other);
  col.dependency = { mode: 'enabled', requestId: login.id, tokenVar: 'token', expiryVar: 'tokenExpiresAt' };
  col.variables = [{ key: 'base', value: 'http://x', enabled: true }, { key: 'colSecret', value: 's', enabled: true, secret: true }];
  const env = newEnvironment('Staging');
  env.values = [{ key: 'token', value: 'tok-1', enabled: true }, { key: 'tokenExpiresAt', value: '123', enabled: true },
    { key: 'apiKey', value: 'k', enabled: true, secret: true }, { key: 'orders_url', value: 'http://o', enabled: true, discovered: 'src1' }];
  return {
    collections: [col], environments: [env], activeEnvironmentId: env.id,
    globals: [{ key: 'g', value: '1', enabled: true }],
    history: [{ id: 'h1', time: 1, request: { auth: { type: 'bearer', bearer: { token: 'raw-token' } } } }],
    discoverySources: [{ id: 'src1', name: 'Consul', token: 'acl', environmentId: env.id, headers: [{ key: 'Authorization', value: 'x' }] }],
    settings: { timeout: 5, proxy: { password: 'pw' } },
    tabs: [{ id: 't' }],
  };
}

test('backup round-trips through import detection with everything included', () => {
  const ws = workspace();
  const b = makeBackup(ws, [{ name: 'sid', value: '1', domain: 'x', path: '/' }]);
  const detected = postman.importAny(JSON.parse(JSON.stringify(b)));
  assert.strictEqual(detected.kind, 'backup');
  assert.deepStrictEqual(detected.summary, { collections: 1, requests: 2, environments: 1, globals: 1, history: 1, discoverySources: 1, cookies: 1 });
  assert.strictEqual(b.workspace.tabs, undefined);
  assert.strictEqual(b.workspace.environments[0].values[0].value, 'tok-1');
});

test('excluding secrets blanks credentials but keeps variable references and normal values', () => {
  const b = makeBackup(workspace(), [{ name: 'sid' }], { excludeSecrets: true });
  const w = b.workspace;
  assert.strictEqual(b.secretsIncluded, false);
  const env = Object.fromEntries(w.environments[0].values.map((v) => [v.key, v.value]));
  assert.deepStrictEqual(env, { token: '', tokenExpiresAt: '', apiKey: '', orders_url: 'http://o' });
  assert.strictEqual(w.collections[0].auth.bearer.token, '{{token}}');
  assert.strictEqual(w.collections[0].items[0].request.auth.basic.password, '');
  assert.strictEqual(w.collections[0].items[0].request.auth.basic.username, 'me');
  assert.strictEqual(w.collections[0].items[1].request.auth.apikey.value, '');
  assert.deepStrictEqual(w.collections[0].variables.map((v) => v.value), ['http://x', '']);
  assert.strictEqual(w.history[0].request.auth.bearer.token, '');
  assert.strictEqual(w.discoverySources[0].token, '');
  assert.strictEqual(w.discoverySources[0].headers[0].value, '');
  assert.strictEqual(w.settings.proxy.password, '');
  assert.strictEqual(w.cookies, undefined);
  assert.strictEqual(w.globals[0].value, '1');
});

test('replace restores the backup exactly', () => {
  const b = makeBackup(workspace(), []);
  const res = restore({ collections: [newCollection('Old')], environments: [], settings: { theme: 'dark' } }, b, 'replace');
  assert.deepStrictEqual(res.workspace.collections.map((c) => c.name), ['Shop']);
  assert.strictEqual(res.workspace.activeEnvironmentId, b.workspace.environments[0].id);
  assert.strictEqual(res.workspace.settings.theme, 'dark');
  assert.strictEqual(res.workspace.settings.timeout, 5);
});

test('merge into a workspace that already has the same items adds copies with new ids', () => {
  const ws = workspace();
  const b = makeBackup(ws, []);
  ws.globals.push({ key: 'mine', value: 'keep', enabled: true });
  const res = restore(ws, b, 'merge');
  const w = res.workspace;
  assert.deepStrictEqual(w.collections.map((c) => c.name), ['Shop', 'Shop (imported)']);
  const [orig, copy] = w.collections;
  assert.notStrictEqual(copy.id, orig.id);
  assert.notStrictEqual(copy.items[0].id, orig.items[0].id);
  assert.strictEqual(copy.dependency.requestId, copy.items[0].id); // dependency follows the copied Login
  assert.deepStrictEqual(w.environments.map((e) => e.name), ['Staging', 'Staging (imported)']);
  const srcCopy = w.discoverySources[1];
  assert.strictEqual(srcCopy.environmentId, w.environments[1].id);
  assert.strictEqual(w.environments[1].values.find((v) => v.key === 'orders_url').discovered, srcCopy.id);
  assert.strictEqual(w.environments[0].values.find((v) => v.key === 'orders_url').discovered, 'src1');
  assert.deepStrictEqual(w.globals.map((g) => g.key), ['g', 'mine']); // existing keys win, nothing duplicated
  assert.strictEqual(w.history.length, 1); // same history id is not duplicated
  assert.deepStrictEqual(res.added.collections, 1);
});

test('merge into an empty workspace keeps original ids', () => {
  const ws = workspace();
  const res = restore({}, makeBackup(ws, []), 'merge');
  assert.strictEqual(res.workspace.collections[0].id, ws.collections[0].id);
  assert.strictEqual(res.workspace.discoverySources[0].environmentId, ws.environments[0].id);
});

test('cookies merge by name/domain/path', () => {
  const merged = mergeCookies([{ name: 'a', domain: 'x', path: '/', value: '1' }, { name: 'b', domain: 'x', path: '/', value: '1' }], [{ name: 'a', domain: 'x', path: '/', value: '2' }]);
  assert.deepStrictEqual(merged.map((c) => `${c.name}=${c.value}`), ['a=2', 'b=1']);
});

test('stripSecrets leaves a workspace without dependencies intact', () => {
  const ws = { collections: [], environments: [{ values: [{ key: 'x', value: 'y' }] }] };
  stripSecrets(ws);
  assert.strictEqual(ws.environments[0].values[0].value, 'y');
});
