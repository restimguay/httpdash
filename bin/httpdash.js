#!/usr/bin/env node
'use strict';

/**
 * HttpDash command-line runner: runs a collection outside the app (CI, cron, schedulers).
 *
 *   httpdash run <file> [options]
 *
 * <file> can be a Postman collection, an HttpDash backup (Export → HttpDash backup) or a workspace.json.
 * Exit code: 0 = everything passed, 1 = a test or request failed, 2 = usage / input error.
 */
const fs = require('fs');
const path = require('path');
const runner = require('../src/core/runner');
const postman = require('../src/core/postman');
const backup = require('../src/core/backup');
const { listToObject } = require('../src/core/variables');

const HELP = `HttpDash command-line runner

Usage:
  httpdash run <file> [options]
  httpdash list <file>

<file>: Postman collection (v2.0/v2.1), HttpDash backup, or HttpDash workspace.json

Options:
  -c, --collection <name|id>    Collection to run (when the file has several)
  -f, --folder <name>           Run only this folder
  -e, --environment <file|name> Postman environment file, or an environment name inside the backup
  -g, --globals <file>          Postman globals file
      --env-var <key=value>     Set an environment variable (repeatable; use for secrets in CI)
  -n, --iteration-count <n>     Number of iterations
  -d, --iteration-data <file>   CSV or JSON data file (one iteration per row)
      --delay-request <ms>      Wait between requests
      --timeout-request <ms>    Request timeout
  -k, --insecure                Do not verify SSL certificates
      --bail                    Stop at the first failure
  -r, --reporters <list>        cli,json,junit (default: cli)
      --reporter-json-export <file>   Where to write the JSON report (default: httpdash-report.json)
      --reporter-junit-export <file>  Where to write the JUnit XML report (default: httpdash-junit.xml)
      --no-color                Plain output
  -v, --version                 Show the version
  -h, --help                    Show this help
`;

function parseArgs(argv) {
  const opts = { envVars: {}, reporters: ['cli'], color: true };
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw usage(`Missing value for ${a}`);
      return argv[++i];
    };
    switch (a) {
      case '-c': case '--collection': opts.collection = val(); break;
      case '-f': case '--folder': opts.folder = val(); break;
      case '-e': case '--environment': opts.environment = val(); break;
      case '-g': case '--globals': opts.globals = val(); break;
      case '--env-var': {
        const kv = val();
        const i2 = kv.indexOf('=');
        if (i2 < 1) throw usage(`--env-var expects key=value, got "${kv}"`);
        opts.envVars[kv.slice(0, i2)] = kv.slice(i2 + 1);
        break;
      }
      case '-n': case '--iteration-count': opts.iterations = Number(val()); break;
      case '-d': case '--iteration-data': opts.data = val(); break;
      case '--delay-request': opts.delay = Number(val()); break;
      case '--timeout-request': opts.timeout = Number(val()); break;
      case '-k': case '--insecure': opts.insecure = true; break;
      case '--bail': opts.bail = true; break;
      case '-r': case '--reporters': opts.reporters = val().split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--reporter-json-export': opts.jsonOut = val(); break;
      case '--reporter-junit-export': opts.junitOut = val(); break;
      case '--no-color': opts.color = false; break;
      case '-h': case '--help': opts.help = true; break;
      case '-v': case '--version': opts.version = true; break;
      default:
        if (a.startsWith('-')) throw usage(`Unknown option ${a}`);
        pos.push(a);
    }
  }
  opts.command = pos[0];
  opts.file = pos[1];
  return opts;
}

function usage(msg) {
  const e = new Error(msg);
  e.exitCode = 2;
  return e;
}

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw usage(`Could not read ${file}: ${e.message}`);
  }
};

// Loads collections, environments and globals from any supported file.
function loadSource(file) {
  const json = readJson(file);
  if (backup.isBackup(json)) return { ...json.workspace, kind: 'HttpDash backup' };
  if (Array.isArray(json.collections) && json.version) return { ...json, kind: 'HttpDash workspace' };
  const r = postman.importAny(json);
  if (r.kind === 'collection') return { collections: [r.data], environments: [], globals: [], kind: 'collection' };
  throw usage(`${file} is a ${r.kind}, not a collection. Pass it with -e / -g instead.`);
}

