'use strict';

/* Monitors (scheduled runs), mock servers, the secret scanner and the audit log viewer. */
(() => {
  const { h } = HD;
  const S = HD.S;
  HD.views = HD.views || {};

  const openTab = (kind, refId) => {
    const existing = S.ws.tabs.find((t) => t.kind === kind && (refId === undefined || t.refId === refId));
    if (existing) return HD.activateTab(existing.id);
    const cur = HD.currentTab();
    const tab = { id: HD.uid(), kind, refId };
    S.ws.tabs.splice(cur ? S.ws.tabs.indexOf(cur) + 1 : S.ws.tabs.length, 0, tab);
    return HD.activateTab(tab.id);
  };
  const ago = (t) => {
    if (!t) return 'never';
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${(s / 3600).toFixed(1)} h ago`;
    return new Date(t).toLocaleString();
  };

  // ==== Monitors ===========================================================================

  const monitors = () => (S.ws.monitors = S.ws.monitors || []);
  HD.monitors = monitors;
  const running = new Set();

  HD.newMonitor = () => {
    const col = S.ws.collections[0];
    const m = {
      id: HD.uid(), name: col ? `${col.name} monitor` : 'New monitor', collectionId: col ? col.id : null, folderId: null,
      environmentId: S.ws.activeEnvironmentId || null, intervalMinutes: 15, enabled: true,
      notifyOnFailure: true, notifyOnRecovery: true, persistVariables: true, lastRunAt: null, history: [],
    };
    monitors().push(m);
    HD.save();
    HD.renderSidebar();
    openTab('monitor', m.id);
  };

  const notify = (title, body) => {
    try {
      if (window.Notification && Notification.permission !== 'denied') new Notification(title, { body });
    } catch { /* notifications unavailable */ }
  };

  HD.runMonitor = async (m) => {
    if (running.has(m.id)) return;
    const col = S.ws.collections.find((c) => c.id === m.collectionId);
    if (!col) return;
    running.add(m.id);
    HD.emit('monitors');
    const env = S.ws.environments.find((e) => e.id === m.environmentId);
    const before = { globals: HD.listToObject(S.ws.globals), environment: env ? HD.listToObject(env.values) : {}, collection: HD.listToObject(col.variables) };
    const started = Date.now();
    let entry;
    try {
      const sum = await window.api.runMonitor({
        collection: HD.clone(col), folderId: m.folderId, scopes: HD.clone(before), iterations: 1,
        settings: S.ws.settings, monitorName: m.name, useCookies: true,
      });
      if (m.persistVariables) {
        let changed = HD.applyScope(S.ws.globals, before.globals, sum.scopes.globals);
        if (env) changed = HD.applyScope(env.values, before.environment, sum.scopes.environment) || changed;
        changed = HD.applyScope(col.variables, before.collection, sum.scopes.collection) || changed;
        if (changed) HD.emit('variables');
      }
      const failures = [];
      for (const r of sum.results) {
        if (r.error) failures.push({ request: r.name, error: r.error });
        for (const t of r.tests) failures.push({ request: r.name, test: t.name, error: t.error });
      }
      entry = { time: started, ok: !sum.failed && !sum.failedRequests, requests: sum.requests, passed: sum.passed, failed: sum.failed, errors: sum.failedRequests, durationMs: sum.duration, failures: failures.slice(0, 50) };
    } catch (e) {
      entry = { time: started, ok: false, requests: 0, passed: 0, failed: 0, errors: 1, durationMs: Date.now() - started, failures: [{ request: '(run)', error: HD.cleanErr(e) }] };
    }
    const prev = m.history[0];
    m.history.unshift(entry);
    if (m.history.length > 100) m.history.length = 100;
    m.lastRunAt = started;
    running.delete(m.id);
    HD.log(entry.ok ? 'info' : 'error', `Monitor "${m.name}": ${entry.ok ? 'passed' : `${entry.failed} failed tests, ${entry.errors} request errors`} (${HD.formatMs(entry.durationMs)})`);
    if (!entry.ok && m.notifyOnFailure) notify(`HttpDash monitor failed: ${m.name}`, entry.failures.slice(0, 3).map((f) => `${f.request}: ${f.test ? `${f.test} – ` : ''}${f.error}`).join('\n'));
    if (entry.ok && prev && !prev.ok && m.notifyOnRecovery) notify(`HttpDash monitor recovered: ${m.name}`, `All ${entry.passed} tests passed.`);
    HD.save();
    HD.emit('monitors');
  };

  let schedulerStarted = false;
  HD.startMonitors = () => {
    if (schedulerStarted) return;
    schedulerStarted = true;
    try { if (window.Notification && Notification.permission === 'default') Notification.requestPermission(); } catch { /* ignore */ }
    const tick = async () => {
      if (document.body.classList.contains('is-locked')) return;
      for (const m of monitors()) {
        if (!m.enabled || running.has(m.id)) continue;
        if (Date.now() - (m.lastRunAt || 0) >= (Number(m.intervalMinutes) || 15) * 60000) await HD.runMonitor(m);
      }
    };
    setInterval(tick, 20000);
    setTimeout(tick, 5000);
  };

  HD.renderMonitorsSidebar = (panel) => {
    panel.appendChild(h('div.side-toolbar', HD.button('', () => HD.newMonitor(), { icon: 'plus', ghost: true, title: 'New monitor' }), h('span.muted.small.side-hint', 'Scheduled collection runs')));
    const list = h('div.tree');
    panel.appendChild(list);
    if (!monitors().length) {
      list.appendChild(h('div.empty-state.small', h('div', 'No monitors yet.'), h('div.muted', 'A monitor runs a collection every few minutes and notifies you when tests fail.'),
        HD.button('New monitor', () => HD.newMonitor(), { small: true, icon: 'plus' })));
      return;
    }
    const active = HD.currentTab();
    for (const m of monitors()) {
      const last = m.history[0];
      const state = running.has(m.id) ? 'running' : !m.enabled ? 'paused' : !last ? 'idle' : last.ok ? 'ok' : 'fail';
      list.appendChild(h('div.tree-row.env-row', {
        class: active && active.kind === 'monitor' && active.refId === m.id ? 'active' : '',
        onclick: () => openTab('monitor', m.id),
        oncontextmenu: (e) => HD.menu(e, [
          { label: 'Run now', onClick: () => HD.runMonitor(m) },
          { label: m.enabled ? 'Pause' : 'Resume', onClick: () => { m.enabled = !m.enabled; HD.save(); HD.renderSidebar(); } },
          { separator: true },
          { label: 'Delete', danger: true, onClick: () => deleteMonitor(m) },
        ]),
      }, h(`span.monitor-dot.${state}`, { title: state }), h('span.tree-name', m.name), h('span.muted.small', `${m.intervalMinutes}m`)));
    }
  };

  const deleteMonitor = async (m) => {
    if (!(await HD.confirm('Delete monitor', `Delete "${m.name}" and its run history?`, { danger: true, okLabel: 'Delete' }))) return;
    monitors().splice(monitors().indexOf(m), 1);
    S.ws.tabs.filter((t) => t.kind === 'monitor' && t.refId === m.id).forEach((t) => HD.closeTab(t.id, true));
    HD.save();
    HD.renderSidebar();
  };

  HD.views.monitor = (tab, root) => {
    const m = monitors().find((x) => x.id === tab.refId);
    if (!m) { root.appendChild(h('div.empty-state', 'This monitor no longer exists.')); return; }
    HD.variableInfo = () => ({});
    const touch = () => { HD.save(); HD.renderSidebar(); };
    const rerender = () => { HD.clear(root); HD.views.monitor(tab, root); };
    const col = S.ws.collections.find((c) => c.id === m.collectionId);
    const folders = [];
    if (col) HD.walk(col.items, (it, parents) => { if (it.type === 'folder') folders.push([it.id, [...parents.map((p) => p.name), it.name].join(' / ')]); });
    const hist = m.history || [];
    const okRuns = hist.filter((r) => r.ok).length;
    const uptime = hist.length ? `${((okRuns / hist.length) * 100).toFixed(1)}%` : '–';
    const avg = hist.length ? HD.formatMs(hist.reduce((n, r) => n + r.durationMs, 0) / hist.length) : '–';
    const next = m.enabled ? (m.lastRunAt ? Math.max(0, m.lastRunAt + m.intervalMinutes * 60000 - Date.now()) : 0) : null;
    const maxDur = Math.max(1, ...hist.slice(0, 60).map((r) => r.durationMs));

    const check = (key, label) => h('label.check', h('input', { type: 'checkbox', checked: !!m[key], onchange: (e) => { m[key] = e.target.checked; touch(); } }), label);
    root.appendChild(h('div.container-view',
      h('div.req-header',
        h('div.breadcrumb', h('span.kind-label', 'Monitor'), h('input.title-input', { value: m.name, spellcheck: 'false', oninput: (e) => { m.name = e.target.value; touch(); HD.renderTabBar(); } })),
        h('div.req-header-actions',
          HD.button(running.has(m.id) ? 'Running…' : 'Run now', () => HD.runMonitor(m), { small: true, primary: true, icon: 'play', disabled: running.has(m.id) || !col }),
          HD.button('', () => deleteMonitor(m), { icon: 'trash', ghost: true, small: true, title: 'Delete monitor' }))),
      h('div.monitor-layout',
        h('div.monitor-config',
          h('label.field', h('span', 'Collection'), HD.select([['', '— Select —'], ...S.ws.collections.map((c) => [c.id, c.name])], m.collectionId || '', (v) => { m.collectionId = v || null; m.folderId = null; touch(); rerender(); })),
          col ? h('label.field', h('span', 'Folder'), HD.select([['', 'Entire collection'], ...folders], m.folderId || '', (v) => { m.folderId = v || null; touch(); })) : null,
          h('label.field', h('span', 'Environment'), HD.select([['', 'No environment'], ...S.ws.environments.map((e) => [e.id, e.name])], m.environmentId || '', (v) => { m.environmentId = v || null; touch(); })),
          h('label.field', h('span', 'Run every'), HD.select([[1, '1 minute'], [5, '5 minutes'], [10, '10 minutes'], [15, '15 minutes'], [30, '30 minutes'], [60, '1 hour'], [180, '3 hours'], [360, '6 hours'], [720, '12 hours'], [1440, '24 hours']], m.intervalMinutes, (v) => { m.intervalMinutes = Number(v); touch(); rerender(); })),
          check('enabled', 'Enabled'),
          check('notifyOnFailure', 'Desktop notification when it fails'),
          check('notifyOnRecovery', 'Desktop notification when it recovers'),
          check('persistVariables', 'Keep variable changes (e.g. refreshed tokens)'),
          h('div.muted.small.monitor-note', 'Monitors run while HttpDash is open and unlocked. For around-the-clock checks, schedule the command-line runner (httpdash run) with cron, Task Scheduler or your CI.')),
        h('div.monitor-results',
          h('div.runner-summary',
            h('div.stat', h('div.stat-value', uptime), h('div.stat-label', `Success (${hist.length} runs)`)),
            h('div.stat', h('div.stat-value', avg), h('div.stat-label', 'Avg. duration')),
            h('div.stat', h('div.stat-value', hist[0] ? (hist[0].ok ? 'Passed' : 'Failed') : '–'), h('div.stat-label', `Last run ${ago(m.lastRunAt)}`)),
            h('div.stat', h('div.stat-value', next === null ? 'Paused' : running.has(m.id) ? 'Now' : next <= 0 ? 'Soon' : `${Math.ceil(next / 60000)} min`), h('div.stat-label', 'Next run'))),
          hist.length ? h('div.monitor-chart', { title: 'Duration of the last runs (red = failed)' },
            hist.slice(0, 60).reverse().map((r) => h('div.monitor-bar', { class: r.ok ? 'ok' : 'fail', style: { height: `${Math.max(6, (r.durationMs / maxDur) * 100)}%` }, title: `${new Date(r.time).toLocaleString()} – ${r.ok ? 'passed' : 'failed'} – ${HD.formatMs(r.durationMs)}` }))) : null,
          h('div.section-title', 'Run history'),
          hist.length ? h('div.runner-list', hist.slice(0, 50).map((r) => {
            const row = h('div.runner-row', { class: r.ok ? '' : 'has-fail' },
              h('div.runner-row-head', { onclick: () => row.classList.toggle('open') },
                h(`span.test-badge.${r.ok ? 'pass' : 'fail'}`, r.ok ? 'PASS' : 'FAIL'),
                h('span', new Date(r.time).toLocaleString()), h('span.spacer'),
                h('span.muted.small', `${r.passed} passed · ${r.failed} failed · ${r.errors} errors`),
                h('span.muted.small', HD.formatMs(r.durationMs))),
              r.failures && r.failures.length ? h('div.runner-detail', r.failures.map((f) => h('div.test-item.compact', h('span.test-badge.fail', 'FAIL'), h('span.test-name', `${f.request}${f.test ? ` › ${f.test}` : ''}`), h('span.test-error', f.error)))) : null);
            return row;
          })) : h('div.empty-state.small', 'No runs yet. Click "Run now" or wait for the schedule.')))));
  };
  HD.on('monitors', () => {
    const t = HD.currentTab();
    if (t && t.kind === 'monitor') HD.renderActiveTab();
    if ((S.ws.ui.sidebarTab || '') === 'monitors') HD.renderSidebar();
  });

  // ==== Mock servers =======================================================================

  HD.mockLogs = {};
  const runningMocks = new Map();
  const refreshMocks = async () => {
    runningMocks.clear();
    for (const m of await window.api.mock.list()) runningMocks.set(m.collectionId, m);
  };
  window.api.mock.onLog((entry) => {
    const list = (HD.mockLogs[entry.collectionId] = HD.mockLogs[entry.collectionId] || []);
    list.unshift(entry);
    if (list.length > 100) list.length = 100;
    HD.log('net', `MOCK ${entry.method} ${entry.path} -> ${entry.status}${entry.example ? ` (example "${entry.example}")` : ''}`);
    HD.emit('mock-log', entry.collectionId);
  });

  // Keep running mock servers in sync with saved examples.
  const origSave = HD.save;
  const pushMockRoutes = HD.debounce(() => {
    for (const id of runningMocks.keys()) {
      const col = S.ws.collections.find((c) => c.id === id);
      if (col) window.api.mock.update({ collection: HD.clone(col) }).catch(() => {});
    }
  }, 800);
  HD.save = () => { origSave(); if (runningMocks.size) pushMockRoutes(); };

  const leadingVars = (col) => {
    const names = new Set();
    HD.walk(col.items, (it) => {
      if (it.type !== 'request') return;
      const m = /^\s*\{\{([^{}]+)\}\}/.exec(it.request.url || '');
      if (m) names.add(m[1].trim());
    });
    return [...names];
  };
  const routesOf = (col) => {
    const out = [];
    HD.walk(col.items, (it, parents) => {
      if (it.type !== 'request') return;
      let p = String(it.request.url || '').split('?')[0].replace(/^\{\{[^{}]+\}\}/, '').replace(/^[a-z]+:\/\/[^/]*/i, '');
      if (!p.startsWith('/')) p = `/${p}`;
      out.push({ id: it.id, name: it.name, folder: parents.map((x) => x.name).join(' / '), method: it.request.method, path: p, examples: (it.examples || []).length });
    });
    return out;
  };

  HD.renderMockPanel = async (panel, col) => {
    await refreshMocks();
    HD.clear(panel);
    col.mock = col.mock || { port: 3001, delayMs: 0, lan: false };
    const cfg = col.mock;
    const state = runningMocks.get(col.id);
    const rerender = () => HD.renderMockPanel(panel, col);
    const routes = routesOf(col);
    const withExamples = routes.filter((r) => r.examples).length;

    const controls = h('div.mock-controls',
      h('label.field', h('span', 'Port'), h('input.input.input-small', { type: 'number', min: 1, max: 65535, value: cfg.port, disabled: !!state, oninput: (e) => { cfg.port = Number(e.target.value); HD.save(); } })),
      h('label.field', h('span', 'Delay (ms)'), h('input.input.input-small', { type: 'number', min: 0, value: cfg.delayMs, disabled: !!state, oninput: (e) => { cfg.delayMs = Number(e.target.value); HD.save(); } })),
      h('label.check.mock-lan', h('input', { type: 'checkbox', checked: !!cfg.lan, disabled: !!state, onchange: (e) => { cfg.lan = e.target.checked; HD.save(); } }), 'Allow other devices on my network'),
      state
        ? HD.button('Stop mock server', async () => { await window.api.mock.stop(col.id); rerender(); }, { danger: true, icon: 'stop' })
        : HD.button('Start mock server', async () => {
          try {
            await window.api.mock.start({ collection: HD.clone(col), port: cfg.port, delayMs: cfg.delayMs, lan: cfg.lan });
            rerender();
          } catch (e) { HD.toast(HD.cleanErr(e), 'error', 6000); }
        }, { primary: true, icon: 'play' }));

    const status = state
      ? h('div.mock-running', h('span.monitor-dot.ok'), h('span', 'Running at '), h('b.mono', state.url), HD.button('', () => HD.copy(state.url), { icon: 'copy', ghost: true, small: true, title: 'Copy URL' }),
        h('span.spacer'),
        HD.button('Use in an environment', () => mockEnvironment(col, state.url), { small: true }))
      : h('div.muted.small', 'The mock server answers requests with the examples saved on this collection\'s requests (send a request, then "… → Save as example" in the response).');

    const log = HD.mockLogs[col.id] || [];
    panel.append(
      h('div.panel-pad.mock-panel',
        controls, status,
        cfg.lan && !state ? h('div.export-warning', 'Other devices on your network will be able to read these examples.') : null,
        h('div.section-title', `Routes (${withExamples} of ${routes.length} have examples)`),
        h('div.muted.small', 'Path segments like :id and {{variables}} match any value. Choose a specific example with the request header x-mock-response-name or x-mock-response-code.'),
        h('div.table-wrap.no-pad', h('table.data-table',
          h('thead', h('tr', h('th', 'Method'), h('th', 'Path'), h('th', 'Request'), h('th', 'Examples'))),
          h('tbody', routes.map((r) => h('tr',
            h('td', h(`span.method-tag.${HD.methodClass(r.method)}`, r.method)),
            h('td.mono', r.path),
            h('td', h('a', { href: '#', onclick: (e) => { e.preventDefault(); HD.openRequest(r.id); } }, r.name), r.folder ? h('span.muted.small', ` ${r.folder}`) : null),
            h('td', r.examples ? String(r.examples) : h('span.text-warn', 'none'))))))),
        h('div.section-title', 'Recent requests'),
        log.length ? h('div.mock-log', log.slice(0, 30).map((e) => h('div.console-line',
          h('span.console-time', new Date(e.time).toLocaleTimeString()),
          h(`span.${HD.statusClass(e.status)}`, String(e.status)),
          h('span.console-msg.mono', `${e.method} ${e.path}`),
          h('span.console-src', e.example ? `example "${e.example}"` : e.route || 'no match')))) : h('div.muted.small', state ? 'Waiting for requests…' : 'Start the server to see requests here.')));
    const onLog = (id) => { if (id === col.id && document.body.contains(panel)) rerender(); };
    if (panel.__onLog) HD.off('mock-log', panel.__onLog);
    panel.__onLog = onLog;
    HD.on('mock-log', onLog);
  };

  // Creates (or updates) "<collection> (mock)": a copy of the active environment whose base URL variables point at the mock.
  const mockEnvironment = (col, url) => {
    const vars = leadingVars(col);
    const name = `${col.name} (mock)`;
    let env = S.ws.environments.find((e) => e.name === name);
    if (!env) {
      env = HD.newEnvironment(name);
      const active = HD.activeEnvironment();
      env.values = active ? HD.clone(active.values) : [];
      S.ws.environments.push(env);
    }
    for (const v of vars) {
      const row = env.values.find((x) => x.key === v);
      if (row) { row.value = url; row.enabled = true; } else env.values.push({ key: v, value: url, enabled: true });
    }
    S.ws.activeEnvironmentId = env.id;
    HD.save();
    HD.renderEnvSelect();
    HD.renderSidebar();
    HD.emit('variables');
    HD.toast(vars.length ? `Environment "${name}" is now active: ${vars.map((v) => `{{${v}}}`).join(', ')} point to the mock.` : `Environment "${name}" created. Your request URLs don't start with a {{variable}}, so point them at ${url} yourself.`, 'success', 7000);
  };

  // ==== Secret scanner =====================================================================

  HD.openSecretScan = () => openTab('secrets');

  const scanScope = () => HD.clone({ collections: S.ws.collections, environments: S.ws.environments, globals: S.ws.globals });

  HD.views.secrets = (tab, root) => {
    HD.variableInfo = () => ({});
    const body = h('div.panel-pad.secrets-view');
    root.appendChild(h('div.container-view',
      h('div.req-header', h('div.breadcrumb', h('span.kind-label', 'Security'), h('span.title-static', 'Secret scan')),
        h('div.req-header-actions', HD.button('Scan again', () => run(), { small: true, icon: 'search' }))),
      body));
    const run = async () => {
      HD.clear(body).appendChild(h('div.runner-progress', h('div.spinner.small'), 'Scanning collections, environments and globals…'));
      const findings = await window.api.scanSecrets(scanScope());
      render(findings);
    };
    const render = (findings) => {
      HD.clear(body);
      const count = (s) => findings.filter((f) => f.severity === s).length;
      body.append(
        h('div.runner-summary',
          h('div.stat.fail', h('div.stat-value', String(count('high'))), h('div.stat-label', 'High')),
          h('div.stat', h('div.stat-value', String(count('medium'))), h('div.stat-label', 'Medium')),
          h('div.stat', h('div.stat-value', String(count('low'))), h('div.stat-label', 'Low'))),
        h('div.muted.small', 'Looks for API keys, tokens, passwords and private keys typed directly into requests, auth settings, scripts and variables. Values that only reference a variable, like {{token}}, are fine. Fixes move the value into a secret variable or mark a variable as secret, so it is masked on screen and left out when you export with "Leave out secrets".'));
      if (!findings.length) {
        body.appendChild(h('div.empty-state', h('div.res-empty-title', 'No plain-text secrets found'), h('div.muted', 'Nothing to fix.')));
        return;
      }
      body.appendChild(h('div.secret-list', findings.map((f) => h('div.secret-item',
        h(`span.severity.${f.severity}`, f.severity.toUpperCase()),
        h('div.secret-main',
          h('div', h('b', f.type)),
          h('div.muted.small', `${f.where} › ${f.field}`),
          h('div.mono.small', f.preview)),
        h('div.secret-actions',
          f.fix ? HD.button(f.fix.kind === 'mark-secret' ? 'Mark as secret' : 'Move to secret variable', async () => {
            if (await HD.applySecretFix(f)) run();
          }, { small: true, primary: true }) : h('span.muted.small', 'Edit by hand'),
          f.fix && f.fix.nodeId ? HD.button('Open', () => openNode(f.fix.nodeId), { small: true, ghost: true }) : null)))));
    };
    run();
  };

  const openNode = (id) => {
    const found = HD.find(id);
    if (!found) return;
    if (found.node.type === 'request') HD.openRequest(id); else HD.openContainer(id, 'auth');
  };

  // Keeps open, unedited tabs of a changed request in sync with the saved version.
  const syncTabs = (nodeId) => {
    const found = HD.find(nodeId);
    for (const t of S.ws.tabs) {
      if (t.kind !== 'request' || t.refId !== nodeId) continue;
      if (t.dirty) HD.toast(`"${t.draft.name}" has unsaved edits; the fix applies to the saved version only.`, 'warn', 6000);
      else t.draft.request = HD.clone(found.node.request);
    }
  };

  HD.applySecretFix = async (f) => {
    const fix = f.fix;
    if (fix.kind === 'mark-secret') {
      const list = fix.scope === 'environment' ? (S.ws.environments.find((e) => e.id === fix.ownerId) || {}).values
        : fix.scope === 'globals' ? S.ws.globals : (S.ws.collections.find((c) => c.id === fix.ownerId) || {}).variables;
      const row = (list || []).find((v) => v.key === fix.key);
      if (!row) return false;
      row.secret = true;
    } else {
      const found = HD.find(fix.nodeId);
      if (!found) return false;
      const env = HD.activeEnvironment();
      const where = env ? `the "${env.name}" environment` : `the "${found.collection.name}" collection variables`;
      const name = await HD.prompt('Move to a secret variable', `Variable name (stored as a secret in ${where})`, fix.suggestedName);
      if (!name) return false;
      const node = found.node;
      let value;
      if (fix.target === 'header') {
        const hd = node.request.headers[fix.index];
        const m = /^(Bearer|Token|Basic|Digest|ApiKey|Key)\s+(.+)$/i.exec(hd.value);
        value = m ? m[2] : hd.value;
        hd.value = m ? `${m[1]} {{${name}}}` : `{{${name}}}`;
      } else if (fix.target === 'auth') {
        const auth = node.type === 'request' ? node.request.auth : node.auth;
        value = auth[fix.authType][fix.field];
        auth[fix.authType][fix.field] = `{{${name}}}`;
      } else if (fix.target === 'url-credentials') {
        const m = /\/\/([^/\s:@{}]+):([^/\s@{}]+)@/.exec(node.request.url);
        if (!m) return false;
        try { value = decodeURIComponent(m[2]); } catch { value = m[2]; }
        node.request.url = node.request.url.replace(`${m[1]}:${m[2]}@`, `${m[1]}:{{${name}}}@`);
      }
      const list = env ? env.values : (found.collection.variables = found.collection.variables || []);
      const row = list.find((v) => v.key === name);
      if (row) Object.assign(row, { value, secret: true, enabled: true }); else list.push({ key: name, value, enabled: true, secret: true });
      if (node.type === 'request') syncTabs(node.id);
    }
    HD.save();
    HD.emit('variables');
    HD.renderSidebar();
    HD.toast('Fixed', 'success', 1500);
    return true;
  };

  // ==== Audit log ==========================================================================

  HD.openAuditLog = () => openTab('audit');

  HD.views.audit = (tab, root) => {
    HD.variableInfo = () => ({});
    tab.ui = tab.ui || { text: '', event: '' };
    const list = h('div.audit-list');
    const text = h('input.input.side-search', { value: tab.ui.text, placeholder: 'Filter (user, URL, collection…)', oninput: HD.debounce((e) => { tab.ui.text = e.target.value; load(); }, 250) });
    root.appendChild(h('div.container-view',
      h('div.req-header', h('div.breadcrumb', h('span.kind-label', 'Security'), h('span.title-static', 'Audit log')),
        h('div.req-header-actions',
          HD.button('Refresh', () => load(), { small: true, ghost: true }),
          HD.button('Export', () => window.api.audit.export().then((p) => p && HD.toast(`Saved to ${p}`, 'success')), { small: true, icon: 'upload' }),
          HD.button('Clear', async () => {
            if (!(await HD.confirm('Clear audit log', 'Delete all audit entries? The clearing itself is recorded.', { danger: true, okLabel: 'Clear' }))) return;
            await window.api.audit.clear();
            load();
          }, { small: true, danger: true }))),
      h('div.panel-pad.audit-filters', text,
        HD.select([['', 'All events'], ['request', 'Requests'], ['lock', 'Sign-in & lock'], ['export', 'Exports'], ['import', 'Imports'], ['runner', 'Collection runs'], ['monitor', 'Monitors'], ['mock', 'Mock servers'], ['app', 'App starts']], tab.ui.event, (v) => { tab.ui.event = v; load(); }),
        h('span.muted.small', 'Stored locally in audit.log. Request entries record method, host, path and status only.')),
      list));
    const load = async () => {
      const entries = await window.api.audit.read({ text: tab.ui.text, event: tab.ui.event, limit: 1000 });
      HD.clear(list);
      if (!entries.length) { list.appendChild(h('div.empty-state.small', 'No matching entries.')); return; }
      list.appendChild(h('div.table-wrap', h('table.data-table',
        h('thead', h('tr', h('th', 'Time'), h('th', 'User'), h('th', 'Event'), h('th', 'Details'))),
        h('tbody', entries.map((e) => {
          const { time, user, event, ok, ...rest } = e;
          const details = Object.entries(rest).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ');
          return h('tr', { class: ok === false || rest.error ? 'audit-fail' : '' },
            h('td.nowrap', new Date(time).toLocaleString()), h('td', user || ''), h('td.mono', event), h('td.break', details));
        })))));
    };
    load();
  };
})();
