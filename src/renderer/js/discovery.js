'use strict';

/* Service discovery: registry sources that create/refresh an environment with one variable per service. */
(() => {
  const { h } = HD;
  const S = HD.S;

  const PROVIDERS = {
    consul: { label: 'Consul', url: 'http://consul.service.consul:8500', tokenLabel: 'ACL token (X-Consul-Token)', help: 'Reads /v1/catalog/services and each service\'s healthy instances.' },
    eureka: { label: 'Eureka (Spring Cloud)', url: 'http://eureka:8761', tokenLabel: 'Authorization (optional, e.g. "Basic …")', help: 'Reads /eureka/apps and uses each app\'s home page URL or host:port.' },
    kubernetes: { label: 'Kubernetes', url: 'https://kubernetes.example.com:6443', tokenLabel: 'Bearer token (service account)', help: 'Lists Services in a namespace through the API server.' },
    json: { label: 'Custom JSON endpoint', url: 'https://registry.example.com/services', tokenLabel: 'Authorization (optional)', help: 'Any endpoint returning a list of services or a { name: url } map.' },
  };
  HD.DISCOVERY_PROVIDERS = PROVIDERS;

  const sources = () => (S.ws.discoverySources = S.ws.discoverySources || []);
  HD.discoverySources = sources;

  HD.newDiscoverySource = (provider = 'consul') => ({
    id: HD.uid(), name: `${PROVIDERS[provider].label.split(' ')[0]} services`, provider, url: '', token: '', headers: [],
    variablePattern: '{name}_url', verifySSL: provider !== 'kubernetes', keepMissing: false, syncOnStartup: false, environmentId: null,
    datacenter: '', tag: '', scheme: 'http', onlyHealthy: true, onlyUp: true,
    namespace: 'default', addressMode: 'cluster-dns', labelSelector: '',
    listPath: '', nameField: 'name', urlField: 'url', lastSync: null,
  });

  HD.openDiscovery = (id) => {
    const existing = S.ws.tabs.find((t) => t.kind === 'discovery' && t.refId === id);
    if (existing) return HD.activateTab(existing.id);
    const cur = HD.currentTab();
    const tab = { id: HD.uid(), kind: 'discovery', refId: id };
    S.ws.tabs.splice(cur ? S.ws.tabs.indexOf(cur) + 1 : S.ws.tabs.length, 0, tab);
    return HD.activateTab(tab.id);
  };

  HD.addDiscoverySource = () => {
    const src = HD.newDiscoverySource('consul');
    sources().push(src);
    HD.save();
    HD.renderSidebar();
    HD.openDiscovery(src.id);
  };

  const varsForResolve = () => {
    const env = HD.activeEnvironment();
    return { ...HD.listToObject(S.ws.globals), ...(env ? HD.listToObject(env.values) : {}) };
  };

  // Calls the registry. With previewOnly, nothing is written.
  const call = (src, previewOnly) => {
    const env = S.ws.environments.find((e) => e.id === src.environmentId);
    return window.api.syncDiscovery({
      config: HD.clone(src), values: env ? HD.clone(env.values) : [], sourceId: src.id,
      settings: S.ws.settings, vars: varsForResolve(), previewOnly,
    });
  };

  /** Syncs a source into its environment, creating the environment the first time. */
  HD.syncDiscovery = async (src, { silent = false } = {}) => {
    try {
      const res = await call(src, false);
      let env = S.ws.environments.find((e) => e.id === src.environmentId);
      if (!env) {
        env = HD.newEnvironment(src.name);
        S.ws.environments.push(env);
        src.environmentId = env.id;
        if (!S.ws.activeEnvironmentId) S.ws.activeEnvironmentId = env.id;
      }
      env.values = res.values;
      env.discoverySourceId = src.id;
      src.lastSync = {
        time: Date.now(), count: res.services.length, diff: res.diff, warnings: res.warnings, error: null,
        services: res.services.map((s) => ({ name: s.name, variable: s.variable, url: s.url, instances: (s.instances || []).map((i) => ({ healthy: i.healthy })) })),
      };
      HD.save();
      HD.renderSidebar();
      HD.renderEnvSelect();
      HD.emit('variables');
      const d = res.diff;
      const summary = `${res.services.length} services: ${d.added.length} added, ${d.updated.length} updated, ${d.removed.length} removed`;
      HD.log('info', `Service discovery "${src.name}" → environment "${env.name}": ${summary}`);
      if (!silent || d.added.length || d.updated.length || d.removed.length) HD.toast(`${env.name}: ${summary}`, 'success');
      return res;
    } catch (e) {
      const msg = HD.cleanErr(e);
      src.lastSync = { ...(src.lastSync || {}), time: Date.now(), error: msg };
      HD.save();
      HD.log('error', `Service discovery "${src.name}" failed: ${msg}`);
      HD.toast(`Discovery "${src.name}" failed: ${msg}`, 'error', 6000);
      return null;
    }
  };

  HD.syncDiscoveryOnStartup = async () => {
    for (const src of sources().filter((s) => s.syncOnStartup && s.url)) await HD.syncDiscovery(src, { silent: true });
  };

  // ---- Sidebar section (inside the Environments panel) -----------------------------------------

  HD.renderDiscoverySidebar = (list) => {
    list.appendChild(h('div.history-day.side-section', h('span', 'Service discovery'), h('span.spacer'),
      h('button.tree-more.visible', { type: 'button', title: 'Add a discovery source', onclick: () => HD.addDiscoverySource() }, HD.icon('plus'))));
    if (!sources().length) {
      list.appendChild(h('div.tree-empty.discovery-empty', 'Create environments from Consul, Eureka, Kubernetes or a JSON registry. ',
        h('a', { href: '#', onclick: (e) => { e.preventDefault(); HD.addDiscoverySource(); } }, 'Add a source')));
      return;
    }
    const active = HD.currentTab();
    for (const src of sources()) {
      const ls = src.lastSync;
      list.appendChild(h('div.tree-row.env-row', {
        class: active && active.kind === 'discovery' && active.refId === src.id ? 'active' : '',
        onclick: () => HD.openDiscovery(src.id),
        oncontextmenu: (e) => HD.menu(e, sourceMenu(src)),
      },
      HD.icon('search'),
      h('span.tree-name', src.name),
      ls && ls.error ? h('span.small.text-error', 'error') : ls ? h('span.muted.small', String(ls.count)) : null,
      h('button.tree-more', { type: 'button', title: 'Sync now', onclick: (e) => { e.stopPropagation(); HD.syncDiscovery(src); } }, HD.icon('history'))));
    }
  };

  const sourceMenu = (src) => [
    { label: 'Sync now', onClick: () => HD.syncDiscovery(src) },
    { label: 'Edit', onClick: () => HD.openDiscovery(src.id) },
    { label: 'Duplicate', onClick: () => { const c = { ...HD.clone(src), id: HD.uid(), name: `${src.name} Copy`, environmentId: null, lastSync: null }; sources().push(c); HD.save(); HD.renderSidebar(); } },
    { separator: true },
    { label: 'Delete source', danger: true, onClick: async () => {
      if (!(await HD.confirm('Delete discovery source', `Delete "${src.name}"? Its environment is kept.`, { danger: true, okLabel: 'Delete' }))) return;
      sources().splice(sources().indexOf(src), 1);
      S.ws.tabs.filter((t) => t.kind === 'discovery' && t.refId === src.id).forEach((t) => HD.closeTab(t.id, true));
      HD.save();
      HD.renderSidebar();
    } },
  ];

  // Banner for an environment that is filled by discovery.
  HD.discoveryBannerFor = (env) => {
    const src = sources().find((s) => s.environmentId === env.id);
    if (!src) return null;
    const ls = src.lastSync;
    return h('div.discovery-banner',
      HD.icon('search'),
      h('span', 'Service URLs in this environment come from ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); HD.openDiscovery(src.id); } }, src.name),
        ls ? ` · last synced ${new Date(ls.time).toLocaleString()}` : '', '. Other variables you add here are kept on re-sync.'),
      h('span.spacer'),
      HD.button('Re-sync', () => HD.syncDiscovery(src).then(() => HD.renderActiveTab()), { small: true }));
  };

  // ---- Source editor tab ------------------------------------------------------------------

  HD.views = HD.views || {};
  HD.views.discovery = (tab, root) => {
    const src = sources().find((s) => s.id === tab.refId);
    if (!src) {
      root.appendChild(h('div.empty-state', 'This discovery source no longer exists.'));
      return;
    }
    HD.variableInfo = () => HD.variableInfoFor(null);
    tab.ui = tab.ui || {};
    const touch = () => HD.save();
    const rerender = () => { HD.clear(root); HD.views.discovery(tab, root); };
    const p = PROVIDERS[src.provider];

    const text = (key, label, placeholder, help, type = 'text') => h('label.field', h('span', label),
      h('input.input', { type, value: src[key] == null ? '' : src[key], placeholder, spellcheck: 'false', oninput: (e) => { src[key] = e.target.value; touch(); } }),
      help ? h('span.field-help', help) : null);
    const check = (key, label) => h('label.check', h('input', { type: 'checkbox', checked: src[key] !== false && !!src[key], onchange: (e) => { src[key] = e.target.checked; touch(); } }), label);
    const select = (key, label, options, help) => h('label.field', h('span', label), HD.select(options, src[key], (v) => { src[key] = v; touch(); }), help ? h('span.field-help', help) : null);

    let providerFields;
    if (src.provider === 'consul') {
      providerFields = [text('datacenter', 'Datacenter', 'dc1 (default: the agent\'s)'), text('tag', 'Only services with tag', 'e.g. http'),
        select('scheme', 'URL scheme', [['http', 'http'], ['https', 'https']]), check('onlyHealthy', 'Only instances passing health checks')];
    } else if (src.provider === 'eureka') {
      providerFields = [check('onlyUp', 'Only instances with status UP')];
    } else if (src.provider === 'kubernetes') {
      providerFields = [text('namespace', 'Namespace', 'default', 'Use * for all namespaces (variables become namespace_service_url).'),
        select('addressMode', 'Address to use', [['cluster-dns', 'Cluster DNS (name.namespace.svc.cluster.local)'], ['cluster-ip', 'Cluster IP'], ['external', 'External (LoadBalancer / external IP)']],
          'Cluster DNS and Cluster IP only work from inside the cluster or over a VPN.'),
        text('labelSelector', 'Label selector', 'e.g. app.kubernetes.io/part-of=shop')];
    } else {
      providerFields = [text('listPath', 'List path', 'e.g. data.services (empty: the whole response)', 'Where the list (or name → URL map) sits in the response.'),
        text('nameField', 'Name field', 'name'), text('urlField', 'URL field or template', 'url', 'A field (e.g. url, endpoints[0].href) or a template such as http://{host}:{port}.')];
    }

    const envOptions = [['', 'Create a new environment'], ...S.ws.environments.map((e) => [e.id, e.name])];
    const results = h('div.discovery-results');
    const config = h('div.discovery-config',
      h('div.dep-grid',
        h('label.field', h('span', 'Registry type'), HD.select(Object.entries(PROVIDERS).map(([id, x]) => [id, x.label]), src.provider, (v) => {
          src.provider = v;
          if (v === 'kubernetes') src.verifySSL = false;
          touch();
          rerender();
        })),
        text('url', 'Registry URL', p.url, 'Variables like {{consulUrl}} are allowed.'),
        text('token', p.tokenLabel, '', null, 'password'),
        ...providerFields),
      h('div.section-title', 'Environment'),
      h('div.dep-grid',
        h('label.field', h('span', 'Sync into'), HD.select(envOptions, src.environmentId || '', (v) => { src.environmentId = v || null; touch(); }),
          h('span.field-help.env-target-help', src.environmentId ? 'Discovered variables in this environment are updated in place.' : `A new environment named "${src.name}" is created on the first sync.`)),
        text('variablePattern', 'Variable name pattern', '{name}_url', '{name} is the service name in lower_snake_case; {NAME} in UPPER_CASE.')),
      check('keepMissing', 'Keep variables for services that disappear from the registry'),
      check('verifySSL', 'Verify the registry\'s SSL certificate'),
      check('syncOnStartup', 'Sync automatically when HttpDash starts'),
      h('details.discovery-headers', h('summary', `Extra request headers${(src.headers || []).filter((x) => x.key).length ? ` (${src.headers.filter((x) => x.key).length})` : ''}`),
        HD.kvTable({ rows: (src.headers = src.headers || []), onChange: touch, bulk: false })),
      h('div.button-row.discovery-actions',
        HD.button('Preview services', async () => {
          HD.clear(results).appendChild(h('div.runner-progress', h('div.spinner.small'), 'Querying registry…'));
          try {
            const res = await call(src, true);
            renderResults(res, null);
          } catch (e) {
            HD.clear(results).appendChild(h('div.test-script-error', HD.cleanErr(e)));
          }
        }, { icon: 'search' }),
        HD.button(src.environmentId ? 'Sync to environment' : 'Create environment', async () => {
          HD.clear(results).appendChild(h('div.runner-progress', h('div.spinner.small'), 'Syncing…'));
          const res = await HD.syncDiscovery(src);
          if (res) rerender(); else HD.clear(results).appendChild(h('div.test-script-error', src.lastSync.error));
        }, { primary: true, icon: 'download' }),
        src.environmentId ? HD.button('Open environment', () => HD.openEnvironment(src.environmentId), { ghost: true }) : null));

    const renderResults = (res, diff) => {
      HD.clear(results);
      const changed = diff ? new Map([...diff.added.map((k) => [k, 'added']), ...diff.updated.map((k) => [k, 'updated'])]) : new Map();
      results.appendChild(h('div.section-title', `${res.services.length} services found`));
      for (const w of res.warnings || []) results.appendChild(h('div.discovery-warning', w));
      if (diff && diff.removed.length) results.appendChild(h('div.discovery-warning', `Removed: ${diff.removed.join(', ')}`));
      if (!res.services.length) return;
      results.appendChild(h('div.table-wrap.no-pad', h('table.data-table',
        h('thead', h('tr', h('th', 'Service'), h('th', 'Variable'), h('th', 'URL'), h('th', 'Instances'), diff ? h('th', '') : null)),
        h('tbody', res.services.map((s) => h('tr',
          h('td', s.name),
          h('td.mono', `{{${s.variable}}}`),
          h('td.mono.break', s.url),
          h('td.muted', s.instances && s.instances.length ? `${s.instances.filter((i) => i.healthy).length}/${s.instances.length} healthy` : '—'),
          diff ? h('td', changed.get(s.variable) ? h(`span.pill.${changed.get(s.variable)}`, changed.get(s.variable)) : null) : null))))));
    };

    const ls = src.lastSync;
    root.appendChild(h('div.container-view',
      h('div.req-header',
        h('div.breadcrumb', h('span.kind-label', 'Service discovery'),
          h('input.title-input', { value: src.name, spellcheck: 'false', oninput: (e) => {
            src.name = e.target.value;
            touch();
            HD.renderSidebar();
            HD.renderTabBar();
            const help = root.querySelector('.env-target-help');
            if (help && !src.environmentId) help.textContent = `A new environment named "${src.name}" is created on the first sync.`;
          } })),
        ls ? h('span.muted.small', ls.error ? h('span.text-error', `Last sync failed: ${ls.error}`) : `Last synced ${new Date(ls.time).toLocaleString()} · ${ls.count} services`) : null),
      h('div.panel-pad', h('div.muted.small', p.help)),
      h('div.discovery-layout', config, results)));

    if (ls && !ls.error && ls.diff && tab.ui.showLast !== false) {
      const env = S.ws.environments.find((e) => e.id === src.environmentId);
      if (env && ls.services) {
        renderResults({ services: ls.services, warnings: ls.warnings }, ls.diff);
        results.querySelector('.section-title').textContent = `Last sync: ${ls.services.length} services in "${env.name}"`;
      }
    } else if (!ls) {
      results.appendChild(h('div.empty-state.small', h('div', 'Enter the registry URL, then preview the services or create the environment.'),
        h('div.muted', 'Each service becomes a variable such as {{orders_url}}. Use it in requests: {{orders_url}}/api/orders')));
    }
  };
})();
