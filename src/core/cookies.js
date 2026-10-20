'use strict';

const { URL } = require('url');

// Parses a Set-Cookie header value into a cookie record bound to the request URL.
function parseSetCookie(header, requestUrl) {
  const url = new URL(requestUrl);
  const parts = String(header).split(';');
  const [nameValue, ...attrs] = parts;
  const eq = nameValue.indexOf('=');
  if (eq < 1) return null;
  const cookie = {
    name: nameValue.slice(0, eq).trim(),
    value: nameValue.slice(eq + 1).trim(),
    domain: url.hostname,
    hostOnly: true,
    path: defaultPath(url.pathname),
    expires: null,
    secure: false,
    httpOnly: false,
    sameSite: null,
  };
  for (const attr of attrs) {
    const i = attr.indexOf('=');
    const key = (i === -1 ? attr : attr.slice(0, i)).trim().toLowerCase();
    const val = i === -1 ? '' : attr.slice(i + 1).trim();
    if (key === 'domain' && val) {
      const d = val.replace(/^\./, '').toLowerCase();
      if (!domainMatch(url.hostname, d)) return null; // Reject cookies for foreign domains.
      cookie.domain = d;
      cookie.hostOnly = false;
    } else if (key === 'path' && val.startsWith('/')) cookie.path = val;
    else if (key === 'expires') {
      const t = Date.parse(val);
      if (!Number.isNaN(t) && cookie.expires === null) cookie.expires = t;
    } else if (key === 'max-age') {
      const n = parseInt(val, 10);
      if (!Number.isNaN(n)) cookie.expires = Date.now() + n * 1000;
    } else if (key === 'secure') cookie.secure = true;
    else if (key === 'httponly') cookie.httpOnly = true;
    else if (key === 'samesite') cookie.sameSite = val;
  }
  return cookie;
}

function defaultPath(pathname) {
  if (!pathname || !pathname.startsWith('/')) return '/';
  const idx = pathname.lastIndexOf('/');
  return idx <= 0 ? '/' : pathname.slice(0, idx);
}

function domainMatch(host, domain) {
  host = host.toLowerCase();
  domain = domain.toLowerCase();
  return host === domain || host.endsWith('.' + domain);
}

function pathMatch(reqPath, cookiePath) {
  if (reqPath === cookiePath) return true;
  if (reqPath.startsWith(cookiePath)) {
    return cookiePath.endsWith('/') || reqPath[cookiePath.length] === '/';
  }
  return false;
}

function isExpired(c, now = Date.now()) {
  return c.expires !== null && c.expires !== undefined && c.expires <= now;
}

// Stores cookies (in place) from the Set-Cookie headers of a response.
function storeFromResponse(jar, headers, requestUrl) {
  for (const [k, v] of headers) {
    if (k.toLowerCase() !== 'set-cookie') continue;
    const c = parseSetCookie(v, requestUrl);
    if (!c) continue;
    const idx = jar.findIndex((e) => e.name === c.name && e.domain === c.domain && e.path === c.path);
    if (idx !== -1) jar.splice(idx, 1);
    if (!isExpired(c)) jar.push(c);
  }
  return jar;
}

function cookiesFor(jar, requestUrl) {
  const url = new URL(requestUrl);
  const now = Date.now();
  return jar.filter((c) => {
    if (isExpired(c, now)) return false;
    if (c.secure && url.protocol !== 'https:') return false;
    const hostOk = c.hostOnly ? url.hostname.toLowerCase() === c.domain : domainMatch(url.hostname, c.domain);
    return hostOk && pathMatch(url.pathname || '/', c.path || '/');
  }).sort((a, b) => (b.path || '').length - (a.path || '').length);
}

function cookieHeader(jar, requestUrl) {
  return cookiesFor(jar, requestUrl).map((c) => `${c.name}=${c.value}`).join('; ');
}

module.exports = { parseSetCookie, storeFromResponse, cookiesFor, cookieHeader, isExpired };
