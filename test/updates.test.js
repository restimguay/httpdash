'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { compareVersions, pickAsset, latestRelease, downloadAsset } = require('../src/core/updates');

const assets = [
  'HttpDash-Setup-1.2.0-x64.exe', 'HttpDash-Setup-1.2.0-arm64.exe', 'HttpDash-1.2.0-portable.exe',
  'HttpDash-1.2.0-mac-x64.zip', 'HttpDash-1.2.0-mac-arm64.zip', 'HttpDash-1.2.0-mac-arm64.dmg',
].map((name) => ({ name, size: 10, browser_download_url: `https://example.test/${name}` }));

test('versions compare numerically, with pre-releases before their release', () => {
  assert.strictEqual(compareVersions('1.10.0', '1.9.3'), 1);
  assert.strictEqual(compareVersions('v1.2.0', '1.2'), 0);
  assert.strictEqual(compareVersions('1.2.0-beta.2', '1.2.0'), -1);
  assert.strictEqual(compareVersions('1.2.0-beta.10', '1.2.0-beta.9'), 1);
  assert.strictEqual(compareVersions('1.0.0', '1.0.1'), -1);
});

test('each platform picks the file it can install itself from', () => {
  const rel = { assets };
  assert.strictEqual(pickAsset(rel, { platform: 'win32', arch: 'x64' }).name, 'HttpDash-Setup-1.2.0-x64.exe');
  assert.strictEqual(pickAsset(rel, { platform: 'win32', arch: 'arm64' }).name, 'HttpDash-Setup-1.2.0-arm64.exe');
  assert.strictEqual(pickAsset(rel, { platform: 'win32', arch: 'x64', portable: true }), null);
  assert.strictEqual(pickAsset(rel, { platform: 'darwin', arch: 'arm64' }).name, 'HttpDash-1.2.0-mac-arm64.zip');
  assert.strictEqual(pickAsset(rel, { platform: 'linux', arch: 'x64' }), null);
});

test('the latest release is read from GitHub, with its checksum', async () => {
  const digest = `sha256:${'a'.repeat(64)}`;
  const calls = [];
  const fetchJson = async (url) => {
    calls.push(url);
    if (url.endsWith('/releases/latest')) return { tag_name: 'v1.2.0', name: 'HttpDash 1.2.0', body: 'Notes', html_url: 'https://github.com/x/y/releases/tag/v1.2.0', assets: assets.map((a) => ({ ...a, digest })) };
    return [{ tag_name: 'v1.3.0-beta.1', assets: [] }, { tag_name: 'v1.2.0', assets: [] }, { tag_name: 'v2.0.0', draft: true, assets: [] }];
  };
  const r = await latestRelease({ repo: 'x/y', fetchJson, platform: 'darwin', arch: 'x64' });
  assert.strictEqual(r.version, '1.2.0');
  assert.strictEqual(r.asset.name, 'HttpDash-1.2.0-mac-x64.zip');
  assert.strictEqual(r.asset.sha256, 'a'.repeat(64));
  const pre = await latestRelease({ repo: 'x/y', fetchJson, platform: 'darwin', arch: 'x64', includePrereleases: true });
  assert.strictEqual(pre.version, '1.3.0-beta.1');
  assert.strictEqual(await latestRelease({ repo: 'x/y', fetchJson: async () => null, platform: 'darwin', arch: 'x64' }), null);
  assert.deepStrictEqual(calls, ['https://api.github.com/repos/x/y/releases/latest', 'https://api.github.com/repos/x/y/releases?per_page=10']);
});

test('downloads are verified against the published checksum', async () => {
  const payload = crypto.randomBytes(200000);
  const server = http.createServer((req, res) => { res.writeHead(200, { 'Content-Length': payload.length }); res.end(payload); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/HttpDash-Setup-1.2.0-x64.exe`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hd-upd-'));
  try {
    const good = crypto.createHash('sha256').update(payload).digest('hex');
    const seen = [];
    const out = await downloadAsset({ name: 'HttpDash-Setup-1.2.0-x64.exe', url, size: payload.length, sha256: good }, dir, { fetchStream: fetch, onProgress: (p) => seen.push(p.received) });
    assert.ok(fs.readFileSync(out.file).equals(payload));
    assert.strictEqual(seen[seen.length - 1], payload.length);
    await assert.rejects(downloadAsset({ name: 'bad.exe', url, size: payload.length, sha256: 'b'.repeat(64) }, dir, { fetchStream: fetch }), /checksum/);
    assert.ok(!fs.existsSync(path.join(dir, 'bad.exe')) && !fs.existsSync(path.join(dir, 'bad.exe.part')));
  } finally {
    server.close();
  }
});
