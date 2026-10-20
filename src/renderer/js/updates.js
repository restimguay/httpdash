'use strict';

/* App updates from GitHub releases, the header Update button (app + team changes), and Buy me a coffee. */
(() => {
  const { h } = HD;
  HD.appUpdate = null;

  const pct = (p) => (p && p.total ? `${Math.round((p.received / p.total) * 100)}%` : '');
  const appItem = () => {
    const u = HD.appUpdate;
    if (!u || !u.release) return null;
    const v = u.release.version;
    if (u.status === 'ready') return { label: `Restart to update to ${v}`, onClick: () => install(), primary: true };
    if (u.status === 'downloading') return { label: `Downloading HttpDash ${v}… ${pct(u.progress)}`, onClick: () => HD.showAppUpdate() };
    if (u.status === 'available' || (u.status === 'error' && u.release)) return { label: `HttpDash ${v} is available`, onClick: () => HD.showAppUpdate() };
    return null;
  };
  const teamItems = () => (HD.teamIncoming ? HD.teamIncoming() : []).map((r) => ({
    label: `Team "${r.name}": ${r.incoming.behind} new change${r.incoming.behind > 1 ? 's' : ''}`,
    onClick: () => HD.teamSync(r, { pullOnly: true }),
  }));

  HD.renderUpdateButton = () => {
    const host = document.getElementById('update-button');
    if (!host) return;
    HD.clear(host);
    const items = [appItem(), ...teamItems()].filter(Boolean);
    if (!items.length) return;
    const ready = HD.appUpdate && HD.appUpdate.status === 'ready';
    const label = items.length === 1 && ready ? 'Restart to update' : 'Update';
    host.append(HD.button(label, (e) => {
      if (items.length === 1) items[0].onClick();
      else HD.menu(e, items.map((it) => ({ label: it.label, onClick: it.onClick })));
    }, { small: true, primary: true, icon: 'download', title: items.map((i) => i.label).join('\n'), class: 'update-btn' }),
    ...(items.length > 1 ? [h('span.update-count', String(items.length))] : []));
  };

  const install = async () => {
    if (HD.S.ws.tabs.some((t) => t.dirty) && !(await HD.confirm('Restart to update', 'Some tabs have unsaved changes. They are kept as unsaved drafts and reopen after the update. Restart now?', { okLabel: 'Restart' }))) return;
    await HD.saveNow();
    const ok = await window.api.updates.install();
    if (!ok) HD.toast('The update could not be installed automatically. Opening the download page.', 'warn', 6000);
    if (!ok) window.api.updates.openPage();
  };

  // Release details with the actions this installation supports.
  HD.showAppUpdate = () => {
    const u = HD.appUpdate;
    if (!u || !u.release) return;
    const r = u.release;
    const status = h('div.update-status');
    const renderStatus = () => {
      const s = HD.appUpdate;
      HD.clear(status);
      if (s.status === 'downloading') status.append(h('div.update-progress', h('div.update-progress-bar', { style: { width: pct(s.progress) || '5%' } })), h('div.muted.small', `Downloading… ${pct(s.progress)}`));
      else if (s.status === 'ready') status.append(h('div.text-ok', 'Downloaded. Restart HttpDash to finish updating.'));
      else if (s.status === 'error') status.append(h('div.text-err.small', s.error));
    };
    renderStatus();
    const onChange = () => { if (document.body.contains(status)) renderStatus(); };
    HD.on('app-update', onChange);
    const buttons = [{ label: 'Skip this version', onClick: async () => { await window.api.updates.skip(r.version); } }, { label: 'Later' }];
    if (u.canInstall) {
      buttons.push(u.status === 'ready'
        ? { label: 'Restart now', primary: true, onClick: () => { install(); } }
        : { label: 'Download and install', primary: true, onClick: async () => {
          try {
            await window.api.updates.download();
            await install();
          } catch (e) { /* shown in the dialog */ }
          return false;
        } });
    } else buttons.push({ label: 'Open download page', primary: true, onClick: () => { window.api.updates.openPage(); } });
    HD.modal({
      title: `HttpDash ${r.version} is available`,
      width: 600,
      onClose: () => HD.off('app-update', onChange),
      body: h('div.update-dialog',
        h('div.muted', `You have ${u.current}. ${r.publishedAt ? `Released ${new Date(r.publishedAt).toLocaleDateString()}.` : ''}`),
        r.notes ? h('pre.update-notes', r.notes) : null,
        !u.canInstall ? h('div.muted.small', 'This copy can\'t update itself (portable version, or the app isn\'t in a writable folder such as Applications). Download the new version and replace this one.') : null,
        status),
      buttons,
    });
  };

  HD.renderUpdateSettings = async (panel) => {
    const s = HD.appUpdate || (HD.appUpdate = await window.api.updates.status());
    const line = h('div.setting-help');
    const describe = () => {
      const u = HD.appUpdate;
      const when = u.lastCheck ? `Last checked ${new Date(u.lastCheck).toLocaleString()}.` : 'Not checked yet.';
      const text = {
        checking: 'Checking…',
        current: `You have the latest version (${u.current}).`,
        available: u.release ? `Version ${u.release.version} is available.` : '',
        downloading: u.release ? `Downloading ${u.release.version}… ${pct(u.progress)}` : '',
        ready: u.release ? `Version ${u.release.version} is ready; it installs when you restart.` : '',
        error: `Could not check: ${u.error}`,
        idle: '',
      }[u.status] || '';
      line.textContent = `${text} ${when}`.trim();
    };
    describe();
    const onChange = () => { if (document.body.contains(line)) describe(); };
    HD.on('app-update', onChange);
    panel.append(
      h('div.setting-row',
        h('div', h('div.setting-label', 'App updates'), h('div.setting-help', 'New versions come from the HttpDash releases on GitHub.')),
        HD.select([['auto', 'Install automatically'], ['notify', 'Show Update in the header'], ['off', 'Don\'t check']], s.mode, async (v) => { HD.appUpdate = await window.api.updates.setConfig({ mode: v }); HD.renderUpdateButton(); })),
      h('div.setting-row',
        h('div', h('div.setting-label', 'Include pre-releases'), h('div.setting-help', 'Get beta versions before they are released to everyone.')),
        h('label.switch', h('input', { type: 'checkbox', checked: !!s.includePrereleases, onchange: async (e) => { HD.appUpdate = await window.api.updates.setConfig({ includePrereleases: e.target.checked }); } }), h('span.slider'))),
      h('div.setting-row',
        h('div', h('div.setting-label', `Version ${s.current}`), line),
        HD.button('Check now', async () => {
          const u = await window.api.updates.check();
          if (u.status === 'current') HD.toast('HttpDash is up to date.', 'success');
          else if (u.status === 'available' || u.status === 'ready') HD.showAppUpdate();
          else if (u.status === 'error') HD.toast(`Could not check for updates: ${u.error}`, 'error', 6000);
        }, { small: true })),
      h('div.setting-row',
        h('div', h('div.setting-label', 'Team repositories'), h('div.setting-help', 'Each team repository has its own setting in its Team tab: show Update in the header, get changes automatically, or do nothing.')),
        HD.button('Open Team', () => HD.command('team'), { small: true, ghost: true })));
  };

  HD.checkForUpdates = async () => {
    const u = await window.api.updates.check();
    if (u.status === 'current') HD.toast(`HttpDash ${u.current} is the latest version.`, 'success');
    else if (u.status === 'error') HD.toast(`Could not check for updates: ${u.error}`, 'error', 6000);
    else if (u.release) HD.showAppUpdate();
    HD.checkTeamUpdates();
  };

  HD.initUpdates = async () => {
    window.api.updates.onStatus((state) => {
      const before = HD.appUpdate;
      HD.appUpdate = state;
      HD.renderUpdateButton();
      HD.emit('app-update');
      if (state.status === 'ready' && (!before || before.status !== 'ready') && state.mode === 'auto') {
        HD.toast(`HttpDash ${state.release.version} is ready. It installs the next time you quit, or now with "Restart to update".`, 'info', 8000);
      }
    });
    HD.appUpdate = await window.api.updates.status();
    HD.renderUpdateButton();
    const info = await window.api.appInfo();
    HD.coffeeUrl = info.coffeeUrl || '';
    HD.renderStatusbar();
  };
})();
