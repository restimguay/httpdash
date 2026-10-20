'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const crypto = require('crypto');
const oauth2 = require('../src/core/oauth2');
const httpClient = require('../src/core/http-client');
const postman = require('../src/core/postman');
const { shareable, applyRepo, keepLocalTokens } = require('../src/core/repo-format');

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// A tiny OAuth 2.0 provider: /authorize redirects back with a code, /token checks it (and PKCE).
function startProvider() {
  const codes = new Map();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/authorize') {
      const p = url.searchParams;
      const back = new URL(p.get('redirect_uri'));
      if (p.get('response_type') === 'token') {
        back.hash = new URLSearchParams({ access_token: 'implicit-token', token_type: 'Bearer', expires_in: '60', state: p.get('state') }).toString();
      } else {
        const code = `code-${codes.size + 1}`;
        codes.set(code, { challenge: p.get('code_challenge'), method: p.get('code_challenge_method'), redirect: p.get('redirect_uri'), client: p.get('client_id') });
        back.searchParams.set('code', code);
        back.searchParams.set('state', p.get('state'));
      }
      res.writeHead(302, { Location: back.href });
      res.end();
      return;
    }
    if (url.pathname === '/token') {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const f = new URLSearchParams(body);
        const reply = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
        if (f.get('grant_type') === 'refresh_token') return reply(f.get('refresh_token') === 'refresh-1' ? 200 : 400, { access_token: 'refreshed', expires_in: 3600 });
        const entry = codes.get(f.get('code'));
        if (!entry) return reply(400, { error: 'invalid_grant', error_description: 'unknown code' });
        if (entry.redirect !== f.get('redirect_uri')) return reply(400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
        if (entry.challenge) {
          const verifier = f.get('code_verifier') || '';
          const expected = entry.method === 'S256' ? b64url(crypto.createHash('sha256').update(verifier).digest()) : verifier;
          if (expected !== entry.challenge) return reply(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
        }
        codes.delete(f.get('code'));
        return reply(200, { access_token: 'access-1', refresh_token: 'refresh-1', token_type: 'Bearer', expires_in: 3600, client: f.get('client_id') || req.headers.authorization });
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, base: `http://127.0.0.1:${server.address().port}` })));
}

let provider;
test.before(async () => { provider = await startProvider(); });
test.after(() => provider.server.close());

// Plays the browser: opens the authorization URL and returns where the provider redirected to.
async function signIn(cfg, opts) {
  const res = await httpClient.send({ method: 'GET', url: oauth2.authorizationUrl(cfg, opts), headers: [], followRedirects: false, timeout: 5000 });
  return new URL(res.headers.find(([k]) => k.toLowerCase() === 'location')[1], cfg.authUrl).href;
}
async function exchange(cfg, kind, extra) {
  const req = oauth2.tokenRequest(cfg, kind, extra);
  const res = await httpClient.send({ method: 'POST', url: req.url, headers: req.headers, body: req.body, timeout: 5000 });
  return oauth2.parseTokenResponse(res.status, res.body.toString('utf8'));
}

