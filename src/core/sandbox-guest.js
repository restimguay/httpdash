'use strict';

/**
 * The script runtime that runs *inside* the QuickJS sandbox (see sandbox.js): the Postman-style
 * `pm` API plus chai, CryptoJS, URL, Buffer, console and timers. It has no access to Node or to
 * HttpDash; everything it needs from outside comes through `host`, a few functions that take and
 * return plain strings and numbers. Its state goes back to the host as JSON when the script ends.
 *
 * createSandbox runs once per session (one request, or one collection run) and holds what scripts
 * share: the classes, CryptoJS and chai, which is the slow part to load. createScript runs once per
 * script and builds that script's variables, tests and globals; each script gets its own context.
 *
 * sandbox.js evaluates this file's source inside QuickJS; it is never run in Node's own context.
 */
function createSandbox(host) {
  const stringify = JSON.stringify;
  const indirectEval = globalThis.eval;

  // ---- Bytes and encodings ----------------------------------------------------------------

  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const B64_INDEX = {};
  for (let i = 0; i < B64.length; i++) B64_INDEX[B64[i]] = i;

  function bytesToBase64(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
      out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
      out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=';
      out += i + 2 < bytes.length ? B64[n & 63] : '=';
    }
    return out;
  }
  function base64ToBytes(s) {
    const clean = String(s).replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/]/g, '');
    const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
    let o = 0;
    for (let i = 0; i < clean.length; i += 4) {
      const n = (B64_INDEX[clean[i]] << 18) | ((B64_INDEX[clean[i + 1]] || 0) << 12) | ((B64_INDEX[clean[i + 2]] || 0) << 6) | (B64_INDEX[clean[i + 3]] || 0);
      out[o++] = (n >> 16) & 255;
      if (i + 2 < clean.length) out[o++] = (n >> 8) & 255;
      if (i + 3 < clean.length) out[o++] = n & 255;
    }
    return out.subarray(0, o);
  }
  function utf8Encode(str) {
    const out = [];
    for (let i = 0; i < str.length; i++) {
      let c = str.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
        const d = str.charCodeAt(i + 1);
        if (d >= 0xdc00 && d <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; }
      }
      if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd; // lone surrogate
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return Uint8Array.from(out);
  }
  function utf8Decode(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length;) {
      const b = bytes[i];
      let c = 0xfffd;
      let n = 1;
      if (b < 0x80) c = b;
      else if (b >= 0xc2 && b < 0xe0 && (bytes[i + 1] & 0xc0) === 0x80) { c = ((b & 31) << 6) | (bytes[i + 1] & 63); n = 2; }
      else if (b >= 0xe0 && b < 0xf0 && (bytes[i + 1] & 0xc0) === 0x80 && (bytes[i + 2] & 0xc0) === 0x80) {
        c = ((b & 15) << 12) | ((bytes[i + 1] & 63) << 6) | (bytes[i + 2] & 63); n = 3;
        if (c < 0x800 || (c >= 0xd800 && c <= 0xdfff)) c = 0xfffd;
      } else if (b >= 0xf0 && b < 0xf5 && (bytes[i + 1] & 0xc0) === 0x80 && (bytes[i + 2] & 0xc0) === 0x80 && (bytes[i + 3] & 0xc0) === 0x80) {
        c = ((b & 7) << 18) | ((bytes[i + 1] & 63) << 12) | ((bytes[i + 2] & 63) << 6) | (bytes[i + 3] & 63); n = 4;
        if (c < 0x10000 || c > 0x10ffff) c = 0xfffd;
      }
      out += String.fromCodePoint(c);
      i += n;
    }
    return out;
  }
  const latin1Encode = (s) => Uint8Array.from(String(s), (ch) => ch.charCodeAt(0) & 255);
  function latin1Decode(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 8192)));
    return out;
  }
  const hexEncode = (bytes) => Array.from(bytes, (b) => (b < 16 ? '0' : '') + b.toString(16)).join('');
  function hexDecode(s) {
    const clean = String(s).replace(/[^0-9a-fA-F]/g, '');
    const out = new Uint8Array(clean.length >> 1);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.substr(i * 2, 2), 16);
    return out;
  }
  function encode(str, encoding) {
    switch (String(encoding || 'utf8').toLowerCase()) {
      case 'utf8': case 'utf-8': return utf8Encode(str);
      case 'base64': case 'base64url': return base64ToBytes(str);
      case 'hex': return hexDecode(str);
      case 'latin1': case 'binary': case 'ascii': return latin1Encode(str);
      default: throw new TypeError(`Unknown encoding: ${encoding}`);
    }
  }
  function decode(bytes, encoding) {
    switch (String(encoding || 'utf8').toLowerCase()) {
      case 'utf8': case 'utf-8': return utf8Decode(bytes);
      case 'base64': return bytesToBase64(bytes);
      case 'base64url': return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      case 'hex': return hexEncode(bytes);
      case 'latin1': case 'binary': return latin1Decode(bytes);
      case 'ascii': return latin1Decode(bytes.map((b) => b & 127));
      default: throw new TypeError(`Unknown encoding: ${encoding}`);
    }
  }

  // A Node-style Buffer covering what API scripts use: from/alloc/concat, toString and toJSON.
  class Buffer extends Uint8Array {
    static from(value, encodingOrOffset, length) {
      if (typeof value === 'string') return Buffer._copy(encode(value, encodingOrOffset));
      if (value instanceof ArrayBuffer) return new Buffer(value, encodingOrOffset || 0, length === undefined ? value.byteLength - (encodingOrOffset || 0) : length);
      if (value && value.type === 'Buffer' && Array.isArray(value.data)) return Buffer._copy(value.data);
      if (value && (Array.isArray(value) || ArrayBuffer.isView(value))) return Buffer._copy(value);
      throw new TypeError('The first argument must be a string, Buffer, ArrayBuffer or array');
    }
    static _copy(items) { const b = new Buffer(items.length); b.set(items); return b; }
    static alloc(size, fill) { const b = new Buffer(size); if (fill !== undefined) b.fill(typeof fill === 'string' ? fill.charCodeAt(0) : fill); return b; }
    static isBuffer(b) { return b instanceof Buffer; }
    static byteLength(s, encoding) { return typeof s === 'string' ? encode(s, encoding).length : s.byteLength; }
    static concat(list, total) {
      const size = total === undefined ? list.reduce((n, b) => n + b.length, 0) : total;
      const out = new Buffer(size);
      let o = 0;
      for (const b of list) { out.set(b.subarray(0, Math.max(0, size - o)), o); o += b.length; if (o >= size) break; }
      return out;
    }
    toString(encoding, start, end) { return decode(this.subarray(start || 0, end === undefined ? this.length : end), encoding); }
    toJSON() { return { type: 'Buffer', data: Array.from(this) }; }
    equals(other) { return other.length === this.length && this.every((b, i) => b === other[i]); }
    write(str, offset, encoding) { const bytes = encode(str, encoding); this.set(bytes.subarray(0, this.length - (offset || 0)), offset || 0); return Math.min(bytes.length, this.length - (offset || 0)); }
  }

  class TextEncoder {
    get encoding() { return 'utf-8'; }
    encode(s) { return utf8Encode(String(s === undefined ? '' : s)); }
  }
  class TextDecoder {
    get encoding() { return 'utf-8'; }
    decode(b) {
      if (!b) return '';
      return utf8Decode(b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength));
    }
  }
  const btoa = (s) => {
    const str = String(s);
    if (/[^\u0000-ÿ]/.test(str)) throw new Error('btoa: the string contains characters outside of the Latin1 range');
    return bytesToBase64(latin1Encode(str));
  };
  const atob = (s) => latin1Decode(base64ToBytes(s));

  // ---- CryptoJS (the subset Postman scripts use); hashing is done by the host ---------------

  class WordArray {
    constructor(bytes) {
      this._bytes = Uint8Array.from(bytes || []);
      this.sigBytes = this._bytes.length;
    }
    get words() {
      const words = [];
      for (let i = 0; i < this._bytes.length; i++) words[i >>> 2] = (words[i >>> 2] | 0) | (this._bytes[i] << (24 - (i % 4) * 8));
      return words;
    }
    toString(encoder) { return (encoder || cryptoEnc.Hex).stringify(this); }
    concat(other) { this._bytes = Uint8Array.from([...this._bytes, ...other._bytes]); this.sigBytes = this._bytes.length; return this; }
    clone() { return new WordArray(this._bytes); }
  }
  const toBytes = (v) => (v instanceof WordArray ? v._bytes : utf8Encode(v == null ? '' : String(v)));
  const cryptoEnc = {
    Hex: { stringify: (wa) => hexEncode(wa._bytes), parse: (s) => new WordArray(hexDecode(s)) },
    Base64: { stringify: (wa) => bytesToBase64(wa._bytes), parse: (s) => new WordArray(base64ToBytes(s)) },
    Base64url: { stringify: (wa) => decode(wa._bytes, 'base64url'), parse: (s) => new WordArray(base64ToBytes(s)) },
    Utf8: { stringify: (wa) => utf8Decode(wa._bytes), parse: (s) => new WordArray(utf8Encode(String(s))) },
    Latin1: { stringify: (wa) => latin1Decode(wa._bytes), parse: (s) => new WordArray(latin1Encode(s)) },
  };
  const digest = (alg) => (msg) => new WordArray(base64ToBytes(host.hash(alg, bytesToBase64(toBytes(msg)))));
  const hmac = (alg) => (msg, key) => new WordArray(base64ToBytes(host.hmac(alg, bytesToBase64(toBytes(msg)), bytesToBase64(toBytes(key)))));
  const CryptoJS = {
    enc: cryptoEnc,
    lib: { WordArray: { random: (n) => new WordArray(base64ToBytes(host.randomBytes(n))), create: (b) => new WordArray(b || []) } },
  };
  for (const [name, alg] of [['MD5', 'md5'], ['SHA1', 'sha1'], ['SHA224', 'sha224'], ['SHA256', 'sha256'], ['SHA384', 'sha384'], ['SHA512', 'sha512']]) {
    CryptoJS[name] = digest(alg);
    CryptoJS[`Hmac${name}`] = hmac(alg);
  }

  // ---- URL and URLSearchParams; parsing is done by the host's WHATWG URL ---------------------

  const formEncode = (s) => encodeURIComponent(String(s)).replace(/[!'()~]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`).replace(/%20/g, '+');
  const formDecode = (s) => { try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; } };

  class URLSearchParams {
    constructor(init) {
      this._list = [];
      this._onChange = null;
      if (init == null) return;
      if (typeof init === 'string') this._parse(init);
      else if (typeof init[Symbol.iterator] === 'function') for (const [k, v] of init) this._list.push([String(k), String(v)]);
      else for (const k of Object.keys(init)) this._list.push([k, String(init[k])]);
    }
    _parse(s) {
      this._list = String(s).replace(/^\?/, '').split('&').filter(Boolean).map((part) => {
        const i = part.indexOf('=');
        return i === -1 ? [formDecode(part), ''] : [formDecode(part.slice(0, i)), formDecode(part.slice(i + 1))];
      });
    }
    _changed() { if (this._onChange) this._onChange(this.toString()); }
    get size() { return this._list.length; }
    append(k, v) { this._list.push([String(k), String(v)]); this._changed(); }
    delete(k, v) { this._list = this._list.filter(([a, b]) => a !== String(k) || (v !== undefined && b !== String(v))); this._changed(); }
    get(k) { const e = this._list.find(([a]) => a === String(k)); return e ? e[1] : null; }
    getAll(k) { return this._list.filter(([a]) => a === String(k)).map(([, b]) => b); }
    has(k, v) { return this._list.some(([a, b]) => a === String(k) && (v === undefined || b === String(v))); }
    set(k, v) {
      const key = String(k);
      const i = this._list.findIndex(([a]) => a === key);
      if (i === -1) this._list.push([key, String(v)]);
      else this._list = this._list.filter(([a], j) => a !== key || j === i).map((e, j) => (e[0] === key ? [key, String(v)] : e));
      this._changed();
    }
    sort() { this._list.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)); this._changed(); }
    forEach(fn, thisArg) { for (const [k, v] of this._list) fn.call(thisArg, v, k, this); }
    keys() { return this._list.map(([k]) => k)[Symbol.iterator](); }
    values() { return this._list.map(([, v]) => v)[Symbol.iterator](); }
    entries() { return this._list.map(([k, v]) => [k, v])[Symbol.iterator](); }
    [Symbol.iterator]() { return this.entries(); }
    toString() { return this._list.map(([k, v]) => `${formEncode(k)}=${formEncode(v)}`).join('&'); }
  }

  const URL_SETTERS = ['href', 'protocol', 'username', 'password', 'host', 'hostname', 'port', 'pathname', 'search', 'hash'];
  class URL {
    constructor(url, base) { this._load(host.parseUrl(String(url), base === undefined ? '' : String(base))); }
    static canParse(url, base) { try { return !!new URL(url, base); } catch { return false; } }
    _load(json) {
      this._parts = JSON.parse(json);
      if (!this._params) {
        this._params = new URLSearchParams(this._parts.search);
        this._params._onChange = (q) => this._load(host.setUrl(this._parts.href, 'search', q));
      } else this._params._parse(this._parts.search);
    }
    get origin() { return this._parts.origin; }
    get searchParams() { return this._params; }
    toString() { return this._parts.href; }
    toJSON() { return this._parts.href; }
  }
  for (const prop of URL_SETTERS) {
    Object.defineProperty(URL.prototype, prop, {
      get() { return this._parts[prop]; },
      set(v) { this._load(host.setUrl(this._parts.href, prop, String(v))); },
    });
  }

  // ---- console and util --------------------------------------------------------------------

  const IDENT = /^[A-Za-z_$][\w$]*$/;
  function inspect(value, depth = 0, seen = []) {
    const t = typeof value;
    if (t === 'string') return depth ? `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'` : value;
    if (value === null || t === 'number' || t === 'boolean' || t === 'undefined' || t === 'symbol') return String(value);
    if (t === 'bigint') return `${value}n`;
    if (t === 'function') return `[Function: ${value.name || '(anonymous)'}]`;
    if (value instanceof Error) return value.stack ? `${value.name}: ${value.message}\n${value.stack}`.trim() : `${value.name}: ${value.message}`;
    if (value instanceof PmResponse) return `Response ${value.code} ${value.status}`;
    if (value instanceof Date) return isNaN(value) ? 'Invalid Date' : value.toISOString();
    if (value instanceof RegExp) return String(value);
    if (value instanceof URL) return `URL '${value.href}'`;
    if (seen.includes(value)) return '[Circular]';
    if (value instanceof Uint8Array) return `<${value instanceof Buffer ? 'Buffer' : 'Uint8Array'} ${hexEncode(value.subarray(0, 50)).replace(/(..)(?!$)/g, '$1 ')}${value.length > 50 ? ' ...' : ''}>`;
    if (depth > 3) return Array.isArray(value) ? '[Array]' : '[Object]';
    const next = seen.concat([value]);
    const show = (v) => inspect(v, depth + 1, next);
    if (Array.isArray(value)) return value.length ? `[ ${value.map(show).join(', ')} ]` : '[]';
    if (value instanceof Map) return `Map(${value.size}) {${value.size ? ` ${[...value].map(([k, v]) => `${show(k)} => ${show(v)}`).join(', ')} ` : ''}}`;
    if (value instanceof Set) return `Set(${value.size}) {${value.size ? ` ${[...value].map(show).join(', ')} ` : ''}}`;
    const keys = Object.keys(value);
    const body = keys.map((k) => `${IDENT.test(k) ? k : `'${k}'`}: ${show(value[k])}`).join(', ');
    return keys.length ? `{ ${body} }` : '{}';
  }
  function format(...args) {
    let first = args[0];
    let rest = args.slice(1);
    if (typeof first === 'string' && /%[sdifjoO%]/.test(first)) {
      first = first.replace(/%([sdifjoO%])/g, (m, f) => {
        if (f === '%') return '%';
        if (!rest.length) return m;
        const v = rest.shift();
        if (f === 's') return typeof v === 'string' ? v : inspect(v, 1);
        if (f === 'd' || f === 'i') return String(f === 'i' ? parseInt(v, 10) : Number(v));
        if (f === 'f') return String(parseFloat(v));
        if (f === 'j') { try { return stringify(v); } catch { return '[Circular]'; } }
        return inspect(v, 1);
      });
      return [first, ...rest.map((a) => inspect(a))].join(' ');
    }
    return args.map((a) => inspect(a)).join(' ');
  }

  // ---- Host calls that finish later (pm.sendRequest, setTimeout) ------------------------------

  const ops = new Map();
  let nextOp = 1;
  const hostCall = (start) => new Promise((resolve, reject) => {
    const id = nextOp++;
    ops.set(id, { resolve, reject });
    start(id);
  });
  function complete(id, ok, payload) {
    const op = ops.get(id);
    if (!op) return;
    ops.delete(id);
    if (ok) op.resolve(payload); else op.reject(new Error(payload));
  }

  // ---- The pm API ---------------------------------------------------------------------------

  class PropertyList {
    constructor(items, onChange) {
      this._items = items;
      this._onChange = onChange || (() => {});
    }
    _find(key) {
      const lower = String(key).toLowerCase();
      return this._items.find((i) => String(i.key).toLowerCase() === lower && i.enabled !== false);
    }
    get(key) { const i = this._find(key); return i ? i.value : undefined; }
    has(key, value) { const i = this._find(key); return !!i && (value === undefined || i.value === value); }
    add(item) { this._items.push(normalizeItem(item)); this._onChange(); }
    upsert(item) {
      const n = normalizeItem(item);
      const existing = this._find(n.key);
      if (existing) existing.value = n.value; else this._items.push(n);
      this._onChange();
    }
    remove(predicate) {
      const fn = typeof predicate === 'function' ? predicate : (i) => String(i.key).toLowerCase() === String(predicate).toLowerCase();
      for (let i = this._items.length - 1; i >= 0; i--) if (fn(this._items[i])) this._items.splice(i, 1);
      this._onChange();
    }
    clear() { this._items.splice(0); this._onChange(); }
    each(fn) { this._items.filter((i) => i.enabled !== false).forEach(fn); }
    map(fn) { return this._items.filter((i) => i.enabled !== false).map(fn); }
    filter(fn) { return this._items.filter((i) => i.enabled !== false).filter(fn); }
    all() { return this._items.filter((i) => i.enabled !== false); }
    count() { return this.all().length; }
    toObject() {
      const o = {};
      this.each((i) => { o[i.key] = i.value; });
      return o;
    }
    toJSON() { return this.all(); }
  }

  function normalizeItem(item) {
    if (typeof item === 'string') {
      const idx = item.indexOf(':');
      return { key: item.slice(0, idx).trim(), value: item.slice(idx + 1).trim(), enabled: true };
    }
    return { key: item.key, value: item.value == null ? '' : String(item.value), enabled: item.disabled ? false : true };
  }

  function decodeSafe(s) {
    try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; }
  }

  function makeRequestApi(req) {
    req.headers = req.headers || [];
    const headers = new PropertyList(req.headers);

    const parseQuery = () => {
      const q = req.url.indexOf('?');
      if (q === -1) return [];
      return req.url.slice(q + 1).split('&').filter(Boolean).map((p) => {
        const i = p.indexOf('=');
        return { key: decodeSafe(i === -1 ? p : p.slice(0, i)), value: i === -1 ? '' : decodeSafe(p.slice(i + 1)), enabled: true };
      });
    };
    const writeQuery = (items) => {
      const base = req.url.split('?')[0];
      const qs = items.filter((i) => i.enabled !== false).map((i) => `${encodeURIComponent(i.key)}=${encodeURIComponent(i.value)}`).join('&');
      req.url = qs ? `${base}?${qs}` : base;
      req.params = items.map((i) => ({ key: i.key, value: i.value, enabled: true }));
    };

    const urlApi = {
      toString: () => req.url,
      getHost: () => { try { return new URL(req.url).hostname; } catch { return ''; } },
      getPath: () => { try { return new URL(req.url).pathname; } catch { return ''; } },
      getQueryString: () => (req.url.split('?')[1] || ''),
      update: (s) => { req.url = String(s); },
      get query() {
        const items = parseQuery();
        return new PropertyList(items, () => writeQuery(items));
      },
    };

    return {
      get url() { return urlApi; },
      set url(v) { req.url = String(v); },
      get method() { return req.method; },
      set method(v) { req.method = String(v).toUpperCase(); },
      headers,
      get body() {
        const b = req.body || { mode: 'none' };
        return {
          mode: b.mode,
          raw: b.raw,
          get urlencoded() { b.urlencoded = b.urlencoded || []; return new PropertyList(b.urlencoded); },
          get formdata() { b.formdata = b.formdata || []; return new PropertyList(b.formdata); },
          graphql: b.graphql,
          toString: () => (b.mode === 'raw' ? b.raw || '' : ''),
          update: (v) => {
            req.body = req.body || {};
            if (typeof v === 'string') { req.body.mode = 'raw'; req.body.raw = v; } else Object.assign(req.body, v);
          },
        };
      },
      set body(v) { req.body = v; },
      get auth() { return req.auth; },
      addHeader: (h) => headers.add(h),
      removeHeader: (k) => headers.remove(k),
      upsertHeader: (h) => headers.upsert(h),
      toJSON: () => req,
    };
  }

  // chai is about a third of a megabyte, so it is only loaded when a script first asserts something.
  let chai;
  function getChai() {
    if (chai) return chai;
    chai = indirectEval(`(function () { var self = {}; ${host.chaiSource()}\n; return self.chai; })()`);
    extendChai(chai);
    return chai;
  }

  class PmResponse {
    constructor(res) {
      this._res = res;
      this.code = res.status;
      this.status = res.statusText;
      this.responseTime = res.time;
      this.responseSize = res.size;
      this.headers = new PropertyList((res.headers || []).map(([key, value]) => ({ key, value, enabled: true })));
    }
    text() { return this._res.bodyText != null ? this._res.bodyText : ''; }
    json() { return JSON.parse(this.text()); }
    reason() { return this.status; }
    // Enables Postman-style assertions: pm.response.to.have.status(200)
    get to() { return getChai().expect(this).to; }
    get not() { return getChai().expect(this).not; }
  }

  function extendChai(c) {
    c.use((_chai, utils) => {
      const { Assertion } = _chai;
      const isResp = (o) => o instanceof PmResponse;

      Assertion.addMethod('status', function (expected) {
        const r = this._obj;
        if (typeof expected === 'number') {
          this.assert(r.code === expected, 'expected response to have status code #{exp} but got #{act}', 'expected response to not have status code #{act}', expected, r.code);
        } else {
          this.assert(r.status === expected, 'expected response to have status reason #{exp} but got #{act}', 'expected response to not have status reason #{act}', expected, r.status);
        }
      });
      Assertion.addMethod('header', function (name, value) {
        const r = this._obj;
        const has = r.headers.has(name);
        if (value === undefined) {
          this.assert(has, `expected response to have header ${name}`, `expected response to not have header ${name}`);
        } else {
          const actual = r.headers.get(name);
          this.assert(actual === value, `expected response header ${name} to be #{exp} but got #{act}`, `expected response header ${name} to not be #{exp}`, value, actual);
        }
      });
      Assertion.addMethod('body', function (expected) {
        const r = this._obj;
        const text = r.text();
        if (expected === undefined) this.assert(text.length > 0, 'expected response to have a body', 'expected response to not have a body');
        else if (expected instanceof RegExp) this.assert(expected.test(text), `expected response body to match ${expected}`, `expected response body to not match ${expected}`);
        else if (typeof expected === 'string') this.assert(text === expected, 'expected response body to equal #{exp}', 'expected response body to not equal #{exp}', expected, text);
        else new Assertion(r.json()).to.deep.equal(expected);
      });
      Assertion.addMethod('jsonBody', function (path, value) {
        const r = this._obj;
        let json;
        try { json = r.json(); } catch { this.assert(false, 'expected response body to be valid JSON'); }
        if (path === undefined) return;
        if (typeof path === 'object') { new Assertion(json).to.deep.equal(path); return; }
        const got = String(path).split('.').reduce((o, k) => (o == null ? undefined : o[k]), json);
        if (value === undefined) this.assert(got !== undefined, `expected response JSON to have path ${path}`, `expected response JSON to not have path ${path}`);
        else new Assertion(got).to.deep.equal(value);
      });
      Assertion.addMethod('jsonSchema', function (schema) {
        const errors = validateSchema(this._obj instanceof PmResponse ? this._obj.json() : this._obj, schema, '$');
        this.assert(errors.length === 0, `expected data to satisfy schema but found errors: ${errors.join('; ')}`, 'expected data to not satisfy schema');
      });

      const statusProp = (name, test, label) => {
        Assertion.overwriteProperty(name, (_super) => function () {
          if (isResp(this._obj)) {
            const code = this._obj.code;
            this.assert(test(code), `expected response to be ${label} but got status ${code}`, `expected response to not be ${label}`);
          } else _super.call(this);
        });
      };
      statusProp('ok', (code) => code === 200, 'ok (200)');
      for (const [name, test, label] of [
        ['success', (code) => code >= 200 && code < 300, '2XX'],
        ['info', (code) => code >= 100 && code < 200, '1XX'],
        ['redirection', (code) => code >= 300 && code < 400, '3XX'],
        ['clientError', (code) => code >= 400 && code < 500, '4XX'],
        ['serverError', (code) => code >= 500, '5XX'],
        ['error', (code) => code >= 400, '4XX or 5XX'],
        ['accepted', (code) => code === 202, '202'],
        ['badRequest', (code) => code === 400, '400'],
        ['unauthorized', (code) => code === 401, '401'],
        ['forbidden', (code) => code === 403, '403'],
        ['notFound', (code) => code === 404, '404'],
        ['rateLimited', (code) => code === 429, '429'],
      ]) {
        Assertion.addProperty(name, function () {
          const code = this._obj.code;
          this.assert(test(code), `expected response to be ${label} but got status ${code}`, `expected response to not be ${label}`);
        });
      }
      Assertion.addProperty('json', function () {
        let ok = true;
        try { this._obj.json(); } catch { ok = false; }
        this.assert(ok, 'expected response body to be JSON', 'expected response body to not be JSON');
      });
      Assertion.addProperty('withBody', function () {
        this.assert(this._obj.text().length > 0, 'expected response to have a body', 'expected response to not have a body');
      });
      utils.addProperty(Assertion.prototype, 'response', function () { return this; });
    });
  }

  // Minimal JSON Schema validator (type, properties, required, items, enum, min/max, pattern).
  function validateSchema(data, schema, path) {
    const errors = [];
    if (!schema || typeof schema !== 'object') return errors;
    const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
    if (schema.type) {
      const types = [].concat(schema.type);
      const t = typeOf(data);
      if (!types.some((x) => x === t || (x === 'number' && t === 'integer'))) {
        errors.push(`${path} should be ${types.join('|')} but is ${t}`);
        return errors;
      }
    }
    if (schema.enum && !schema.enum.some((e) => stringify(e) === stringify(data))) errors.push(`${path} should be one of ${stringify(schema.enum)}`);
    if (typeof data === 'number') {
      if (schema.minimum !== undefined && data < schema.minimum) errors.push(`${path} should be >= ${schema.minimum}`);
      if (schema.maximum !== undefined && data > schema.maximum) errors.push(`${path} should be <= ${schema.maximum}`);
    }
    if (typeof data === 'string') {
      if (schema.minLength !== undefined && data.length < schema.minLength) errors.push(`${path} should have length >= ${schema.minLength}`);
      if (schema.maxLength !== undefined && data.length > schema.maxLength) errors.push(`${path} should have length <= ${schema.maxLength}`);
      if (schema.pattern && !new RegExp(schema.pattern).test(data)) errors.push(`${path} should match ${schema.pattern}`);
    }
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      for (const r of schema.required || []) if (!(r in data)) errors.push(`${path}.${r} is required`);
      for (const [k, sub] of Object.entries(schema.properties || {})) {
        if (k in data) errors.push(...validateSchema(data[k], sub, `${path}.${k}`));
      }
    }
    if (Array.isArray(data)) {
      if (schema.minItems !== undefined && data.length < schema.minItems) errors.push(`${path} should have >= ${schema.minItems} items`);
      if (schema.maxItems !== undefined && data.length > schema.maxItems) errors.push(`${path} should have <= ${schema.maxItems} items`);
      if (schema.items) data.forEach((d, i) => errors.push(...validateSchema(d, schema.items, `${path}[${i}]`)));
    }
    return errors;
  }

  // ---- One script --------------------------------------------------------------------------

  // Builds the globals for one script. inputJson: { event, scopes, request, response, cookies, info }.
  function createScript(inputJson) {
    const input = JSON.parse(inputJson);
    ops.clear(); // calls left over from an earlier script that timed out

    const scopes = input.scopes;
    const mergeScopes = () => Object.assign({}, scopes.globals, scopes.collection, scopes.environment, scopes.data, scopes.local);
    const replaceIn = (s) => host.resolve(String(s), stringify(mergeScopes()));

    function makeScope(store, name) {
      return {
        name,
        get: (k) => store[k],
        set: (k, v) => { store[k] = v; },
        unset: (k) => { delete store[k]; },
        has: (k) => Object.prototype.hasOwnProperty.call(store, k),
        clear: () => { for (const k of Object.keys(store)) delete store[k]; },
        toObject: () => ({ ...store }),
        replaceIn,
      };
    }

    const result = { tests: [], error: null, nextRequest: undefined, visualizer: null, skipRequest: false };
    const log = (level) => (...args) => host.log(level, format(...args));
    const safeCallback = (fn) => {
      try { fn(); } catch (e) {
        result.error = result.error || (e && e.message) || String(e);
        log('error')(e && e.stack ? `${e.message}\n${e.stack}` : String(e));
      }
    };

    const environment = makeScope(scopes.environment, 'environment');
    const globals = makeScope(scopes.globals, 'globals');
    const collectionVariables = makeScope(scopes.collection, 'collection');
    const iterationData = makeScope(scopes.data, 'data');
    const local = makeScope(scopes.local, 'local');
    const variables = {
      ...local,
      get: (k) => mergeScopes()[k],
      has: (k) => k in mergeScopes(),
      toObject: () => mergeScopes(),
    };

    const request = input.request;
    const response = input.response ? new PmResponse(input.response) : null;
    const cookies = input.cookies || [];
    const info = input.info || {};

    const test = (name, fn) => {
      const entry = { name: String(name), passed: true, skipped: false, error: null };
      result.tests.push(entry);
      try {
        const out = fn && fn();
        if (out && typeof out.then === 'function') {
          Promise.resolve(out).catch((e) => { entry.passed = false; entry.error = e && e.message ? e.message : String(e); });
        }
      } catch (e) {
        entry.passed = false;
        entry.error = e && e.message ? e.message : String(e);
      }
    };
    test.skip = (name) => { result.tests.push({ name: String(name), passed: true, skipped: true, error: null }); };

    const sendRequest = (req, cb) => {
      const p = hostCall((id) => host.send(id, stringify({ request: req, scopes }))).then((json) => new PmResponse(JSON.parse(json)));
      return p.then(
        (r) => { if (cb) safeCallback(() => cb(null, r)); return r; },
        (err) => { if (cb) safeCallback(() => cb(err, null)); else throw err; },
      );
    };

    const timers = new Map(); // handle -> host op id
    let nextTimer = 1;
    const setTimeout = (fn, ms, ...args) => {
      const handle = nextTimer++;
      hostCall((id) => { timers.set(handle, id); host.sleep(id, Number(ms) || 0); })
        .then(() => { if (timers.delete(handle)) safeCallback(() => fn(...args)); }, () => {});
      return handle;
    };
    const clearTimeout = (handle) => {
      const id = timers.get(handle);
      if (id === undefined) return;
      timers.delete(handle);
      host.cancel(id);
      complete(id, false, 'cancelled');
    };

    const pm = {
      info: { eventName: input.event, iteration: info.iteration || 0, iterationCount: info.iterationCount || 1, requestName: info.requestName, requestId: info.requestId },
      environment,
      globals,
      collectionVariables,
      iterationData,
      variables,
      request: makeRequestApi(request),
      response,
      cookies: {
        get: (name) => { const c = cookies.find((x) => x.name === name); return c ? c.value : undefined; },
        has: (name) => cookies.some((x) => x.name === name),
        toObject: () => Object.fromEntries(cookies.map((c) => [c.name, c.value])),
        all: () => cookies.slice(),
      },
      test,
      get expect() { return getChai().expect; },
      sendRequest,
      setNextRequest: (name) => { result.nextRequest = name; },
      execution: { setNextRequest: (name) => { result.nextRequest = name; }, skipRequest: () => { result.skipRequest = true; } },
      visualizer: { set: (template, data) => { result.visualizer = { template: String(template), data: data || {} }; }, clear: () => { result.visualizer = null; } },
    };

    const util = { format, inspect: (v) => inspect(v, 1) };
    const legacyTests = {};
    const scriptGlobals = {
      pm,
      postman: {
        setEnvironmentVariable: environment.set,
        getEnvironmentVariable: environment.get,
        clearEnvironmentVariable: environment.unset,
        setGlobalVariable: globals.set,
        getGlobalVariable: globals.get,
        clearGlobalVariable: globals.unset,
        setNextRequest: pm.setNextRequest,
        getResponseHeader: (k) => (response ? response.headers.get(k) : undefined),
      },
      tests: legacyTests,
      environment: scopes.environment,
      globals: scopes.globals,
      data: scopes.data,
      iteration: pm.info.iteration,
      request: { url: request.url, method: request.method, headers: Object.fromEntries((request.headers || []).map((h) => [h.key, h.value])) },
      responseBody: response ? response.text() : undefined,
      responseCode: response ? { code: response.code, name: response.status } : undefined,
      responseTime: response ? response.responseTime : undefined,
      responseHeaders: response ? response.headers.toObject() : undefined,
      console: { log: log('log'), info: log('info'), warn: log('warn'), error: log('error'), debug: log('debug') },
      CryptoJS,
      require: (name) => {
        if (name === 'chai') return getChai();
        if (name === 'crypto-js') return CryptoJS;
        if (name === 'util') return util;
        if (name === 'url') return { URL, URLSearchParams };
        if (name === 'buffer') return { Buffer };
        throw new Error(`Module '${name}' is not available in the sandbox`);
      },
      setTimeout,
      clearTimeout,
      atob,
      btoa,
      URL,
      URLSearchParams,
      TextEncoder,
      TextDecoder,
      Buffer,
    };

    // The script's state as plain JSON, for the host to copy back.
    function finish() {
      for (const [name, passed] of Object.entries(legacyTests)) {
        result.tests.push({ name, passed: !!passed, skipped: false, error: passed ? null : 'Assertion failed' });
      }
      return stringify({ scopes, request, result });
    }

    return { globals: scriptGlobals, names: Object.keys(scriptGlobals), finish };
  }

  return { createScript, complete };
}
