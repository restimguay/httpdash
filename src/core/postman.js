'use strict';

// Import/export of Postman collection (v2.0 / v2.1) and environment files, plus OpenAPI/Swagger JSON import.
const { uid, newRequestDef, newCollection, newFolder, newEnvironment } = require('./model');
const { paramsFromUrl } = require('./curl');

const SCHEMA_V21 = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

const text = (d) => (d == null ? '' : typeof d === 'string' ? d : d.content || '');
const kv = (list) => (Array.isArray(list) ? list : []).map((i) => ({
  key: i.key || '', value: i.value == null ? '' : typeof i.value === 'string' ? i.value : JSON.stringify(i.value),
  enabled: !i.disabled, description: text(i.description),
}));

// ---- Import -------------------------------------------------------------------------------

function importAuth(auth) {
  if (auth === undefined || auth === null) return { type: 'inherit' };
  const type = auth.type === 'noauth' ? 'none' : auth.type;
  const params = auth[auth.type];
  const obj = {};
  if (Array.isArray(params)) for (const p of params) obj[p.key] = p.value;
  else if (params && typeof params === 'object') Object.assign(obj, params);
  const out = { type };
  if (type === 'apikey') out.apikey = { key: obj.key || '', value: obj.value || '', in: obj.in || 'header' };
  else if (type === 'oauth2') out.oauth2 = { accessToken: obj.accessToken || '', addTo: obj.addTokenTo === 'queryParams' ? 'query' : 'header', headerPrefix: obj.headerPrefix || 'Bearer', grantType: obj.grant_type || 'client_credentials', accessTokenUrl: obj.accessTokenUrl || '', clientId: obj.clientId || '', clientSecret: obj.clientSecret || '', scope: obj.scope || '', username: obj.username || '', password: obj.password || '' };
  else if (type === 'awsv4') out.awsv4 = { accessKey: obj.accessKey || '', secretKey: obj.secretKey || '', region: obj.region || '', service: obj.service || '', sessionToken: obj.sessionToken || '' };
  else if (['basic', 'bearer', 'digest'].includes(type)) out[type] = obj;
  else if (type !== 'none') return { type: 'none' }; // Unsupported auth types (ntlm, hawk, ...) fall back to none.
  return out;
}

function importScripts(events) {
  const out = { preRequestScript: '', testScript: '' };
  for (const e of events || []) {
    const exec = e.script && e.script.exec;
    const code = Array.isArray(exec) ? exec.join('\n') : exec || '';
    if (e.listen === 'prerequest') out.preRequestScript = code;
    if (e.listen === 'test') out.testScript = code;
  }
  return out;
}

function importUrl(url) {
  if (!url) return { url: '', params: [], pathVariables: [] };
  if (typeof url === 'string') return { url, params: paramsFromUrl(url), pathVariables: [] };
  let raw = url.raw;
  if (!raw) {
    const host = Array.isArray(url.host) ? url.host.join('.') : url.host || '';
    const p = Array.isArray(url.path) ? url.path.join('/') : url.path || '';
    const q = (url.query || []).filter((x) => !x.disabled).map((x) => `${x.key}=${x.value || ''}`).join('&');
    raw = `${url.protocol ? url.protocol + '://' : ''}${host}${url.port ? ':' + url.port : ''}${p ? '/' + p : ''}${q ? '?' + q : ''}`;
  }
  const params = url.query ? kv(url.query) : paramsFromUrl(raw);
  return { url: raw, params, pathVariables: kv(url.variable) };
}