function pick(list, wanted, what) {
  if (!list.length) throw usage(`No ${what}s found`);
  if (!wanted) {
    if (list.length === 1) return list[0];
    throw usage(`The file has ${list.length} ${what}s; choose one with --${what} "<name>": ${list.map((x) => `"${x.name}"`).join(', ')}`);
  }
  const hit = list.find((x) => x.id === wanted) || list.find((x) => x.name === wanted) || list.find((x) => x.name.toLowerCase() === String(wanted).toLowerCase());
  if (!hit) throw usage(`No ${what} named "${wanted}". Available: ${list.map((x) => `"${x.name}"`).join(', ')}`);
  return hit;
}

function findFolder(col, name) {
  let found = null;
  const walk = (items) => items.forEach((it) => {
    if (found || it.type !== 'folder') return;
    if (it.name === name || it.id === name) found = it; else walk(it.items);
  });
  walk(col.items);
  if (!found) throw usage(`No folder named "${name}" in "${col.name}"`);
  return found;
}

// ---- Reporters ---------------------------------------------------------------------------

function paint(enabled) {
  const c = (code) => (s) => (enabled ? `\x1b[${code}m${s}\x1b[0m` : String(s));
  return { green: c(32), red: c(31), yellow: c(33), gray: c(90), bold: c(1), cyan: c(36) };
}

