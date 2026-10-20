'use strict';

/* Auth dependency editor: run another request (e.g. Login) first when the token is missing or expired. */
(() => {
  const { h } = HD;
  const S = HD.S;

  const decodeJwtExpiry = (token) => {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    try {
      const json = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
      return typeof json.exp === 'number' ? json.exp * 1000 : null;
    } catch {
      return null;
    }
  };
  const parseExpiry = (v) => {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    if (Number.isFinite(n)) return n < 1e11 ? n * 1000 : n;
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  };

  // Mirrors tokenState() in src/core/dependency.js.
  HD.tokenState = (cfg, vars, now = Date.now()) => {
    const token = vars[cfg.tokenVar || 'token'];
    if (token === undefined || token === null || String(token).trim() === '') return { valid: false, reason: 'missing', expiresAt: null };
    const skew = (cfg.skewSeconds == null ? 30 : Number(cfg.skewSeconds)) * 1000;
    let expiresAt = cfg.expiryVar ? parseExpiry(vars[cfg.expiryVar]) : null;
    if (expiresAt === null) expiresAt = decodeJwtExpiry(token);
    if (expiresAt !== null && now >= expiresAt - skew) return { valid: false, reason: 'expired', expiresAt };
    return { valid: true, reason: 'valid', expiresAt };
  };

  const mergedVars = (collection) => {
    const s = HD.scopesFor(collection);
    return { ...s.globals, ...s.collection, ...s.environment };
  };

  const relative = (ms) => {
    const abs = Math.abs(ms);
    const unit = abs < 60e3 ? `${Math.round(abs / 1e3)}s` : abs < 3600e3 ? `${Math.round(abs / 60e3)} min` : abs < 864e5 ? `${(abs / 3600e3).toFixed(1)} h` : `${(abs / 864e5).toFixed(1)} days`;
    return ms >= 0 ? `in ${unit}` : `${unit} ago`;
  };

  // Editors currently on screen, re-rendered when variables change (e.g. after a token refresh).
  const live = new Set();
  HD.on('variables', () => {
    for (const ed of live) {
      if (document.body.contains(ed.root)) ed.render(); else live.delete(ed);
    }
  });

  HD.reasonText = (reason) => ({ missing: 'token missing', expired: 'token expired', always: 'runs before every request', 401: 'request returned 401' }[reason] || reason);

  /**
   * holder: the object that owns `.dependency` (request definition, folder or collection)
   * opts: { kind: 'request' | 'folder' | 'collection', collection, parents, selfId, onChange }
   */
  HD.dependencyEditor = (holder, opts) => {
    const root = h('div.dep-editor');
    const isCollection = opts.kind === 'collection';
    holder.dependency = holder.dependency || { mode: isCollection ? 'none' : 'inherit' };
    const dep = holder.dependency;

    const render = () => {
      HD.clear(root);
      root.appendChild(h('div.dep-head',
        h('div', h('div.section-title.flush', 'Auth dependency'),
          h('div.muted.small', 'Run another request first, such as a login, when the token this request needs is missing or expired.'))));

      if (!opts.collection) {
        root.appendChild(h('div.info-box', 'Save this request to a collection to use an auth dependency.'));
        return;
      }
      const modes = isCollection ? [['none', 'None'], ['enabled', 'Run a request first']] : [['inherit', 'Inherit from parent'], ['none', 'None'], ['enabled', 'Run a request first']];
      root.appendChild(h('div.dep-grid',
        h('label.field', h('span', 'Mode'), HD.select(modes, dep.mode || (isCollection ? 'none' : 'inherit'), (v) => { dep.mode = v; changed(); render(); }))));

      if (dep.mode === 'inherit' || (!dep.mode && !isCollection)) {
        const chain = [opts.collection, ...(opts.parents || [])];
        let from = null;
        for (let i = chain.length - 1; i >= 0; i--) {
          const d = chain[i].dependency;
          if (d && d.mode && d.mode !== 'inherit') { from = d.mode === 'enabled' ? { cfg: d, node: chain[i] } : null; break; }
        }
        if (from && from.cfg.requestId === opts.selfId) {
          root.appendChild(h('div.info-box', `This is the request "${from.node.name}" runs first, so it never depends on itself.`));
        } else if (from) {
          const target = HD.find(from.cfg.requestId);
          root.appendChild(h('div.info-box', `Inherited from "${from.node.name}": runs "${target ? target.node.name : '(missing request)'}" first ${from.cfg.when === 'always' ? 'before every request' : `when {{${from.cfg.tokenVar || 'token'}}} is missing or expired`}.`));
          root.appendChild(statusRow(from.cfg));
        } else root.appendChild(h('div.info-box', 'No auth dependency is configured on a parent folder or the collection.'));
        return;
      }
      if (dep.mode !== 'enabled') return;

      // Defaults for a freshly enabled dependency.
      if (dep.tokenVar === undefined) Object.assign(dep, { when: 'expired', tokenVar: 'token', tokenPath: 'access_token', expiresInPath: 'expires_in', expiryVar: 'tokenExpiresAt', scope: 'environment', skewSeconds: 30, retryOn401: true });

      const requests = [];
      HD.walk(opts.collection.items, (it, parents) => {
        if (it.type === 'request' && it.id !== opts.selfId) requests.push([it.id, `${it.request.method} ${[...parents.map((p) => p.name), it.name].join(' / ')}`]);
      });
      const input = (key, label, placeholder, help, type = 'text') => h('label.field', h('span', label),
        h('input.input', { type, value: dep[key] == null ? '' : dep[key], placeholder, spellcheck: 'false', oninput: (e) => { dep[key] = type === 'number' ? (e.target.value === '' ? null : Number(e.target.value)) : e.target.value.trim(); changed(); refreshStatus(); } }),
        help ? h('span.field-help', help) : null);

      if (!requests.length) root.appendChild(h('div.info-box', 'Add the login / token request to this collection first, then select it here.'));
      if (dep.requestId && !requests.some(([id]) => id === dep.requestId)) dep.requestId = '';
      root.appendChild(h('div.dep-grid',
        h('label.field', h('span', 'Run this request first'),
          HD.select([['', '— Select a request —'], ...requests], dep.requestId || '', (v) => { dep.requestId = v; changed(); render(); })),
        h('label.field', h('span', 'When'),
          HD.select([['expired', 'Token is missing or expired'], ['always', 'Before every request']], dep.when || 'expired', (v) => { dep.when = v; changed(); render(); })),
        input('tokenVar', 'Token variable', 'token', 'Use it in Authorization, e.g. Bearer {{token}}.'),
        h('label.field', h('span', 'Store variables in'),
          HD.select([['environment', 'Active environment'], ['collection', 'Collection variables'], ['globals', 'Globals']], dep.scope || 'environment', (v) => { dep.scope = v; changed(); refreshStatus(); })),
        input('tokenPath', 'Save token from response (JSON path)', 'access_token', 'e.g. access_token or data.token. Leave empty if the login request\'s test script sets the variable.'),
        input('expiresInPath', 'Expires-in from response (JSON path, seconds)', 'expires_in', 'Optional. Without it, a JWT\'s "exp" claim is used if present.'),
        input('expiryVar', 'Expiry variable', 'tokenExpiresAt', 'Optional. Holds the expiry time (epoch ms).'),
        input('skewSeconds', 'Refresh early (seconds)', '30', 'Treat the token as expired this long before it actually expires.', 'number')));
      root.appendChild(h('label.check', h('input', { type: 'checkbox', checked: dep.retryOn401 !== false, onchange: (e) => { dep.retryOn401 = e.target.checked; changed(); } }),
        'If the request still returns 401, refresh the token and retry once'));
      const status = h('div');
      root.appendChild(status);
      const refreshStatus = () => HD.clear(status).appendChild(statusRow(dep));
      refreshStatus();
    };

    const statusRow = (cfg) => {
      const st = HD.tokenState(cfg, mergedVars(opts.collection));
      const now = Date.now();
      let text;
      let cls;
      if (st.reason === 'missing') { text = `{{${cfg.tokenVar || 'token'}}} is empty: the request will run first on the next send.`; cls = 'warn'; } else if (st.reason === 'expired') { text = `Token expired${st.expiresAt ? ` ${relative(st.expiresAt - now)} (${new Date(st.expiresAt).toLocaleString()})` : ''}: it will be refreshed on the next send.`; cls = 'warn'; } else if (st.expiresAt) { text = `Token valid, expires ${relative(st.expiresAt - now)} (${new Date(st.expiresAt).toLocaleString()}).`; cls = 'ok'; } else { text = 'Token set, expiry unknown: it is reused until a request returns 401.'; cls = 'ok'; }
      if (cfg.when === 'always') { text = 'The request runs before every send.'; cls = 'ok'; }
      return h(`div.dep-status.${cls}`, h('span', text), h('span.spacer'),
        cfg.requestId ? HD.button('Open request', () => HD.openRequest(cfg.requestId), { small: true, ghost: true }) : null,
        HD.button('Clear token', () => {
          const lists = { environment: HD.activeEnvironment() ? HD.activeEnvironment().values : null, collection: opts.collection.variables, globals: S.ws.globals };
          const list = lists[cfg.scope || 'environment'];
          if (!list) { HD.toast('No active environment', 'warn'); return; }
          for (const key of [cfg.tokenVar || 'token', cfg.expiryVar].filter(Boolean)) {
            const i = list.findIndex((v) => v.key === key);
            if (i !== -1) list.splice(i, 1);
          }
          HD.save();
          HD.emit('variables');
          render();
        }, { small: true, ghost: true }));
    };

    const changed = () => opts.onChange && opts.onChange();
    render();
    live.add({ root, render });
    return root;
  };

  // A compact summary of dependency runs, shown above a response.
  HD.dependencyBanner = (runs) => {
    if (!runs || !runs.length) return null;
    return h('div.dep-banner', runs.map((r) => h('div.dep-run', { class: r.error ? 'failed' : '' },
      HD.icon(r.error ? 'x' : 'check'),
      h('span', 'Ran ', h('b', r.name), ` first (${HD.reasonText(r.reason)})`),
      r.status ? h(`span.${HD.statusClass(r.status)}`, `${r.status} ${r.statusText}`) : null,
      r.time ? h('span.muted', HD.formatMs(r.time)) : null,
      Object.keys(r.stored || {}).length ? h('span.muted', `saved ${Object.keys(r.stored).map((k) => `{{${k}}}`).join(', ')}`) : null,
      r.error ? h('span.text-error', r.error) : null,
      r.id ? h('a.dep-open', { href: '#', onclick: (e) => { e.preventDefault(); HD.openRequest(r.id); } }, 'Open') : null)));
  };
})();
