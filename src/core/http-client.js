'use strict';

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { URL } = require('url');

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

class RequestError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

function decompress(buffer, encoding) {
  const enc = String(encoding || '').toLowerCase().trim();
  try {
    if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(buffer);
    if (enc === 'deflate') {
      try { return zlib.inflateSync(buffer); } catch { return zlib.inflateRawSync(buffer); }
    }
    if (enc === 'br') return zlib.brotliDecompressSync(buffer);
  } catch {
    // Fall through and return the raw bytes if the server lied about the encoding.
  }
  return buffer;
}

// Opens a CONNECT tunnel through an HTTP proxy for HTTPS targets.
function connectTunnel(proxy, target, timeout) {
  return new Promise((resolve, reject) => {
    const headers = { Host: `${target.hostname}:${target.port}` };
    if (proxy.username) {
      headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(`${proxy.username}:${proxy.password || ''}`).toString('base64');
    }
    const req = http.request({
      host: proxy.host,
      port: proxy.port || 8080,
      method: 'CONNECT',
      path: `${target.hostname}:${target.port}`,
      headers,
      timeout,
    });
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new RequestError(`Proxy CONNECT failed with status ${res.statusCode}`, 'EPROXY'));
      } else resolve(socket);
    });
    req.once('error', reject);
    req.once('timeout', () => req.destroy(new RequestError('Proxy connection timed out', 'ETIMEDOUT')));
    req.end();
  });
}

/**
 * Performs a single HTTP exchange (no redirect handling).
 * opts: { method, url, headers: [[k, v]], body: Buffer|null, timeout, verifySSL, proxy }
 */
async function exchange(opts) {
  const url = new URL(opts.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new RequestError(`Unsupported protocol ${url.protocol}`, 'EPROTO');
  }
  const isHttps = url.protocol === 'https:';
  const lib = isHttps ? https : http;
  const port = url.port || (isHttps ? 443 : 80);

  const headers = {};
  for (const [k, v] of opts.headers || []) {
    if (!k) continue;
    if (headers[k] !== undefined) headers[k] = [].concat(headers[k], v);
    else headers[k] = v;
  }

  const reqOpts = {
    method: opts.method,
    hostname: url.hostname.replace(/^\[|\]$/g, ''),
    port,
    path: url.pathname + url.search,
    headers,
    rejectUnauthorized: opts.verifySSL !== false,
    agent: false,
    servername: url.hostname,
  };

  const proxy = opts.proxy && opts.proxy.enabled && opts.proxy.host ? opts.proxy : null;
  if (proxy && !matchesBypass(url.hostname, proxy.bypass)) {
    if (isHttps) {
      const socket = await connectTunnel(proxy, { hostname: reqOpts.hostname, port }, opts.timeout || 0);
      // Without an agent, Node uses createConnection to obtain the socket for this request.
      delete reqOpts.agent;
      reqOpts.createConnection = () => require('tls').connect({
        socket,
        servername: url.hostname,
        rejectUnauthorized: reqOpts.rejectUnauthorized,
      });
    } else {
      reqOpts.hostname = proxy.host;
      reqOpts.port = proxy.port || 8080;
      reqOpts.path = url.href;
      if (proxy.username) {
        headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(`${proxy.username}:${proxy.password || ''}`).toString('base64');
      }
    }
  }

  return new Promise((resolve, reject) => {
    const t0 = process.hrtime.bigint();
    const ms = () => Number(process.hrtime.bigint() - t0) / 1e6;
    const timings = { start: Date.now() };
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    const req = lib.request(reqOpts, (res) => {
      timings.firstByte = ms();
      const chunks = [];
      let rawSize = 0;
      res.on('data', (c) => {
        chunks.push(c);
        rawSize += c.length;
        if (opts.maxSize && rawSize > opts.maxSize) {
          req.destroy(new RequestError(`Response exceeded maximum size of ${opts.maxSize} bytes`, 'EMAXSIZE'));
        }
      });
      res.on('end', () => {
        timings.end = ms();
        const raw = Buffer.concat(chunks);
        const body = decompress(raw, res.headers['content-encoding']);
        const headerPairs = [];
        for (let i = 0; i < res.rawHeaders.length; i += 2) headerPairs.push([res.rawHeaders[i], res.rawHeaders[i + 1]]);
        settled = true;
        resolve({
          status: res.statusCode,
          statusText: res.statusMessage || http.STATUS_CODES[res.statusCode] || '',
          httpVersion: res.httpVersion,
          headers: headerPairs,
          body,
          rawSize,
          headersSize: headerPairs.reduce((n, [k, v]) => n + k.length + String(v).length + 4, 0),
          timings: {
            dns: timings.dns,
            connect: timings.connect,
            tls: timings.tls,
            firstByte: timings.firstByte,
            download: timings.end - timings.firstByte,
            total: timings.end,
          },
          remoteAddress: res.socket && res.socket.remoteAddress,
        });
      });
      res.on('error', fail);
    });

    req.on('socket', (socket) => {
      socket.once('lookup', () => { timings.dns = ms(); });
      socket.once('connect', () => { timings.connect = ms(); });
      socket.once('secureConnect', () => { timings.tls = ms(); });
    });
    if (opts.timeout) {
      req.setTimeout(opts.timeout, () => req.destroy(new RequestError(`Request timed out after ${opts.timeout} ms`, 'ETIMEDOUT')));
    }
    if (opts.signal) {
      if (opts.signal.aborted) req.destroy(new RequestError('Request cancelled', 'ECANCELLED'));
      opts.signal.addEventListener('abort', () => req.destroy(new RequestError('Request cancelled', 'ECANCELLED')), { once: true });
    }
    req.on('error', fail);
    if (opts.body && opts.body.length) req.write(opts.body);
    req.end();
  });
}

