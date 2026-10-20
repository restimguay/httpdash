'use strict';

/**
 * App updates from GitHub releases.
 *
 * The updater finds the newest release, picks the file for this platform (the Windows installer,
 * or the macOS zip), downloads it, and checks its SHA-256 when GitHub publishes one. Installing
 * is left to the caller, since that needs Electron (quitting, relaunching).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

// "v1.10.0" > "1.9.3"; a pre-release is lower than its release ("1.2.0-beta.1" < "1.2.0").
function compareVersions(a, b) {
  const parse = (v) => {
    const [main, pre] = String(v || '0').trim().replace(/^v/i, '').split('-', 2);
    return { nums: main.split('.').map((n) => parseInt(n, 10) || 0), pre: pre || '' };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length, 3); i++) {
    const d = (x.nums[i] || 0) - (y.nums[i] || 0);
    if (d) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre.localeCompare(y.pre, undefined, { numeric: true });
}

/**
 * The release file this installation can update itself from, or null (then the person downloads it).
 * Windows installs use the NSIS installer; the portable exe and Linux can't update themselves.
 */
function pickAsset(release, { platform, arch, portable = false }) {
  const assets = release.assets || [];
  if (platform === 'win32' && !portable) return assets.find((a) => new RegExp(`-Setup-[^/]*-${arch}\\.exe$`, 'i').test(a.name)) || null;
  if (platform === 'darwin') return assets.find((a) => new RegExp(`-mac-${arch}\\.zip$`, 'i').test(a.name)) || null;
  return null;
}

// The latest release as { version, name, notes, url, publishedAt, asset }.
async function latestRelease({ repo, fetchJson, platform, arch, portable, includePrereleases = false }) {
  let release;
  if (includePrereleases) {
    const list = await fetchJson(`https://api.github.com/repos/${repo}/releases?per_page=10`);
    release = (list || []).filter((r) => !r.draft).sort((a, b) => compareVersions(b.tag_name, a.tag_name))[0];
  } else {
    release = await fetchJson(`https://api.github.com/repos/${repo}/releases/latest`);
  }
  if (!release || !release.tag_name) return null;
  const asset = pickAsset(release, { platform, arch, portable });
  return {
    version: release.tag_name.replace(/^v/i, ''),
    name: release.name || release.tag_name,
    notes: String(release.body || '').slice(0, 20000),
    url: release.html_url,
    publishedAt: release.published_at,
    asset: asset ? { name: asset.name, size: asset.size, url: asset.browser_download_url, sha256: /^sha256:([0-9a-f]{64})$/i.exec(asset.digest || '')?.[1] || null } : null,
  };
}

/**
 * Downloads asset into dir, reporting progress, and verifies the checksum when one is known.
 * fetchStream(url) must resolve to a fetch Response.
 */
async function downloadAsset(asset, dir, { fetchStream, onProgress } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, path.basename(asset.name));
  const part = `${file}.part`;
  const res = await fetchStream(asset.url);
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || asset.size || 0;
  const hash = crypto.createHash('sha256');
  let received = 0;
  const body = Readable.fromWeb(res.body);
  body.on('data', (chunk) => {
    hash.update(chunk);
    received += chunk.length;
    if (onProgress) onProgress({ received, total });
  });
  await pipeline(body, fs.createWriteStream(part));
  const digest = hash.digest('hex');
  if (asset.sha256 && digest.toLowerCase() !== asset.sha256.toLowerCase()) {
    fs.rmSync(part, { force: true });
    throw new Error('The downloaded update is damaged (checksum mismatch). Try again later.');
  }
  if (asset.size && received !== asset.size) {
    fs.rmSync(part, { force: true });
    throw new Error('The download was incomplete. Try again later.');
  }
  fs.renameSync(part, file);
  return { file, sha256: digest };
}

module.exports = { compareVersions, pickAsset, latestRelease, downloadAsset };