function importBody(body) {
  const def = newRequestDef().body;
  if (!body || !body.mode) return def;
  const out = { ...def, mode: body.mode };
  if (body.mode === 'raw') {
    out.raw = body.raw || '';
    out.rawLanguage = (body.options && body.options.raw && body.options.raw.language) || (/^\s*[{[]/.test(out.raw) ? 'json' : 'text');
  } else if (body.mode === 'urlencoded') out.urlencoded = kv(body.urlencoded);
  else if (body.mode === 'formdata') {
    out.formdata = (body.formdata || []).map((i) => ({ key: i.key || '', value: i.value || '', type: i.type === 'file' ? 'file' : 'text', src: i.src || '', enabled: !i.disabled, contentType: i.contentType || '' }));
  } else if (body.mode === 'file') {
    out.mode = 'binary';
    out.binary = (body.file && body.file.src) || '';
  } else if (body.mode === 'graphql') {
    out.graphql = { query: (body.graphql && body.graphql.query) || '', variables: (body.graphql && body.graphql.variables) || '' };
  } else out.mode = 'none';
  return out;
}

function importItem(item) {
  if (Array.isArray(item.item)) {
    const folder = newFolder(item.name || 'Folder');
    folder.description = text(item.description);
    folder.auth = importAuth(item.auth);
    Object.assign(folder, importScripts(item.event));
    folder.items = item.item.map(importItem);
    return folder;
  }
  const r = typeof item.request === 'string' ? { url: item.request, method: 'GET' } : item.request || {};
  const def = newRequestDef({
    method: (r.method || 'GET').toUpperCase(),
    ...importUrl(r.url),
    headers: typeof r.header === 'string' ? [] : kv(r.header),
    body: importBody(r.body),
    auth: importAuth(r.auth),
    description: text(r.description || item.description),
    ...importScripts(item.event),
  });
  const examples = (item.response || []).map((ex) => ({
    id: uid(), name: ex.name || 'Example', status: ex.code || 0, statusText: ex.status || '',
    headers: (ex.header || []).map((h) => [h.key, h.value]), body: ex.body || '',
  }));
  return { id: uid(), type: 'request', name: item.name || 'Request', request: def, examples };
}

function importPostmanCollection(json) {
  if (!json.info || !Array.isArray(json.item)) throw new Error('Not a Postman collection');
  const col = newCollection(json.info.name || 'Imported Collection');
  col.description = text(json.info.description);
  col.auth = importAuth(json.auth);
  if (col.auth.type === 'inherit') col.auth = { type: 'none' };
  Object.assign(col, importScripts(json.event));
  col.variables = kv(json.variable);
  col.items = json.item.map(importItem);
  return col;
}

function importPostmanEnvironment(json) {
  const env = newEnvironment(json.name || 'Imported Environment');
  env.values = (json.values || []).map((v) => ({ key: v.key, value: v.value == null ? '' : String(v.value), enabled: v.enabled !== false, secret: v.type === 'secret' }));
  return env;
}

// Imports OpenAPI 3 / Swagger 2 JSON documents as a collection with one folder per tag.
function importOpenApi(doc) {
  const col = newCollection((doc.info && doc.info.title) || 'OpenAPI Import');
  col.description = (doc.info && doc.info.description) || '';
  let baseUrl = '';
  if (doc.openapi && doc.servers && doc.servers[0]) {
    baseUrl = doc.servers[0].url;
    for (const [k, v] of Object.entries(doc.servers[0].variables || {})) baseUrl = baseUrl.replace(`{${k}}`, v.default);
  } else if (doc.swagger) {
    baseUrl = `${(doc.schemes && doc.schemes[0]) || 'https'}://${doc.host || 'localhost'}${doc.basePath || ''}`;
  }
  col.variables = [{ key: 'baseUrl', value: baseUrl.replace(/\/$/, ''), enabled: true }];
  const folders = new Map();
  const resolveRef = (o) => {
    if (o && o.$ref) {
      const parts = o.$ref.replace(/^#\//, '').split('/');
      return parts.reduce((acc, p) => (acc ? acc[p] : undefined), doc) || {};
    }
    return o || {};
  };
  const sample = (schema, depth = 0) => {
    schema = resolveRef(schema);
    if (depth > 6) return null;
    if (schema.example !== undefined) return schema.example;
    if (schema.enum) return schema.enum[0];
    if (schema.allOf) return Object.assign({}, ...schema.allOf.map((s) => sample(s, depth + 1)));
    if (schema.oneOf || schema.anyOf) return sample((schema.oneOf || schema.anyOf)[0], depth + 1);
    switch (schema.type) {
      case 'object': case undefined: {
        if (!schema.properties) return schema.type ? {} : null;
        return Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, sample(v, depth + 1)]));
      }
      case 'array': return [sample(schema.items, depth + 1)];
      case 'integer': case 'number': return 0;
      case 'boolean': return true;
      default: return schema.format === 'date-time' ? new Date(0).toISOString() : 'string';
    }
  };

  for (const [p, ops] of Object.entries(doc.paths || {})) {
    for (const [method, op] of Object.entries(ops)) {
      if (!['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(method)) continue;
      const params = [...(ops.parameters || []), ...(op.parameters || [])].map(resolveRef);
      const query = params.filter((x) => x.in === 'query').map((x) => ({ key: x.name, value: '', enabled: !!x.required, description: x.description || '' }));
      const headers = params.filter((x) => x.in === 'header').map((x) => ({ key: x.name, value: '', enabled: true, description: x.description || '' }));
      const pathVariables = params.filter((x) => x.in === 'path').map((x) => ({ key: x.name, value: '', enabled: true, description: x.description || '' }));
      const pathPart = p.replace(/\{([^}]+)\}/g, ':$1');
      const qs = query.filter((q) => q.enabled).map((q) => `${q.key}=`).join('&');
      const def = newRequestDef({
        method: method.toUpperCase(), url: `{{baseUrl}}${pathPart}${qs ? '?' + qs : ''}`, params: query, headers, pathVariables,
        description: op.description || op.summary || '',
      });
      if (op.requestBody) {
        const content = resolveRef(op.requestBody).content || {};
        const json = content['application/json'];
        if (json) {
          def.body.mode = 'raw';
          def.body.rawLanguage = 'json';
          def.body.raw = JSON.stringify(json.example || sample(json.schema), null, 2);
          def.headers.push({ key: 'Content-Type', value: 'application/json', enabled: true });
        } else if (content['application/x-www-form-urlencoded']) {
          const s = resolveRef(content['application/x-www-form-urlencoded'].schema);
          def.body.mode = 'urlencoded';
          def.body.urlencoded = Object.keys(s.properties || {}).map((k) => ({ key: k, value: '', enabled: true }));
        } else if (content['multipart/form-data']) {
          const s = resolveRef(content['multipart/form-data'].schema);
          def.body.mode = 'formdata';
          def.body.formdata = Object.entries(s.properties || {}).map(([k, v]) => ({ key: k, value: '', type: v.format === 'binary' ? 'file' : 'text', enabled: true }));
        }
      } else {
        const bodyParam = params.find((x) => x.in === 'body');
        if (bodyParam) {
          def.body.mode = 'raw';
          def.body.rawLanguage = 'json';
          def.body.raw = JSON.stringify(sample(bodyParam.schema), null, 2);
        }
      }
      const item = { id: uid(), type: 'request', name: op.summary || op.operationId || `${method.toUpperCase()} ${p}`, request: def };
      const tag = (op.tags && op.tags[0]) || null;
      if (tag) {
        if (!folders.has(tag)) {
          const f = newFolder(tag);
          folders.set(tag, f);
          col.items.push(f);
        }
        folders.get(tag).items.push(item);
      } else col.items.push(item);
    }
  }
  return col;
}

/** Detects the type of an imported JSON document and converts it. */
function importAny(json) {
  if (json.info && Array.isArray(json.item)) return { kind: 'collection', data: importPostmanCollection(json) };
  if ((json.openapi || json.swagger) && json.paths) return { kind: 'collection', data: importOpenApi(json) };
  if (Array.isArray(json.values) && (json._postman_variable_scope === 'environment' || json.name !== undefined)) {
    if (json._postman_variable_scope === 'globals') return { kind: 'globals', data: importPostmanEnvironment(json).values };
    return { kind: 'environment', data: importPostmanEnvironment(json) };
  }
  if (json.type === 'collection' && Array.isArray(json.items)) return { kind: 'collection', data: reId(json) };
  throw new Error('Unrecognised file format. Supported: Postman collection v2/v2.1, Postman environment, OpenAPI 3 / Swagger 2 (JSON).');
}

// Gives every node of a native collection fresh ids so re-importing never collides.
function reId(node) {
  const copy = JSON.parse(JSON.stringify(node));
  const walk = (n) => { n.id = uid(); (n.items || []).forEach(walk); };
  walk(copy);
  return copy;
}

// ---- Export -------------------------------------------------------------------------------

function exportAuth(auth) {
  if (!auth || auth.type === 'inherit') return undefined;
  if (auth.type === 'none') return { type: 'noauth' };
  const params = { ...(auth[auth.type] || {}) };
  if (auth.type === 'oauth2') {
    params.addTokenTo = params.addTo === 'query' ? 'queryParams' : 'header';
    delete params.addTo;
  }
  return { type: auth.type, [auth.type]: Object.entries(params).map(([key, value]) => ({ key, value, type: 'string' })) };
}

const exportKv = (list) => (list || []).map((i) => {
  const o = { key: i.key, value: i.value };
  if (i.enabled === false) o.disabled = true;
  if (i.description) o.description = i.description;
  return o;
});

function exportEvents(node) {
  const ev = [];
  if (node.preRequestScript) ev.push({ listen: 'prerequest', script: { type: 'text/javascript', exec: node.preRequestScript.split('\n') } });
  if (node.testScript) ev.push({ listen: 'test', script: { type: 'text/javascript', exec: node.testScript.split('\n') } });
  return ev.length ? ev : undefined;
}

function exportUrl(def) {
  const raw = def.url || '';
  const out = { raw };
  const m = raw.match(/^([a-z]+):\/\/([^/?#]*)([^?#]*)/i);
  if (m) {
    out.protocol = m[1];
    out.host = m[2].split('.');
    out.path = m[3].split('/').filter(Boolean);
  } else {
    const [hostPath] = raw.split('?');
    const [host, ...path] = hostPath.split('/');
    out.host = [host];
    out.path = path.filter(Boolean);
  }
  if (def.params && def.params.length) out.query = exportKv(def.params);
  if (def.pathVariables && def.pathVariables.length) out.variable = exportKv(def.pathVariables);
  return out;
}

function exportBody(b) {
  if (!b || b.mode === 'none') return undefined;
  if (b.mode === 'raw') return { mode: 'raw', raw: b.raw || '', options: { raw: { language: b.rawLanguage || 'text' } } };
  if (b.mode === 'urlencoded') return { mode: 'urlencoded', urlencoded: exportKv(b.urlencoded) };
  if (b.mode === 'formdata') {
    return { mode: 'formdata', formdata: (b.formdata || []).map((i) => ({ key: i.key, ...(i.type === 'file' ? { type: 'file', src: i.src } : { type: 'text', value: i.value }), ...(i.enabled === false ? { disabled: true } : {}) })) };
  }
  if (b.mode === 'binary') return { mode: 'file', file: { src: b.binary } };
  if (b.mode === 'graphql') return { mode: 'graphql', graphql: { query: b.graphql.query, variables: b.graphql.variables } };
  return undefined;
}

function exportItem(item) {
  if (item.type === 'folder') {
    return { name: item.name, description: item.description || undefined, item: item.items.map(exportItem), auth: exportAuth(item.auth), event: exportEvents(item) };
  }
  const d = item.request;
  return {
    name: item.name,
    event: exportEvents(d),
    request: { method: d.method, header: exportKv(d.headers), body: exportBody(d.body), url: exportUrl(d), auth: exportAuth(d.auth), description: d.description || undefined },
    response: (item.examples || []).map((ex) => ({ name: ex.name, code: ex.status, status: ex.statusText, header: (ex.headers || []).map(([key, value]) => ({ key, value })), body: ex.body })),
  };
}

function exportCollection(col) {
  return JSON.parse(JSON.stringify({
    info: { _postman_id: col.id, name: col.name, description: col.description || undefined, schema: SCHEMA_V21 },
    item: col.items.map(exportItem),
    auth: exportAuth(col.auth),
    event: exportEvents(col),
    variable: exportKv(col.variables),
  }));
}

function exportEnvironment(env) {
  return {
    id: env.id,
    name: env.name,
    values: env.values.map((v) => ({ key: v.key, value: v.value, type: v.secret ? 'secret' : 'default', enabled: v.enabled !== false })),
    _postman_variable_scope: 'environment',
    _postman_exported_using: 'HttpDash/1.0',
  };
}

module.exports = { importAny, importPostmanCollection, importPostmanEnvironment, importOpenApi, exportCollection, exportEnvironment };
