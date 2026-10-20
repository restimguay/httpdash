'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const httpClient = require('./http-client');
const cookies = require('./cookies');
const { resolve, mergeScopes } = require('./variables');
const { runScript } = require('./sandbox');
const dependency = require('./dependency');

const MIME = {
  json: 'application/json', xml: 'application/xml', html: 'text/html', text: 'text/plain', javascript: 'application/javascript',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.pdf': 'application/pdf',
  '.json': 'application/json', '.txt': 'text/plain', '.csv': 'text/csv', '.xml': 'application/xml', '.zip': 'application/zip',
};

const clone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));
const enabled = (list) => (list || []).filter((i) => i && i.enabled !== false && (i.key || i.type === 'file'));

/**
 * Walks the ancestor chain (request -> folders -> collection) to find the effective auth.
 * chain: [collection, folder1, folder2, ...] (outermost first)
 */
function effectiveAuth(requestAuth, chain) {
  if (requestAuth && requestAuth.type && requestAuth.type !== 'inherit') return requestAuth;
  for (let i = chain.length - 1; i >= 0; i--) {
    const a = chain[i] && chain[i].auth;
    if (a && a.type && a.type !== 'inherit') return a;
  }
  return { type: 'none' };
}

function substitutePathVariables(url, pathVariables, vars) {
  if (!pathVariables || !pathVariables.length) return url;
  const [base, ...rest] = url.split('?');
  const replaced = base.replace(/\/:([A-Za-z_][\w-]*)/g, (m, name) => {
    const pv = pathVariables.find((p) => p.key === name);
    return pv ? '/' + encodeURIComponent(resolve(pv.value || '', vars)) : m;
  });
  return [replaced, ...rest].join('?');
}

function normalizeUrl(url) {
  let u = String(url || '').trim();
  if (!u) throw new Error('URL is empty');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) u = 'http://' + u;
  // Encode characters that Node's URL parser would reject or mangle, while keeping existing escapes.
  return new URL(u).href;
}

function headerIndex(headers, name) {
  const lower = name.toLowerCase();
  return headers.findIndex(([k]) => k.toLowerCase() === lower);
}
function setHeaderIfMissing(headers, name, value) {
  if (headerIndex(headers, name) === -1) headers.push([name, value]);
}

function encodeForm(items, vars) {
  return enabled(items).map((i) => `${encodeURIComponent(resolve(i.key, vars))}=${encodeURIComponent(resolve(i.value || '', vars))}`).join('&');
}

