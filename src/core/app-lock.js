'use strict';

/**
 * App lock: HttpDash can require an LDAP sign-in before it shows any data.
 *
 * Stored in its own file (not the workspace, so backups and the renderer cannot change it):
 * { ldap: {…, bindPasswordEnc}, lock: { enabled, allowedUsers, idleMinutes, recoveryHash, recoverySalt },
 *   lastTest: { ok, user, time, configHash }, lastUser }
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ldap = require('./ldap-auth');

const LDAP_FIELDS = ['url', 'startTLS', 'verifyCertificate', 'timeoutMs', 'mode', 'userDnTemplate', 'bindDn', 'searchBase', 'searchFilter', 'groupDn'];
const MAX_FREE_ATTEMPTS = 5;

class LockError extends Error {}

const plainSecret = { encrypt: (s) => Buffer.from(String(s), 'utf8').toString('base64'), decrypt: (s) => Buffer.from(String(s), 'base64').toString('utf8') };

class AppLock {
  constructor({ file, secret = plainSecret, authenticate = ldap.authenticate, now = () => Date.now() }) {
    this.file = file;
    this.secret = secret;
    this.authenticate = authenticate;
    this.now = now;
    this.data = this.read();
    this.locked = !!this.data.lock.enabled;
    this.failures = 0;
    this.blockedUntil = 0;
  }

  read() {
    let d = {};
    try { d = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { /* first run */ }
    return {
      ldap: { mode: 'template', verifyCertificate: true, startTLS: false, timeoutMs: 8000, searchFilter: '(uid={username})', ...(d.ldap || {}) },
      lock: { enabled: false, allowedUsers: [], idleMinutes: 0, ...(d.lock || {}) },
      lastTest: d.lastTest || null,
      lastUser: d.lastUser || '',
    };
  }

  write() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  // The LDAP config with the service password decrypted (only used inside the main process).
  ldapConfig() {
    const cfg = { ...this.data.ldap };
    cfg.bindPassword = cfg.bindPasswordEnc ? this.secret.decrypt(cfg.bindPasswordEnc) : '';
    delete cfg.bindPasswordEnc;
    return cfg;
  }

  configHash() {
    const cfg = this.ldapConfig();
    const parts = [...LDAP_FIELDS.map((k) => cfg[k] === undefined ? null : cfg[k]), cfg.bindPassword];
    return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
  }

  isLocked() { return this.locked; }

  status() {
    const lt = this.data.lastTest;
    return {
      enabled: !!this.data.lock.enabled,
      locked: this.locked,
      configured: !!this.data.ldap.url,
      testedOk: !!(lt && lt.ok && lt.configHash === this.configHash()),
      lastTest: lt ? { ok: lt.ok, user: lt.user, time: lt.time, error: lt.error || null, current: lt.configHash === this.configHash() } : null,
      allowedUsers: this.data.lock.allowedUsers,
      idleMinutes: this.data.lock.idleMinutes,
      lastUser: this.data.lastUser,
      blockedForMs: Math.max(0, this.blockedUntil - this.now()),
    };
  }

  // Settings view of the LDAP config: never returns the service password.
  publicConfig() {
    const { bindPasswordEnc, ...rest } = this.data.ldap;
    return { ...rest, bindPasswordSet: !!bindPasswordEnc };
  }

  assertUnlocked() {
    if (this.locked) throw new LockError('HttpDash is locked.');
  }

  setConfig(cfg) {
    this.assertUnlocked();
    if (this.data.lock.enabled) throw new LockError('Turn the lock off before changing the LDAP settings.');
    const next = {};
    for (const k of LDAP_FIELDS) if (cfg[k] !== undefined) next[k] = cfg[k];
    next.bindPasswordEnc = this.data.ldap.bindPasswordEnc;
    // An empty password field keeps the stored one unless clearBindPassword is set.
    if (cfg.bindPassword) next.bindPasswordEnc = this.secret.encrypt(cfg.bindPassword);
    if (cfg.clearBindPassword) delete next.bindPasswordEnc;
    this.data.ldap = { ...this.data.ldap, ...next };
    if (!next.bindPasswordEnc) delete this.data.ldap.bindPasswordEnc;
    this.write();
    return this.status();
  }

  async test(username, password) {
    this.assertUnlocked();
    const time = this.now();
    try {
      const { dn } = await this.authenticate(this.ldapConfig(), username, password);
      this.data.lastTest = { ok: true, user: String(username).trim(), dn, time, configHash: this.configHash() };
      this.write();
      return { ok: true, dn };
    } catch (e) {
      this.data.lastTest = { ok: false, user: String(username || '').trim(), time, error: e.message, configHash: this.configHash() };
      this.write();
      return { ok: false, error: e.message, step: e.step };
    }
  }

  // Turns the lock on (after a successful test of the current settings) and returns a one-time recovery code.
  enable({ allowedUsers, idleMinutes } = {}) {
    this.assertUnlocked();
    if (!this.status().testedOk) throw new LockError('Test a sign-in with the current LDAP settings first.');
    const code = Array.from({ length: 4 }, () => crypto.randomBytes(4).toString('hex').toUpperCase()).join('-');
    const salt = crypto.randomBytes(16).toString('hex');
    this.data.lock = {
      enabled: true,
      allowedUsers: normalizeUsers(allowedUsers),
      idleMinutes: Math.max(0, Number(idleMinutes) || 0),
      recoverySalt: salt,
      recoveryHash: hashCode(code, salt),
    };
    this.write();
    return { recoveryCode: code, status: this.status() };
  }

  updateLock({ allowedUsers, idleMinutes }) {
    this.assertUnlocked();
    if (allowedUsers !== undefined) this.data.lock.allowedUsers = normalizeUsers(allowedUsers);
    if (idleMinutes !== undefined) this.data.lock.idleMinutes = Math.max(0, Number(idleMinutes) || 0);
    this.write();
    return this.status();
  }

  lock() {
    if (!this.data.lock.enabled) throw new LockError('The lock is not turned on.');
    this.locked = true;
    return this.status();
  }

  checkThrottle() {
    const wait = this.blockedUntil - this.now();
    if (wait > 0) throw new LockError(`Too many failed attempts. Try again in ${Math.ceil(wait / 1000)} seconds.`);
  }

  recordFailure() {
    this.failures++;
    if (this.failures >= MAX_FREE_ATTEMPTS) {
      this.blockedUntil = this.now() + Math.min(300, 30 * (this.failures - MAX_FREE_ATTEMPTS + 1)) * 1000;
    }
  }

  // Checks credentials (allowed users + LDAP). Used to unlock and to turn the lock off.
  async verify(username, password) {
    this.checkThrottle();
    const user = String(username || '').trim();
    if (!user) throw new LockError('Enter a username.');
    if (!password) throw new LockError('Enter a password.');
    const allowed = this.data.lock.allowedUsers;
    if (allowed.length && !allowed.includes(user.toLowerCase())) {
      this.recordFailure();
      throw new LockError('This user is not allowed to unlock HttpDash.');
    }
    try {
      await this.authenticate(this.ldapConfig(), user, password);
    } catch (e) {
      this.recordFailure();
      throw new LockError(e.message);
    }
    this.failures = 0;
    this.blockedUntil = 0;
    this.data.lastUser = user;
    this.write();
  }

  async unlock(username, password) {
    if (!this.locked) return this.status();
    await this.verify(username, password);
    this.locked = false;
    return this.status();
  }

  // Unlocks with the recovery code and turns the lock off (the LDAP server may be unusable).
  recover(code) {
    this.checkThrottle();
    const l = this.data.lock;
    const given = String(code || '').trim().toUpperCase().replace(/\s+/g, '');
    if (!l.enabled || !l.recoveryHash || !given) { this.recordFailure(); throw new LockError('Invalid recovery code.'); }
    const a = Buffer.from(hashCode(given, l.recoverySalt), 'hex');
    const b = Buffer.from(l.recoveryHash, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) { this.recordFailure(); throw new LockError('Invalid recovery code.'); }
    this.failures = 0;
    this.data.lock = { enabled: false, allowedUsers: l.allowedUsers, idleMinutes: l.idleMinutes };
    this.locked = false;
    this.write();
    return this.status();
  }

  async disable(username, password) {
    this.assertUnlocked();
    await this.verify(username, password);
    const l = this.data.lock;
    this.data.lock = { enabled: false, allowedUsers: l.allowedUsers, idleMinutes: l.idleMinutes };
    this.write();
    return this.status();
  }
}

function normalizeUsers(list) {
  const arr = Array.isArray(list) ? list : String(list || '').split(/[,\s]+/);
  return [...new Set(arr.map((u) => String(u).trim().toLowerCase()).filter(Boolean))];
}

function hashCode(code, salt) {
  return crypto.scryptSync(String(code).replace(/-/g, ''), salt, 32).toString('hex');
}

module.exports = { AppLock, LockError, normalizeUsers };
