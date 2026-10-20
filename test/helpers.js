'use strict';

const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');

// A small echo server used by the tests.
function startServer(port = 0) {
  const nonce = crypto.randomBytes(8).toString('hex');
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://localhost');
      const body = Buffer.concat(chunks).toString('utf8');
      const json = (code, obj, headers = {}) => {
        res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
        res.end(JSON.stringify(obj));
      };
      switch (url.pathname) {
        case '/echo':
          return json(200, { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body });
        case '/redirect':
          res.writeHead(302, { Location: '/echo?redirected=1' });
          return res.end();
        case '/set-cookie':
          return json(200, { ok: true }, { 'Set-Cookie': ['session=abc123; Path=/', 'theme=dark; Path=/'] });
        case '/gzip': {
          const data = zlib.gzipSync(JSON.stringify({ compressed: true }));
          res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
          return res.end(data);
        }
        case '/digest': {
          const auth = req.headers.authorization || '';
          if (!auth.startsWith('Digest ')) {
            res.writeHead(401, { 'WWW-Authenticate': `Digest realm="test", qop="auth", nonce="${nonce}", opaque="xyz"` });
            return res.end();
          }
          const p = {};
          auth.slice(7).replace(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g, (m, k, q, v) => { p[k] = q !== undefined ? q : v; });
          const H = (s) => crypto.createHash('md5').update(s).digest('hex');
          const expected = H(`${H('user:test:pass')}:${nonce}:${p.nc}:${p.cnonce}:auth:${H(`${req.method}:${p.uri}`)}`);
          return json(p.response === expected ? 200 : 403, { authenticated: p.response === expected });
        }
        case '/slow':
          return setTimeout(() => json(200, { slow: true }), 500);
        default: {
          const m = url.pathname.match(/^\/status\/(\d+)$/);
          if (m) return json(Number(m[1]), { status: Number(m[1]) });
          return json(404, { error: 'not found' });
        }
      }
    });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, base: `http://localhost:${server.address().port}` })));
}

module.exports = { startServer };
