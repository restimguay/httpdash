'use strict';

/* Shared DOM helpers, modals, menus and toasts. Everything hangs off the global HD namespace. */
const HD = (window.HD = {});

// h('div.cls#id', { onclick, style: {}, dataset: {} }, ...children)
HD.h = function h(spec, attrs, ...children) {
  const m = /^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i.exec(spec) || [];
  const el = document.createElement(m[1] || 'div');
  (m[2] || '').replace(/([.#])([\w-]+)/g, (_, t, v) => { if (t === '.') el.classList.add(v); else el.id = v; });
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = null;
  }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') String(v).split(/\s+/).filter(Boolean).forEach((c) => el.classList.add(c));
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'readOnly') el[k] = !!v;
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  const add = (c) => {
    if (c == null || c === false) return;
    if (Array.isArray(c)) c.forEach(add);
    else el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  };
  children.forEach(add);
  return el;
};
const h = HD.h;

HD.uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
HD.clone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));
HD.debounce = (fn, ms) => {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
};
HD.clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
HD.formatBytes = (n) => {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(2)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
};
HD.formatMs = (n) => (n == null ? '' : n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(2)} s`);
HD.methodClass = (m) => `method-${String(m || 'GET').toLowerCase()}`;
HD.statusClass = (s) => (!s ? '' : s < 300 ? 'status-ok' : s < 400 ? 'status-redirect' : 'status-error');

HD.icon = (name) => {
  const paths = {
    plus: 'M12 5v14M5 12h14',
    x: 'M6 6l12 12M18 6L6 18',
    folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
    chevron: 'M9 6l6 6-6 6',
    dots: 'M5 12h.01M12 12h.01M19 12h.01',
    eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
    search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
    copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
    trash: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6',
    play: 'M6 4l14 8-14 8z',
    download: 'M12 3v12M7 10l5 5 5-5M5 21h14',
    upload: 'M12 21V9M7 14l5-5 5 5M5 3h14',
    cookie: 'M12 2a10 10 0 1 0 10 10 4 4 0 0 1-5-5 4 4 0 0 1-5-5zM8.5 8.5h.01M16 15.5h.01M12 12h.01M11 17h.01M7 14h.01',
    code: 'M16 18l6-6-6-6M8 6l-6 6 6 6',
    history: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l4 2',
    layers: 'M12 2l10 6-10 6L2 8zM2 16l10 6 10-6M2 12l10 6 10-6',
    globe: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20',
    terminal: 'M4 17l6-6-6-6M12 19h8',
    sidebar: 'M3 3h18v18H3zM9 3v18',
    columns: 'M3 3h18v18H3zM12 3v18',
    rows: 'M3 3h18v18H3zM3 12h18',
    edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4z',
    check: 'M20 6L9 17l-5-5',
    stop: 'M6 6h12v12H6z',
    file: 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6',
    wrap: 'M3 6h18M3 12h15a3 3 0 1 1 0 6h-4M3 18h7M14 15l-3 3 3 3',
    lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4',
    pulse: 'M3 12h4l3-8 4 16 3-8h4',
    shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
    users: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21v-1a6 6 0 0 1 6-6h2a6 6 0 0 1 6 6v1M16 3.5a4 4 0 0 1 0 7.5M22 21v-1a6 6 0 0 0-4-5.6',
    coffee: 'M4 8h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5zM17 9h1.5a2.5 2.5 0 0 1 0 5H17M7 3v2M10.5 3v2M14 3v2M3 21h16',
    refresh: 'M20 11a8 8 0 0 0-14.9-4M4 4v4h4M4 13a8 8 0 0 0 14.9 4M20 20v-4h-4',
  };
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'icon');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', paths[name] || paths.dots);
  svg.appendChild(p);
  return svg;
};

HD.button = (label, onClick, opts = {}) => h('button', {
  class: ['btn', opts.primary && 'btn-primary', opts.danger && 'btn-danger', opts.ghost && 'btn-ghost', opts.small && 'btn-small', opts.icon && !label && 'btn-icon', opts.class].filter(Boolean).join(' '),
  title: opts.title || (typeof label === 'string' ? label : ''),
  type: 'button',
  disabled: opts.disabled,
  onclick: onClick,
}, opts.icon ? HD.icon(opts.icon) : null, label ? h('span', label) : null);

HD.select = (options, value, onChange, cls = '') => {
  const el = h('select', { class: `select ${cls}`, onchange: (e) => onChange(e.target.value) },
    options.map((o) => {
      const [v, l] = Array.isArray(o) ? o : typeof o === 'object' ? [o.value, o.label] : [o, o];
      return h('option', { value: v, selected: String(v) === String(value) }, l);
    }));
  return el;
};

// Segmented tab strip: tabs = [{ id, label, badge }]
HD.tabStrip = (tabs, active, onSelect, cls = '') => h(`div.subtabs${cls ? '.' + cls : ''}`, tabs.map((t) => h('button', {
  class: `subtab ${t.id === active ? 'active' : ''}`, type: 'button', onclick: () => onSelect(t.id),
}, t.label, t.badge ? h('span.badge', String(t.badge)) : null, t.dot ? h('span.dot') : null)));

// ---- Toasts -----------------------------------------------------------------------------------

HD.toast = (message, type = 'info', ms = 3500) => {
  let host = document.getElementById('toasts');
  if (!host) { host = h('div#toasts'); document.body.appendChild(host); }
  const el = h(`div.toast.toast-${type}`, String(message));
  host.appendChild(el);
  setTimeout(() => { el.classList.add('hide'); setTimeout(() => el.remove(), 300); }, ms);
};

// ---- Modals -----------------------------------------------------------------------------------

HD.modal = ({ title, body, buttons = [], width = 520, onClose, className = '' }) => {
  const prevFocus = document.activeElement;
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
    if (onClose) onClose();
    if (prevFocus && prevFocus.focus) prevFocus.focus();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); }
    if (e.key === 'Enter' && !e.shiftKey && e.target.tagName === 'INPUT') {
      const primary = buttons.find((b) => b.primary);
      if (primary) { e.preventDefault(); run(primary); }
    }
  };
  const run = async (b) => {
    if (b.onClick) {
      const r = await b.onClick();
      if (r === false) return;
    }
    close();
  };
  const dialog = h(`div.modal${className ? '.' + className : ''}`, { style: { width: typeof width === 'number' ? `${width}px` : width }, role: 'dialog', 'aria-modal': 'true' },
    h('div.modal-header', h('div.modal-title', title), HD.button('', close, { icon: 'x', ghost: true, title: 'Close' })),
    h('div.modal-body', body),
    buttons.length ? h('div.modal-footer', buttons.map((b) => HD.button(b.label, () => run(b), { primary: b.primary, danger: b.danger }))) : null);
  const overlay = h('div.modal-overlay', { onmousedown: (e) => { if (e.target === overlay) close(); } }, dialog);
  document.body.appendChild(overlay);
  document.addEventListener('keydown', onKey, true);
  setTimeout(() => {
    const f = dialog.querySelector('[autofocus], input, textarea, select');
    if (f) { f.focus(); if (f.select) f.select(); }
  }, 0);
  return { close, el: dialog };
};

HD.prompt = (title, label, value = '', placeholder = '') => new Promise((resolve) => {
  let done = false;
  const input = h('input.input', { value, placeholder, autofocus: true });
  HD.modal({
    title,
    body: h('label.field', h('span', label), input),
    width: 420,
    buttons: [
      { label: 'Cancel', onClick: () => { done = true; resolve(null); } },
      { label: 'OK', primary: true, onClick: () => { done = true; resolve(input.value.trim()); } },
    ],
    onClose: () => { if (!done) resolve(null); },
  });
});

HD.confirm = (title, message, { danger = false, okLabel = 'OK' } = {}) => new Promise((resolve) => {
  let done = false;
  HD.modal({
    title,
    body: h('p.confirm-text', message),
    width: 420,
    buttons: [
      { label: 'Cancel', onClick: () => { done = true; resolve(false); } },
      { label: okLabel, primary: !danger, danger, onClick: () => { done = true; resolve(true); } },
    ],
    onClose: () => { if (!done) resolve(false); },
  });
});

// ---- Context / dropdown menus ---------------------------------------------------------------

HD.menu = (anchorOrEvent, items) => {
  document.querySelectorAll('.ctx-menu').forEach((m) => m.remove());
  const menu = h('div.ctx-menu', { role: 'menu' }, items.filter(Boolean).map((it) => (it.separator
    ? h('div.ctx-sep')
    : h('button.ctx-item', {
      class: [it.danger && 'danger', it.checked && 'checked'].filter(Boolean).join(' '),
      disabled: it.disabled,
      type: 'button',
      onclick: () => { menu.remove(); it.onClick && it.onClick(); },
    }, it.label, it.hint ? h('span.ctx-hint', it.hint) : null))));
  document.body.appendChild(menu);
  let x; let y;
  if (anchorOrEvent instanceof Event && anchorOrEvent.clientX !== undefined && anchorOrEvent.type === 'contextmenu') {
    anchorOrEvent.preventDefault();
    x = anchorOrEvent.clientX; y = anchorOrEvent.clientY;
  } else {
    const el = anchorOrEvent instanceof Event ? anchorOrEvent.currentTarget : anchorOrEvent;
    const r = el.getBoundingClientRect();
    x = r.left; y = r.bottom + 2;
  }
  const mr = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - mr.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - mr.height - 4))}px`;
  const dismiss = (e) => {
    if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('mousedown', dismiss, true); }
  };
  setTimeout(() => document.addEventListener('mousedown', dismiss, true), 0);
  return menu;
};