test('authorization code with PKCE works end to end', async () => {
  const cfg = { grantType: 'authorization_code_with_pkce', authUrl: `${provider.base}/authorize?prompt=login`, accessTokenUrl: `${provider.base}/token`, callbackUrl: 'https://httpdash.com/oauth/callback', clientId: 'app', scope: 'openid read' };
  const state = oauth2.randomState();
  const pkce = oauth2.pkcePair('S256');
  const authUrl = new URL(oauth2.authorizationUrl(cfg, { state, pkce }));
  assert.strictEqual(authUrl.searchParams.get('prompt'), 'login'); // existing parameters are kept
  assert.strictEqual(authUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.strictEqual(authUrl.searchParams.get('scope'), 'openid read');

  const callback = await signIn(cfg, { state, pkce });
  assert.ok(oauth2.isCallback(callback, cfg.callbackUrl));
  const { code } = oauth2.parseCallback(callback, { state, grantType: cfg.grantType });
  const token = await exchange(cfg, 'code', { code, verifier: pkce.verifier });
  assert.strictEqual(token.access_token, 'access-1');
  assert.strictEqual(token.refresh_token, 'refresh-1');
  assert.strictEqual(token.client, 'app'); // public client: client_id in the body
});

test('a wrong PKCE verifier is rejected by the provider', async () => {
  const cfg = { grantType: 'authorization_code_with_pkce', authUrl: `${provider.base}/authorize`, accessTokenUrl: `${provider.base}/token`, callbackUrl: 'http://127.0.0.1:8765/callback', clientId: 'app' };
  const state = oauth2.randomState();
  const pkce = oauth2.pkcePair();
  const { code } = oauth2.parseCallback(await signIn(cfg, { state, pkce }), { state });
  await assert.rejects(exchange(cfg, 'code', { code, verifier: oauth2.pkcePair().verifier }), /PKCE verification failed/);
});

test('authorization code with a client secret uses Basic auth', async () => {
  const cfg = { grantType: 'authorization_code', authUrl: `${provider.base}/authorize`, accessTokenUrl: `${provider.base}/token`, callbackUrl: 'https://cb.test/done', clientId: 'app', clientSecret: 's3cret' };
  const state = oauth2.randomState();
  const { code } = oauth2.parseCallback(await signIn(cfg, { state }), { state });
  const token = await exchange(cfg, 'code', { code });
  assert.strictEqual(token.client, `Basic ${Buffer.from('app:s3cret').toString('base64')}`);
});

test('implicit grant reads the token from the fragment', async () => {
  const cfg = { grantType: 'implicit', authUrl: `${provider.base}/authorize`, callbackUrl: 'https://cb.test/done', clientId: 'app' };
  const state = oauth2.randomState();
  const callback = await signIn(cfg, { state });
  const { token } = oauth2.parseCallback(callback, { state, grantType: 'implicit' });
  assert.deepStrictEqual(token, { access_token: 'implicit-token', token_type: 'Bearer', expires_in: 60 });
});

test('refresh tokens get a new access token', async () => {
  const cfg = { accessTokenUrl: `${provider.base}/token`, clientId: 'app' };
  assert.strictEqual((await exchange(cfg, 'refresh', { refreshToken: 'refresh-1' })).access_token, 'refreshed');
  await assert.rejects(exchange(cfg, 'refresh', { refreshToken: 'nope' }), /Token request failed \(400\)/);
});

test('callbacks: matching, provider errors and state checks', () => {
  assert.ok(oauth2.isCallback('https://a.test/cb/?code=1', 'https://a.test/cb'));
  assert.ok(!oauth2.isCallback('https://a.test/cb2?code=1', 'https://a.test/cb'));
  assert.ok(!oauth2.isCallback('https://evil.test/cb?code=1', 'https://a.test/cb'));
  assert.throws(() => oauth2.parseCallback('https://a.test/cb?error=access_denied&error_description=User+said+no', {}), /access_denied \(User said no\)/);
  assert.throws(() => oauth2.parseCallback('https://a.test/cb?code=1&state=other', { state: 'mine' }), /state/);
  assert.throws(() => oauth2.authorizationUrl({ authUrl: 'nope', clientId: 'a', callbackUrl: 'b' }), /valid Auth URL/);
});

test('PKCE pairs follow RFC 7636', () => {
  const p = oauth2.pkcePair('S256');
  assert.match(p.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.strictEqual(p.challenge, b64url(crypto.createHash('sha256').update(p.verifier).digest()));
  const plain = oauth2.pkcePair('plain');
  assert.strictEqual(plain.challenge, plain.verifier);
});

test('Postman OAuth 2.0 settings import and export with Postman names', () => {
  const pm = {
    info: { name: 'OAuth', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    auth: { type: 'oauth2', oauth2: [
      { key: 'grant_type', value: 'authorization_code_with_pkce' }, { key: 'authUrl', value: 'https://a.test/authorize' },
      { key: 'accessTokenUrl', value: 'https://a.test/token' }, { key: 'redirect_uri', value: 'https://cb.test' },
      { key: 'clientId', value: 'app' }, { key: 'challengeAlgorithm', value: 'S256' }, { key: 'client_authentication', value: 'body' },
      { key: 'useBrowser', value: true }, { key: 'addTokenTo', value: 'header' },
    ] },
    item: [{ name: 'Pw', request: { method: 'GET', url: 'https://a.test', auth: { type: 'oauth2', oauth2: [{ key: 'grant_type', value: 'password_credentials' }] } } }],
  };
  const col = postman.importPostmanCollection(pm);
  assert.strictEqual(col.auth.oauth2.grantType, 'authorization_code_with_pkce');
  assert.strictEqual(col.auth.oauth2.callbackUrl, 'https://cb.test');
  assert.strictEqual(col.auth.oauth2.clientAuth, 'body');
  assert.strictEqual(col.auth.oauth2.useBrowser, true);
  assert.strictEqual(col.items[0].request.auth.oauth2.grantType, 'password');

  const out = postman.exportCollection(col);
  const params = Object.fromEntries(out.auth.oauth2.map((p) => [p.key, p.value]));
  assert.strictEqual(params.grant_type, 'authorization_code_with_pkce');
  assert.strictEqual(params.redirect_uri, 'https://cb.test');
  assert.strictEqual(params.challengeAlgorithm, 'S256');
  assert.strictEqual(params.client_authentication, 'body');
  const reqParams = Object.fromEntries(out.item[0].request.auth.oauth2.map((p) => [p.key, p.value]));
  assert.strictEqual(reqParams.grant_type, 'password_credentials');
});

test('team sync never shares OAuth tokens and keeps each person\'s own', () => {
  const auth = (o) => ({ type: 'oauth2', oauth2: { clientId: 'app', accessToken: 'mine-access', refreshToken: 'mine-refresh', tokenExpiresAt: 123, ...o } });
  const col = {
    id: 'c1', type: 'collection', name: 'API', auth: auth(), variables: [],
    items: [{ id: 'f1', type: 'folder', name: 'F', auth: auth(), items: [{ id: 'r1', type: 'request', name: 'R', request: { url: 'x', auth: auth({ accessToken: '{{token}}' }) } }] }],
  };
  const shared = shareable({ collections: [col] }).collections[0];
  assert.strictEqual(shared.auth.oauth2.accessToken, '');
  assert.strictEqual(shared.auth.oauth2.refreshToken, '');
  assert.strictEqual(shared.auth.oauth2.clientId, 'app');
  assert.strictEqual(shared.items[0].auth.oauth2.refreshToken, '');
  assert.strictEqual(shared.items[0].items[0].request.auth.oauth2.accessToken, '{{token}}'); // references are kept

  const merged = keepLocalTokens(shared, col);
  assert.strictEqual(merged.auth.oauth2.accessToken, 'mine-access');
  assert.strictEqual(merged.items[0].auth.oauth2.refreshToken, 'mine-refresh');

  const { collections, summary } = applyRepo({ collections: [{ ...col, team: 'repo' }], environments: [] }, { collections: [shared], environments: [] }, 'repo');
  assert.strictEqual(collections[0].auth.oauth2.accessToken, 'mine-access');
  assert.deepStrictEqual(summary.updated, []); // tokens alone are not a change
});
