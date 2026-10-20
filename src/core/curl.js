'use strict';

const { newRequestDef } = require('./model');

// Splits a shell command line into arguments, honouring quotes, escapes and line continuations.
function tokenize(input) {
  const s = String(input).replace(/\\\r?\n/g, ' ').replace(/\^\r?\n/g, ' ');
  const out = [];
  let cur = '';
  let inToken = false;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "'") {
      inToken = true;
      const end = s.indexOf("'", i + 1);
      cur += s.slice(i + 1, end === -1 ? s.length : end);
      i = end === -1 ? s.length : end + 1;
    } else if (c === '$' && s[i + 1] === "'") {
      // ANSI-C quoting: $'...'
      inToken = true;
      i += 2;
      while (i < s.length && s[i] !== "'") {
        if (s[i] === '\\' && i + 1 < s.length) {
          const n = s[i + 1];
          cur += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n;
          i += 2;
        } else cur += s[i++];
      }
      i++;
    } else if (c === '"') {
      inToken = true;
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && '"\\$`'.includes(s[i + 1])) { cur += s[i + 1]; i += 2; } else cur += s[i++];
      }
      i++;
    } else if (c === '\\' && i + 1 < s.length) {
      inToken = true;
      cur += s[i + 1];
      i += 2;
    } else if (/\s/.test(c)) {
      if (inToken) { out.push(cur); cur = ''; inToken = false; }
      i++;
    } else {
      inToken = true;
      cur += c;
      i++;
    }
  }
  if (inToken) out.push(cur);
  return out;
}

const WITH_VALUE = new Set([
  '-X', '--request', '-H', '--header', '-d', '--data', '--data-raw', '--data-binary', '--data-ascii', '--data-urlencode',
  '-F', '--form', '--form-string', '-u', '--user', '-A', '--user-agent', '-b', '--cookie', '-e', '--referer', '--url',
  '-o', '--output', '-m', '--max-time', '--connect-timeout', '-x', '--proxy', '-T', '--upload-file', '--json', '-w', '--write-out',
]);

function parseCurl(command) {
  const args = tokenize(String(command).trim());
  if (!args.length || !/^curl(\.exe)?$/i.test(args[0])) throw new Error('Not a cURL command');
  const req = newRequestDef({ auth: { type: 'none' } });
  let method = null;
  let url = null;
  const data = [];
  const urlencodedData = [];
  const form = [];
  let forceGet = false;
  let head = false;
  let jsonFlag = false;

  for (let i = 1; i < args.length; i++) {
    let a = args[i];
    let val;
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    if (eq > 0 && WITH_VALUE.has(a.slice(0, eq))) { val = a.slice(eq + 1); a = a.slice(0, eq); }
    // Short options may have their value attached, e.g. -XPOST or -H'X: y'.
    if (!a.startsWith('--') && a.length > 2 && a.startsWith('-') && WITH_VALUE.has(a.slice(0, 2))) { val = a.slice(2); a = a.slice(0, 2); }
    const next = () => (val !== undefined ? val : args[++i]);
    switch (a) {
      case '-X': case '--request': method = next().toUpperCase(); break;
      case '-H': case '--header': {
        const h = next();
        const idx = h.indexOf(':');
        if (idx > 0) req.headers.push({ key: h.slice(0, idx).trim(), value: h.slice(idx + 1).trim(), enabled: true });
        break;
      }
      case '-d': case '--data': case '--data-raw': case '--data-binary': case '--data-ascii': data.push(next()); break;
      case '--json': data.push(next()); jsonFlag = true; break;
      case '--data-urlencode': urlencodedData.push(next()); break;
      case '-F': case '--form': case '--form-string': form.push(next()); break;
      case '-u': case '--user': {
        const [username, ...rest] = next().split(':');
        req.auth = { type: 'basic', basic: { username, password: rest.join(':') } };
        break;
      }
      case '-A': case '--user-agent': req.headers.push({ key: 'User-Agent', value: next(), enabled: true }); break;
      case '-b': case '--cookie': req.headers.push({ key: 'Cookie', value: next(), enabled: true }); break;
      case '-e': case '--referer': req.headers.push({ key: 'Referer', value: next(), enabled: true }); break;
      case '--url': url = next(); break;
      case '-G': case '--get': forceGet = true; break;
      case '-I': case '--head': head = true; break;
      default:
        if (WITH_VALUE.has(a)) next();
        else if (!a.startsWith('-') && url === null) url = a;
    }
  }
  if (!url) throw new Error('No URL found in cURL command');
  req.url = url;

  if (forceGet && (data.length || urlencodedData.length)) {
    const qs = [...data, ...urlencodedData].join('&');
    req.url += (req.url.includes('?') ? '&' : '?') + qs;
  } else if (form.length) {
    req.body.mode = 'formdata';
    req.body.formdata = form.map((f) => {
      const idx = f.indexOf('=');
      const key = f.slice(0, idx);
      let value = f.slice(idx + 1);
      if (value.startsWith('@')) {
        value = value.slice(1).split(';')[0].replace(/^"|"$/g, '');
        return { key, type: 'file', src: value, value: '', enabled: true };
      }
      return { key, type: 'text', value, enabled: true };
    });
  } else if (urlencodedData.length && !data.length) {
    req.body.mode = 'urlencoded';
    req.body.urlencoded = urlencodedData.map((d) => {
      const idx = d.indexOf('=');
      return idx === -1 ? { key: d, value: '', enabled: true } : { key: d.slice(0, idx), value: d.slice(idx + 1), enabled: true };
    });
  } else if (data.length || urlencodedData.length) {
    const raw = [...data, ...urlencodedData].join('&');
    const ct = (req.headers.find((h) => /^content-type$/i.test(h.key)) || {}).value || '';
    if (jsonFlag) {
      if (!ct) req.headers.push({ key: 'Content-Type', value: 'application/json', enabled: true });
      req.body.mode = 'raw';
      req.body.raw = raw;
      req.body.rawLanguage = 'json';
    } else if (/x-www-form-urlencoded/i.test(ct) || (!ct && /^[^{[<\s][^=]*=/.test(raw) && !raw.trim().startsWith('{'))) {
      req.body.mode = 'urlencoded';
      req.body.urlencoded = raw.split('&').filter(Boolean).map((pair) => {
        const idx = pair.indexOf('=');
        const dec = (x) => { try { return decodeURIComponent(x.replace(/\+/g, ' ')); } catch { return x; } };
        return idx === -1 ? { key: dec(pair), value: '', enabled: true } : { key: dec(pair.slice(0, idx)), value: dec(pair.slice(idx + 1)), enabled: true };
      });
      req.headers = req.headers.filter((h) => !/^content-type$/i.test(h.key));
    } else {
      req.body.mode = 'raw';
      req.body.raw = raw;
      req.body.rawLanguage = /json/i.test(ct) || /^\s*[{[]/.test(raw) ? 'json' : /xml/i.test(ct) ? 'xml' : 'text';
    }
  }

  req.method = method || (head ? 'HEAD' : forceGet ? 'GET' : req.body.mode !== 'none' ? 'POST' : 'GET');
  req.params = paramsFromUrl(req.url);
  return req;
}

function paramsFromUrl(url) {
  const q = url.indexOf('?');
  if (q === -1) return [];
  return url.slice(q + 1).split('#')[0].split('&').filter(Boolean).map((p) => {
    const i = p.indexOf('=');
    return { key: i === -1 ? p : p.slice(0, i), value: i === -1 ? '' : p.slice(i + 1), enabled: true };
  });
}

module.exports = { parseCurl, tokenize, paramsFromUrl };
