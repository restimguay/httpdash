'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const format = require('../src/core/repo-format');
const { TeamRepo, sync, finishConflicts, describeChanges } = require('../src/core/gitsync');
const { newCollection, newRequestItem, newEnvironment, newFolder } = require('../src/core/model');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hd-team-'));
const clone = (x) => JSON.parse(JSON.stringify(x));

function bareRepo() {
  const dir = path.join(tmp(), 'team.git');
  execFileSync('git', ['init', '--bare', '-q', '-b', 'main', dir]);
  return dir;
}
const teammate = (url, name, extra = {}) => new TeamRepo({ dir: path.join(tmp(), 'clone'), url, userName: name, ...extra });

function workspace() {
  const col = newCollection('Orders API');
  col.variables = [
    { key: 'base', value: 'https://api.example.com', enabled: true },
    { key: 'apiKey', value: 'sk-live-123', enabled: true, secret: true },
    { key: 'token', value: 'eyJhbGciOi', enabled: true },
  ];
  col.dependency = { mode: 'enabled', requestId: 'x', tokenVar: 'token', expiryVar: 'tokenExpiry' };
  const folder = newFolder('Admin');
  folder.items.push(newRequestItem('Delete order', { method: 'DELETE', url: '{{base}}/orders/1' }));
  col.items.push(newRequestItem('List orders', { url: '{{base}}/orders' }), folder, newRequestItem('Create order', { method: 'POST', url: '{{base}}/orders' }));
  const env = newEnvironment('Staging');
  env.values = [{ key: 'host', value: 'staging.example.com', enabled: true }, { key: 'password', value: 'hunter2', enabled: true, secret: true }];
  return { collections: [col], environments: [env] };
}

// ---- format -------------------------------------------------------------------------------

test('repo format writes one file per request, keeps order and blanks secrets and tokens', () => {
  const root = tmp();
  const ws = workspace();
  format.writeRepo(root, ws);
  const colDir = path.join(root, 'collections', 'orders-api');
  assert.ok(fs.existsSync(path.join(root, 'httpdash.json')));
  assert.ok(fs.existsSync(path.join(colDir, 'list-orders.request.json')));
  assert.ok(fs.existsSync(path.join(colDir, 'admin', 'delete-order.request.json')));
  const meta = JSON.parse(fs.readFileSync(path.join(colDir, '_collection.json'), 'utf8'));
  assert.deepStrictEqual(meta.variables.map((v) => v.value), ['https://api.example.com', '', '']);
  assert.ok(meta.variables[2].localOnly);
  const env = JSON.parse(fs.readFileSync(path.join(root, 'environments', 'staging.json'), 'utf8'));
  assert.strictEqual(env.values[1].value, '');
  assert.ok(!JSON.stringify(fs.readdirSync(root)).includes('hunter2'));

  const back = format.readRepo(root);
  assert.deepStrictEqual(back.problems, []);
  assert.deepStrictEqual(back.collections[0].items.map((i) => i.name), ['List orders', 'Admin', 'Create order']);
  assert.strictEqual(back.collections[0].items[1].items[0].request.method, 'DELETE');
});

test('applying the team copy keeps local secrets and leaves unshared items alone', () => {
  const root = tmp();
  const ws = workspace();
  format.writeRepo(root, ws);
  const team = format.readRepo(root);
  team.collections[0].items[0].name = 'List all orders';
  const mine = newCollection('Private');
  const local = { collections: [...clone(ws.collections), mine], environments: clone(ws.environments) };
  const out = format.applyRepo(local, team, 'r1');
  const col = out.collections.find((c) => c.id === ws.collections[0].id);
  assert.strictEqual(col.team, 'r1');
  assert.strictEqual(col.items[0].name, 'List all orders');
  assert.strictEqual(col.variables.find((v) => v.key === 'apiKey').value, 'sk-live-123');
  assert.strictEqual(col.variables.find((v) => v.key === 'token').value, 'eyJhbGciOi');
  assert.ok(!('localOnly' in col.variables.find((v) => v.key === 'token')));
  assert.strictEqual(out.environments[0].values[1].value, 'hunter2');
  assert.ok(out.collections.includes(mine));
  assert.deepStrictEqual(out.summary.updated, ['collection "Orders API"']);

  // The team deleted the environment: the linked local copy goes too.
  const gone = format.applyRepo({ collections: out.collections, environments: out.environments }, { collections: team.collections, environments: [] }, 'r1');
  assert.strictEqual(gone.environments.length, 0);
  assert.deepStrictEqual(gone.summary.removed, ['environment "Staging"']);
});

// ---- git sync -----------------------------------------------------------------------------

