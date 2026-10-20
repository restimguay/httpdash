'use strict';

/* App lock: LDAP sign-in screen, "Lock now", idle auto-lock and the Security settings panel. */
(() => {
  const { h } = HD;
  const S = HD.S;
  HD.lockState = null;

  // ---- Lock screen --------------------------------------------------------------------------

  HD.showLockScreen = (status) => {
    document.body.classList.add('is-locked');
    let mode = 'ldap';
    const card = h('div.lock-card');
    const screen = h('div.lock-screen', card);
    document.body.appendChild(screen);
    const render = (error) => {
      HD.clear(card);
      const msg = h('div.lock-error', error || '');
      card.append(h('div.lock-brand', h('span.brand-mark', 'H'), h('span', 'HttpDash')),
        h('div.lock-title', 'HttpDash is locked'));
      if (mode === 'ldap') {
        const user = h('input.input', { value: status.lastUser || (status.lastTest && status.lastTest.user) || '', placeholder: 'Username', autocomplete: 'username', spellcheck: 'false' });
        const pass = h('input.input', { type: 'password', placeholder: 'Password', autocomplete: 'current-password' });
        const btn = h('button.btn.btn-primary.lock-btn', { type: 'submit' }, 'Unlock');
        const form = h('form.lock-form', {
          onsubmit: async (e) => {
            e.preventDefault();
            btn.disabled = true;
            btn.textContent = 'Signing in…';
            try {
              await window.api.lock.unlock({ username: user.value, password: pass.value });
              location.reload();
            } catch (err) {
              pass.value = '';
              render(HD.cleanErr(err));
            }
          },
        }, h('div.muted.small', 'Sign in with your directory (LDAP) account.'), h('label.field', h('span', 'Username'), user), h('label.field', h('span', 'Password'), pass), msg, btn);
        card.append(form, h('a.lock-link', { href: '#', onclick: (e) => { e.preventDefault(); mode = 'recovery'; render(); } }, 'LDAP server unavailable? Use a recovery code'));
        setTimeout(() => (user.value ? pass : user).focus(), 0);
      } else {
        const code = h('input.input.mono', { placeholder: 'XXXXXXXX-XXXXXXXX-XXXXXXXX-XXXXXXXX', spellcheck: 'false' });
        const form = h('form.lock-form', {
          onsubmit: async (e) => {
            e.preventDefault();
            try {
              await window.api.lock.recover(code.value);
              try { sessionStorage.setItem('hd-recovered', '1'); } catch { /* storage unavailable */ }
              location.reload();
            } catch (err) {
              render(HD.cleanErr(err));
            }
          },
        }, h('div.muted.small', 'The recovery code unlocks HttpDash and turns the lock off, so you can fix the LDAP settings and turn it on again.'),
        h('label.field', h('span', 'Recovery code'), code), msg, h('button.btn.btn-primary.lock-btn', { type: 'submit' }, 'Unlock with recovery code'));
        card.append(form, h('a.lock-link', { href: '#', onclick: (e) => { e.preventDefault(); mode = 'ldap'; render(); } }, 'Back to sign-in'));
        setTimeout(() => code.focus(), 0);
      }
      if (status.blockedForMs && !error) render(`Too many failed attempts. Try again in ${Math.ceil(status.blockedForMs / 1000)} seconds.`);
    };
    render();
  };

  // Saves everything, locks, and reloads so no workspace data stays in this window's memory.
  HD.lockNow = async () => {
    if (!HD.lockState || !HD.lockState.enabled) {
      HD.toast('Turn the lock on in Settings → Security first.', 'warn');
      HD.showSettings('security');
      return;
    }
    try {
      await HD.saveNow();
      await window.api.lock.lock();
      location.reload();
    } catch (e) {
      HD.toast(`Could not lock: ${HD.cleanErr(e)}`, 'error');
    }
  };

  // Locks automatically after the configured minutes without keyboard or mouse activity.
  let lastActivity = Date.now();
  let idleTimer = null;
  for (const evt of ['mousemove', 'mousedown', 'keydown', 'wheel']) document.addEventListener(evt, () => { lastActivity = Date.now(); }, { passive: true });
  HD.startIdleLock = () => {
    clearInterval(idleTimer);
    const minutes = HD.lockState && HD.lockState.enabled ? Number(HD.lockState.idleMinutes) || 0 : 0;
    if (!minutes) return;
    lastActivity = Date.now();
    idleTimer = setInterval(() => {
      if (Date.now() - lastActivity > minutes * 60000 && !S.sending.size) HD.lockNow();
    }, 15000);
  };

  // ---- Settings → Security ----------------------------------------------------------------

  HD.renderSecuritySettings = async (panel) => {
    const [status, cfg] = await Promise.all([window.api.lock.status(), window.api.lock.getConfig()]);
    HD.lockState = status;
    HD.clear(panel);
    const rerender = () => HD.renderSecuritySettings(panel);

    if (status.enabled) {
      const users = h('input.input', { value: status.allowedUsers.join(', '), placeholder: 'Anyone who can sign in' });
      const idle = h('input.input.input-small', { type: 'number', min: 0, value: status.idleMinutes || 0 });
      panel.append(
        h('div.lock-on-banner', HD.icon('check'), h('div', h('b', 'The lock is on.'), h('div.small', `HttpDash asks for an LDAP sign-in at every start and when you lock it (${navigator.platform.startsWith('Mac') ? 'Cmd' : 'Ctrl'}+L).`))),
        h('div.setting-row', h('div', h('div.setting-label', 'LDAP server'), h('div.setting-help.mono', `${cfg.url} · ${cfg.mode === 'search' ? `search in ${cfg.searchBase}` : cfg.userDnTemplate}${cfg.groupDn ? ` · group ${cfg.groupDn}` : ''}`))),
        h('label.field', h('span', 'Users allowed to unlock (comma-separated; empty = anyone who can sign in)'), users),
        h('div.setting-row', h('div', h('div.setting-label', 'Lock after inactivity (minutes)'), h('div.setting-help', '0 = only when you lock it or restart.')), idle),
        h('div.button-row',
          HD.button('Save', async () => {
            try {
              HD.lockState = await window.api.lock.update({ allowedUsers: users.value, idleMinutes: idle.value });
              HD.startIdleLock();
              HD.toast('Lock settings saved', 'success');
            } catch (e) { HD.toast(HD.cleanErr(e), 'error'); }
          }, { small: true }),
          HD.button('Lock now', () => HD.lockNow(), { small: true, primary: true }),
          h('span.spacer'),
          HD.button('Turn lock off…', async () => {
            const creds = await askCredentials('Turn the lock off', 'Sign in to confirm.', status.lastUser);
            if (!creds) return;
            try {
              HD.lockState = await window.api.lock.disable(creds);
              HD.toast('The lock is off', 'success');
              renderTopbarLock();
              rerender();
            } catch (e) { HD.toast(HD.cleanErr(e), 'error', 6000); }
          }, { small: true, danger: true })));
      return;
    }

    // ---- LDAP settings form (lock off) ----
    const f = { ...cfg, bindPassword: '' };
    const input = (key, label, placeholder, help, type = 'text') => h('label.field', h('span', label),
      h('input.input', { type, value: f[key] == null ? '' : f[key], placeholder, spellcheck: 'false', oninput: (e) => { f[key] = type === 'number' ? Number(e.target.value) : e.target.value; } }),
      help ? h('span.field-help', help) : null);
    const check = (key, label) => h('label.check', h('input', { type: 'checkbox', checked: !!f[key], onchange: (e) => { f[key] = e.target.checked; } }), label);
    const modeFields = h('div');
    const renderMode = () => {
      HD.clear(modeFields);
      if ((f.mode || 'template') === 'template') {
        modeFields.append(input('userDnTemplate', 'User DN template', 'uid={username},ou=people,dc=example,dc=com', '{username} is replaced by what the user types.'));
      } else {
        modeFields.append(
          input('searchBase', 'Search base', 'ou=people,dc=example,dc=com'),
          input('searchFilter', 'Search filter', '(uid={username})', 'e.g. (&(objectClass=inetOrgPerson)(uid={username})) or (mail={username})'),
          input('bindDn', 'Service account DN (empty = anonymous search)', 'cn=readonly,dc=example,dc=com'),
          h('label.field', h('span', 'Service account password'),
            h('input.input', { type: 'password', placeholder: cfg.bindPasswordSet ? '•••••••• (stored, leave empty to keep)' : '', oninput: (e) => { f.bindPassword = e.target.value; } })));
      }
    };
    renderMode();

    const saveConfig = async () => {
      const payload = { ...f };
      delete payload.bindPasswordSet;
      return window.api.lock.setConfig(payload);
    };

    const testUser = h('input.input', { value: (status.lastTest && status.lastTest.user) || '', placeholder: 'Username', spellcheck: 'false' });
    const testPass = h('input.input', { type: 'password', placeholder: 'Password' });
    const testResult = h('div');
    const showTest = (lt) => {
      HD.clear(testResult);
      if (!lt) return;
      testResult.appendChild(lt.ok
        ? h('div.dep-status.ok', `Signed in as ${lt.user}${lt.dn ? ` (${lt.dn})` : ''}. ${lt.current === false ? 'Settings changed since; test again.' : 'You can turn the lock on below.'}`)
        : h('div.dep-status.warn', `Sign-in failed: ${lt.error}`));
    };
    showTest(status.lastTest);

    const allowed = h('input.input', { value: status.allowedUsers.join(', ') || (status.lastTest && status.lastTest.ok ? status.lastTest.user : ''), placeholder: 'Anyone who can sign in' });
    const idle = h('input.input.input-small', { type: 'number', min: 0, value: status.idleMinutes || 0 });
    const enableBtn = HD.button('Turn lock on…', async () => {
      try {
        await saveConfig();
        const res = await window.api.lock.enable({ allowedUsers: allowed.value, idleMinutes: idle.value });
        HD.lockState = res.status;
        await showRecoveryCode(res.recoveryCode);
        renderTopbarLock();
        HD.startIdleLock();
        rerender();
      } catch (e) { HD.toast(HD.cleanErr(e), 'error', 6000); }
    }, { primary: true, small: true, disabled: !status.testedOk });
    const enableHint = h('span.muted.small', { style: { display: status.testedOk ? 'none' : '' } }, 'Available after a successful test.');

    panel.append(
      h('div.muted.small.security-intro', 'Require an LDAP sign-in to open HttpDash. Set up the directory, test a sign-in, then turn the lock on.'),
      h('div.section-title', '1. LDAP server'),
      input('url', 'Server URL', 'ldaps://ldap.example.com:636', 'ldap:// (port 389) or ldaps:// (port 636).'),
      h('div.check-row', check('startTLS', 'Use StartTLS (ldap:// only)'), check('verifyCertificate', 'Verify certificate')),
      h('label.field', h('span', 'How to find the user'), HD.select([['template', 'Build the DN from a template'], ['search', 'Search the directory, then sign in']], f.mode || 'template', (v) => { f.mode = v; renderMode(); })),
      modeFields,
      input('groupDn', 'Required group (optional)', 'cn=api-admins,ou=groups,dc=example,dc=com', 'Checks member, uniqueMember and memberUid.'),
      h('div.section-title', '2. Test a sign-in'),
      h('div.field-row', h('label.field', h('span', 'Username'), testUser), h('label.field', h('span', 'Password'), testPass)),
      h('div.button-row', HD.button('Test sign-in', async () => {
        HD.clear(testResult).appendChild(h('div.runner-progress', h('div.spinner.small'), 'Signing in…'));
        try {
          await saveConfig();
          const r = await window.api.lock.test({ username: testUser.value, password: testPass.value });
          testPass.value = '';
          showTest({ ...r, user: testUser.value.trim(), current: true });
          if (r.ok && !allowed.value) allowed.value = testUser.value.trim();
          const st = await window.api.lock.status();
          enableBtn.disabled = !st.testedOk;
          enableHint.style.display = st.testedOk ? 'none' : '';
        } catch (e) { HD.clear(testResult).appendChild(h('div.dep-status.warn', HD.cleanErr(e))); }
      }, { small: true })),
      testResult,
      h('div.section-title', '3. Turn the lock on'),
      h('label.field', h('span', 'Users allowed to unlock (comma-separated; empty = anyone who can sign in)'), allowed),
      h('div.setting-row', h('div', h('div.setting-label', 'Lock after inactivity (minutes)'), h('div.setting-help', '0 = only when you lock it or restart.')), idle),
      h('div.button-row', enableBtn, enableHint),
      h('div.muted.small.security-note', 'While locked, HttpDash shows no data until a sign-in succeeds. Your data files on disk are not encrypted; the lock protects the app, not files read by other programs.'));
  };

  const askCredentials = (title, message, lastUser) => new Promise((resolve) => {
    let done = false;
    const user = h('input.input', { value: lastUser || '', placeholder: 'Username', spellcheck: 'false' });
    const pass = h('input.input', { type: 'password', placeholder: 'Password' });
    HD.modal({
      title, width: 400,
      body: h('div', h('p.confirm-text', message), h('label.field', h('span', 'Username'), user), h('label.field', h('span', 'Password'), pass)),
      buttons: [
        { label: 'Cancel', onClick: () => { done = true; resolve(null); } },
        { label: 'Confirm', primary: true, onClick: () => { done = true; resolve({ username: user.value, password: pass.value }); } },
      ],
      onClose: () => { if (!done) resolve(null); },
    });
  });

  const showRecoveryCode = (code) => new Promise((resolve) => {
    const saved = h('input', { type: 'checkbox' });
    HD.modal({
      title: 'Save your recovery code', width: 480,
      body: h('div',
        h('p.confirm-text', 'If the LDAP server is ever unreachable, this code unlocks HttpDash (and turns the lock off). It is shown only once.'),
        h('div.recovery-code', code),
        h('div.button-row', HD.button('Copy', () => HD.copy(code), { small: true, icon: 'copy' })),
        h('label.check', saved, 'I have saved the recovery code somewhere safe')),
      buttons: [{
        label: 'Done', primary: true,
        onClick: () => {
          if (!saved.checked) { HD.toast('Tick the box once you have saved the code.', 'warn'); return false; }
          resolve();
          return true;
        },
      }],
      onClose: () => resolve(),
    });
  });

  // Top bar lock button, shown while the lock is on.
  const renderTopbarLock = () => {
    const host = document.getElementById('lock-button');
    if (!host) return;
    HD.clear(host);
    if (HD.lockState && HD.lockState.enabled) host.appendChild(HD.button('', () => HD.lockNow(), { icon: 'lock', ghost: true, title: 'Lock HttpDash (Ctrl/Cmd+L)' }));
  };
  HD.renderTopbarLock = renderTopbarLock;
})();