function matchesBypass(host, bypass) {
  if (!bypass) return false;
  return String(bypass).split(',').map((s) => s.trim()).filter(Boolean).some((pattern) => {
    if (pattern === '*') return true;
    if (pattern.startsWith('*.')) return host.endsWith(pattern.slice(1));
    return host === pattern;
  });
}

/**
 * Sends a request, following redirects if requested.
 * onHop(response, url) is called for each intermediate response so the caller can store cookies.
 */
async function send(opts, onHop) {
  let current = { ...opts };
  const redirects = [];
  const maxRedirects = opts.maxRedirects == null ? 10 : opts.maxRedirects;
  for (;;) {
    const res = await exchange(current);
    res.url = current.url;
    if (onHop) await onHop(res, current.url);
    const location = res.headers.find(([k]) => k.toLowerCase() === 'location');
    if (!opts.followRedirects || !REDIRECT_CODES.has(res.status) || !location) {
      res.redirects = redirects;
      return res;
    }
    if (redirects.length >= maxRedirects) throw new RequestError(`Exceeded maximum of ${maxRedirects} redirects`, 'EREDIRECTS');
    const nextUrl = new URL(location[1], current.url).href;
    redirects.push({ status: res.status, from: current.url, to: nextUrl });
    const changeToGet = res.status === 303 || ((res.status === 301 || res.status === 302) && current.method === 'POST');
    const sameOrigin = new URL(nextUrl).origin === new URL(current.url).origin;
    let headers = current.headers.filter(([k]) => k.toLowerCase() !== 'cookie' && k.toLowerCase() !== 'host');
    if (changeToGet) headers = headers.filter(([k]) => !/^content-(type|length)$/i.test(k));
    if (!sameOrigin) headers = headers.filter(([k]) => k.toLowerCase() !== 'authorization');
    current = {
      ...current,
      url: nextUrl,
      method: changeToGet ? 'GET' : current.method,
      body: changeToGet ? null : current.body,
      headers,
    };
    if (opts.cookieHeaderFor) {
      const cookie = opts.cookieHeaderFor(nextUrl);
      if (cookie) current.headers.push(['Cookie', cookie]);
    }
  }
}

module.exports = { send, exchange, RequestError, decompress };
