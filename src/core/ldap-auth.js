'use strict';

/**
 * LDAP sign-in used to unlock HttpDash.
 *
 * Config:
 * {
 *   url: 'ldap://ldap.example.com:389' | 'ldaps://…:636',
 *   startTLS: false,              // upgrade an ldap:// connection with StartTLS
 *   verifyCertificate: true,      // reject self-signed / untrusted certificates
 *   timeoutMs: 8000,
 *   mode: 'template' | 'search',
 *   userDnTemplate: 'uid={username},ou=people,dc=example,dc=com',  // mode 'template'
 *   bindDn, bindPassword,          // mode 'search': service account (empty = anonymous)
 *   searchBase: 'dc=example,dc=com',
 *   searchFilter: '(uid={username})',
 *   groupDn: '',                   // optional: the user must be a member of this group
 * }
 */
const { Client, InvalidCredentialsError } = require('ldapts');

// RFC 4515: escape a value placed inside a search filter.
const escapeFilter = (v) => String(v).replace(/[\\*()\0]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, '0')}`);

// RFC 4514: escape a value placed inside a DN attribute value.
const escapeDn = (v) => String(v)
  .replace(/[\\,+"<>;=\0]/g, (c) => (c === '\0' ? '\\00' : `\\${c}`))
  .replace(/^([ #])/, '\\$1')
  .replace(/ $/, '\\ ');

class LdapAuthError extends Error {
  constructor(message, step) {
    super(message);
    this.step = step;
  }
}

function makeClient(cfg) {
  const url = String(cfg.url || '').trim();
  if (!/^ldaps?:\/\//i.test(url)) throw new LdapAuthError('The server URL must start with ldap:// or ldaps://', 'config');
  const tlsOptions = { rejectUnauthorized: cfg.verifyCertificate !== false };
  return new Client({
    url,
    timeout: cfg.timeoutMs || 8000,
    connectTimeout: cfg.timeoutMs || 8000,
    tlsOptions: /^ldaps:/i.test(url) ? tlsOptions : undefined,
    strictDN: false,
  });
}

async function connect(cfg) {
  const client = makeClient(cfg);
  if (cfg.startTLS && /^ldap:/i.test(cfg.url)) {
    try {
      await client.startTLS({ rejectUnauthorized: cfg.verifyCertificate !== false });
    } catch (e) {
      await safeUnbind(client);
      throw new LdapAuthError(`StartTLS failed: ${e.message}`, 'connect');
    }
  }
  return client;
}

async function safeUnbind(client) {
  try { await client.unbind(); } catch { /* already closed */ }
}

function describe(e, step) {
  if (e instanceof LdapAuthError) return e;
  if (e instanceof InvalidCredentialsError || /invalid credentials|code 49|0x31/i.test(e.message || '')) {
    return new LdapAuthError(step === 'service-bind' ? 'The service account (bind DN / password) was rejected by the server.' : 'Wrong username or password.', step);
  }
  if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT|timeout|connect/i.test(`${e.code || ''} ${e.message || ''}`)) {
    return new LdapAuthError(`Could not reach the LDAP server: ${e.message}`, 'connect');
  }
  if (/certificate|self.signed|CERT_|SSL|TLS/i.test(e.message || '')) {
    return new LdapAuthError(`TLS problem: ${e.message}. Untick "Verify certificate" only for testing.`, 'connect');
  }
  return new LdapAuthError(e.message || String(e), step);
}

/**
 * Verifies a username/password against the directory.
 * Resolves to { dn } on success, rejects with an LdapAuthError otherwise.
 */
async function authenticate(cfg, username, password) {
  username = String(username || '').trim();
  if (!username) throw new LdapAuthError('Enter a username.', 'input');
  // An empty password would be an "unauthenticated bind", which many servers accept.
  if (!password) throw new LdapAuthError('Enter a password.', 'input');

  let userDn;
  if ((cfg.mode || 'template') === 'template') {
    if (!cfg.userDnTemplate || !cfg.userDnTemplate.includes('{username}')) {
      throw new LdapAuthError('The user DN template must contain {username}.', 'config');
    }
    userDn = cfg.userDnTemplate.replace(/\{username\}/g, escapeDn(username));
  } else {
    if (!cfg.searchBase) throw new LdapAuthError('Enter the search base.', 'config');
    const filterTpl = cfg.searchFilter || '(uid={username})';
    if (!filterTpl.includes('{username}')) throw new LdapAuthError('The search filter must contain {username}.', 'config');
    const svc = await connect(cfg);
    try {
      if (cfg.bindDn) {
        try { await svc.bind(cfg.bindDn, cfg.bindPassword || ''); } catch (e) { throw describe(e, 'service-bind'); }
      }
      let entries;
      try {
        ({ searchEntries: entries } = await svc.search(cfg.searchBase, {
          scope: 'sub', filter: filterTpl.replace(/\{username\}/g, escapeFilter(username)), attributes: ['dn'], sizeLimit: 2,
        }));
      } catch (e) {
        if (/size limit/i.test(e.message || '')) throw new LdapAuthError('More than one directory entry matches this username. Make the search filter more specific.', 'search');
        throw describe(e, 'search');
      }
      if (entries.length === 0) throw new LdapAuthError('Wrong username or password.', 'search');
      if (entries.length > 1) throw new LdapAuthError('More than one directory entry matches this username. Make the search filter more specific.', 'search');
      userDn = entries[0].dn;
    } finally {
      await safeUnbind(svc);
    }
  }

  const client = await connect(cfg);
  try {
    try { await client.bind(userDn, password); } catch (e) { throw describe(e, 'bind'); }
    if (cfg.groupDn) {
      let entries;
      try {
        ({ searchEntries: entries } = await client.search(cfg.groupDn, {
          scope: 'base',
          filter: `(|(member=${escapeFilter(userDn)})(uniqueMember=${escapeFilter(userDn)})(memberUid=${escapeFilter(username)}))`,
          attributes: ['dn'],
        }));
      } catch (e) {
        throw describe(e, 'group');
      }
      if (!entries.length) throw new LdapAuthError('Signed in, but this user is not a member of the required group.', 'group');
    }
    return { dn: userDn };
  } catch (e) {
    throw describe(e, 'bind');
  } finally {
    await safeUnbind(client);
  }
}

module.exports = { authenticate, escapeFilter, escapeDn, LdapAuthError };
