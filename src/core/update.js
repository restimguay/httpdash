'use strict';

// Update check against GitHub releases. Only runs when the user asks (Help → Check for Updates),
// so HttpDash makes no network calls of its own in the background.

const RELEASES_API = 'https://api.github.com/repos/restimguay/httpdash/releases/latest';
const RELEASES_PAGE = 'https://github.com/restimguay/httpdash/releases/latest';

// "v1.2.3", "1.2.3-beta.1" -> { parts: [1, 2, 3], pre: 'beta.1' }; null when it isn't a version.
function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v || '').trim());
  return m ? { parts: [+m[1], +m[2], +m[3]], pre: m[4] || '' } : null;
}

// Returns 1 when a is newer than b, -1 when older, 0 when equal. A pre-release sorts before its release.
function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) throw new Error(`Not a version: ${!x ? a : b}`);
  for (let i = 0; i < 3; i++) if (x.parts[i] !== y.parts[i]) return x.parts[i] > y.parts[i] ? 1 : -1;
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre > y.pre ? 1 : -1;
}

// Turns a GitHub "latest release" response into what the app shows. Tags that aren't versions
// (such as "initial") are reported as no update, since there is nothing to compare.
function checkRelease(release, currentVersion) {
  const tag = release && release.tag_name;
  const url = (release && release.html_url) || RELEASES_PAGE;
  if (!parseVersion(tag)) return { available: false, latest: tag || null, url };
  return { available: compareVersions(tag, currentVersion) > 0, latest: tag.replace(/^v/, ''), url, notes: release.body || '' };
}

module.exports = { RELEASES_API, RELEASES_PAGE, parseVersion, compareVersions, checkRelease };