function buildMultipart(items, vars) {
  const boundary = '----HttpDashBoundary' + crypto.randomBytes(12).toString('hex');
  const parts = [];
  for (const item of enabled(items)) {
    const name = resolve(item.key, vars).replace(/"/g, '%22');
    if (item.type === 'file') {
      for (const src of [].concat(item.src || [])) {
        if (!src) continue;
        const data = fs.readFileSync(src);
        const filename = path.basename(src).replace(/"/g, '%22');
        const type = item.contentType || MIME[path.extname(src).toLowerCase()] || 'application/octet-stream';
        parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`));
        parts.push(data, Buffer.from('\r\n'));
      }
    } else {
      const ct = item.contentType ? `\r\nContent-Type: ${item.contentType}` : '';
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"${ct}\r\n\r\n${resolve(item.value || '', vars)}\r\n`));
    }
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

function buildBody(body, vars) {
  if (!body || !body.mode || body.mode === 'none') return { body: null };
  switch (body.mode) {
    case 'raw': {
      const lang = body.rawLanguage || 'text';
      const raw = resolve(body.raw || '', vars);
      if (!raw) return { body: null };
      return { body: Buffer.from(raw, 'utf8'), contentType: MIME[lang] || 'text/plain' };
    }
    case 'urlencoded':
      return { body: Buffer.from(encodeForm(body.urlencoded, vars)), contentType: 'application/x-www-form-urlencoded' };
    case 'formdata':
      return buildMultipart(body.formdata, vars);
    case 'binary': {
      if (!body.binary) return { body: null };
      return { body: fs.readFileSync(body.binary), contentType: MIME[path.extname(body.binary).toLowerCase()] || 'application/octet-stream' };
    }
    case 'graphql': {
      const g = body.graphql || {};
      let variables = {};
      const rawVars = resolve(g.variables || '', vars).trim();
      if (rawVars) {
        try { variables = JSON.parse(rawVars); } catch { throw new Error('GraphQL variables are not valid JSON'); }
      }
      const payload = { query: resolve(g.query || '', vars), variables };
      if (g.operationName) payload.operationName = g.operationName;
      return { body: Buffer.from(JSON.stringify(payload)), contentType: 'application/json' };
    }
    default:
      return { body: null };
  }
}

// Builds the "Authorization" header (or query params) for non-interactive auth types.
function applyAuth(auth, prepared, vars) {
  const r = (v) => resolve(v == null ? '' : String(v), vars);
  const a = auth[auth.type] || {};
  switch (auth.type) {
    case 'basic':
      setHeaderIfMissing(prepared.headers, 'Authorization', 'Basic ' + Buffer.from(`${r(a.username)}:${r(a.password)}`).toString('base64'));
      break;
    case 'bearer':
      setHeaderIfMissing(prepared.headers, 'Authorization', `Bearer ${r(a.token)}`);
      break;
    case 'apikey': {
      const key = r(a.key);
      if (!key) break;
      if (a.in === 'query') {
        const u = new URL(prepared.url);
        u.searchParams.append(key, r(a.value));
        prepared.url = u.href;
      } else setHeaderIfMissing(prepared.headers, key, r(a.value));
      break;
    }
    case 'oauth2': {
      const token = r(a.accessToken);
      if (!token) break;
      if (a.addTo === 'query') {
        const u = new URL(prepared.url);
        u.searchParams.append('access_token', token);
        prepared.url = u.href;
      } else setHeaderIfMissing(prepared.headers, 'Authorization', `${r(a.headerPrefix) || 'Bearer'} ${token}`);
      break;
    }
    case 'awsv4':
      signAwsV4(prepared, {
        accessKey: r(a.accessKey), secretKey: r(a.secretKey), sessionToken: r(a.sessionToken),
        region: r(a.region) || 'us-east-1', service: r(a.service) || 'execute-api',
      });
      break;
    default:
      break;
  }
}

function signAwsV4(prepared, { accessKey, secretKey, sessionToken, region, service }) {
  const u = new URL(prepared.url);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const payloadHash = crypto.createHash('sha256').update(prepared.body || Buffer.alloc(0)).digest('hex');
  setHeaderIfMissing(prepared.headers, 'Host', u.host);
  prepared.headers.push(['X-Amz-Date', amzDate]);
  prepared.headers.push(['X-Amz-Content-Sha256', payloadHash]);
  if (sessionToken) prepared.headers.push(['X-Amz-Security-Token', sessionToken]);
  const canonHeaders = prepared.headers
    .map(([k, v]) => [k.toLowerCase().trim(), String(v).trim().replace(/\s+/g, ' ')])
    .sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
  const signedHeaders = canonHeaders.map(([k]) => k).join(';');
  const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  const query = [...u.searchParams.entries()].map(([k, v]) => [enc(k), enc(v)]).sort().map(([k, v]) => `${k}=${v}`).join('&');
  const canonical = [prepared.method, u.pathname || '/', query, canonHeaders.map(([k, v]) => `${k}:${v}\n`).join(''), signedHeaders, payloadHash].join('\n');
  const scope = `${date}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, crypto.createHash('sha256').update(canonical).digest('hex')].join('\n');
  const hmac = (key, s) => crypto.createHmac('sha256', key).update(s).digest();
  const kSigning = hmac(hmac(hmac(hmac('AWS4' + secretKey, date), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(toSign).digest('hex');
  prepared.headers.push(['Authorization', `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`]);
}

function digestHeader(challenge, { username, password }, method, url, body) {
  const params = {};
  challenge.replace(/^Digest\s+/i, '').replace(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g, (m, k, q, v) => { params[k.toLowerCase()] = q !== undefined ? q : v; });
  const algorithm = (params.algorithm || 'MD5').toUpperCase();
  const hashAlg = algorithm.startsWith('SHA-256') ? 'sha256' : 'md5';
  const H = (s) => crypto.createHash(hashAlg).update(s).digest('hex');
  const u = new URL(url);
  const uri = u.pathname + u.search;
  const qop = params.qop ? params.qop.split(',').map((s) => s.trim()).find((q) => q === 'auth' || q === 'auth-int') : null;
  const cnonce = crypto.randomBytes(8).toString('hex');
  const nc = '00000001';
  let ha1 = H(`${username}:${params.realm}:${password}`);
  if (algorithm.endsWith('-SESS')) ha1 = H(`${ha1}:${params.nonce}:${cnonce}`);
  const ha2 = qop === 'auth-int' ? H(`${method}:${uri}:${H(body || '')}`) : H(`${method}:${uri}`);
  const response = qop ? H(`${ha1}:${params.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : H(`${ha1}:${params.nonce}:${ha2}`);
  let header = `Digest username="${username}", realm="${params.realm}", nonce="${params.nonce}", uri="${uri}", algorithm=${algorithm}, response="${response}"`;
  if (qop) header += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
  if (params.opaque) header += `, opaque="${params.opaque}"`;
  return header;
}

/**
 * Resolves a request definition into concrete method/url/headers/body.
 * Used both by the executor and by code generation.
 */
function prepare(request, { chain = [], vars = {}, settings = {}, jar = null, defaultHeaders = true } = {}) {
  const auth = effectiveAuth(request.auth, chain);
  let url = resolve(request.url || '', vars);
  url = substitutePathVariables(url, request.pathVariables, vars);
  url = normalizeUrl(url);

  const headers = enabled(request.headers).map((h) => [resolve(h.key, vars), resolve(h.value || '', vars)]);
  const method = (resolve(request.method || 'GET', vars) || 'GET').toUpperCase();
  const built = buildBody(request.body, vars);
  const prepared = { method, url, headers, body: built.body, auth };
  if (built.contentType && built.body) setHeaderIfMissing(headers, 'Content-Type', built.contentType);

  if (defaultHeaders) {
    setHeaderIfMissing(headers, 'User-Agent', settings.userAgent || 'HttpDash/1.0');
    setHeaderIfMissing(headers, 'Accept', '*/*');
    setHeaderIfMissing(headers, 'Accept-Encoding', 'gzip, deflate, br');
    if (settings.sendNoCache !== false) setHeaderIfMissing(headers, 'Cache-Control', 'no-cache');
    setHeaderIfMissing(headers, 'Host', new URL(url).host);
    if (built.body) setHeaderIfMissing(headers, 'Content-Length', String(built.body.length));
  }
  applyAuth(auth, prepared, vars);
  if (jar && settings.sendCookies !== false && headerIndex(headers, 'cookie') === -1) {
    const c = cookies.cookieHeader(jar, prepared.url);
    if (c) headers.push(['Cookie', c]);
  }
  return prepared;
}

function isTextual(contentType) {
  if (!contentType) return true;
  return /^text\/|json|xml|javascript|ecmascript|html|x-www-form-urlencoded|graphql|yaml|csv/i.test(contentType);
}

function buildResponse(raw, maxPreview) {
  const ctPair = raw.headers.find(([k]) => k.toLowerCase() === 'content-type');
  const contentType = ctPair ? ctPair[1] : '';
  const textual = isTextual(contentType) || raw.body.length === 0;
  return {
    status: raw.status,
    statusText: raw.statusText,
    httpVersion: raw.httpVersion,
    headers: raw.headers,
    contentType,
    bodyText: textual ? raw.body.toString('utf8') : null,
    bodyBase64: !textual && raw.body.length <= maxPreview ? raw.body.toString('base64') : null,
    size: raw.rawSize + raw.headersSize,
    bodySize: raw.body.length,
    headersSize: raw.headersSize,
    time: Math.round(raw.timings.total),
    timings: raw.timings,
    url: raw.url,
    redirects: raw.redirects || [],
    remoteAddress: raw.remoteAddress,
  };
}

/**
 * Executes a request with scripts.
 * opts: {
 *   request, chain (ancestors with scripts/auth), scopes {globals, collection, environment, data},
 *   jar (cookie array, mutated), settings, info, log(level, msg), signal
 * }
 * Returns { response, error, tests, preRequestError, testError, nextRequest, sentRequest, scopes, visualizer }
 */
async function execute(opts) {
  const settings = opts.settings || {};
  const scopes = {
    globals: { ...(opts.scopes.globals || {}) },
    collection: { ...(opts.scopes.collection || {}) },
    environment: { ...(opts.scopes.environment || {}) },
    data: { ...(opts.scopes.data || {}) },
    local: {},
  };
  const jar = opts.jar || [];
  const request = clone(opts.request);
  const chain = opts.chain || [];
  const log = opts.log || (() => {});
  const result = { tests: [], scopes, nextRequest: undefined, visualizer: null };

  const scriptSendRequest = async (req) => {
    const def = typeof req === 'string' ? { url: req, method: 'GET' } : normalizeScriptRequest(req);
    const p = prepare(def, { vars: mergeScopes(scopes), settings, jar });
    log('info', `pm.sendRequest ${p.method} ${p.url}`);
    const raw = await httpClient.send(clientOptions(p, settings, jar), (hop, hopUrl) => cookies.storeFromResponse(jar, hop.headers, hopUrl));
    return buildResponse(raw, settings.maxPreviewBytes || 20 * 1024 * 1024);
  };

  const scriptCtx = (event) => ({
    event, scopes, request, jar, cookies: jar, info: opts.info || {}, sendRequest: scriptSendRequest, log,
  });

  // 0. Auth dependency: run e.g. a login request first when the token is missing or expired.
  const depCfg = dependency.effectiveDependency(request, chain);
  result.dependencyRuns = [];
  const runDep = (force, reasonOverride) => dependency.runDependency({
    cfg: depCfg,
    scopes,
    lookup: opts.lookup,
    selfId: (opts.info || {}).requestId,
    depth: opts.depth || 0,
    force,
    reasonOverride,
    log,
    runRequest: (item, itemChain, depth) => execute({
      ...opts,
      request: item.request,
      chain: itemChain,
      scopes,
      depth,
      info: { ...(opts.info || {}), requestName: item.name, requestId: item.id },
    }),
  });
  if (depCfg) {
    const dep = await runDep(false);
    if (dep) {
      result.dependencyRuns.push(dep);
      if (dep.error) {
        result.error = `Auth dependency "${dep.name}" failed: ${dep.error}`;
        return result;
      }
    }
  }

  // 1. Pre-request scripts: collection -> folders -> request.
  for (const node of [...chain, request]) {
    const code = node && node.preRequestScript;
    if (!code) continue;
    const res = await runScript(code, scriptCtx('prerequest'));
    if (res.error) result.preRequestError = res.error;
    if (res.nextRequest !== undefined) result.nextRequest = res.nextRequest;
    result.tests.push(...res.tests);
    if (res.skipRequest) { result.skipped = true; return result; }
    if (res.error) {
      result.error = `Pre-request script error: ${res.error}`;
      return result;
    }
  }

  // 2. Send (again after refreshing the token if the server answers 401 and retryOn401 is set).
  let prepared;
  let raw;
  for (let attempt = 0; ; attempt++) {
    try {
      prepared = prepare(request, { chain, vars: mergeScopes(scopes), settings, jar });
    } catch (e) {
      result.error = e.message;
      return result;
    }
    result.sentRequest = {
      method: prepared.method,
      url: prepared.url,
      headers: prepared.headers,
      bodyText: prepared.body ? (prepared.body.length > 1e6 ? `<${prepared.body.length} bytes>` : prepared.body.toString('utf8')) : null,
    };
    raw = await sendPrepared(prepared);
    if (!raw) return result;
    const canRetry = attempt === 0 && raw.status === 401 && depCfg && depCfg.retryOn401 && !result.dependencyRuns.length;
    if (!canRetry) break;
    log('net', `${prepared.method} ${prepared.url} -> 401; refreshing token`);
    const dep = await runDep(true, '401');
    if (!dep) break;
    result.dependencyRuns.push(dep);
    if (dep.error) {
      result.error = `Auth dependency "${dep.name}" failed: ${dep.error}`;
      return result;
    }
  }

  async function sendPrepared(prepared) {
    let raw;
    try {
      const clientOpts = clientOptions(prepared, settings, jar);
      clientOpts.signal = opts.signal;
      raw = await httpClient.send(clientOpts, (hop, hopUrl) => cookies.storeFromResponse(jar, hop.headers, hopUrl));
      if (raw.status === 401 && prepared.auth.type === 'digest') {
        const challenge = raw.headers.find(([k, v]) => k.toLowerCase() === 'www-authenticate' && /^digest/i.test(v));
        if (challenge) {
          const a = prepared.auth.digest || {};
          const vars = mergeScopes(scopes);
          const finalUrl = raw.url || prepared.url;
          clientOpts.url = finalUrl;
          clientOpts.headers = prepared.headers.filter(([k]) => k.toLowerCase() !== 'authorization');
          clientOpts.headers.push(['Authorization', digestHeader(challenge[1], { username: resolve(a.username || '', vars), password: resolve(a.password || '', vars) }, prepared.method, finalUrl, prepared.body)]);
          result.sentRequest.headers = clientOpts.headers;
          raw = await httpClient.send(clientOpts, (hop, hopUrl) => cookies.storeFromResponse(jar, hop.headers, hopUrl));
        }
      }
    } catch (e) {
      result.error = describeNetworkError(e);
      log('error', `${prepared.method} ${prepared.url} failed: ${result.error}`);
      return null;
    }
    return raw;
  }

  const response = buildResponse(raw, settings.maxPreviewBytes || 20 * 1024 * 1024);
  result.response = response;
  log('net', `${prepared.method} ${prepared.url} -> ${response.status} ${response.statusText} (${response.time} ms)`);

  // 3. Test scripts: collection -> folders -> request.
  for (const node of [...chain, request]) {
    const code = node && node.testScript;
    if (!code) continue;
    const res = await runScript(code, { ...scriptCtx('test'), response, cookies: cookies.cookiesFor(jar, response.url || prepared.url) });
    if (res.error) result.testError = res.error;
    if (res.nextRequest !== undefined) result.nextRequest = res.nextRequest;
    if (res.visualizer) result.visualizer = res.visualizer;
    result.tests.push(...res.tests);
  }
  return result;
}

function clientOptions(prepared, settings, jar) {
  return {
    method: prepared.method,
    url: prepared.url,
    headers: prepared.headers,
    body: prepared.body,
    timeout: settings.timeout || 0,
    verifySSL: settings.verifySSL !== false,
    followRedirects: settings.followRedirects !== false,
    maxRedirects: settings.maxRedirects || 10,
    proxy: settings.proxy,
    maxSize: settings.maxResponseBytes || 0,
    cookieHeaderFor: settings.sendCookies !== false && jar ? (u) => cookies.cookieHeader(jar, u) : null,
  };
}

// Converts the request shapes accepted by pm.sendRequest (Postman SDK style) into our definition.
function normalizeScriptRequest(req) {
  const toList = (h) => {
    if (!h) return [];
    if (Array.isArray(h)) return h.map((x) => (typeof x === 'string' ? { key: x.split(':')[0].trim(), value: x.split(':').slice(1).join(':').trim() } : x));
    return Object.entries(h).map(([key, value]) => ({ key, value: String(value) }));
  };
  const out = { url: String(req.url), method: (req.method || 'GET').toUpperCase(), headers: toList(req.header || req.headers), body: { mode: 'none' } };
  if (req.body) {
    const b = req.body;
    if (typeof b === 'string') out.body = { mode: 'raw', raw: b };
    else if (b.mode === 'raw') out.body = { mode: 'raw', raw: typeof b.raw === 'string' ? b.raw : JSON.stringify(b.raw), rawLanguage: b.options && b.options.raw && b.options.raw.language };
    else if (b.mode === 'urlencoded') out.body = { mode: 'urlencoded', urlencoded: toList(b.urlencoded) };
    else if (b.mode === 'formdata') out.body = { mode: 'formdata', formdata: toList(b.formdata) };
    else if (b.mode === 'graphql') out.body = { mode: 'graphql', graphql: { query: b.graphql.query, variables: JSON.stringify(b.graphql.variables || {}) } };
  }
  if (req.auth) out.auth = req.auth;
  return out;
}

function describeNetworkError(e) {
  const map = {
    ENOTFOUND: 'Could not resolve host (DNS lookup failed)',
    ECONNREFUSED: 'Connection refused',
    ECONNRESET: 'Connection reset by peer',
    ETIMEDOUT: 'Request timed out',
    EHOSTUNREACH: 'Host unreachable',
    CERT_HAS_EXPIRED: 'SSL certificate has expired (disable SSL verification in Settings to ignore)',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'Self-signed SSL certificate (disable SSL verification in Settings to ignore)',
    SELF_SIGNED_CERT_IN_CHAIN: 'Self-signed certificate in chain (disable SSL verification in Settings to ignore)',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'Unable to verify SSL certificate (disable SSL verification in Settings to ignore)',
  };
  const base = e && e.message ? e.message : String(e);
  return e && e.code && map[e.code] ? `${map[e.code]}: ${base}` : base;
}

module.exports = { execute, prepare, effectiveAuth, buildBody, digestHeader, normalizeUrl };
