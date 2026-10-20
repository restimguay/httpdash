'use strict';

/* App shell: top bar, tabs, console, theme, keyboard shortcuts and bootstrapping. */
(() => {
  const { h } = HD;
  const S = HD.S;

  // ---- Tabs ---------------------------------------------------------------------------------

  HD.currentTab = () => S.ws.tabs.find((t) => t.id === S.ws.activeTabId) || null;

  const activate = (id) => {
    S.ws.activeTabId = id;
    HD.save();
    HD.renderTabBar();
    HD.renderActiveTab();
    HD.renderSidebar();
  };
  HD.activateTab = activate;

  const addTab = (tab) => {
    const cur = HD.currentTab();
    const idx = cur ? S.ws.tabs.indexOf(cur) + 1 : S.ws.tabs.length;
    S.ws.tabs.splice(idx, 0, tab);
    activate(tab.id);
    return tab;
  };

  HD.openRequest = (itemId) => {
    const existing = S.ws.tabs.find((t) => t.kind === 'request' && t.refId === itemId);
    if (existing) return activate(existing.id);
    const found = HD.find(itemId);
    if (!found) return null;
    return addTab({ id: HD.uid(), kind: 'request', refId: itemId, draft: { name: found.node.name, request: HD.clone(found.node.request) }, dirty: false, ui: {} });
  };

  HD.openNewRequest = (request, name) => addTab({
    id: HD.uid(), kind: 'request', refId: null,
    draft: { name: name || 'Untitled Request', request: HD.newRequestDef({ auth: { type: 'none' }, ...(request || {}) }) },
    dirty: !!request, ui: {},
  });

  HD.openContainer = (id, sub) => {
    const found = HD.find(id);
    if (!found) return;
    const existing = S.ws.tabs.find((t) => (t.kind === 'collection' || t.kind === 'folder') && t.refId === id);
    if (existing) {
      if (sub) existing.ui = { ...(existing.ui || {}), sub };
      return activate(existing.id);
    }
    return addTab({ id: HD.uid(), kind: found.node.type, refId: id, ui: sub ? { sub } : {} });
  };

  HD.openEnvironment = (id) => {
    const existing = S.ws.tabs.find((t) => t.kind === 'environment' && t.refId === id);
    if (existing) return activate(existing.id);
    return addTab({ id: HD.uid(), kind: 'environment', refId: id });
  };
  HD.openGlobals = () => {
    const existing = S.ws.tabs.find((t) => t.kind === 'globals');
    if (existing) return activate(existing.id);
    return addTab({ id: HD.uid(), kind: 'globals' });
  };
  HD.openRunner = (collectionId, folderId) => {
    const existing = S.ws.tabs.find((t) => t.kind === 'runner');
    const cfg = { iterations: 1, delay: 0, persist: true, stopOnFailure: false, useCookies: true, environmentId: S.ws.activeEnvironmentId, excluded: {} };
    if (existing) {
      if (collectionId) existing.runner = { ...(existing.runner || cfg), collectionId, folderId: folderId || null, excluded: {} };
      return activate(existing.id);
    }
    return addTab({ id: HD.uid(), kind: 'runner', runner: { ...cfg, collectionId: collectionId || null, folderId: folderId || null } });
  };

  const tabTitle = (t) => {
    if (t.kind === 'request') return t.draft.name || 'Untitled Request';
    if (t.kind === 'collection' || t.kind === 'folder') { const f = HD.find(t.refId); return f ? f.node.name : 'Deleted'; }
    if (t.kind === 'environment') { const e = S.ws.environments.find((x) => x.id === t.refId); return e ? e.name : 'Deleted'; }
    if (t.kind === 'globals') return 'Globals';
    if (t.kind === 'runner') return 'Collection Runner';
    if (t.kind === 'monitor') { const m = HD.monitors().find((x) => x.id === t.refId); return m ? m.name : 'Deleted'; }
    if (t.kind === 'secrets') return 'Secret scan';
    if (t.kind === 'audit') return 'Audit log';
    if (t.kind === 'discovery') { const d = HD.discoverySources().find((x) => x.id === t.refId); return d ? d.name : 'Deleted'; }
    return 'Tab';
  };

  HD.closeTab = async (id, force) => {
    const tab = S.ws.tabs.find((t) => t.id === id);
    if (!tab) return;
    if (!force && tab.dirty) {
      const choice = await new Promise((resolve) => {
        let done = false;
        HD.modal({
          title: 'Unsaved changes',
          body: h('p.confirm-text', `"${tabTitle(tab)}" has unsaved changes. Save them before closing?`),
          width: 440,
          buttons: [
            { label: 'Cancel', onClick: () => { done = true; resolve('cancel'); } },
            { label: "Don't save", danger: true, onClick: () => { done = true; resolve('discard'); } },
            { label: 'Save', primary: true, onClick: () => { done = true; resolve('save'); } },
          ],
          onClose: () => { if (!done) resolve('cancel'); },
        });
      });
      if (choice === 'cancel') return;
      if (choice === 'save' && !(await HD.saveTab(tab))) return;
    }
    if (S.sending.get(id)) window.api.cancel(id);
    const idx = S.ws.tabs.indexOf(tab);
    S.ws.tabs.splice(idx, 1);
    S.responses.delete(id);
    if (S.ws.activeTabId === id) {
      const next = S.ws.tabs[idx] || S.ws.tabs[idx - 1];
      S.ws.activeTabId = next ? next.id : null;
    }
    HD.save();
    HD.renderTabBar();
    HD.renderActiveTab();
  };

  // Saves a request tab back to its collection (or asks where to save it). Returns true on success.
  HD.saveTab = async (tab) => {
    if (!tab || tab.kind !== 'request') return true;
    let found = HD.find(tab.refId);
    if (!found) {
      const loc = await HD.pickLocation('Save request', tab.draft.name);
      if (!loc) return false;
      const item = HD.newRequestItem(loc.name, HD.clone(tab.draft.request));
      const parent = HD.find(loc.folderId || loc.collectionId).node;
      parent.items.push(item);
      (S.ws.ui.expanded = S.ws.ui.expanded || {})[parent.id] = true;
      tab.refId = item.id;
      tab.draft.name = loc.name;
      found = HD.find(item.id);
    } else {
      found.node.request = HD.clone(tab.draft.request);
      found.node.name = tab.draft.name;
    }
    tab.dirty = false;
    HD.save();
    HD.renderSidebar();
    HD.renderTabBar();
    if (HD.currentTab() === tab) HD.renderActiveTab();
    HD.toast('Saved', 'success', 1200);
    return true;
  };

  HD.renderTabBar = () => {
    const bar = document.getElementById('tabbar');
    HD.clear(bar);
    const strip = h('div.tabs');
    for (const t of S.ws.tabs) {
      const icon = t.kind === 'request'
        ? h(`span.method-tag.${HD.methodClass(t.draft.request.method)}`, t.draft.request.method.slice(0, 6))
        : HD.icon({ collection: 'layers', folder: 'folder', environment: 'globe', globals: 'globe', runner: 'play', discovery: 'search', monitor: 'pulse', secrets: 'shield', audit: 'history' }[t.kind] || 'file');
      const el = h('div.tab', {
        class: [t.id === S.ws.activeTabId && 'active', t.dirty && 'dirty', S.sending.get(t.id) && 'sending'].filter(Boolean).join(' '),
        title: t.kind === 'request' ? `${tabTitle(t)}\n${t.draft.request.url}` : tabTitle(t),
        draggable: 'true',
        onclick: () => activate(t.id),
        onauxclick: (e) => { if (e.button === 1) HD.closeTab(t.id); },
        oncontextmenu: (e) => HD.menu(e, [
          { label: 'Close', onClick: () => HD.closeTab(t.id) },
          { label: 'Close other tabs', onClick: async () => { for (const o of S.ws.tabs.filter((x) => x.id !== t.id)) await HD.closeTab(o.id); } },
          { label: 'Close all tabs', onClick: async () => { for (const o of [...S.ws.tabs]) await HD.closeTab(o.id); } },
          t.kind === 'request' ? { label: 'Duplicate tab', onClick: () => HD.openNewRequest(HD.clone(t.draft.request), `${t.draft.name} Copy`) } : null,
        ]),
        ondragstart: (e) => { e.dataTransfer.setData('text/tab', t.id); },
        ondragover: (e) => { if (e.dataTransfer.types.includes('text/tab')) e.preventDefault(); },
        ondrop: (e) => {
          const from = e.dataTransfer.getData('text/tab');
          if (!from || from === t.id) return;
          e.preventDefault();
          e.stopPropagation();
          const src = S.ws.tabs.find((x) => x.id === from);
          S.ws.tabs.splice(S.ws.tabs.indexOf(src), 1);
          S.ws.tabs.splice(S.ws.tabs.indexOf(t), 0, src);
          HD.save();
          HD.renderTabBar();
        },
      }, icon, h('span.tab-title', tabTitle(t)),
      h('button.tab-close', { type: 'button', title: 'Close tab', onclick: (e) => { e.stopPropagation(); HD.closeTab(t.id); } }, h('span.tab-dot'), HD.icon('x')));
      strip.appendChild(el);
    }
    bar.append(strip, HD.button('', () => HD.openNewRequest(), { icon: 'plus', ghost: true, title: 'New request (Ctrl+T)', class: 'tab-add' }));
    const active = bar.querySelector('.tab.active');
    if (active) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };

  HD.renderActiveTab = () => {
    const root = document.getElementById('content');
    HD.clear(root);
    const tab = HD.currentTab();
    if (!tab) {
      HD.variableInfo = () => HD.variableInfoFor(null);
      root.appendChild(h('div.welcome',
        h('div.welcome-title', 'HttpDash'),
        h('div.muted', 'Build, test and document HTTP APIs.'),
        h('div.welcome-actions',
          HD.button('New request', () => HD.openNewRequest(), { primary: true, icon: 'plus' }),
          HD.button('Import', () => HD.showImport(), { icon: 'download' }),
          HD.button('Collection runner', () => HD.openRunner(), { icon: 'play' })),
        h('div.welcome-tips',
          h('div', h('kbd', 'Ctrl/Cmd + T'), ' new request'),
          h('div', h('kbd', 'Ctrl/Cmd + Enter'), ' send'),
          h('div', h('kbd', 'Ctrl/Cmd + S'), ' save'),
          h('div', 'Paste a cURL command into the URL bar to import it'))));
      return;
    }
    const view = HD.views[tab.kind];
    if (view) view(tab, root);
  };

  // ---- Top bar ------------------------------------------------------------------------------

  HD.renderEnvSelect = () => {
    const host = document.getElementById('env-select');
    HD.clear(host);
    host.appendChild(HD.select([['', 'No Environment'], ...S.ws.environments.map((e) => [e.id, e.name])], S.ws.activeEnvironmentId || '', (v) => {
      S.ws.activeEnvironmentId = v || null;
      HD.save();
      HD.renderSidebar();
      HD.refreshVarHighlights();
      const t = HD.currentTab();
      if (t && t.kind === 'environment') HD.renderActiveTab();
    }, 'env-dropdown'));
    const eye = HD.button('', () => HD.showQuickLook(eye), { icon: 'eye', ghost: true, title: 'Environment quick look' });
    host.appendChild(eye);
  };

  const renderTopbar = () => {
    const bar = document.getElementById('topbar');
    HD.clear(bar);
    bar.append(
      h('div.brand', h('span.brand-mark', 'H'), h('span', 'HttpDash')),
      HD.button('New', (e) => HD.menu(e, [
        { label: 'HTTP Request', hint: 'Ctrl+T', onClick: () => HD.openNewRequest() },
        { label: 'Collection', onClick: async () => { const n = await HD.prompt('New collection', 'Name', 'New Collection'); if (n) { const c = HD.newCollection(n); S.ws.collections.push(c); HD.save(); S.ws.ui.sidebarTab = 'collections'; HD.renderSidebar(); HD.openContainer(c.id); } } },
        { label: 'Environment', onClick: async () => { const n = await HD.prompt('New environment', 'Name', 'New Environment'); if (n) { const env = HD.newEnvironment(n); S.ws.environments.push(env); HD.save(); HD.renderEnvSelect(); S.ws.ui.sidebarTab = 'environments'; HD.renderSidebar(); HD.openEnvironment(env.id); } } },
      ]), { icon: 'plus', small: true }),
      HD.button('Import', () => HD.showImport(), { icon: 'download', small: true }),
      HD.button('Export', () => HD.showExportAll(), { icon: 'upload', small: true }),
      HD.button('Runner', () => HD.openRunner(), { icon: 'play', small: true, ghost: true }),
      h('span.spacer'),
      h('div#env-select'),
      h('div#lock-button'),
      HD.button('', () => HD.showCookies(), { icon: 'cookie', ghost: true, title: 'Cookies' }),
      HD.button('', () => HD.showSettings(), { icon: 'gear', ghost: true, title: 'Settings' }));
    HD.renderEnvSelect();
  };

  // ---- Console & status bar ----------------------------------------------------------------

  let consoleFilter = 'all';
  const renderConsole = () => {
    const panel = document.getElementById('console');
    const open = !!S.ws.ui.consoleOpen;
    panel.classList.toggle('open', open);
    if (S.ws.ui.consoleHeight) panel.style.height = `${S.ws.ui.consoleHeight}px`;
    HD.clear(panel);
    if (!open) return;
    const levels = { all: () => true, net: (l) => l.level === 'net', log: (l) => l.level !== 'net', error: (l) => l.level === 'error' || l.level === 'warn' };
    const resize = h('div.console-resize');
    const list = h('div.console-list');
    panel.append(resize,
      h('div.console-head', h('b', 'Console'),
        HD.tabStrip([{ id: 'all', label: 'All' }, { id: 'net', label: 'Network' }, { id: 'log', label: 'Logs' }, { id: 'error', label: 'Errors' }], consoleFilter, (id) => { consoleFilter = id; renderConsole(); }, 'segmented'),
        h('span.spacer'),
        HD.button('Clear', () => { S.consoleLogs.length = 0; renderConsole(); }, { small: true, ghost: true }),
        HD.button('', () => { S.ws.ui.consoleOpen = false; HD.save(); renderConsole(); renderStatusbar(); }, { icon: 'x', ghost: true, small: true, title: 'Close console' })),
      list);
    const logs = S.consoleLogs.filter(levels[consoleFilter]);
    if (!logs.length) list.appendChild(h('div.muted.small.panel-pad', 'Network activity and console.log() output from scripts appear here.'));
    for (const l of logs) {
      list.appendChild(h(`div.console-line.lvl-${l.level}`,
        h('span.console-time', new Date(l.time).toLocaleTimeString()),
        h('span.console-level', l.level.toUpperCase()),
        h('span.console-msg', l.message),
        l.extra && l.extra.request ? h('span.console-src', l.extra.request) : null));
    }
    list.scrollTop = list.scrollHeight;
    let startH;
    resize.addEventListener('mousedown', () => { startH = panel.offsetHeight; });
    HD.splitter(resize, { axis: 'y', onMove: (d) => { const v = Math.max(80, Math.min(window.innerHeight - 200, startH - d)); panel.style.height = `${v}px`; S.ws.ui.consoleHeight = v; }, onEnd: () => HD.save() });
  };
  HD.on('console', HD.debounce(() => { renderConsole(); renderStatusbar(); }, 50));

  const renderStatusbar = () => {
    const bar = document.getElementById('statusbar');
    HD.clear(bar);
    const errors = S.consoleLogs.filter((l) => l.level === 'error').length;
    bar.append(
      HD.button('', () => { S.ws.ui.sidebarHidden = !S.ws.ui.sidebarHidden; HD.save(); applyLayout(); }, { icon: 'sidebar', ghost: true, small: true, title: 'Toggle sidebar (Ctrl+\\)' }),
      HD.button(errors ? `Console (${errors} errors)` : 'Console', () => { S.ws.ui.consoleOpen = !S.ws.ui.consoleOpen; HD.save(); renderConsole(); renderStatusbar(); }, { icon: 'terminal', ghost: true, small: true, class: errors ? 'has-errors' : '' }),
      h('span.spacer'),
      HD.button('Cookies', () => HD.showCookies(), { icon: 'cookie', ghost: true, small: true }),
      HD.button('Runner', () => HD.openRunner(), { icon: 'play', ghost: true, small: true }),
      HD.button('', () => { S.ws.ui.layout = (S.ws.ui.layout || 'vertical') === 'vertical' ? 'horizontal' : 'vertical'; HD.save(); HD.renderActiveTab(); }, { icon: (S.ws.ui.layout || 'vertical') === 'vertical' ? 'columns' : 'rows', ghost: true, small: true, title: 'Toggle request/response layout' }));
  };

  const applyLayout = () => {
    const side = document.getElementById('sidebar-wrap');
    side.style.display = S.ws.ui.sidebarHidden ? 'none' : '';
    side.style.width = `${S.ws.ui.sidebarWidth || 300}px`;
  };

  // ---- Theme --------------------------------------------------------------------------------

  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
  HD.applyTheme = () => {
    const pref = S.ws.settings.theme || 'system';
    const theme = pref === 'system' ? (darkQuery.matches ? 'dark' : 'light') : pref;
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.setProperty('--editor-font-size', `${S.ws.settings.fontSize || 13}px`);
    document.querySelectorAll('.CodeMirror').forEach((c) => c.CodeMirror && c.CodeMirror.refresh());
  };
  darkQuery.addEventListener('change', () => HD.applyTheme());

  // ---- Commands -----------------------------------------------------------------------------

  const commands = {
    'new-request': () => HD.openNewRequest(),
    'new-collection': async () => { const n = await HD.prompt('New collection', 'Name', 'New Collection'); if (n) { const c = HD.newCollection(n); S.ws.collections.push(c); HD.save(); HD.renderSidebar(); HD.openContainer(c.id); } },
    'new-environment': async () => { const n = await HD.prompt('New environment', 'Name', 'New Environment'); if (n) { const e = HD.newEnvironment(n); S.ws.environments.push(e); HD.save(); HD.renderEnvSelect(); HD.renderSidebar(); HD.openEnvironment(e.id); } },
    import: () => HD.showImport(),
    save: () => HD.saveTab(HD.currentTab()),
    'close-tab': () => { const t = HD.currentTab(); if (t) HD.closeTab(t.id); },
    settings: () => HD.showSettings(),
    'toggle-sidebar': () => { S.ws.ui.sidebarHidden = !S.ws.ui.sidebarHidden; HD.save(); applyLayout(); },
    'toggle-console': () => { S.ws.ui.consoleOpen = !S.ws.ui.consoleOpen; HD.save(); renderConsole(); renderStatusbar(); },
    send: () => { const t = HD.currentTab(); const fn = t && S.senders.get(t.id); if (fn) fn(); },
    runner: () => HD.openRunner(),
    cookies: () => HD.showCookies(),
    codegen: () => HD.showCodegen(HD.currentTab()),
    lock: () => HD.lockNow(),
    secrets: () => HD.openSecretScan(),
    audit: () => HD.openAuditLog(),
    monitors: () => { S.ws.ui.sidebarTab = 'monitors'; HD.save(); HD.renderSidebar(); },
  };
  HD.command = (name) => commands[name] && commands[name]();
  // Keyboard shortcuts are handled here; the application menu only displays them.
  const SHORTCUTS = { t: 'new-request', o: 'import', s: 'save', w: 'close-tab', ',': 'settings', '\\': 'toggle-sidebar', Enter: 'send', l: 'lock' };
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey) return;
    let cmd = e.altKey ? (e.key.toLowerCase() === 'c' || e.code === 'KeyC' ? 'toggle-console' : null) : SHORTCUTS[e.key.length === 1 ? e.key.toLowerCase() : e.key];
    if (!cmd) return;
    if (document.querySelector('.modal-overlay') || document.body.classList.contains('is-locked')) return;
    e.preventDefault();
    HD.command(cmd);
  });
  window.api.onMenu((cmd) => {
    // Don't fire app shortcuts while a modal dialog is open.
    if (document.body.classList.contains('is-locked')) return;
    if (document.querySelector('.modal-overlay') && cmd !== 'close-tab') return;
    HD.command(cmd);
  });

  // ---- Boot ---------------------------------------------------------------------------------

  const boot = async () => {
    // With the app lock on, nothing is loaded until an LDAP sign-in succeeds.
    const lockStatus = await window.api.lock.status();
    HD.lockState = lockStatus;
    if (lockStatus.locked) {
      HD.showLockScreen(lockStatus);
      return;
    }
    await HD.load();
    HD.applyTheme();
    // Clean up tabs that refer to things that no longer exist.
    S.ws.tabs = S.ws.tabs.filter((t) => t.kind !== 'request' || t.draft);
    if (S.ws.activeTabId && !S.ws.tabs.some((t) => t.id === S.ws.activeTabId)) S.ws.activeTabId = S.ws.tabs[0] ? S.ws.tabs[0].id : null;
    renderTopbar();
    applyLayout();
    HD.renderSidebar();
    HD.renderTabBar();
    HD.renderActiveTab();
    renderConsole();
    renderStatusbar();

    const handle = document.getElementById('sidebar-resize');
    let startW;
    handle.addEventListener('mousedown', () => { startW = document.getElementById('sidebar-wrap').offsetWidth; });
    HD.splitter(handle, {
      axis: 'x',
      onMove: (d) => { S.ws.ui.sidebarWidth = Math.max(200, Math.min(600, startW + d)); applyLayout(); },
      onEnd: () => { HD.save(); document.querySelectorAll('.CodeMirror').forEach((c) => c.CodeMirror && c.CodeMirror.refresh()); },
    });
    HD.on('variables', () => {
      HD.refreshVarHighlights();
      const t = HD.currentTab();
      if (t && ['environment', 'globals', 'collection'].includes(t.kind)) HD.renderActiveTab();
    });
    window.addEventListener('beforeunload', () => { window.api.saveWorkspace(S.ws).catch(() => {}); });
    HD.renderTopbarLock();
    HD.startIdleLock();
    HD.startMonitors();
    try {
      if (sessionStorage.getItem('hd-recovered')) {
        sessionStorage.removeItem('hd-recovered');
        HD.toast('Unlocked with the recovery code. The lock is now off; fix the LDAP settings and turn it on again.', 'warn', 9000);
        HD.showSettings('security');
      }
    } catch { /* storage unavailable */ }
    HD.syncDiscoveryOnStartup();
  };
  boot().catch((e) => {
    document.body.textContent = `Failed to start: ${e.message}`;
    console.error(e);
  });
})();
