'use strict';

/* Collection, folder, environment, globals and runner views. */
(() => {
  const { h } = HD;
  const S = HD.S;
  HD.views = HD.views || {};

  const touch = () => { HD.save(); };

  // ---- Collection & folder ------------------------------------------------------------------

  const containerView = (tab, root, kind) => {
    const found = HD.find(tab.refId);
    if (!found) {
      root.appendChild(h('div.empty-state', `This ${kind} no longer exists.`));
      return;
    }
    const node = found.node;
    tab.ui = tab.ui || {};
    const ui = tab.ui;
    HD.variableInfo = () => HD.variableInfoFor(found.collection);

    const tabs = [
      { id: 'overview', label: 'Overview' },
      { id: 'auth', label: 'Authorization' },
      { id: 'pre', label: 'Pre-request Script', dot: !!(node.preRequestScript || '').trim() },
      { id: 'tests', label: 'Tests', dot: !!(node.testScript || '').trim() },
    ];
    if (kind === 'collection') tabs.push({ id: 'variables', label: 'Variables', badge: (node.variables || []).filter((v) => v.key).length || null });

    const panel = h('div.req-panel');
    const strip = h('div');
    const renderStrip = () => HD.clear(strip).appendChild(HD.tabStrip(tabs, ui.sub || 'overview', (id) => { ui.sub = id; renderStrip(); renderPanel(); }));
    const renderPanel = () => {
      HD.clear(panel);
      const t = ui.sub || 'overview';
      if (t === 'overview') {
        panel.appendChild(h('div.panel-pad.overview',
          h('div.overview-stats',
            h('div.stat', h('div.stat-value', String(HD.countRequests(node))), h('div.stat-label', 'Requests')),
            h('div.stat', h('div.stat-value', String((node.items || []).filter((i) => i.type === 'folder').length)), h('div.stat-label', 'Folders')),
            h('div.stat', h('div.stat-value', HD.AUTH_TYPES.find(([x]) => x === (node.auth || {}).type)?.[1] || 'None'), h('div.stat-label', 'Authorization'))),
          h('label.field', h('span', 'Description'),
            h('textarea.input.docs-input', { value: node.description || '', placeholder: `Add a description for this ${kind}…`, oninput: (e) => { node.description = e.target.value; touch(); } })),
          h('div.button-row',
            HD.button(`Run ${kind}`, () => HD.openRunner(found.collection.id, kind === 'folder' ? node.id : null), { primary: true, icon: 'play' }),
            kind === 'collection' ? HD.button('Export', () => window.api.exportCollection(node), { icon: 'upload' }) : null,
            HD.button('Add request', () => { const r = HD.newRequestItem(); node.items.push(r); touch(); HD.renderSidebar(); HD.openRequest(r.id); }, { icon: 'plus' }),
            HD.button('Add folder', () => { node.items.push(HD.newFolder()); touch(); HD.renderSidebar(); renderPanel(); }, { icon: 'folder' }))));
      } else if (t === 'auth') {
        panel.appendChild(HD.authEditor(node.auth = node.auth || { type: kind === 'collection' ? 'none' : 'inherit' }, {
          onChange: () => { touch(); },
          allowInherit: kind === 'folder',
          inheritFrom: () => {
            const chain = [found.collection, ...found.parents];
            for (let i = chain.length - 1; i >= 0; i--) if (chain[i].auth && chain[i].auth.type !== 'inherit') return { auth: chain[i].auth, from: chain[i].name };
            return { auth: { type: 'none' }, from: null };
          },
          scopes: () => HD.scopesFor(found.collection),
        }));
        panel.appendChild(h('div.muted.small.panel-pad', `Requests set to "Inherit auth from parent" will use this ${kind}'s authorization.`));
        panel.appendChild(HD.dependencyEditor(node, { kind, collection: found.collection, parents: found.parents, selfId: null, onChange: touch }));
      } else if (t === 'pre') {
        panel.appendChild(HD.scriptEditor(node, 'preRequestScript', [
          ['Set an environment variable', "pm.environment.set('variable_key', 'variable_value');"],
          ['Add a header to every request', "pm.request.headers.upsert({ key: 'X-Request-Id', value: pm.variables.replaceIn('{{$guid}}') });"],
          ['Log request', "console.log(pm.info.requestName, pm.request.method, pm.request.url.toString());"],
        ], () => { touch(); renderStrip(); }, `This script runs before every request in this ${kind}.`));
      } else if (t === 'tests') {
        panel.appendChild(HD.scriptEditor(node, 'testScript', [
          ['Status code is 2xx', "pm.test('Status code is 2xx', () => {\n  pm.response.to.be.success;\n});"],
          ['Response time below 1s', "pm.test('Response time below 1s', () => {\n  pm.expect(pm.response.responseTime).to.be.below(1000);\n});"],
        ], () => { touch(); renderStrip(); }, `This script runs after every request in this ${kind}.`));
      } else if (t === 'variables') {
        node.variables = node.variables || [];
        panel.appendChild(h('div.panel-pad', h('div.muted.small', 'Collection variables are available to every request in this collection. Environment variables override them.')));
        panel.appendChild(HD.kvTable({ rows: node.variables, secret: true, onChange: () => { touch(); HD.refreshVarHighlights(); } }));
      }
    };

    const title = h('input.title-input', { value: node.name, spellcheck: 'false', oninput: (e) => { node.name = e.target.value; tab.title = node.name; touch(); HD.renderSidebar(); HD.renderTabBar(); } });
    root.appendChild(h('div.container-view',
      h('div.req-header', h('div.breadcrumb', h('span.kind-label', kind === 'collection' ? 'Collection' : 'Folder'), found.parents.length || kind === 'folder' ? h('span.crumb', found.collection.name) : null, ...found.parents.map((p) => h('span.crumb', p.name)), title)),
      strip, panel));
    renderStrip();
    renderPanel();
  };

  HD.views.collection = (tab, root) => containerView(tab, root, 'collection');
  HD.views.folder = (tab, root) => containerView(tab, root, 'folder');

  // ---- Environments & globals -----------------------------------------------------------------

  HD.views.environment = (tab, root) => {
    const env = S.ws.environments.find((e) => e.id === tab.refId);
    if (!env) {
      root.appendChild(h('div.empty-state', 'This environment no longer exists.'));
      return;
    }
    HD.variableInfo = () => HD.variableInfoFor(null);
    const active = S.ws.activeEnvironmentId === env.id;
    root.appendChild(h('div.container-view',
      h('div.req-header',
        h('div.breadcrumb', h('span.kind-label', 'Environment'), h('input.title-input', { value: env.name, spellcheck: 'false', oninput: (e) => { env.name = e.target.value; tab.title = env.name; touch(); HD.renderSidebar(); HD.renderTabBar(); HD.renderEnvSelect(); } })),
        h('div.req-header-actions',
          active ? h('span.pill', 'Active') : HD.button('Set active', () => { S.ws.activeEnvironmentId = env.id; touch(); HD.renderEnvSelect(); HD.renderSidebar(); HD.renderActiveTab(); }, { small: true }),
          HD.button('Export', () => window.api.exportEnvironment(env), { small: true, icon: 'upload' }))),
      HD.discoveryBannerFor(env),
      h('div.panel-pad', h('div.muted.small', 'Reference variables with {{name}} in URLs, headers, bodies and auth fields. Mark sensitive values as "secret" to mask them.')),
      HD.kvTable({ rows: env.values, secret: true, onChange: () => { touch(); HD.refreshVarHighlights(); } })));
  };

  HD.views.globals = (tab, root) => {
    HD.variableInfo = () => HD.variableInfoFor(null);
    root.appendChild(h('div.container-view',
      h('div.req-header', h('div.breadcrumb', h('span.kind-label', 'Globals'), h('span.title-static', 'Global variables')),
        h('div.req-header-actions', HD.button('Export', () => window.api.exportGlobals(S.ws.globals), { small: true, icon: 'upload' }))),
      h('div.panel-pad', h('div.muted.small', 'Globals are available everywhere and have the lowest precedence: collection, environment and data variables override them.')),
      HD.kvTable({ rows: S.ws.globals, secret: true, onChange: () => { touch(); HD.refreshVarHighlights(); } })));
  };

  // ---- Runner -------------------------------------------------------------------------------

  const runs = new Map(); // tabId -> { results, summary, running, events }
  let runningTab = null;
  window.api.onRunnerEvent((evt) => {
    const run = runningTab && runs.get(runningTab);
    if (!run) return;
    if (evt.type === 'request-done') run.results.push(evt);
    if (evt.type === 'iteration') run.iteration = evt.iteration;
    if (evt.type === 'request-start') run.current = evt.name;
    if (evt.type === 'console') HD.log(evt.level, evt.message, { request: evt.name, runner: true });
    if (evt.type === 'done') run.summary = evt.summary;
    const tab = HD.currentTab();
    if (tab && tab.id === runningTab && run.rerender) run.rerender();
  });

  HD.views.runner = (tab, root) => {
    const cfg = (tab.runner = tab.runner || { iterations: 1, delay: 0, persist: true, stopOnFailure: false, useCookies: true, environmentId: S.ws.activeEnvironmentId, excluded: {} });
    cfg.excluded = cfg.excluded || {};
    if (!cfg.collectionId && S.ws.collections[0]) cfg.collectionId = S.ws.collections[0].id;
    const run = runs.get(tab.id) || { results: [] };
    runs.set(tab.id, run);
    HD.variableInfo = () => ({});

    const col = S.ws.collections.find((c) => c.id === cfg.collectionId);
    const left = h('div.runner-config');
    const right = h('div.runner-results');
    root.appendChild(h('div.runner-view', left, right));

    // Config.
    const folders = [];
    if (col) HD.walk(col.items, (it, parents) => { if (it.type === 'folder') folders.push([it.id, [...parents.map((p) => p.name), it.name].join(' / ')]); });
    const reqList = [];
    if (col) {
      const scope = cfg.folderId ? HD.find(cfg.folderId) : null;
      HD.walk(scope && scope.node.items ? scope.node.items : col.items, (it, parents) => { if (it.type === 'request') reqList.push({ it, path: parents.map((p) => p.name).join(' / ') }); });
    }
    const rerender = () => { HD.clear(root); HD.views.runner(tab, root); };
    left.append(
      h('div.section-title', 'Run configuration'),
      h('label.field', h('span', 'Collection'), HD.select([['', '— Select —'], ...S.ws.collections.map((c) => [c.id, c.name])], cfg.collectionId || '', (v) => { cfg.collectionId = v; cfg.folderId = null; cfg.excluded = {}; HD.save(); rerender(); })),
      col ? h('label.field', h('span', 'Folder'), HD.select([['', 'Entire collection'], ...folders], cfg.folderId || '', (v) => { cfg.folderId = v || null; HD.save(); rerender(); })) : null,
      h('label.field', h('span', 'Environment'), HD.select([['', 'No environment'], ...S.ws.environments.map((e) => [e.id, e.name])], cfg.environmentId || '', (v) => { cfg.environmentId = v || null; HD.save(); })),
      h('div.field-row',
        h('label.field', h('span', 'Iterations'), h('input.input', { type: 'number', min: 1, value: cfg.iterations, oninput: (e) => { cfg.iterations = Math.max(1, Number(e.target.value) || 1); HD.save(); } })),
        h('label.field', h('span', 'Delay (ms)'), h('input.input', { type: 'number', min: 0, value: cfg.delay, oninput: (e) => { cfg.delay = Math.max(0, Number(e.target.value) || 0); HD.save(); } }))),
      h('label.field', h('span', 'Data file (CSV or JSON)'),
        h('div.button-row',
          HD.button(cfg.dataFile ? `${cfg.dataFile} (${(cfg.data || []).length} rows)` : 'Select file', async () => {
            const [f] = await window.api.openFile({ filters: [{ name: 'Data', extensions: ['csv', 'json'] }] });
            if (!f) return;
            try {
              const d = await window.api.readDataFile(f);
              cfg.dataFile = d.file;
              cfg.data = d.rows;
              cfg.iterations = d.rows.length || 1;
              HD.save();
              rerender();
            } catch (e) { HD.toast(`Could not read data file: ${e.message}`, 'error'); }
          }, { small: true, icon: 'file' }),
          cfg.dataFile ? HD.button('', () => { cfg.dataFile = null; cfg.data = null; HD.save(); rerender(); }, { icon: 'x', ghost: true, small: true, title: 'Remove data file' }) : null,
          cfg.data && cfg.data.length ? HD.button('Preview', () => previewData(cfg.data), { ghost: true, small: true }) : null)),
      h('label.check', h('input', { type: 'checkbox', checked: cfg.persist, onchange: (e) => { cfg.persist = e.target.checked; HD.save(); } }), 'Persist variable changes after the run'),
      h('label.check', h('input', { type: 'checkbox', checked: cfg.useCookies, onchange: (e) => { cfg.useCookies = e.target.checked; HD.save(); } }), 'Use the cookie jar'),
      h('label.check', h('input', { type: 'checkbox', checked: cfg.stopOnFailure, onchange: (e) => { cfg.stopOnFailure = e.target.checked; HD.save(); } }), 'Stop run on first failure'),
      h('div.section-title', `Requests (${reqList.filter((r) => !cfg.excluded[r.it.id]).length}/${reqList.length})`,
        h('span.spacer'),
        HD.button('All', () => { cfg.excluded = {}; HD.save(); rerender(); }, { ghost: true, small: true }),
        HD.button('None', () => { reqList.forEach((r) => { cfg.excluded[r.it.id] = true; }); HD.save(); rerender(); }, { ghost: true, small: true })),
      h('div.runner-reqs', reqList.map(({ it, path }) => h('label.check.runner-req',
        h('input', { type: 'checkbox', checked: !cfg.excluded[it.id], onchange: (e) => { if (e.target.checked) delete cfg.excluded[it.id]; else cfg.excluded[it.id] = true; HD.save(); } }),
        h(`span.method-tag.${HD.methodClass(it.request.method)}`, it.request.method),
        h('span.runner-req-name', it.name), path ? h('span.muted.small', path) : null))),
      h('div.runner-start', run.running
        ? HD.button('Stop', () => window.api.stopRun(), { danger: true, icon: 'stop' })
        : HD.button(`Run ${col ? col.name : ''}`, () => start(), { primary: true, icon: 'play', disabled: !col })));

    // Results.
    run.rerender = () => renderResults();
    const renderResults = () => {
      HD.clear(right);
      const results = run.results;
      const tests = results.flatMap((r) => r.tests);
      const passed = tests.filter((t) => t.passed && !t.skipped).length;
      const failed = tests.filter((t) => !t.passed).length;
      const errors = results.filter((r) => r.error).length;
      const avg = results.length ? Math.round(results.reduce((n, r) => n + r.time, 0) / results.length) : 0;
      right.appendChild(h('div.runner-summary',
        h('div.stat', h('div.stat-value', String(results.length)), h('div.stat-label', 'Requests')),
        h('div.stat.pass', h('div.stat-value', String(passed)), h('div.stat-label', 'Passed')),
        h('div.stat.fail', h('div.stat-value', String(failed)), h('div.stat-label', 'Failed')),
        h('div.stat', h('div.stat-value', String(errors)), h('div.stat-label', 'Errors')),
        h('div.stat', h('div.stat-value', HD.formatMs(avg)), h('div.stat-label', 'Avg. response')),
        h('span.spacer'),
        results.length && !run.running ? HD.button('Export results', () => window.api.exportJson({ name: 'run-results.json', data: { collection: col && col.name, summary: run.summary, results } }), { small: true, icon: 'upload' }) : null));
      if (run.running) right.appendChild(h('div.runner-progress', h('div.spinner.small'), `Iteration ${(run.iteration || 0) + 1} — ${run.current || ''}`));
      if (run.summary && !run.running) {
        right.appendChild(h('div.runner-done', `Run ${run.summary.stopped ? 'stopped' : 'completed'} in ${HD.formatMs(run.summary.duration)} — ${run.summary.iterations} iteration(s).`));
      }
      if (run.error) right.appendChild(h('div.test-script-error', run.error));
      const filter = tab.ui && tab.ui.filter ? tab.ui.filter : 'all';
      right.appendChild(h('div.body-toolbar', HD.tabStrip([{ id: 'all', label: 'All' }, { id: 'passed', label: 'Passed' }, { id: 'failed', label: 'Failed' }], filter, (id) => { tab.ui = tab.ui || {}; tab.ui.filter = id; renderResults(); }, 'segmented')));
      const list = h('div.runner-list');
      let lastIt = -1;
      for (const r of results) {
        const ok = !r.error && r.tests.every((t) => t.passed);
        if (filter === 'passed' && !ok) continue;
        if (filter === 'failed' && ok) continue;
        if (r.iteration !== lastIt) { list.appendChild(h('div.runner-iter', `Iteration ${r.iteration + 1}`)); lastIt = r.iteration; }
        const row = h('div.runner-row', { class: ok ? '' : 'has-fail' },
          h('div.runner-row-head', { onclick: () => row.classList.toggle('open') },
            h(`span.method-tag.${HD.methodClass(r.method)}`, r.method),
            h('span.runner-req-name', r.name),
            h('span.muted.small.ellipsis', r.url),
            h('span.spacer'),
            r.error ? h('span.text-error.small', r.error) : h(`span.${HD.statusClass(r.status)}`, `${r.status} ${r.statusText}`),
            h('span.muted.small', HD.formatMs(r.time)),
            h('span.muted.small', HD.formatBytes(r.size))),
          r.dependencyRuns && r.dependencyRuns.length ? h('div.runner-deps', HD.dependencyBanner(r.dependencyRuns)) : null,
          r.tests.length ? h('div.runner-tests', r.tests.map((t) => h('div.test-item.compact',
            h(`span.test-badge.${t.skipped ? 'skip' : t.passed ? 'pass' : 'fail'}`, t.skipped ? 'SKIP' : t.passed ? 'PASS' : 'FAIL'),
            h('span.test-name', t.name), t.error ? h('span.test-error', t.error) : null))) : null,
          h('div.runner-detail',
            r.sentRequest ? h('pre.timeline-body', [`${r.sentRequest.method} ${r.sentRequest.url}`, ...r.sentRequest.headers.map(([k, v]) => `${k}: ${v}`), r.sentRequest.bodyText ? `\n${r.sentRequest.bodyText}` : ''].join('\n')) : null,
            r.response ? h('pre.timeline-body', [...r.response.headers.map(([k, v]) => `${k}: ${v}`), '', (r.response.bodyText || '').slice(0, 20000)].join('\n')) : null));
        list.appendChild(row);
      }
      if (!results.length && !run.running) list.appendChild(h('div.empty-state.small', 'Configure the run on the left and press Run. Results appear here as each request completes.'));
      right.appendChild(list);
    };
    renderResults();

    const start = async () => {
      const c = S.ws.collections.find((x) => x.id === cfg.collectionId);
      if (!c) return;
      const env = S.ws.environments.find((e) => e.id === cfg.environmentId);
      const before = { globals: HD.listToObject(S.ws.globals), environment: env ? HD.listToObject(env.values) : {}, collection: HD.listToObject(c.variables) };
      run.results = [];
      run.summary = null;
      run.error = null;
      run.running = true;
      runningTab = tab.id;
      rerender();
      try {
        const summary = await window.api.runCollection({
          collection: HD.clone(c),
          excluded: Object.keys(cfg.excluded),
          folderId: cfg.folderId,
          scopes: HD.clone(before),
          iterations: cfg.iterations,
          data: cfg.data || null,
          delay: cfg.delay,
          stopOnFailure: cfg.stopOnFailure,
          useCookies: cfg.useCookies,
          settings: S.ws.settings,
        });
        // The returned summary is authoritative; the last progress event can arrive after the reply.
        run.results = summary.results;
        run.summary = { ...summary, results: undefined };
        if (cfg.persist) {
          let changed = HD.applyScope(S.ws.globals, before.globals, summary.scopes.globals);
          if (env) changed = HD.applyScope(env.values, before.environment, summary.scopes.environment) || changed;
          changed = HD.applyScope(c.variables, before.collection, summary.scopes.collection) || changed;
          if (changed) { HD.save(); HD.refreshVarHighlights(); }
        }
        HD.toast(`Run finished: ${summary.passed} passed, ${summary.failed} failed`, summary.failed ? 'warn' : 'success');
      } catch (e) {
        run.error = e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
      }
      run.running = false;
      runningTab = null;
      if (HD.currentTab() === tab) rerender();
    };
  };

  function previewData(rows) {
    const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
    HD.modal({
      title: `Data preview (${rows.length} rows)`, width: 760,
      body: h('div.table-wrap.scroll', h('table.data-table', h('thead', h('tr', h('th', '#'), cols.map((c) => h('th', c)))),
        h('tbody', rows.slice(0, 500).map((r, i) => h('tr', h('td.muted', String(i + 1)), cols.map((c) => h('td.mono', typeof r[c] === 'object' ? JSON.stringify(r[c]) : String(r[c] == null ? '' : r[c])))))))),
    });
  }
})();