const fmtBytes = (n) => (n < 1024 ? `${n}B` : `${(n / 1024).toFixed(1)}KB`);
const xml = (s) => String(s == null ? '' : s).replace(/[<>&"']/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[ch]));

function junit(collectionName, summary) {
  const totals = { tests: 0, failures: 0, errors: 0 };
  const suites = summary.results.map((r) => {
    const cases = r.tests.length ? r.tests : [{ name: r.error ? 'request' : 'request completed', passed: !r.error, error: r.error }];
    const failures = cases.filter((t) => !t.passed && !r.error).length;
    totals.tests += cases.length;
    totals.failures += failures;
    totals.errors += r.error ? 1 : 0;
    const body = cases.map((t) => {
      let inner = '';
      if (t.skipped) inner = '<skipped/>';
      else if (!t.passed) inner = r.error && !r.tests.length ? `<error message="${xml(r.error)}"/>` : `<failure message="${xml(t.error)}"/>`;
      return `    <testcase name="${xml(t.name)}" classname="${xml(`${collectionName}.${r.name}`)}" time="${(r.time / 1000).toFixed(3)}">${inner}</testcase>`;
    }).join('\n');
    return `  <testsuite name="${xml(`${r.name} (iteration ${r.iteration + 1})`)}" tests="${cases.length}" failures="${failures}" errors="${r.error ? 1 : 0}" time="${(r.time / 1000).toFixed(3)}">\n${body}\n  </testsuite>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="${xml(collectionName)}" tests="${totals.tests}" failures="${totals.failures}" errors="${totals.errors}">\n${suites.join('\n')}\n</testsuites>\n`;
}

// ---- Main ---------------------------------------------------------------------------------

async function main(argv, io = { out: (s) => process.stdout.write(`${s}\n`), err: (s) => process.stderr.write(`${s}\n`) }) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    io.err(e.message);
    return e.exitCode || 2;
  }
  if (opts.version) { io.out(require('../package.json').version); return 0; }
  if (opts.help || !opts.command) { io.out(HELP); return opts.help ? 0 : 2; }
  const p = paint(opts.color && process.stdout.isTTY !== false);
  try {
    if (!opts.file) throw usage('Missing <file>. Run "httpdash --help" for usage.');
    const src = loadSource(opts.file);
    if (opts.command === 'list') {
      io.out(`${src.kind}: ${opts.file}`);
      io.out(`Collections: ${(src.collections || []).map((c) => `"${c.name}"`).join(', ') || '(none)'}`);
      io.out(`Environments: ${(src.environments || []).map((e) => `"${e.name}"`).join(', ') || '(none)'}`);
      return 0;
    }
    if (opts.command !== 'run') throw usage(`Unknown command "${opts.command}". Use "run" or "list".`);

    const col = pick(src.collections || [], opts.collection, 'collection');
    const folder = opts.folder ? findFolder(col, opts.folder) : null;

    let environment = {};
    let envName = null;
    if (opts.environment) {
      if (fs.existsSync(opts.environment)) {
        const r = postman.importAny(readJson(opts.environment));
        if (r.kind !== 'environment') throw usage(`${opts.environment} is not an environment file`);
        environment = listToObject(r.data.values);
        envName = r.data.name;
      } else {
        const env = pick(src.environments || [], opts.environment, 'environment');
        environment = listToObject(env.values);
        envName = env.name;
      }
    }
    Object.assign(environment, opts.envVars);
    let globals = listToObject(src.globals || []);
    if (opts.globals) {
      const r = postman.importAny(readJson(opts.globals));
      globals = { ...globals, ...listToObject(r.kind === 'globals' ? r.data : r.data.values) };
    }
    let data = null;
    if (opts.data) {
      try { data = runner.parseDataFile(fs.readFileSync(opts.data, 'utf8'), opts.data); } catch (e) { throw usage(`Could not read data file ${opts.data}: ${e.message}`); }
    }

    const settings = {
      timeout: opts.timeout || 0, verifySSL: !opts.insecure, followRedirects: true, sendCookies: true, sendNoCache: true,
      userAgent: 'HttpDash-CLI/1.0', maxResponseBytes: 50 * 1024 * 1024,
    };
    const cli = opts.reporters.includes('cli');
    if (cli) {
      io.out(p.bold(`HttpDash  ${col.name}${folder ? ` / ${folder.name}` : ''}${envName ? `  (environment: ${envName})` : ''}`));
    }
    let lastIteration = -1;
    const summary = await runner.run({
      collection: col,
      folderId: folder ? folder.id : null,
      scopes: { globals, environment, collection: listToObject(col.variables) },
      iterations: opts.iterations || (data ? data.length : 1),
      data,
      delay: opts.delay || 0,
      settings,
      jar: [],
      stopOnFailure: !!opts.bail,
      onEvent: (evt) => {
        if (!cli) return;
        if (evt.type === 'iteration' && (opts.iterations > 1 || data)) {
          if (evt.iteration !== lastIteration) io.out(p.gray(`\nIteration ${evt.iteration + 1}`));
          lastIteration = evt.iteration;
        }
        if (evt.type === 'request-done') {
          io.out(`\n${p.cyan('→')} ${evt.name}`);
          for (const d of evt.dependencyRuns || []) io.out(p.gray(`  ↳ ran "${d.name}" first (${d.reason}) ${d.status || ''} ${d.error ? p.red(d.error) : ''}`));
          if (evt.error) io.out(`  ${evt.method} ${evt.url} ${p.red(`[${evt.error}]`)}`);
          else io.out(`  ${evt.method} ${evt.url} ${p.gray(`[${evt.status} ${evt.statusText}, ${fmtBytes(evt.size)}, ${evt.time}ms]`)}`);
          for (const t of evt.tests) {
            if (t.skipped) io.out(p.gray(`  - ${t.name} (skipped)`));
            else if (t.passed) io.out(`  ${p.green('✓')} ${t.name}`);
            else io.out(`  ${p.red('✗')} ${t.name}: ${p.red(t.error)}`);
          }
        }
        if (evt.type === 'console' && evt.level === 'error') io.out(p.yellow(`  ! ${evt.message}`));
      },
    });

    const failedOverall = summary.failed > 0 || summary.failedRequests > 0;
    if (cli) {
      io.out('');
      io.out(p.bold('┌──────────────┬──────────┬──────────┐'));
      io.out(p.bold('│              │ executed │   failed │'));
      io.out(`│ iterations   │ ${String(summary.iterations).padStart(8)} │ ${String(0).padStart(8)} │`);
      io.out(`│ requests     │ ${String(summary.requests).padStart(8)} │ ${(summary.failedRequests ? p.red : (s) => s)(String(summary.failedRequests).padStart(8))} │`);
      io.out(`│ tests        │ ${String(summary.tests).padStart(8)} │ ${(summary.failed ? p.red : (s) => s)(String(summary.failed).padStart(8))} │`);
      io.out('└──────────────┴──────────┴──────────┘');
      io.out(`Total time ${summary.duration} ms. ${failedOverall ? p.red('FAILED') : p.green('PASSED')}${summary.stopped ? ' (stopped early with --bail)' : ''}`);
    }
    const reportData = { collection: col.name, environment: envName, startedAt: new Date(Date.now() - summary.duration).toISOString(), summary: { ...summary, results: undefined, scopes: undefined }, results: summary.results };
    if (opts.reporters.includes('json')) {
      const out = opts.jsonOut || 'httpdash-report.json';
      fs.writeFileSync(out, JSON.stringify(reportData, null, 2));
      if (cli) io.out(p.gray(`JSON report: ${path.resolve(out)}`));
    }
    if (opts.reporters.includes('junit')) {
      const out = opts.junitOut || 'httpdash-junit.xml';
      fs.writeFileSync(out, junit(col.name, summary));
      if (cli) io.out(p.gray(`JUnit report: ${path.resolve(out)}`));
    }
    return failedOverall ? 1 : 0;
  } catch (e) {
    io.err(p.red(`Error: ${e.message}`));
    return e.exitCode || 2;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

module.exports = { main, parseArgs, junit };
