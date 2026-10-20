'use strict';

/**
 * Mock server: serves a collection's saved examples over HTTP.
 *
 * Each request in the collection becomes a route (method + path). Path segments written as
 * :name or {{variable}} match anything. When a route has several examples, the client can pick
 * one with the header x-mock-response-name or x-mock-response-code; otherwise the first 2xx
 * example (or the first example) is returned.
 */
const http = require('http');

const SKIP_HEADERS = new Set(['content-length', 'transfer-encoding', 'content-encoding', 'connection', 'keep-alive']);

// "{{BASE_URL}}/api/users/:id?x=1" -> ['api', 'users', ':id']
function pathSegments(url) {
  let u = String(url || '').trim().split('#')[0].split('?')[0];
  u = u.replace(/^\{\{[^{}]+\}\}/, ''); // leading {{baseUrl}}
  u = u.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, ''); // scheme://host
  if (!u.startsWith('/')) u = u.includes('/') ? u.slice(u.indexOf('/')) : '/';
  return u.split('/').filter(Boolean);
}

const isWildcard = (seg) => seg.startsWith(':') || /\{\{[^{}]+\}\}/.test(seg) || /^\{[^{}]+\}$/.test(seg);

function buildRoutes(collection) {
  const routes = [];
  const walk = (items, folders) => {
    for (const it of items || []) {
      if (it.type === 'folder') walk(it.items, [...folders, it.name]);
      else if (it.type === 'request') {
        const segs = pathSegments(it.request.url);
        routes.push({
          id: it.id,
          name: it.name,
          folder: folders.join(' / '),
          method: String(it.request.method || 'GET').toUpperCase(),
          path: `/${segs.join('/')}`,
          segments: segs,
          examples: it.examples || [],
        });
      }
    }
  };
  walk(collection.items, []);
  return routes;
}

// Returns the best route for a method + path, preferring routes with more literal segments.
function matchRoute(routes, method, pathname) {
  const reqSegs = String(pathname).split('/').filter(Boolean).map((s) => { try { return decodeURIComponent(s); } catch { return s; } });
  let best = null;
  for (const r of routes) {
    if (r.method !== method || r.segments.length !== reqSegs.length) continue;
    let score = 0;
    let ok = true;
    for (let i = 0; i < reqSegs.length; i++) {
      if (isWildcard(r.segments[i])) continue;
      if (r.segments[i] !== reqSegs[i]) { ok = false; break; }
      score++;
    }
    if (ok && (!best || score > best.score || (score === best.score && r.examples.length > best.route.examples.length))) best = { route: r, score };
  }
  return best ? best.route : null;
}

function pickExample(examples, headers) {
  if (!examples.length) return null;
  const name = headers['x-mock-response-name'];
  const code = headers['x-mock-response-code'];
  if (name) {
    const byName = examples.find((e) => e.name === name);
    if (byName) return byName;
  }
  if (code) {
    const byCode = examples.find((e) => String(e.status) === String(code));
    if (byCode) return byCode;
  }
  return examples.find((e) => e.status >= 200 && e.status < 300) || examples[0];
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': '*',
};

/**
 * Starts a mock server. opts: { collection, port, host, delayMs, onRequest(entry) }
 * Resolves to { url, port, routes, close() }.
 */
function startMockServer({ collection, port = 0, host = '127.0.0.1', delayMs = 0, onRequest }) {
  let routes = buildRoutes(collection);
  const server = http.createServer((req, res) => {
    const started = Date.now();
    const u = new URL(req.url, 'http://mock');
    const method = req.method.toUpperCase();
    // Drain the body (ignored) so keep-alive clients behave.
    req.resume();
    req.on('end', () => {
      const finish = (status, headers, body, extra = {}) => {
        const send = () => {
          const buf = Buffer.from(body || '', 'utf8');
          res.writeHead(status, { ...CORS, ...headers, 'Content-Length': buf.length });
          res.end(method === 'HEAD' ? undefined : buf);
          if (onRequest) onRequest({ time: started, method, path: u.pathname + u.search, status, durationMs: Date.now() - started, ...extra });
        };
        if (delayMs > 0) setTimeout(send, delayMs); else send();
      };
      if (method === 'OPTIONS') return finish(204, {}, '');
      const route = matchRoute(routes, method === 'HEAD' ? 'GET' : method, u.pathname) || matchRoute(routes, method, u.pathname);
      if (!route) {
        return finish(404, { 'Content-Type': 'application/json' }, JSON.stringify({
          error: 'No mock route matches this request',
          request: `${method} ${u.pathname}`,
          routes: routes.map((r) => `${r.method} ${r.path}${r.examples.length ? '' : ' (no examples)'}`),
        }, null, 2));
      }
      const ex = pickExample(route.examples, req.headers);
      if (!ex) {
        return finish(501, { 'Content-Type': 'application/json' }, JSON.stringify({
          error: `"${route.name}" has no saved examples. Send it in HttpDash and use "Save as example".`,
        }, null, 2), { route: route.name });
      }
      const headers = {};
      for (const [k, v] of ex.headers || []) if (!SKIP_HEADERS.has(String(k).toLowerCase())) headers[k] = v;
      headers['X-Mock-Example'] = encodeURIComponent(ex.name || '');
      return finish(ex.status || 200, headers, ex.body || '', { route: route.name, example: ex.name });
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', (e) => reject(e.code === 'EADDRINUSE' ? new Error(`Port ${port} is already in use`) : e));
    server.listen(port, host, () => {
      const actual = server.address().port;
      resolve({
        port: actual,
        url: `http://${host === '0.0.0.0' ? 'localhost' : host}:${actual}`,
        get routes() { return routes; },
        update(col) { routes = buildRoutes(col); },
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

module.exports = { startMockServer, buildRoutes, matchRoute, pickExample, pathSegments };