HD.copy = async (text) => {
  try {
    await navigator.clipboard.writeText(text);
    HD.toast('Copied to clipboard', 'success', 1500);
  } catch {
    HD.toast('Could not access the clipboard', 'error');
  }
};

// Makes a splitter element resize a target by dragging.
HD.splitter = (handle, { axis = 'x', onMove, onEnd }) => {
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const start = axis === 'x' ? e.clientX : e.clientY;
    document.body.classList.add(axis === 'x' ? 'resizing-x' : 'resizing-y');
    const move = (ev) => onMove((axis === 'x' ? ev.clientX : ev.clientY) - start, ev);
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      document.body.classList.remove('resizing-x', 'resizing-y');
      if (onEnd) onEnd();
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
};

// Tiny Handlebars-like renderer for pm.visualizer: {{x}}, {{{x}}}, {{#each}}, {{#if}}/{{else}}, {{@index}}, {{this}}.
HD.renderTemplate = (template, data) => {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const lookup = (path, ctx) => {
    path = path.trim();
    if (path === 'this' || path === '.') return ctx.this;
    if (path.startsWith('@')) return ctx[path];
    const parts = path.replace(/^this\./, '').split('.');
    let v = ctx.this;
    for (const p of parts) v = v == null ? undefined : v[p];
    if (v === undefined && ctx.root && ctx.root !== ctx.this) {
      v = ctx.root;
      for (const p of parts) v = v == null ? undefined : v[p];
    }
    return v;
  };
  const render = (tpl, ctx) => {
    let out = '';
    let i = 0;
    while (i < tpl.length) {
      const open = tpl.indexOf('{{', i);
      if (open === -1) { out += tpl.slice(i); break; }
      out += tpl.slice(i, open);
      const triple = tpl.startsWith('{{{', open);
      const close = tpl.indexOf(triple ? '}}}' : '}}', open);
      if (close === -1) { out += tpl.slice(open); break; }
      const tag = tpl.slice(open + (triple ? 3 : 2), close).trim();
      i = close + (triple ? 3 : 2);
      const block = /^#(each|if|unless|with)\s+(.+)$/.exec(tag);
      if (block) {
        const [, kind, expr] = block;
        // Find the matching close tag, honouring nesting.
        let depth = 1; let j = i; let elseAt = -1;
        const re = /\{\{\s*(#(?:each|if|unless|with)\b|\/(?:each|if|unless|with)\b|else\s*\}\})/g;
        re.lastIndex = i;
        let m;
        while ((m = re.exec(tpl))) {
          if (m[1].startsWith('#')) depth++;
          else if (m[1].startsWith('/')) { depth--; if (depth === 0) { j = m.index; break; } } else if (depth === 1 && elseAt === -1) elseAt = m.index;
        }
        const end = tpl.indexOf('}}', j) + 2;
        const inner = tpl.slice(i, elseAt === -1 ? j : elseAt);
        const elseInner = elseAt === -1 ? '' : tpl.slice(tpl.indexOf('}}', elseAt) + 2, j);
        const val = lookup(expr, ctx);
        if (kind === 'each') {
          const list = Array.isArray(val) ? val.map((v, idx) => [idx, v]) : val && typeof val === 'object' ? Object.entries(val) : [];
          out += list.length ? list.map(([k, v], idx) => render(inner, { this: v, root: ctx.root, '@index': idx, '@key': k, '@first': idx === 0, '@last': idx === list.length - 1 })).join('') : render(elseInner, ctx);
        } else if (kind === 'with') out += render(inner, { ...ctx, this: val });
        else {
          const truthy = Array.isArray(val) ? val.length > 0 : !!val;
          out += render((kind === 'if') === truthy ? inner : elseInner, ctx);
        }
        i = end;
        continue;
      }
      if (tag.startsWith('!')) continue;
      const v = lookup(tag, ctx);
      out += triple ? String(v == null ? '' : v) : esc(typeof v === 'object' && v !== null ? JSON.stringify(v) : v);
    }
    return out;
  };
  return render(String(template), { this: data, root: data });
};
