'use strict';

const { execute } = require('./executor');

// Flattens a collection (or one folder of it) into an ordered list of { item, chain }.
function flatten(collection, folderId) {
  const out = [];
  const walk = (node, chain) => {
    for (const child of node.items || []) {
      if (child.type === 'folder') walk(child, [...chain, child]);
      else out.push({ item: child, chain });
    }
  };
  if (folderId) {
    const find = (node, chain) => {
      for (const child of node.items || []) {
        if (child.type !== 'folder') continue;
        if (child.id === folderId) return walk(child, [...chain, child]) || true;
        if (find(child, [...chain, child])) return true;
      }
      return false;
    };
    find(collection, [collection]);
  } else walk(collection, [collection]);
  return out;
}

function parseCsv(textInput) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const s = String(textInput).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++; } else if (c === '"') inQuotes = false; else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((x) => x !== '')) rows.push(row);
  if (!rows.length) return [];
  const [header, ...data] = rows;
  return data.map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), r[i] === undefined ? '' : r[i]])));
}

function parseDataFile(content, filename = '') {
  const trimmed = String(content).trim();
  if (/\.json$/i.test(filename) || trimmed.startsWith('[')) {
    const data = JSON.parse(trimmed);
    if (!Array.isArray(data)) throw new Error('JSON data file must contain an array of objects');
    return data;
  }
  return parseCsv(content);
}

/**
 * opts: { collection, folderId, scopes: {globals, environment}, iterations, data, delay, settings, jar,
 *         stopOnFailure, onEvent(evt), signal }
 * Returns a summary; scopes are updated in place so the caller can persist them.
 */
async function run(opts) {
  const list = flatten(opts.collection, opts.folderId);
  const data = opts.data && opts.data.length ? opts.data : null;
  const iterations = Math.max(1, opts.iterations || (data ? data.length : 1));
  const emit = opts.onEvent || (() => {});
  const scopes = {
    globals: opts.scopes.globals || {},
    environment: opts.scopes.environment || {},
    collection: opts.scopes.collection || {},
  };
  const summary = { iterations, requests: 0, failedRequests: 0, tests: 0, passed: 0, failed: 0, skipped: 0, totalTime: 0, results: [], stopped: false };
  const started = Date.now();

  outer: for (let it = 0; it < iterations; it++) {
    const dataRow = data ? data[it % data.length] : {};
    emit({ type: 'iteration', iteration: it, dataRow });
    let idx = 0;
    let guard = 0;
    while (idx < list.length) {
      if (opts.signal && opts.signal.aborted) { summary.stopped = true; break outer; }
      if (++guard > 10000) throw new Error('Runner exceeded 10000 steps in one iteration (setNextRequest loop?)');
      const { item, chain } = list[idx];
      emit({ type: 'request-start', iteration: it, id: item.id, name: item.name });
      const res = await execute({
        request: item.request,
        chain,
        scopes: { ...scopes, data: dataRow },
        jar: opts.jar,
        settings: opts.settings,
        info: { requestName: item.name, requestId: item.id, iteration: it, iterationCount: iterations },
        log: (level, message) => emit({ type: 'console', level, message, name: item.name }),
        signal: opts.signal,
      });
      Object.assign(scopes.globals, clearInto(scopes.globals, res.scopes.globals));
      Object.assign(scopes.environment, clearInto(scopes.environment, res.scopes.environment));
      Object.assign(scopes.collection, clearInto(scopes.collection, res.scopes.collection));

      const passed = res.tests.filter((t) => t.passed && !t.skipped).length;
      const skipped = res.tests.filter((t) => t.skipped).length;
      const failed = res.tests.filter((t) => !t.passed).length;
      summary.requests++;
      summary.tests += res.tests.length;
      summary.passed += passed;
      summary.failed += failed;
      summary.skipped += skipped;
      if (res.error) summary.failedRequests++;
      if (res.response) summary.totalTime += res.response.time;
      const entry = {
        iteration: it, id: item.id, name: item.name,
        method: res.sentRequest ? res.sentRequest.method : item.request.method,
        url: res.sentRequest ? res.sentRequest.url : item.request.url,
        status: res.response ? res.response.status : null,
        statusText: res.response ? res.response.statusText : '',
        time: res.response ? res.response.time : 0,
        size: res.response ? res.response.size : 0,
        error: res.error || null,
        skipped: !!res.skipped,
        tests: res.tests,
        response: res.response ? { headers: res.response.headers, bodyText: truncate(res.response.bodyText) } : null,
        sentRequest: res.sentRequest,
      };
      summary.results.push(entry);
      emit({ type: 'request-done', ...entry });

      if (opts.stopOnFailure && (failed || res.error)) { summary.stopped = true; break outer; }

      if (res.nextRequest === null) break; // pm.setNextRequest(null) ends this iteration.
      if (res.nextRequest !== undefined) {
        const target = list.findIndex((x) => x.item.name === res.nextRequest || x.item.id === res.nextRequest);
        if (target === -1) {
          emit({ type: 'console', level: 'warn', message: `setNextRequest: no request named "${res.nextRequest}"; stopping iteration` });
          break;
        }
        idx = target;
      } else idx++;

      if (opts.delay && idx < list.length) await sleep(opts.delay, opts.signal);
    }
  }
  summary.duration = Date.now() - started;
  summary.scopes = scopes;
  emit({ type: 'done', summary: { ...summary, results: undefined } });
  return summary;
}

// Replaces the contents of target with source (so deletions by scripts are honoured).
function clearInto(target, source) {
  for (const k of Object.keys(target)) delete target[k];
  return source;
}

function truncate(s, n = 200000) {
  if (s == null) return s;
  return s.length > n ? s.slice(0, n) + `\n... [truncated ${s.length - n} characters]` : s;
}

function sleep(ms, signal) {
  return new Promise((res) => {
    const t = setTimeout(res, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true });
  });
}

module.exports = { run, flatten, parseCsv, parseDataFile };
