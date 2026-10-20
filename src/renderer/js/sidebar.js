'use strict';

/* Sidebar: collections tree, environments list and history. */
(() => {
  const { h } = HD;
  const S = HD.S;
  let filter = '';
  let dragId = null;

  const expanded = () => (S.ws.ui.expanded = S.ws.ui.expanded || {});

  HD.renderSidebar = () => {
    const root = document.getElementById('sidebar');
    HD.clear(root);
    const tab = S.ws.ui.sidebarTab || 'collections';
    const nav = h('div.side-nav', [
      ['collections', 'layers', 'Collections'],
      ['environments', 'globe', 'Environments'],
      ['history', 'history', 'History'],
      ['monitors', 'pulse', 'Monitors'],
      ['team', 'users', 'Team'],
    ].map(([id, icon, label]) => h('button.side-nav-btn', {
      class: id === tab ? 'active' : '', type: 'button', title: label,
      onclick: () => { S.ws.ui.sidebarTab = id; HD.save(); HD.renderSidebar(); },
    }, HD.icon(icon), h('span', label))));
    const panel = h('div.side-panel');
    root.append(nav, panel);
    if (tab === 'collections') renderCollections(panel);
    else if (tab === 'environments') renderEnvironments(panel);
    else if (tab === 'monitors') HD.renderMonitorsSidebar(panel);
    else if (tab === 'team') HD.renderTeamSidebar(panel);
    else renderHistory(panel);
  };

  // Shows which items are shared through a team repository.
  const teamBadge = (item) => {
    if (!item.team) return null;
    const repo = HD.teamRepos().find((r) => r.id === item.team);
    return h('span.team-badge', { title: `Shared through "${repo ? repo.name : 'a team repository'}"` }, HD.icon('users'));
  };

  const toolbar = (onAdd, addTitle, extra) => {
    const search = h('input.input.side-search', {
      placeholder: 'Filter', value: filter, spellcheck: 'false',
      oninput: HD.debounce((e) => { filter = e.target.value; const pos = e.target.selectionStart; HD.renderSidebar(); const s = document.querySelector('.side-search'); if (s) { s.focus(); s.setSelectionRange(pos, pos); } }, 150),
    });
    return h('div.side-toolbar', onAdd ? HD.button('', onAdd, { icon: 'plus', ghost: true, title: addTitle }) : null, search, extra || null);
  };

  // ---- Collections --------------------------------------------------------------------------

  const matches = (node, f) => {
    if (!f) return true;
    if (node.name.toLowerCase().includes(f)) return true;
    if (node.type === 'request' && (node.request.url || '').toLowerCase().includes(f)) return true;
    return (node.items || []).some((c) => matches(c, f));
  };

  function renderCollections(panel) {
    panel.appendChild(toolbar(async () => {
      const name = await HD.prompt('New collection', 'Name', 'New Collection');
      if (!name) return;
      const c = HD.newCollection(name);
      S.ws.collections.push(c);
      expanded()[c.id] = true;
      HD.save();
      HD.renderSidebar();
      HD.openContainer(c.id);
    }, 'New collection', HD.button('', () => HD.showImport(), { icon: 'download', ghost: true, title: 'Import' })));
    const tree = h('div.tree');
    panel.appendChild(tree);
    const f = filter.trim().toLowerCase();
    if (!S.ws.collections.length) {
      tree.appendChild(h('div.empty-state.small', h('div', 'No collections yet.'), h('div.muted', 'Create one, or import a Postman collection / OpenAPI file.')));
    }
    const active = HD.currentTab();
    const activeRef = active && active.refId;
    const renderNode = (node, depth, collection) => {
      if (!matches(node, f)) return;
      const isContainer = node.type !== 'request';
      const open = f ? true : !!expanded()[node.id];
      const row = h('div.tree-row', {
        class: [activeRef === node.id && 'active', isContainer && 'container'].filter(Boolean).join(' '),
        style: { paddingLeft: `${6 + depth * 14}px` },
        draggable: node.type !== 'collection' ? 'true' : null,
        dataset: { id: node.id },
        onclick: () => {
          if (isContainer) { expanded()[node.id] = !expanded()[node.id]; HD.save(); HD.renderSidebar(); } else HD.openRequest(node.id);
        },
        ondblclick: () => { if (isContainer) HD.openContainer(node.id); },
        oncontextmenu: (e) => HD.menu(e, nodeMenu(node, collection)),
        ondragstart: (e) => { dragId = node.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', node.id); },
        ondragover: (e) => {
          if (!dragId || dragId === node.id) return;
          e.preventDefault();
          row.classList.add(isContainer ? 'drop-into' : 'drop-before');
        },
        ondragleave: () => row.classList.remove('drop-into', 'drop-before'),
        ondrop: (e) => {
          e.preventDefault();
          e.stopPropagation();
          row.classList.remove('drop-into', 'drop-before');
          moveNode(dragId, node);
          dragId = null;
        },
      },
      isContainer ? h('span.tree-caret', { class: open ? 'open' : '' }, HD.icon('chevron')) : h('span.tree-caret.empty'),
      node.type === 'request' ? h(`span.method-tag.${HD.methodClass(node.request.method)}`, node.request.method.slice(0, 6)) : HD.icon(node.type === 'collection' ? 'layers' : 'folder'),
      h('span.tree-name', node.name),
      teamBadge(node),
      h('button.tree-more', { type: 'button', title: 'More actions', onclick: (e) => { e.stopPropagation(); HD.menu(e, nodeMenu(node, collection)); } }, HD.icon('dots')));
      tree.appendChild(row);
      if (isContainer && open) {
        if (!node.items.length && !f) tree.appendChild(h('div.tree-empty', { style: { paddingLeft: `${34 + depth * 14}px` } }, 'Empty — ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); addRequest(node); } }, 'add a request')));
        node.items.forEach((c) => renderNode(c, depth + 1, collection));
      }
    };
    S.ws.collections.forEach((c) => renderNode(c, 0, c));
  }

  const addRequest = (parent) => {
    const r = HD.newRequestItem();
    parent.items.push(r);
    expanded()[parent.id] = true;
    HD.save();
    HD.renderSidebar();
    HD.openRequest(r.id);
  };

  function nodeMenu(node, collection) {
    const found = HD.find(node.id);
    const rename = async () => {
      const name = await HD.prompt('Rename', 'Name', node.name);
      if (!name) return;
      node.name = name;
      for (const t of S.ws.tabs) {
        if (t.refId === node.id) { t.title = name; if (t.draft) t.draft.name = name; }
      }
      HD.save();
      HD.renderSidebar();
      HD.renderTabBar();
      HD.renderActiveTab();
    };
    const remove = async () => {
      const what = node.type === 'request' ? 'request' : node.type;
      if (!(await HD.confirm(`Delete ${what}`, `Delete "${node.name}"${node.type !== 'request' ? ' and everything in it' : ''}?${collection && collection.team ? ' It is shared with your team: the next sync deletes it for everyone.' : ''} This cannot be undone.`, { danger: true, okLabel: 'Delete' }))) return;
      const ids = new Set([node.id]);
      HD.walk(node.items || [], (it) => ids.add(it.id));
      found.siblings.splice(found.siblings.indexOf(node), 1);
      S.ws.tabs.filter((t) => ids.has(t.refId)).forEach((t) => HD.closeTab(t.id, true));
      HD.save();
      HD.renderSidebar();
    };
    const duplicate = () => {
      const copy = HD.duplicate(node);
      copy.name = `${node.name} Copy`;
      found.siblings.splice(found.siblings.indexOf(node) + 1, 0, copy);
      HD.save();
      HD.renderSidebar();
    };
    if (node.type === 'request') {
      return [
        { label: 'Open in new tab', onClick: () => HD.openRequest(node.id) },
        { label: 'Rename', onClick: rename },
        { label: 'Duplicate', onClick: duplicate },
        { label: 'Copy as cURL', onClick: async () => {
          const code = await window.api.generateCode({ target: 'curl', request: node.request, chain: [found.collection, ...found.parents].map((n) => ({ auth: n.auth })), scopes: HD.scopesFor(found.collection) }).catch((e) => HD.toast(HD.cleanErr(e), 'error'));
          if (code) HD.copy(code);
        } },
        { separator: true },
        { label: 'Delete', danger: true, onClick: remove },
      ];
    }
    return [
      { label: 'Add request', onClick: () => addRequest(node) },
      { label: 'Add folder', onClick: async () => {
        const name = await HD.prompt('New folder', 'Name', 'New Folder');
        if (!name) return;
        const f = HD.newFolder(name);
        node.items.push(f);
        expanded()[node.id] = true;
        HD.save();
        HD.renderSidebar();
      } },
      { separator: true },
      { label: node.type === 'collection' ? 'Edit collection' : 'Edit folder', hint: 'auth, scripts, variables', onClick: () => HD.openContainer(node.id) },
      { label: `Run ${node.type}`, onClick: () => HD.openRunner(collection.id, node.type === 'folder' ? node.id : null) },
      { label: 'Rename', onClick: rename },
      { label: 'Duplicate', onClick: duplicate },
      node.type === 'collection' ? { label: 'Export (Postman v2.1)', onClick: () => window.api.exportCollection(node) } : null,
      { separator: true },
      { label: 'Delete', danger: true, onClick: remove },
    ];
  }

  function moveNode(id, target) {
    const src = HD.find(id);
    if (!src || id === target.id) return;
    // Refuse to move a folder into itself or one of its descendants.
    let inside = false;
    HD.walk(src.node.items || [], (it) => { if (it.id === target.id) inside = true; });
    if (inside) return;
    src.siblings.splice(src.siblings.indexOf(src.node), 1);
    if (target.type === 'request') {
      const t = HD.find(target.id);
      t.siblings.splice(t.siblings.indexOf(target), 0, src.node);
    } else {
      target.items.push(src.node);
      expanded()[target.id] = true;
    }
    HD.save();
    HD.renderSidebar();
    HD.renderActiveTab();
  }

  // ---- Environments -------------------------------------------------------------------------

  function renderEnvironments(panel) {
    panel.appendChild(toolbar(async () => {
      const name = await HD.prompt('New environment', 'Name', 'New Environment');
      if (!name) return;
      const env = HD.newEnvironment(name);
      S.ws.environments.push(env);
      HD.save();
      HD.renderSidebar();
      HD.renderEnvSelect();
      HD.openEnvironment(env.id);
    }, 'New environment'));
    const list = h('div.tree');
    panel.appendChild(list);
    const f = filter.trim().toLowerCase();
    list.appendChild(h('div.tree-row.env-row', { onclick: () => HD.openGlobals() }, HD.icon('globe'), h('span.tree-name', 'Globals'), h('span.muted.small', String(S.ws.globals.filter((v) => v.key).length))));
    for (const env of S.ws.environments) {
      if (f && !env.name.toLowerCase().includes(f)) continue;
      const isActive = S.ws.activeEnvironmentId === env.id;
      list.appendChild(h('div.tree-row.env-row', {
        class: isActive ? 'env-active' : '',
        onclick: () => HD.openEnvironment(env.id),
        oncontextmenu: (e) => HD.menu(e, envMenu(env)),
      },
      h('button.env-check', {
        type: 'button', title: isActive ? 'Active environment' : 'Set as active',
        onclick: (e) => { e.stopPropagation(); S.ws.activeEnvironmentId = isActive ? null : env.id; HD.save(); HD.renderSidebar(); HD.renderEnvSelect(); HD.refreshVarHighlights(); },
      }, isActive ? HD.icon('check') : null),
      h('span.tree-name', env.name),
      teamBadge(env),
      h('span.muted.small', String(env.values.filter((v) => v.key).length)),
      h('button.tree-more', { type: 'button', onclick: (e) => { e.stopPropagation(); HD.menu(e, envMenu(env)); } }, HD.icon('dots'))));
    }
    if (!S.ws.environments.length) list.appendChild(h('div.empty-state.small', 'No environments. Environments hold sets of variables like base URLs and tokens.'));
    HD.renderDiscoverySidebar(list);
  }

  function envMenu(env) {
    return [
      { label: 'Edit', onClick: () => HD.openEnvironment(env.id) },
      { label: 'Set active', onClick: () => { S.ws.activeEnvironmentId = env.id; HD.save(); HD.renderSidebar(); HD.renderEnvSelect(); } },
      { label: 'Duplicate', onClick: () => { const c = HD.clone(env); c.id = HD.uid(); delete c.team; c.name = `${env.name} Copy`; S.ws.environments.push(c); HD.save(); HD.renderSidebar(); HD.renderEnvSelect(); } },
      { label: 'Export', onClick: () => window.api.exportEnvironment(env) },
      { separator: true },
      { label: 'Delete', danger: true, onClick: async () => {
        if (!(await HD.confirm('Delete environment', `Delete "${env.name}"?`, { danger: true, okLabel: 'Delete' }))) return;
        S.ws.environments.splice(S.ws.environments.indexOf(env), 1);
        if (S.ws.activeEnvironmentId === env.id) S.ws.activeEnvironmentId = null;
        S.ws.tabs.filter((t) => t.refId === env.id).forEach((t) => HD.closeTab(t.id, true));
        HD.save();
        HD.renderSidebar();
        HD.renderEnvSelect();
      } },
    ];
  }

  // ---- History ------------------------------------------------------------------------------

  function renderHistory(panel) {
    panel.appendChild(toolbar(null, null, HD.button('', async () => {
      if (!(await HD.confirm('Clear history', 'Delete all history entries?', { danger: true, okLabel: 'Clear' }))) return;
      S.ws.history = [];
      HD.save();
      HD.renderSidebar();
    }, { icon: 'trash', ghost: true, title: 'Clear history' })));
    const list = h('div.tree');
    panel.appendChild(list);
    const f = filter.trim().toLowerCase();
    let lastDay = null;
    const items = S.ws.history.filter((e) => !f || (e.url || '').toLowerCase().includes(f) || (e.name || '').toLowerCase().includes(f));
    if (!items.length) list.appendChild(h('div.empty-state.small', 'Requests you send will appear here.'));
    const today = new Date().toDateString();
    const yesterday = new Date(Date.now() - 864e5).toDateString();
    for (const e of items) {
      const d = new Date(e.time).toDateString();
      if (d !== lastDay) {
        list.appendChild(h('div.history-day', d === today ? 'Today' : d === yesterday ? 'Yesterday' : d));
        lastDay = d;
      }
      list.appendChild(h('div.tree-row.history-row', {
        title: `${e.method} ${e.url}\n${new Date(e.time).toLocaleString()}${e.error ? `\n${e.error}` : ''}`,
        onclick: () => HD.openNewRequest(HD.clone(e.request), e.name || e.url),
        oncontextmenu: (ev) => HD.menu(ev, [
          { label: 'Open', onClick: () => HD.openNewRequest(HD.clone(e.request), e.name || e.url) },
          { label: 'Save to collection', onClick: async () => {
            const loc = await HD.pickLocation('Save request', e.name || e.url);
            if (!loc) return;
            const item = HD.newRequestItem(loc.name, HD.clone(e.request));
            const target = HD.find(loc.folderId || loc.collectionId).node;
            target.items.push(item);
            HD.save();
            HD.renderSidebar();
          } },
          { label: 'Delete', danger: true, onClick: () => { S.ws.history.splice(S.ws.history.indexOf(e), 1); HD.save(); HD.renderSidebar(); } },
        ]),
      },
      h(`span.method-tag.${HD.methodClass(e.method)}`, (e.method || '').slice(0, 6)),
      h('span.tree-name', e.url),
      e.status ? h(`span.small.${HD.statusClass(e.status)}`, String(e.status)) : e.error ? h('span.small.text-error', 'ERR') : null));
    }
  }

  HD.on('history', () => { if ((S.ws.ui.sidebarTab || 'collections') === 'history') HD.renderSidebar(); });
})();