test('two teammates share, pull and edit through a git repository', async () => {
  const url = bareRepo();
  const alice = teammate(url, 'Alice');
  const bob = teammate(url, 'Bob');
  const ws = workspace();

  const first = await sync(alice, ws, { message: 'Share Orders API' });
  assert.ok(first.committed && first.pushed);
  assert.deepStrictEqual(first.status, { ahead: 0, behind: 0 });

  // Bob starts empty and gets everything.
  const got = await sync(bob, null, { pullOnly: true });
  assert.strictEqual(got.team.collections[0].name, 'Orders API');
  let bobWs = format.applyRepo({ collections: [], environments: [] }, got.team, 'r1');
  assert.strictEqual(bobWs.summary.added.length, 2);
  assert.strictEqual(bobWs.collections[0].variables.find((v) => v.key === 'apiKey').value, '');

  // Bob adds a request, Alice renames another: both changes merge without conflict.
  bobWs.collections[0].items.push(newRequestItem('Cancel order', { method: 'POST' }));
  const bobPush = await sync(bob, bobWs, { message: 'Add cancel' });
  assert.ok(bobPush.pushed);
  const aliceWs = clone(ws);
  aliceWs.collections[0].items[2].name = 'Create an order';
  const aliceSync = await sync(alice, aliceWs, { message: 'Rename' });
  assert.ok(aliceSync.merged && aliceSync.pushed);
  const names = aliceSync.team.collections[0].items.map((i) => i.name);
  assert.deepStrictEqual(names.sort(), ['Admin', 'Cancel order', 'Create an order', 'List orders']);

  const log = await alice.log();
  assert.ok(log.some((c) => c.author === 'Bob' && c.subject === 'Add cancel'));
  assert.ok(!execFileSync('git', ['log', '-p', '--all'], { cwd: url }).toString().includes('sk-live-123'));
});

test('conflicting edits can be resolved with either side', async () => {
  const url = bareRepo();
  const alice = teammate(url, 'Alice');
  const bob = teammate(url, 'Bob');
  const ws = workspace();
  await sync(alice, ws);
  const bobWs = format.applyRepo({ collections: [], environments: [] }, (await sync(bob, null, { pullOnly: true })).team, 'r1');

  bobWs.collections[0].items[0].request.url = '{{base}}/v2/orders';
  await sync(bob, bobWs, { message: 'v2' });
  const aliceWs = clone(ws);
  aliceWs.collections[0].items[0].request.url = '{{base}}/v3/orders';
  const clash = await sync(alice, aliceWs, { message: 'v3' });
  assert.deepStrictEqual(clash.conflicts, ['collections/orders-api/list-orders.request.json']);

  const done = await finishConflicts(alice, 'team');
  assert.ok(done.pushed);
  assert.strictEqual(done.team.collections[0].items[0].request.url, '{{base}}/v2/orders');

  // And the other way round.
  aliceWs.collections[0].items[0].request.url = '{{base}}/v4/orders';
  await sync(alice, aliceWs);
  bobWs.collections[0].items[0].request.url = '{{base}}/v5/orders';
  const clash2 = await sync(bob, bobWs);
  assert.strictEqual(clash2.conflicts.length, 1);
  const mine = await finishConflicts(bob, 'mine');
  assert.strictEqual(mine.team.collections[0].items[0].request.url, '{{base}}/v5/orders');

  // An aborted merge leaves the clone usable.
  aliceWs.collections[0].items[0].request.url = '{{base}}/v6/orders';
  const again = await sync(alice, aliceWs);
  assert.strictEqual(again.conflicts.length, 1);
  await alice.abortMerge();
  const pulled = await finishConflicts(alice, 'team').catch(() => null);
  assert.strictEqual(pulled, null); // nothing to resolve after the abort
  await alice.ensureClone();
  assert.ok(!fs.existsSync(path.join(alice.dir, '.git', 'MERGE_HEAD')));
});

test('a subfolder keeps the workspace inside part of an existing repository', async () => {
  const url = bareRepo();
  const owner = teammate(url, 'Owner');
  await owner.ensureClone();
  fs.writeFileSync(path.join(owner.dir, 'app.js'), 'console.log(1)\n');
  await owner.git(['add', '-A']);
  await owner.git(['commit', '-m', 'app']);
  await owner.push();

  const dev = teammate(url, 'Dev', { subdir: 'api/httpdash' });
  const res = await sync(dev, workspace());
  assert.ok(res.pushed);
  assert.ok(fs.existsSync(path.join(dev.dir, 'app.js')));
  assert.ok(fs.existsSync(path.join(dev.dir, 'api', 'httpdash', 'collections', 'orders-api', '_collection.json')));
  assert.strictEqual(res.team.collections.length, 1);
});

test('git errors are reported in plain words', async () => {
  const repo = teammate(path.join(tmp(), 'missing.git'), 'X');
  await assert.rejects(sync(repo, workspace()), /not found|does not appear|could not read|repository/i);
  assert.match(await TeamRepo.version(), /^git version/);
});

test('your own unchanged items are not reported as teammates\' changes', () => {
  const root = tmp();
  const ws = workspace();
  ws.collections[0].items[0].examples = []; // the app creates requests with an empty examples list
  format.writeRepo(root, ws);
  const out = format.applyRepo(clone(ws), format.readRepo(root), 'r1');
  assert.deepStrictEqual(out.summary, { added: [], updated: [], removed: [] });
});

test('commits without a message get a summary of what changed', () => {
  assert.strictEqual(describeChanges('M  collections/orders-api/health.request.json\nA  collections/orders-api/cancel-order.request.json\nD  environments/staging.json\nM  README.md\n'),
    'Add cancel-order; update health; remove staging');
});
