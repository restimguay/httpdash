#!/usr/bin/env node
'use strict';

/**
 * Compares command-line collection runners on the same collection against the same local server:
 * HttpDash (this checkout), Postman's Newman and Bruno's CLI. Each runner gets one warm-up run, then
 * the median of several timed runs is reported with peak memory.
 *
 *   node bench/run.js [--requests 500] [--runs 5] [--no-scripts] [--only httpdash,newman,bruno] [--httpdash <checkout>]
 *
 * Competitor CLIs are installed once at the pinned versions below into a cache folder, and their
 * binaries are run directly (not through npx, which would add its own start-up time).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const NEWMAN = 'newman@6.2.3';
const BRUNO = '@usebruno/cli@4.2.1';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i === -1 ? def : args[i + 1]; };
const REQUESTS = Number(opt('requests', 500));
const RUNS = Number(opt('runs', 5));
const SCRIPTS = !args.includes('--no-scripts');
const ONLY = opt('only', 'httpdash,newman,bruno').split(',');
const root = path.resolve(opt('httpdash', path.join(__dirname, '..')));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'httpdash-bench-'));

// ---- The server: a small JSON API, like most real endpoints ------------------------------------

const payload = JSON.stringify({ ok: true, items: Array.from({ length: 10 }, (_, i) => ({ id: i, name: `Item ${i}`, price: i * 1.5 })) });
function startServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
    res.end(payload);
  });
  server.keepAliveTimeout = 5000;
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// ---- The collection, written once per tool -------------------------------------------------------

const PRE = "pm.environment.set('stamp', String(Date.now()));";
const TEST = "pm.test('status is 200', () => pm.response.to.have.status(200));\npm.test('json ok', () => pm.expect(pm.response.json().ok).to.equal(true));";

function writePostman(base) {
  const item = Array.from({ length: REQUESTS }, (_, i) => ({
    name: `Request ${i + 1}`,
    event: SCRIPTS ? [
      { listen: 'prerequest', script: { type: 'text/javascript', exec: PRE.split('\n') } },
      { listen: 'test', script: { type: 'text/javascript', exec: TEST.split('\n') } },
    ] : [],
    request: { method: 'GET', header: [{ key: 'X-Stamp', value: '{{stamp}}' }], url: `${base}/items/${i + 1}?page=1` },
  }));
  const file = path.join(work, 'bench.postman_collection.json');
  fs.writeFileSync(file, JSON.stringify({ info: { name: 'Bench', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' }, item }));
  return file;
}

function writeBruno(base) {
  const dir = path.join(work, 'bruno');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'bruno.json'), JSON.stringify({ version: '1', name: 'Bench', type: 'collection' }));
  for (let i = 0; i < REQUESTS; i++) {
    const parts = [
      `meta {\n  name: Request ${i + 1}\n  type: http\n  seq: ${i + 1}\n}`,
      `get {\n  url: ${base}/items/${i + 1}?page=1\n  body: none\n  auth: none\n}`,
      'headers {\n  X-Stamp: {{stamp}}\n}',
    ];
    if (SCRIPTS) {
      parts.push("script:pre-request {\n  bru.setVar('stamp', String(Date.now()));\n}");
      parts.push("tests {\n  test('status is 200', function () { expect(res.getStatus()).to.equal(200); });\n  test('json ok', function () { expect(res.getBody().ok).to.equal(true); });\n}");
    }
    fs.writeFileSync(path.join(dir, `request-${String(i + 1).padStart(4, '0')}.bru`), `${parts.join('\n\n')}\n`);
  }
  return dir;
}

// ---- Running and measuring ---------------------------------------------------------------------

// Runs a command under /usr/bin/time to get wall time and peak memory (macOS and Linux formats).
// It must not block: the test server runs in this same process.
async function measure(cmd, cmdArgs, cwd) {
  const isMac = process.platform === 'darwin';
  const timeArgs = isMac ? ['-l', cmd, ...cmdArgs] : ['-v', cmd, ...cmdArgs];
  const start = process.hrtime.bigint();
  const r = await new Promise((resolve) => {
    const child = spawn('/usr/bin/time', timeArgs, { cwd, env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  const err = r.stderr || '';
  const rss = isMac
    ? Number((/(\d+)\s+maximum resident set size/.exec(err) || [])[1] || 0)
    : Number((/Maximum resident set size \(kbytes\): (\d+)/.exec(err) || [])[1] || 0) * 1024;
  return { ms, rssMB: rss / 1048576, status: r.status, output: (r.stdout || '') + err };
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

// Installs the competitor CLIs once; later runs reuse them.
function installTools() {
  const dir = path.join(os.tmpdir(), 'httpdash-bench-tools');
  const bin = (name) => path.join(dir, 'node_modules', '.bin', name);
  if (!fs.existsSync(bin('newman')) || !fs.existsSync(bin('bru'))) {
    console.log(`Installing ${NEWMAN} and ${BRUNO} into ${dir} (once)…`);
    fs.mkdirSync(dir, { recursive: true });
    const r = require('child_process').spawnSync('npm', ['install', '--no-save', '--no-audit', '--no-fund', '--prefix', dir, NEWMAN, BRUNO], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('Could not install the competitor CLIs');
  }
  return { newman: bin('newman'), bru: bin('bru') };
}

(async () => {
  const bins = installTools();
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const postmanFile = writePostman(base);
  const brunoDir = writeBruno(base);

  const tools = {
    httpdash: { label: 'HttpDash', run: () => measure(process.execPath, [path.join(root, 'bin', 'httpdash.js'), 'run', postmanFile, '--no-color', '-r', 'json', '--reporter-json-export', path.join(work, 'hd.json')], work) },
    newman: { label: `Newman ${NEWMAN.split('@')[1]}`, run: () => measure(bins.newman, ['run', postmanFile, '--reporters', 'json', '--reporter-json-export', path.join(work, 'nm.json')], work) },
    bruno: { label: `Bruno CLI ${BRUNO.split('@').pop()}`, run: () => measure(bins.bru, ['run', '--output', path.join(work, 'bru.json')], brunoDir) },
  };

  console.log(`${REQUESTS} requests, ${SCRIPTS ? 'with pre-request and test scripts' : 'no scripts'}, median of ${RUNS} runs (after a warm-up)\n`);
  const rows = [];
  for (const key of ONLY) {
    const tool = tools[key];
    if (!tool) continue;
    const warm = await tool.run();
    if (warm.status !== 0) {
      console.log(`${tool.label}: failed (exit ${warm.status})\n${warm.output.slice(-1500)}`);
      continue;
    }
    const runs = [];
    for (let i = 0; i < RUNS; i++) runs.push(await tool.run());
    const failed = runs.find((r) => r.status !== 0);
    if (failed) { console.log(`${tool.label}: a run failed (exit ${failed.status})`); continue; }
    rows.push({ label: tool.label, ms: median(runs.map((r) => r.ms)), rss: median(runs.map((r) => r.rssMB)) });
    console.log(`  ${tool.label.padEnd(18)} ${String(Math.round(median(runs.map((r) => r.ms)))).padStart(6)} ms   ${median(runs.map((r) => r.rssMB)).toFixed(0).padStart(4)} MB peak`);
  }
  if (rows.length > 1) {
    const best = Math.min(...rows.map((r) => r.ms));
    console.log('\n| Runner | Time | Requests/s | Peak memory | vs fastest |\n| --- | --- | --- | --- | --- |');
    for (const r of rows.sort((a, b) => a.ms - b.ms)) {
      console.log(`| ${r.label} | ${(r.ms / 1000).toFixed(2)} s | ${Math.round(REQUESTS / (r.ms / 1000))} | ${r.rss.toFixed(0)} MB | ${r.ms === best ? 'fastest' : `${(r.ms / best).toFixed(1)}× slower`} |`);
    }
  }
  server.close();
  fs.rmSync(work, { recursive: true, force: true });
})();
