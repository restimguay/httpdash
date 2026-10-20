'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ldapjs = require('ldapjs');
const { authenticate, escapeFilter, escapeDn } = require('../src/core/ldap-auth');
const { AppLock } = require('../src/core/app-lock');

// A small OpenLDAP-like directory served by ldapjs (test-only dependency).
const BASE = 'dc=example,dc=com';
const norm = (dn) => String(dn).toLowerCase().replace(/\s*,\s*/g, ',');
const entries = [
  { dn: 'uid=alice,ou=people,dc=example,dc=com', attributes: { objectclass: ['inetOrgPerson'], uid: 'alice', cn: 'Alice' }, password: 'wonderland' },
  { dn: 'uid=bob,ou=staff,ou=people,dc=example,dc=com', attributes: { objectclass: ['inetOrgPerson'], uid: 'bob', cn: 'Bob' }, password: 'builder' },
  { dn: 'uid=svc,ou=system,dc=example,dc=com', attributes: { objectclass: ['account'], uid: 'svc' }, password: 'svc-secret' },
  { dn: 'cn=api-admins,ou=groups,dc=example,dc=com', attributes: { objectclass: ['groupOfNames'], cn: 'api-admins', member: ['uid=alice,ou=people,dc=example,dc=com'] } },
];
let server;
let url;
test.before(async () => {
  server = ldapjs.createServer();
  server.bind(BASE, (req, res, next) => {
    const e = entries.find((x) => norm(x.dn) === norm(req.dn.toString()));
    if (e && e.password && req.credentials === e.password) { res.end(); return next(); }
    return next(new ldapjs.InvalidCredentialsError());
  });
  server.search(BASE, (req, res, next) => {
    const base = norm(req.dn.toString());
    for (const e of entries) {
      const dn = norm(e.dn);
      const inScope = req.scope === 'base' ? dn === base : dn === base || dn.endsWith(`,${base}`);
      if (inScope && req.filter.matches(e.attributes)) res.send({ dn: e.dn, attributes: e.attributes });
    }
    res.end();
    return next();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  url = `ldap://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const template = () => ({ url, mode: 'template', userDnTemplate: 'uid={username},ou=people,dc=example,dc=com' });
const search = (extra = {}) => ({ url, mode: 'search', bindDn: 'uid=svc,ou=system,dc=example,dc=com', bindPassword: 'svc-secret', searchBase: 'ou=people,dc=example,dc=com', searchFilter: '(uid={username})', ...extra });

test('escaping follows RFC 4515 / 4514', () => {
  assert.strictEqual(escapeFilter('a*b(c)\\'), 'a\\2ab\\28c\\29\\5c');
  assert.strictEqual(escapeDn('x,y=z'), 'x\\,y\\=z');
});

test('template mode: correct password signs in, wrong password and empty password do not', async () => {
  assert.deepStrictEqual(await authenticate(template(), 'alice', 'wonderland'), { dn: 'uid=alice,ou=people,dc=example,dc=com' });
  await assert.rejects(authenticate(template(), 'alice', 'nope'), /Wrong username or password/);
  await assert.rejects(authenticate(template(), 'alice', ''), /Enter a password/);
  await assert.rejects(authenticate({ ...template(), userDnTemplate: 'ou=people' }, 'alice', 'x'), /must contain \{username\}/);
});

test('search mode finds users in nested branches via the service account', async () => {
  assert.strictEqual((await authenticate(search(), 'bob', 'builder')).dn, 'uid=bob,ou=staff,ou=people,dc=example,dc=com');
  await assert.rejects(authenticate(search(), 'nobody', 'x'), /Wrong username or password/);
  await assert.rejects(authenticate(search({ bindPassword: 'bad' }), 'bob', 'builder'), /service account/);
});

test('filter injection cannot match other users', async () => {
  await assert.rejects(authenticate(search(), '*', 'builder'), /Wrong username or password/);
  await assert.rejects(authenticate(search(), 'b*', 'builder'), /Wrong username or password/);
  await assert.rejects(authenticate(search({ searchFilter: '(&(objectClass=inetOrgPerson)(uid={username}))' }), 'x)(uid=*', 'builder'), /Wrong username or password/);
});

test('group membership is enforced when a group DN is set', async () => {
  const cfg = search({ groupDn: 'cn=api-admins,ou=groups,dc=example,dc=com' });
  assert.ok(await authenticate(cfg, 'alice', 'wonderland'));
  await assert.rejects(authenticate(cfg, 'bob', 'builder'), /not a member of the required group/);
});

test('unreachable server gives a clear error', async () => {
  await assert.rejects(authenticate({ ...template(), url: 'ldap://127.0.0.1:1', timeoutMs: 2000 }, 'alice', 'wonderland'), /Could not reach the LDAP server/);
  await assert.rejects(authenticate({ ...template(), url: 'http://x' }, 'alice', 'x'), /ldap:\/\//);
});

function newLock(clock = { t: 1e12 }) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hd-lock-')), 'security.json');
  return { lock: new AppLock({ file, now: () => clock.t }), file, clock };
}

test('app lock: test first, enable, lock, unlock, allowed users, persistence', async () => {
  const { lock, file } = newLock();
  lock.setConfig(search({ bindPassword: 'svc-secret' }));
  assert.throws(() => lock.enable({}), /Test a sign-in/);
  assert.strictEqual((await lock.test('bob', 'wrong')).ok, false);
  assert.throws(() => lock.enable({}), /Test a sign-in/);
  assert.strictEqual((await lock.test('bob', 'builder')).ok, true);
  const { recoveryCode } = lock.enable({ allowedUsers: 'Bob, alice' });
  assert.match(recoveryCode, /^[0-9A-F]{8}(-[0-9A-F]{8}){3}$/);
  assert.throws(() => lock.setConfig({ url: 'ldap://other' }), /Turn the lock off/);

  // The service password is not stored in plain text, and is never returned to the UI.
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes('svc-secret'));
  assert.strictEqual(lock.publicConfig().bindPassword, undefined);
  assert.strictEqual(lock.publicConfig().bindPasswordSet, true);

  lock.lock();
  await assert.rejects(lock.test('bob', 'builder'), /locked/);
  await assert.rejects(lock.unlock('bob', 'nope'), /Wrong username or password/);
  await assert.rejects(lock.unlock('carol', 'x'), /not allowed/);
  await lock.unlock('bob', 'builder');
  assert.strictEqual(lock.isLocked(), false);

  // A restart starts locked.
  const again = new AppLock({ file });
  assert.strictEqual(again.isLocked(), true);
  assert.strictEqual(again.status().lastUser, 'bob');
});

test('app lock: repeated failures are throttled', async () => {
  const { lock, clock } = newLock();
  lock.setConfig(template());
  await lock.test('alice', 'wonderland');
  lock.enable({});
  lock.lock();
  for (let i = 0; i < 5; i++) await assert.rejects(lock.unlock('alice', 'bad'), /Wrong username/);
  await assert.rejects(lock.unlock('alice', 'wonderland'), /Too many failed attempts/);
  clock.t += 31000;
  await lock.unlock('alice', 'wonderland');
  assert.strictEqual(lock.isLocked(), false);
});

test('app lock: recovery code unlocks and turns the lock off; disabling needs a sign-in', async () => {
  const { lock } = newLock();
  lock.setConfig(template());
  await lock.test('alice', 'wonderland');
  const { recoveryCode } = lock.enable({});
  lock.lock();
  assert.throws(() => lock.recover('0000-0000'), /Invalid recovery code/);
  lock.recover(recoveryCode.toLowerCase());
  assert.deepStrictEqual([lock.isLocked(), lock.status().enabled], [false, false]);

  await lock.test('alice', 'wonderland');
  lock.enable({});
  await assert.rejects(lock.disable('alice', 'bad'), /Wrong username/);
  await lock.disable('alice', 'wonderland');
  assert.strictEqual(lock.status().enabled, false);
});

test('changing the LDAP settings invalidates an earlier successful test', async () => {
  const { lock } = newLock();
  lock.setConfig(template());
  await lock.test('alice', 'wonderland');
  assert.strictEqual(lock.status().testedOk, true);
  lock.setConfig({ groupDn: 'cn=api-admins,ou=groups,dc=example,dc=com' });
  assert.strictEqual(lock.status().testedOk, false);
});

test('empty username or password is rejected without counting as a failed attempt', async () => {
  const { lock } = newLock();
  lock.setConfig(template());
  await lock.test('alice', 'wonderland');
  lock.enable({});
  lock.lock();
  for (let i = 0; i < 8; i++) await assert.rejects(lock.unlock('', 'x'), /Enter a username/);
  await assert.rejects(lock.unlock('alice', ''), /Enter a password/);
  await lock.unlock('alice', 'wonderland');
  assert.strictEqual(lock.isLocked(), false);
});
