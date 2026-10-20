'use strict';

/**
 * Local audit log: one JSON object per line in audit.log, rotated to audit.log.1 at maxBytes.
 * Records who did what (sign-ins, locks, exports, imports, requests sent, runs, mock servers).
 * Request entries hold the method, host, path and status only: never headers, bodies or query values.
 */
const fs = require('fs');
const path = require('path');

class AuditLog {
  constructor(file, { maxBytes = 5 * 1024 * 1024, user = () => '' } = {}) {
    this.file = file;
    this.maxBytes = maxBytes;
    this.user = user;
  }

  append(event, details = {}) {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      try {
        if (fs.statSync(this.file).size > this.maxBytes) fs.renameSync(this.file, `${this.file}.1`);
      } catch { /* no file yet */ }
      fs.appendFileSync(this.file, `${JSON.stringify({ time: new Date().toISOString(), user: this.user() || undefined, event, ...details })}\n`, { mode: 0o600 });
    } catch {
      // Auditing must never break the app.
    }
  }

  // Newest first. filter: { text, event, limit }
  read({ text = '', event = '', limit = 1000 } = {}) {
    const lines = [];
    for (const f of [this.file, `${this.file}.1`]) {
      try { lines.push(...fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).reverse()); } catch { /* missing */ }
    }
    const needle = text.toLowerCase();
    const out = [];
    for (const line of lines) {
      let e;
      try { e = JSON.parse(line); } catch { continue; }
      if (event && !e.event.startsWith(event)) continue;
      if (needle && !line.toLowerCase().includes(needle)) continue;
      out.push(e);
      if (out.length >= limit) break;
    }
    return out;
  }

  clear() {
    for (const f of [this.file, `${this.file}.1`]) { try { fs.unlinkSync(f); } catch { /* missing */ } }
  }
}

// "https://api.example.com:8443/v1/users?id=5" -> "api.example.com:8443/v1/users" (no query values).
function safeTarget(url) {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return String(url || '').split('?')[0].slice(0, 200);
  }
}

module.exports = { AuditLog, safeTarget };
