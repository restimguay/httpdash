'use strict';

/**
 * Secret scanner: finds credentials stored in plain text in collections, environments and globals.
 *
 * Each finding: { severity: 'high'|'medium'|'low', type, where, field, preview, fix }
 * fix (optional) tells the UI how to repair it:
 *   { kind: 'mark-secret', scope: 'environment'|'globals'|'collection', ownerId, key }
 *   { kind: 'move-to-variable', nodeId, target: 'header'|'auth'|'url-credentials', index?, authType?, field?, suggestedName }
 */

const PATTERNS = [
  { type: 'AWS access key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/, severity: 'high' },
  { type: 'GitHub token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/, severity: 'high' },
  { type: 'Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/, severity: 'high' },
  { type: 'Stripe key', re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/, severity: 'high' },
  { type: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/, severity: 'high' },
  { type: 'Private key', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/, severity: 'high' },
  { type: 'JSON Web Token', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/, severity: 'medium' },
];

const SECRET_AUTH_FIELDS = {
  basic: ['password'], bearer: ['token'], apikey: ['value'], digest: ['password'],
  oauth2: ['accessToken', 'clientSecret', 'password'], awsv4: ['secretKey', 'sessionToken'],
};
const SENSITIVE_HEADER = /^(authorization|proxy-authorization|cookie|x-api-key|api-key|apikey|x-auth-token|x-access-token|x-csrf-token|private-token|x-secret|.*-token|.*-secret|.*-key)$/i;
const SENSITIVE_NAME = /pass(word|wd)?|secret|token|api[-_]?key|apikey|credential|private[-_]?key|auth/i;

const isVarRef = (v) => /^\s*\{\{[^{}]+\}\}\s*$/.test(String(v || ''));
const onlyVarsAndPrefix = (v) => /^\s*(?:[A-Za-z]+\s+)?\{\{[^{}]+\}\}\s*$/.test(String(v || '')); // "Bearer {{token}}"

function mask(v) {
  const s = String(v);
  if (s.length <= 8) return '•'.repeat(s.length);
  return `${s.slice(0, 4)}…${s.slice(-2)} (${s.length} chars)`;
}

const slug = (s) => String(s || 'secret').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'secret';

function patternFindings(text, base) {
  const out = [];
  if (!text || typeof text !== 'string') return out;
  for (const p of PATTERNS) {
    const m = text.match(p.re);
    if (m) out.push({ ...base, severity: p.severity, type: p.type, preview: mask(m[0]) });
  }
  const cred = text.match(/\/\/([^/\s:@{}]+):([^/\s@{}]+)@/);
  if (cred) out.push({ ...base, severity: 'high', type: 'Password in URL', preview: `${cred[1]}:${mask(cred[2])}@` });
  const q = text.match(/[?&](password|passwd|pwd|secret|api_?key|access_?token|token|client_secret)=([^&#{}\s]+)/i);
  if (q) out.push({ ...base, severity: 'medium', type: `"${q[1]}" query parameter`, preview: `${q[1]}=${mask(q[2])}` });
  return out;
}

function scanWorkspace(ws) {
  const findings = [];
  const add = (f) => findings.push({ id: `f${findings.length + 1}`, ...f });

  const scanAuth = (auth, where, nodeId, nodeName) => {
    if (!auth || !SECRET_AUTH_FIELDS[auth.type] || !auth[auth.type]) return;
    for (const field of SECRET_AUTH_FIELDS[auth.type]) {
      const v = auth[auth.type][field];
      if (v && !isVarRef(v)) {
        add({
          severity: 'high', type: `Plain-text ${auth.type} ${field}`, where, field: `Authorization → ${field}`, preview: mask(v),
          fix: { kind: 'move-to-variable', nodeId, target: 'auth', authType: auth.type, field, suggestedName: `${slug(nodeName)}_${slug(field)}` },
        });
      }
    }
  };

  const walk = (node, colName, path) => {
    const where = [colName, ...path, node.type === 'collection' ? null : node.name].filter(Boolean).join(' / ');
    if (node.type === 'request') {
      const r = node.request || {};
      for (const f of patternFindings(r.url, { where, field: 'URL' })) {
        if (f.type === 'Password in URL') f.fix = { kind: 'move-to-variable', nodeId: node.id, target: 'url-credentials', suggestedName: `${slug(node.name)}_password` };
        add(f);
      }
      (r.headers || []).forEach((h, index) => {
        if (!h.key || !h.value || isVarRef(h.value) || onlyVarsAndPrefix(h.value)) return;
        if (SENSITIVE_HEADER.test(h.key)) {
          add({
            severity: 'high', type: `Plain-text ${h.key} header`, where, field: `Header ${h.key}`, preview: mask(h.value),
            fix: { kind: 'move-to-variable', nodeId: node.id, target: 'header', index, suggestedName: `${slug(node.name)}_${slug(h.key)}` },
          });
        } else {
          for (const f of patternFindings(h.value, { where, field: `Header ${h.key}` })) add(f);
        }
      });
      scanAuth(r.auth, where, node.id, node.name);
      const body = r.body || {};
      if (body.mode === 'raw') for (const f of patternFindings(body.raw, { where, field: 'Body' })) add(f);
      for (const list of [body.urlencoded, body.formdata]) {
        for (const kv of list || []) {
          if (kv.value && !isVarRef(kv.value) && SENSITIVE_NAME.test(kv.key || '')) add({ severity: 'medium', type: `Plain-text "${kv.key}" body field`, where, field: `Body ${kv.key}`, preview: mask(kv.value) });
        }
      }
      for (const [field, code] of [['Pre-request script', r.preRequestScript], ['Tests', r.testScript]]) {
        for (const f of patternFindings(code, { where, field })) add(f);
      }
      for (const ex of node.examples || []) {
        for (const [k, v] of ex.headers || []) {
          if (/^set-cookie$|^authorization$/i.test(k)) continue; // Responses legitimately carry these.
          for (const f of patternFindings(v, { where, field: `Example "${ex.name}" header ${k}` })) add(f);
        }
      }
    } else {
      scanAuth(node.auth, where || colName, node.id, node.name);
      for (const [field, code] of [['Pre-request script', node.preRequestScript], ['Tests', node.testScript]]) {
        for (const f of patternFindings(code, { where: where || colName, field: `${node.type === 'collection' ? 'Collection' : 'Folder'} ${field.toLowerCase()}` })) add(f);
      }
      for (const child of node.items || []) walk(child, colName, node.type === 'collection' ? path : [...path, node.name]);
    }
  };
  for (const col of ws.collections || []) walk(col, col.name, []);

  const scanVars = (list, scope, ownerId, where) => {
    for (const v of list || []) {
      if (!v.key || !v.value || v.secret || v.discovered || isVarRef(v.value)) continue;
      const hits = patternFindings(String(v.value), { where, field: `Variable ${v.key}` });
      if (hits.length || SENSITIVE_NAME.test(v.key)) {
        const top = hits[0];
        add({
          severity: top ? top.severity : 'low',
          type: top ? `${top.type} in a variable not marked secret` : 'Sensitive-looking variable not marked secret',
          where, field: `Variable ${v.key}`, preview: mask(v.value),
          fix: { kind: 'mark-secret', scope, ownerId, key: v.key },
        });
      }
    }
  };
  for (const env of ws.environments || []) scanVars(env.values, 'environment', env.id, `Environment ${env.name}`);
  scanVars(ws.globals, 'globals', null, 'Globals');
  for (const col of ws.collections || []) scanVars(col.variables, 'collection', col.id, `Collection ${col.name} variables`);

  const order = { high: 0, medium: 1, low: 2 };
  return findings.sort((a, b) => order[a.severity] - order[b.severity]);
}

module.exports = { scanWorkspace, mask, PATTERNS };
