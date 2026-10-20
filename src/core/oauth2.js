'use strict';

/**
 * OAuth 2.0 helpers: building authorization URLs (with PKCE), reading the callback, and building
 * token requests for every grant. No Electron here; main.js drives the sign-in window and sends
 * the requests.
 */
const crypto = require('crypto');

const GRANTS = ['authorization_code', 'authorization_code_with_pkce', 'implicit', 'client_credentials', 'password'];

// Postman's names for the grant types, where they differ from ours.
const FROM_POSTMAN_GRANT = { password_credentials: 'password' };
const TO_POSTMAN_GRANT = { password: 'password_credentials' };

const base64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// RFC 7636: a random verifier and its challenge.
function pkcePair(method = 'S256') {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = method === 'plain' ? verifier : base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge, method: method === 'plain' ? 'plain' : 'S256' };
}

const randomState = () => base64url(crypto.randomBytes(16));
const usesBrowserRedirect = (grant) => grant === 'authorization_code' || grant === 'authorization_code_with_pkce' || grant === 'implicit';

/**
 * The URL that starts the sign-in. cfg holds resolved values: authUrl, clientId, callbackUrl,
 * scope, grantType, audience. Query parameters already in authUrl are kept.
 */
function authorizationUrl(cfg, { state, pkce } = {}) {
  let url;
  try { url = new URL(cfg.authUrl); } catch { throw new Error('Enter a valid Auth URL'); }
  if (!cfg.clientId) throw new Error('Enter the Client ID');
  if (!cfg.callbackUrl) throw new Error('Enter the Callback URL');
  const p = url.searchParams;
  p.set('response_type', cfg.grantType === 'implicit' ? 'token' : 'code');
  p.set('client_id', cfg.clientId);
  p.set('redirect_uri', cfg.callbackUrl);
  if (cfg.scope) p.set('scope', cfg.scope);
  if (cfg.audience) p.set('audience', cfg.audience);
  if (state) p.set('state', state);
  if (pkce) {
    p.set('code_challenge', pkce.challenge);
    p.set('code_challenge_method', pkce.method);
  }
  return url.href;
}

// True when url is the callback: same scheme, host, port and path (the query and fragment carry the result).
function isCallback(url, callbackUrl) {
  let a;
  let b;
  try { a = new URL(url); b = new URL(callbackUrl); } catch { return false; }
  const path = (u) => u.pathname.replace(/\/+$/, '') || '/';
  return a.protocol === b.protocol && a.host === b.host && path(a) === path(b);
}

/**
 * Reads the provider's answer from the callback URL: the code (query) or, for the implicit grant,
 * the token (fragment). Throws on provider errors and on a state mismatch.
 */
