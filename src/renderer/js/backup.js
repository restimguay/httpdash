'use strict';

/* Export everything (HttpDash backup or Postman files) and restore backups (merge or replace). */
(() => {
  const { h } = HD;
  const S = HD.S;

  const fields = ['collections', 'environments', 'globals', 'history', 'discoverySources', 'settings', 'activeEnvironmentId'];
  const currentWorkspace = () => {
    const ws = {};
    for (const f of fields) ws[f] = S.ws[f];
    if (!ws.discoverySources) ws.discoverySources = [];
    return HD.clone(ws);
  };

  const counts = () => {
    let requests = 0;
    for (const c of S.ws.collections) requests += HD.countRequests(c);
    return [
      [S.ws.collections.length, 'collections'], [requests, 'requests'], [S.ws.environments.length, 'environments'],
      [S.ws.globals.filter((g) => g.key).length, 'globals'], [(S.ws.discoverySources || []).length, 'discovery sources'], [S.ws.history.length, 'history entries'],
    ];
  };

  HD.showExportAll = () => {
    let format = 'backup';
    let excludeSecrets = false;
    const body = h('div.export-all');
    const render = () => {
      HD.clear(body);
      const option = (id, title, desc) => h('label.export-option', { class: format === id ? 'selected' : '' },
        h('input', { type: 'radio', name: 'export-format', checked: format === id, onchange: () => { format = id; render(); } }),
        h('div', h('div.export-option-title', title), h('div.muted.small', desc)));
      body.append(
        option('backup', 'HttpDash backup (one file)', 'Everything: collections, environments, globals, history, service discovery sources, settings and cookies. Restore it with Import, merging into or replacing a workspace.'),
        option('postman', 'Postman format (folder of files)', 'One .postman_collection.json per collection, one .postman_environment.json per environment, plus globals. Opens in Postman and other tools. Auth dependencies and discovery sources are HttpDash-only and not included.'),
        h('div.export-counts', counts().map(([n, label]) => h('span', h('b', String(n)), ` ${label}`))),
        h('label.check', h('input', { type: 'checkbox', checked: excludeSecrets, onchange: (e) => { excludeSecrets = e.target.checked; render(); } }),
          'Leave out secrets (tokens, passwords, secret variables, cookies)'),
        excludeSecrets
          ? h('div.muted.small', 'Secret variables and the variables holding auth-dependency tokens are emptied. Credentials typed into auth fields are removed; references such as {{token}} are kept.')
          : h('div.export-warning', 'The file will contain your tokens, passwords and secret variables. Keep it private, or tick the box above before sharing it.'));
    };
    render();
    HD.modal({
      title: 'Export all',
      width: 560,
      body,
      buttons: [
        { label: 'Cancel' },
        {
          label: 'Export…', primary: true,
          onClick: async () => {
            try {
              const res = await window.api.exportAll({ workspace: currentWorkspace(), format, excludeSecrets });
              if (!res) return false;
              HD.toast(format === 'backup' ? `Backup saved to ${res.path}` : `${res.files} files saved to ${res.path}`, 'success', 6000);
              return true;
            } catch (e) {
              HD.toast(`Export failed: ${HD.cleanErr(e)}`, 'error', 6000);
              return false;
            }
          },
        },
      ],
    });
  };

  // Asks how to restore a backup, then applies it.
  HD.importBackup = (item) => new Promise((resolve) => {
    const sum = item.summary || {};
    const data = item.data;
    const restore = async (mode) => {
      if (mode === 'replace' && !(await HD.confirm('Replace workspace', 'Replace all current collections, environments, globals, history, discovery sources and settings with the backup? This cannot be undone. Export a backup first if you might need the current data.', { danger: true, okLabel: 'Replace everything' }))) {
        resolve(false);
        return;
      }
      try {
        const res = await window.api.restoreBackup({ current: currentWorkspace(), data, mode });
        Object.assign(S.ws, res.workspace);
        // Close tabs whose collection/request/environment no longer exists.
        const exists = (t) => {
          if (t.kind === 'request') return !t.refId || !!HD.find(t.refId);
          if (t.kind === 'collection' || t.kind === 'folder') return !!HD.find(t.refId);
          if (t.kind === 'environment') return S.ws.environments.some((e) => e.id === t.refId);
          if (t.kind === 'discovery') return (S.ws.discoverySources || []).some((s) => s.id === t.refId);
          return true;
        };
        S.ws.tabs = S.ws.tabs.filter(exists);
        if (!S.ws.tabs.some((t) => t.id === S.ws.activeTabId)) S.ws.activeTabId = S.ws.tabs[0] ? S.ws.tabs[0].id : null;
        HD.save();
        HD.applyTheme();
        HD.renderSidebar();
        HD.renderEnvSelect();
        HD.renderTabBar();
        HD.renderActiveTab();
        HD.emit('variables');
        HD.emit('history');
        const a = res.added;
        HD.toast(`${mode === 'replace' ? 'Restored' : 'Merged'} backup: ${a.collections} collections, ${a.environments} environments${a.globals ? `, ${a.globals} globals` : ''}${a.discoverySources ? `, ${a.discoverySources} discovery sources` : ''}`, 'success', 5000);
        resolve(true);
      } catch (e) {
        HD.toast(`Restore failed: ${HD.cleanErr(e)}`, 'error', 6000);
        resolve(false);
      }
    };
    let chosen = false;
    HD.modal({
      title: 'Import HttpDash backup',
      width: 520,
      body: h('div',
        h('p.confirm-text', `Backup from ${data.exportedAt ? new Date(data.exportedAt).toLocaleString() : 'an unknown date'}${data.secretsIncluded === false ? ' (secrets were left out)' : ''}:`),
        h('div.export-counts', [[sum.collections, 'collections'], [sum.requests, 'requests'], [sum.environments, 'environments'], [sum.globals, 'globals'], [sum.discoverySources, 'discovery sources'], [sum.history, 'history entries'], [sum.cookies, 'cookies']]
          .filter(([n]) => n).map(([n, label]) => h('span', h('b', String(n)), ` ${label}`))),
        h('div.restore-modes',
          h('div', h('b', 'Merge'), h('span.muted.small', ' adds everything to your current workspace. Items that already exist are added as copies marked "(imported)".')),
          h('div', h('b', 'Replace'), h('span.muted.small', ' swaps your current workspace for the backup.')))),
      buttons: [
        { label: 'Cancel', onClick: () => { chosen = true; resolve(false); } },
        { label: 'Replace', danger: true, onClick: () => { chosen = true; restore('replace'); } },
        { label: 'Merge', primary: true, onClick: () => { chosen = true; restore('merge'); } },
      ],
      onClose: () => { if (!chosen) resolve(false); },
    });
  });
})();
