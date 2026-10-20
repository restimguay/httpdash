'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { compareVersions, checkRelease, parseVersion } = require('../src/core/update');

test('versions compare numerically, with pre-releases before their release', () => {
  assert.strictEqual(compareVersions('1.10.0', '1.9.9'), 1);
  assert.strictEqual(compareVersions('v1.0.0', '1.0.0'), 0);
  assert.strictEqual(compareVersions('1.0.0', '1.0.1'), -1);
  assert.strictEqual(compareVersions('1.0.0-beta.1', '1.0.0'), -1);
  assert.strictEqual(compareVersions('1.0.0', '1.0.0-rc.1'), 1);
  assert.strictEqual(parseVersion('initial'), null);
});

test('a newer release tag is reported as an update', () => {
  const r = checkRelease({ tag_name: 'v1.2.0', html_url: 'https://example.test/r', body: 'notes' }, '1.0.0');
  assert.deepStrictEqual(r, { available: true, latest: '1.2.0', url: 'https://example.test/r', notes: 'notes' });
  assert.strictEqual(checkRelease({ tag_name: 'v1.0.0' }, '1.0.0').available, false);
});

test('a release tag that is not a version is not an update', () => {
  const r = checkRelease({ tag_name: 'initial' }, '1.0.0');
  assert.strictEqual(r.available, false);
  assert.strictEqual(r.latest, 'initial');
});
