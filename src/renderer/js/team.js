'use strict';

/* Team sharing: collections and environments synced through any git repository. */
(() => {
  const { h } = HD;
  const S = HD.S;
  HD.views = HD.views || {};

  const repos = () => (S.ws.teamRepos = S.ws.teamRepos || []);
  HD.teamRepos = repos;
  const busy = new Map(); // repoId -> 'Syncing…' etc.
  const pending = new Map(); // repoId -> { conflicts, pullOnly }
  let gitInfo = null;

  const openTab = (repoId) => {
    const existing = S.ws.tabs.find((t) => t.kind === 'team' && t.refId === repoId);
    if (existing) return HD.activateTab(existing.id);
    const cur = HD.currentTab();
    const tab = { id: HD.uid(), kind: 'team', refId: repoId };
    S.ws.tabs.splice(cur ? S.ws.tabs.indexOf(cur) + 1 : S.ws.tabs.length, 0, tab);
    return HD.activateTab(tab.id);
  };
  HD.openTeamRepo = openTab;
  const refresh = () => HD.emit('team');
  const repoName = (url) => String(url || '').replace(/\.git$/, '').split(/[/:]/).filter(Boolean).pop() || 'Team repository';
  const config = (r) => ({ id: r.id, url: r.url, branch: r.branch, subdir: r.subdir, auth: r.auth });
  const sharedState = (r) => HD.clone({
    collections: S.ws.collections.filter((c) => c.team === r.id),
    environments: S.ws.environments.filter((e) => e.team === r.id),
  });

  HD.newTeamRepo = () => {
    const r = { id: HD.uid(), name: 'Team repository', url: '', branch: 'main', subdir: '', auth: 'system', lastSync: null, joined: false, last: null };
    repos().push(r);
    HD.save();
    S.ws.ui.sidebarTab = 'team';
    HD.renderSidebar();
    openTab(r.id);
  };

  // ---- Applying the team's version ---------------------------------------------------------

  const applyTeam = async (r, team, keepMissing = false) => {
    const out = await window.api.team.apply({ local: HD.clone({ collections: S.ws.collections, environments: S.ws.environments }), team, repoId: r.id, keepMissing });
    S.ws.collections = out.collections;
    S.ws.environments = out.environments;
    if (S.ws.activeEnvironmentId && !S.ws.environments.some((e) => e.id === S.ws.activeEnvironmentId)) S.ws.activeEnvironmentId = null;
    // Open tabs follow the new version unless they hold unsaved edits.
    let kept = 0;
    for (const t of [...S.ws.tabs]) {
      if (t.kind !== 'request' || !t.refId) continue;
      const found = HD.find(t.refId);
      if (!found) { if (!t.dirty) HD.closeTab(t.id, true); else kept++; continue; }
      if (found.collection.team !== r.id) continue;
      if (t.dirty) kept++;
      else t.draft = { name: found.node.name, request: HD.clone(found.node.request) };
    }
    if (kept) HD.toast(`${kept} open tab${kept > 1 ? 's have' : ' has'} unsaved edits; save them to keep your version, or close them without saving to take the team's.`, 'warn', 8000);
    HD.save();
    HD.renderSidebar();
    HD.renderEnvSelect();
    HD.renderTabBar();
    HD.renderActiveTab();
    HD.emit('variables');
    return out.summary;
  };

  const describe = (summary) => {
    const parts = [];
    if (summary.added.length) parts.push(`added ${summary.added.join(', ')}`);
    if (summary.updated.length) parts.push(`updated ${summary.updated.join(', ')}`);
    if (summary.removed.length) parts.push(`removed ${summary.removed.join(', ')}`);
    return parts.join('; ');
  };

  const finish = async (r, res, pullOnly) => {
    pending.delete(r.id);
    const summary = await applyTeam(r, res.team);
    const changes = describe(summary);
    r.lastSync = Date.now();
    r.last = {
      ok: true, time: r.lastSync, pullOnly, pushed: !!res.pushed, changes,
      problems: (res.team.problems || []).slice(0, 10), status: res.status,
    };
    HD.save();
    const what = pullOnly ? 'Got the latest from the team' : res.pushed ? 'Synced with the team' : 'Up to date';
    HD.toast(changes ? `${what}: ${changes}` : `${what}. No changes from teammates.`, 'success', changes ? 7000 : 3500);
    HD.log('info', `Team "${r.name}": ${what.toLowerCase()}${changes ? ` (${changes})` : ''}`);
  };

  // Plain-text credentials in what is about to be pushed. Returns true to go ahead.
  const checkSecrets = async (state) => {
    const findings = await window.api.team.scan(state);
    if (!findings.length) return true;
    return new Promise((resolve) => {
      let answered = false;
      const done = (v) => { if (!answered) { answered = true; resolve(v); } };
      HD.modal({
        title: 'Plain-text secrets found',
        width: 620,
        onClose: () => done(false),
        body: h('div.team-secrets',
          h('p', `The items you share contain ${findings.length} value${findings.length > 1 ? 's that look' : ' that looks'} like credentials. Everyone with access to the repository would be able to read ${findings.length > 1 ? 'them' : 'it'}, including in the history after you remove ${findings.length > 1 ? 'them' : 'it'}.`),
          h('div.secret-list', findings.slice(0, 12).map((f) => h('div.secret-item',
            h(`span.severity.${f.severity}`, f.severity.toUpperCase()),
            h('div.secret-main', h('div', h('b', f.type)), h('div.muted.small', `${f.where} › ${f.field}`), h('div.mono.small', f.preview))))),
          findings.length > 12 ? h('div.muted.small', `…and ${findings.length - 12} more.`) : null,
          h('p.muted.small', 'Secret variables are always pushed with an empty value. Use the secret scan to move these values into secret variables first.')),
        buttons: [
          { label: 'Open secret scan', onClick: () => { done(false); HD.openSecretScan(); } },
          { label: 'Push anyway', danger: true, onClick: () => done(true) },
          { label: 'Cancel', primary: true, onClick: () => done(false) },
        ],
      });
    });
  };

  HD.teamSync = async (r, { pullOnly = false, message = '' } = {}) => {
    if (busy.has(r.id)) return;
    if (!r.url) { HD.toast('Enter the repository URL first.', 'warn'); return; }
    busy.set(r.id, pullOnly ? 'Getting latest…' : 'Syncing…');
    refresh();
    try {
      // First contact: take the team's items before writing ours, so nothing of theirs is deleted.
      if (!r.joined) {
        const res = await window.api.team.sync({ repo: config(r), state: null, pullOnly: true });
        await applyTeam(r, res.team, true); // items you just chose to share aren't in the repository yet
        r.joined = true;
        HD.save();
      }
      const state = sharedState(r);
      if (!pullOnly && !(await checkSecrets(state))) return;
      const dirty = S.ws.tabs.filter((t) => t.dirty && t.refId && (HD.find(t.refId) || {}).collection && HD.find(t.refId).collection.team === r.id);
      if (!pullOnly && dirty.length) HD.toast(`${dirty.length} tab${dirty.length > 1 ? 's have' : ' has'} unsaved edits that are not included. Save them and sync again to share them.`, 'warn', 6000);
      const res = await window.api.team.sync({ repo: config(r), state, message: message || undefined, pullOnly });
      if (res.conflicts.length) {
        pending.set(r.id, { conflicts: res.conflicts, pullOnly });
        HD.toast('You and a teammate changed the same items. Choose whose version to keep.', 'warn', 7000);
        openTab(r.id);
        return;
      }
      await finish(r, res, pullOnly);
      if (!pullOnly) S.ws.tabs.forEach((t) => { if (t.kind === 'team' && t.refId === r.id && t.ui) t.ui.message = ''; });
    } catch (e) {
      r.last = { ok: false, time: Date.now(), error: HD.cleanErr(e) };
      HD.save();
      HD.toast(`Team sync failed: ${HD.cleanErr(e)}`, 'error', 9000);
    } finally {
      busy.delete(r.id);
      refresh();
    }
  };

  const resolveConflicts = async (r, side) => {
    const p = pending.get(r.id);
    if (!p) return;
    busy.set(r.id, 'Finishing…');
    refresh();
    try {
      if (side === 'cancel') {
        await window.api.team.abort(config(r));
        pending.delete(r.id);
        HD.toast('Sync cancelled. Nothing was changed on your side or the team\'s.', 'info');
        return;
      }
      const res = await window.api.team.resolve({ repo: config(r), side, pullOnly: p.pullOnly });
      await finish(r, res, p.pullOnly);
    } catch (e) {
      HD.toast(`Could not finish: ${HD.cleanErr(e)}`, 'error', 9000);
    } finally {
      busy.delete(r.id);
      refresh();
    }
  };

  const disconnect = async (r) => {
    const linked = S.ws.collections.filter((c) => c.team === r.id).length + S.ws.environments.filter((e) => e.team === r.id).length;
    if (!(await HD.confirm('Disconnect repository', `Stop syncing with "${r.name}"? Your copies of the ${linked} shared item${linked === 1 ? '' : 's'} stay in HttpDash as normal items; nothing is deleted from the repository.`, { danger: true, okLabel: 'Disconnect' }))) return;
    for (const x of [...S.ws.collections, ...S.ws.environments]) if (x.team === r.id) delete x.team;
    repos().splice(repos().indexOf(r), 1);
    pending.delete(r.id);
    await window.api.team.remove(r.id);
    S.ws.tabs.filter((t) => t.kind === 'team' && t.refId === r.id).forEach((t) => HD.closeTab(t.id, true));
    HD.save();
    HD.renderSidebar();
  };

  // ---- Sidebar -----------------------------------------------------------------------------

  HD.renderTeamSidebar = (panel) => {
    panel.appendChild(h('div.side-toolbar', HD.button('', () => HD.newTeamRepo(), { icon: 'plus', ghost: true, title: 'Connect a repository' }), h('span.muted.small.side-hint', 'Share through git')));
    const list = h('div.tree');
    panel.appendChild(list);
    if (!repos().length) {
      list.appendChild(h('div.empty-state.small', h('div', 'No team repositories yet.'),
        h('div.muted', 'Share collections and environments with your team through any git repository: GitHub, GitLab, Bitbucket, Azure DevOps or your own server.'),
        HD.button('Connect a repository', () => HD.newTeamRepo(), { small: true, icon: 'plus' })));
      return;
    }
    const active = HD.currentTab();
    for (const r of repos()) {
      const state = busy.has(r.id) ? 'running' : pending.has(r.id) ? 'fail' : !r.last ? 'idle' : r.last.ok ? 'ok' : 'fail';
      const count = S.ws.collections.filter((c) => c.team === r.id).length + S.ws.environments.filter((e) => e.team === r.id).length;
      list.appendChild(h('div.tree-row.env-row', {
        class: active && active.kind === 'team' && active.refId === r.id ? 'active' : '',
        onclick: () => openTab(r.id),
        oncontextmenu: (e) => HD.menu(e, [
          { label: 'Sync', onClick: () => HD.teamSync(r) },
          { label: 'Get latest', onClick: () => HD.teamSync(r, { pullOnly: true }) },
          { separator: true },
          { label: 'Disconnect', danger: true, onClick: () => disconnect(r) },
        ]),
      }, h(`span.monitor-dot.${state}`, { title: state }), h('span.tree-name', r.name), h('span.muted.small', String(count))));
    }
  };

  // ---- Repository view ---------------------------------------------------------------------

  const ago = (t) => {
    if (!t) return 'never';
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return new Date(t).toLocaleString();
  };

  HD.views.team = (tab, root) => {
    const r = repos().find((x) => x.id === tab.refId);
    if (!r) { root.appendChild(h('div.empty-state', 'This team repository is no longer connected.')); return; }
    HD.variableInfo = () => ({});
    tab.ui = tab.ui || { message: '' };
    const touch = () => { HD.save(); HD.renderSidebar(); };
    const rerender = () => HD.renderActiveTab();
    const working = busy.get(r.id);
    const conflict = pending.get(r.id);
    // Connection settings can't change once items were exchanged without a fresh start.
    const field = (label, key, placeholder, hint) => h('label.field', h('span', label),
      h('input.input', {
        value: r[key] || '', placeholder, spellcheck: 'false', disabled: !!working,
        oninput: (e) => {
          r[key] = e.target.value.trim();
          if (key === 'url' && (!r.name || r.name === 'Team repository' || r.name === repoName(r._prevUrl))) { r.name = repoName(r.url); HD.renderTabBar(); }
          r._prevUrl = r.url;
          r.joined = false; // a different repository, branch or folder starts by taking the team's items
          touch();
        },
      }), hint ? h('span.muted.small', hint) : null);

    const tokenBox = h('div.team-token');
    const renderToken = async () => {
      const info = await window.api.team.tokenInfo(r.id);
      HD.clear(tokenBox);
      const user = h('input.input', { value: info.username || '', placeholder: 'oauth2 (GitLab), x-access-token (GitHub), or your user name', spellcheck: 'false' });
      const tok = h('input.input', { type: 'password', placeholder: info.saved ? 'Saved (enter a new one to replace it)' : 'Personal access token', autocomplete: 'off' });
      tokenBox.append(
        h('label.field', h('span', 'User name'), user),
        h('label.field', h('span', 'Access token'), tok),
        h('div.team-token-actions',
          HD.button(info.saved ? 'Replace token' : 'Save token', async () => {
            if (!tok.value) { HD.toast('Enter the token first.', 'warn'); return; }
            await window.api.team.setToken({ repoId: r.id, token: tok.value, username: user.value.trim() || 'oauth2' });
            HD.toast('Token saved, encrypted on this computer.', 'success');
            renderToken();
          }, { small: true, primary: true }),
          info.saved ? HD.button('Remove token', async () => { await window.api.team.setToken({ repoId: r.id, token: '' }); renderToken(); }, { small: true, ghost: true }) : null,
          h('span.muted.small', 'Stored encrypted with your system keychain, never in the workspace, exports or the repository.')));
    };

    const sharedRow = (item, kind) => {
      const other = item.team && item.team !== r.id ? repos().find((x) => x.id === item.team) : null;
      return h('label.check.team-item',
        h('input', {
          type: 'checkbox', checked: item.team === r.id, disabled: !!other || !!working,
          onchange: async (e) => {
            if (e.target.checked) item.team = r.id;
            else {
              const ok = await HD.confirm('Stop sharing', `Stop sharing ${kind} "${item.name}"? The next sync removes it from the repository for everyone; your copy stays here.`, { danger: true, okLabel: 'Stop sharing' });
              if (!ok) { e.target.checked = true; return; }
              delete item.team;
            }
            touch();
            rerender();
          },
        }),
        HD.icon(kind === 'collection' ? 'layers' : 'globe'), h('span', item.name),
        other ? h('span.muted.small', ` shared through "${other.name}"`) : null);
    };

    const sharedCount = S.ws.collections.filter((c) => c.team === r.id).length + S.ws.environments.filter((e) => e.team === r.id).length;
    const status = r.last && r.last.status;
    const logBox = h('div.team-log', h('div.muted.small', 'Loading…'));

    root.appendChild(h('div.container-view',
      h('div.req-header',
        h('div.breadcrumb', h('span.kind-label', 'Team'), h('input.title-input', { value: r.name, spellcheck: 'false', oninput: (e) => { r.name = e.target.value; touch(); HD.renderTabBar(); } })),
        h('div.req-header-actions',
          HD.button(working === 'Getting latest…' ? working : 'Get latest', () => HD.teamSync(r, { pullOnly: true }), { small: true, icon: 'download', disabled: !!working || !!conflict }),
          HD.button(working === 'Syncing…' ? working : 'Sync', () => HD.teamSync(r, { message: tab.ui.message }), { small: true, primary: true, icon: 'refresh', disabled: !!working || !!conflict }),
          HD.button('', () => disconnect(r), { icon: 'trash', ghost: true, small: true, title: 'Disconnect' }))),
      h('div.panel-pad.team-view',
        gitInfo && !gitInfo.ok ? h('div.export-warning', gitInfo.error) : null,
        conflict ? h('div.team-conflict',
          h('div', h('b', 'You and a teammate changed the same items.'), ' Choose whose version to keep for these files. Changes to other items are merged either way.'),
          h('ul.mono.small', conflict.conflicts.map((f) => h('li', f))),
          h('div.team-conflict-actions',
            HD.button('Keep mine', () => resolveConflicts(r, 'mine'), { primary: true, disabled: !!working }),
            HD.button('Keep the team\'s', () => resolveConflicts(r, 'team'), { disabled: !!working }),
            HD.button('Cancel sync', () => resolveConflicts(r, 'cancel'), { ghost: true, disabled: !!working }))) : null,
        r.last ? h(`div.team-status.${r.last.ok ? 'ok' : 'fail'}`,
          r.last.ok
            ? [h('b', r.last.pullOnly ? 'Got latest ' : 'Synced '), ago(r.last.time), r.last.changes ? h('div.small', `Teammates' changes: ${r.last.changes}`) : null,
              status && status.ahead ? h('div.small.text-warn', `${status.ahead} local commit${status.ahead > 1 ? 's' : ''} not pushed yet — click Sync.`) : null,
              (r.last.problems || []).length ? h('div.small.text-warn', `Skipped unreadable files: ${r.last.problems.join('; ')}`) : null]
            : [h('b', 'Last sync failed '), ago(r.last.time), h('div.small', r.last.error)]) : null,

        h('div.team-grid',
          h('div.team-col',
            h('div.section-title', 'Repository'),
            field('URL', 'url', 'https://github.com/acme/api-workspace.git  or  git@github.com:acme/api-workspace.git'),
            h('div.team-row2',
              field('Branch', 'branch', 'main'),
              field('Folder in the repository', 'subdir', 'optional, e.g. api/httpdash')),
            h('label.field', h('span', 'Sign in with'),
              HD.select([['system', 'This computer\'s git (SSH key or credential manager)'], ['token', 'An access token']], r.auth || 'system', (v) => { r.auth = v; touch(); rerender(); })),
            r.auth === 'token' ? tokenBox : h('div.muted.small', 'Uses whatever git already uses on this computer. If "git clone" works in a terminal, it works here.'),
            h('div.section-title', 'Commit message'),
            h('input.input', { value: tab.ui.message, placeholder: 'Describe your change (optional; a summary is written for you)', oninput: (e) => { tab.ui.message = e.target.value; } }),
            h('div.muted.small.team-help',
              h('div', h('b', 'Sync'), ' saves your shared items, commits them, merges your teammates\' changes and pushes.'),
              h('div', h('b', 'Get latest'), ' brings in teammates\' changes without pushing yours.'),
              h('div', 'Each request is its own file, so people rarely touch the same file. Secret variables and auth-dependency tokens are pushed empty; each person keeps their own values.'))),
          h('div.team-col',
            h('div.section-title', `Shared items (${sharedCount})`),
            h('div.muted.small', 'Checked items are shared through this repository. Teammates\' items appear here after Get latest.'),
            h('div.team-items',
              S.ws.collections.length ? S.ws.collections.map((c) => sharedRow(c, 'collection')) : h('div.muted.small', 'No collections.'),
              S.ws.environments.map((e) => sharedRow(e, 'environment'))),
            h('div.section-title', 'Recent changes'),
            logBox)))));

    if (r.auth === 'token') renderToken();
    if (!gitInfo) window.api.team.gitVersion().then((g) => { gitInfo = g; if (!g.ok) rerender(); });
    (r.url && r.joined ? window.api.team.log(config(r)) : Promise.resolve([])).then((log) => {
      HD.clear(logBox);
      if (!log.length) { logBox.appendChild(h('div.muted.small', r.joined ? 'No commits yet.' : 'Sync to see the repository\'s history.')); return; }
      logBox.append(...log.map((c) => h('div.team-commit',
        h('span.mono.small.muted', c.hash), h('span.team-commit-subject', c.subject),
        h('span.muted.small', `${c.author} · ${ago(Date.parse(c.date))}`))));
    }).catch((e) => { HD.clear(logBox).appendChild(h('div.muted.small', HD.cleanErr(e))); });
  };

  HD.on('team', () => {
    const t = HD.currentTab();
    if (t && t.kind === 'team') HD.renderActiveTab();
    if ((S.ws.ui.sidebarTab || '') === 'team') HD.renderSidebar();
  });
})();