function parseCallback(url, { state, grantType } = {}) {
  const u = new URL(url);
  const params = new URLSearchParams(u.search);
  for (const [k, v] of new URLSearchParams(u.hash.replace(/^#/, ''))) if (!params.has(k)) params.set(k, v);
  if (params.get('error')) {
    const desc = params.get('error_description');
    throw new Error(`Sign-in failed: ${params.get('error')}${desc ? ` (${desc})` : ''}`);
  }
  if (state && params.get('state') !== state) throw new Error('Sign-in failed: the state in the callback does not match. Try again.');
  if (grantType === 'implicit') {
    if (!params.get('access_token')) throw new Error('The callback did not include an access token');
    const token = { access_token: params.get('access_token') };
    for (const k of ['token_type', 'expires_in', 'scope', 'id_token']) if (params.get(k)) token[k] = k === 'expires_in' ? Number(params.get(k)) : params.get(k);
    return { token };
  }
  if (!params.get('code')) throw new Error('The callback did not include an authorization code');
  return { code: params.get('code') };
}

/**
 * Builds a token request. kind: 'code' (exchange an authorization code), 'refresh', or the grant
 * itself for client credentials and password. Returns { url, headers, body }.
 */
function tokenRequest(cfg, kind, extra = {}) {
  if (!cfg.accessTokenUrl) throw new Error('Enter the Access Token URL');
  const form = new URLSearchParams();
  if (kind === 'code') {
    form.set('grant_type', 'authorization_code');
    form.set('code', extra.code);
    form.set('redirect_uri', cfg.callbackUrl);
    if (extra.verifier) form.set('code_verifier', extra.verifier);
  } else if (kind === 'refresh') {
    form.set('grant_type', 'refresh_token');
    form.set('refresh_token', extra.refreshToken);
    if (cfg.scope) form.set('scope', cfg.scope);
  } else if (kind === 'password') {
    form.set('grant_type', 'password');
    form.set('username', cfg.username || '');
    form.set('password', cfg.password || '');
    if (cfg.scope) form.set('scope', cfg.scope);
  } else {
    form.set('grant_type', 'client_credentials');
    if (cfg.scope) form.set('scope', cfg.scope);
  }
  if (cfg.audience && kind !== 'refresh') form.set('audience', cfg.audience);
  const headers = [['Content-Type', 'application/x-www-form-urlencoded'], ['Accept', 'application/json']];
  // Public clients (no secret, typical with PKCE) always send client_id in the body.
  if (cfg.clientAuth === 'body' || !cfg.clientSecret) {
    form.set('client_id', cfg.clientId || '');
    if (cfg.clientSecret) form.set('client_secret', cfg.clientSecret);
  } else {
    headers.push(['Authorization', `Basic ${Buffer.from(`${encodeURIComponent(cfg.clientId || '')}:${encodeURIComponent(cfg.clientSecret)}`).toString('base64')}`]);
  }
  return { url: cfg.accessTokenUrl, headers, body: Buffer.from(form.toString()) };
}

// Parses a token endpoint response (JSON, or form-encoded from older servers like GitHub's).
function parseTokenResponse(status, text) {
  let json;
  try { json = JSON.parse(text); } catch { json = Object.fromEntries(new URLSearchParams(text)); }
  if (status >= 400 || !json.access_token) {
    throw new Error(`Token request failed (${status}): ${json.error_description || json.error || String(text).slice(0, 300)}`);
  }
  if (json.expires_in != null) json.expires_in = Number(json.expires_in);
  return json;
}

// Maps Postman's oauth2 parameters to ours.
function fromPostman(obj) {
  const grant = FROM_POSTMAN_GRANT[obj.grant_type] || obj.grant_type || 'client_credentials';
  return {
    accessToken: obj.accessToken || '',
    addTo: obj.addTokenTo === 'queryParams' ? 'query' : 'header',
    headerPrefix: obj.headerPrefix || 'Bearer',
    grantType: GRANTS.includes(grant) ? grant : 'client_credentials',
    authUrl: obj.authUrl || '',
    accessTokenUrl: obj.accessTokenUrl || '',
    callbackUrl: obj.redirect_uri || '',
    clientId: obj.clientId || '',
    clientSecret: obj.clientSecret || '',
    scope: obj.scope || '',
    audience: obj.audience || '',
    username: obj.username || '',
    password: obj.password || '',
    clientAuth: obj.client_authentication === 'body' ? 'body' : 'header',
    pkceMethod: obj.challengeAlgorithm === 'plain' ? 'plain' : 'S256',
    useBrowser: obj.useBrowser === true || obj.useBrowser === 'true',
    refreshToken: obj.refreshToken || '',
  };
}

// Maps ours to Postman's parameter names.
function toPostman(cfg) {
  const out = { ...cfg };
  out.addTokenTo = cfg.addTo === 'query' ? 'queryParams' : 'header';
  out.grant_type = TO_POSTMAN_GRANT[cfg.grantType] || cfg.grantType || 'client_credentials';
  if (cfg.callbackUrl) out.redirect_uri = cfg.callbackUrl;
  if (cfg.clientAuth) out.client_authentication = cfg.clientAuth;
  if (cfg.pkceMethod) out.challengeAlgorithm = cfg.pkceMethod;
  for (const k of ['addTo', 'grantType', 'callbackUrl', 'clientAuth', 'pkceMethod', 'tokenExpiresAt']) delete out[k];
  return out;
}

module.exports = {
  GRANTS, pkcePair, randomState, usesBrowserRedirect, authorizationUrl, isCallback, parseCallback, tokenRequest, parseTokenResponse, fromPostman, toPostman,
};
