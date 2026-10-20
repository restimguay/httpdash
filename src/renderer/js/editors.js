'use strict';

/* CodeMirror wrappers, the URL bar editor, variable highlighting and the key/value table. */
(() => {
  const { h } = HD;
  const DYNAMIC_VARS = ['$guid', '$randomUUID', '$timestamp', '$isoTimestamp', '$randomInt', '$randomBoolean', '$randomFirstName', '$randomLastName',
    '$randomFullName', '$randomUserName', '$randomEmail', '$randomWord', '$randomWords', '$randomColor', '$randomHexColor', '$randomIP',
    '$randomPhoneNumber', '$randomAlphaNumeric', '$randomPrice', '$randomUrl', '$randomDomainName', '$randomCity', '$randomCountry', '$randomLoremSentence'];
  HD.DYNAMIC_VARS = DYNAMIC_VARS;

  // Provided by app.js: returns { name: { value, scope } } for the active context.
  HD.variableInfo = () => ({});

  const MODES = {
    json: { name: 'javascript', json: true },
    javascript: 'javascript',
    xml: 'xml',
    html: 'htmlmixed',
    text: null,
    graphql: 'javascript',
    shell: 'shell',
    python: 'python',
    go: 'go',
    php: 'php',
    csharp: 'text/x-csharp',
    java: 'text/x-java',
    powershell: 'powershell',
    http: 'http',
  };

  const varOverlay = () => ({
    token(stream) {
      if (stream.match('{{')) {
        let name = '';
        let ch;
        while ((ch = stream.next()) != null) {
          if (ch === '}' && stream.peek() === '}') { stream.next(); break; }
          name += ch;
        }
        name = name.trim();
        const known = name in HD.variableInfo() || DYNAMIC_VARS.includes(name);
        return known ? 'hd-var' : 'hd-var hd-var-missing';
      }
      while (stream.next() != null && !stream.match('{{', false)) { /* skip */ }
      return null;
    },
  });

  const editorsWithVars = new Set();
  HD.refreshVarHighlights = () => {
    for (const cm of editorsWithVars) {
      if (!document.body.contains(cm.getWrapperElement())) { editorsWithVars.delete(cm); continue; }
      cm.removeOverlay(cm.state.hdOverlay);
      cm.state.hdOverlay = varOverlay();
      cm.addOverlay(cm.state.hdOverlay);
    }
  };

  function enableVariables(cm) {
    cm.state.hdOverlay = varOverlay();
    cm.addOverlay(cm.state.hdOverlay);
    editorsWithVars.add(cm);
    // Autocomplete variable names after typing "{{".
    cm.on('inputRead', (instance, change) => {
      if (change.text.join('') !== '{') return;
      const cur = instance.getCursor();
      const before = instance.getRange({ line: cur.line, ch: Math.max(0, cur.ch - 2) }, cur);
      if (before === '{{') showVarHint(instance);
    });
  }

  function showVarHint(cm) {
    cm.showHint({
      completeSingle: false,
      hint: (inst) => {
        const cur = inst.getCursor();
        const line = inst.getLine(cur.line);
        const start = line.lastIndexOf('{{', cur.ch) + 2;
        const typed = line.slice(start, cur.ch).toLowerCase();
        const info = HD.variableInfo();
        const names = [...Object.keys(info), ...DYNAMIC_VARS].filter((n) => n.toLowerCase().includes(typed));
        return {
          list: names.map((n) => ({
            text: line.slice(cur.ch, cur.ch + 2) === '}}' ? n : `${n}}}`,
            displayText: n,
            render: (el) => {
              el.appendChild(h('span.hint-name', n));
              el.appendChild(h('span.hint-scope', info[n] ? info[n].scope : 'dynamic'));
            },
          })),
          from: CodeMirror.Pos(cur.line, start),
          to: cur,
        };
      },
    });
  }

  /** Creates a CodeMirror editor. */
  HD.editor = (parent, opts = {}) => {
    const cm = CodeMirror(parent, {
      value: opts.value || '',
      mode: (MODES[opts.mode] !== undefined ? MODES[opts.mode] : opts.mode) || 'text/plain',
      readOnly: opts.readOnly ? true : false,
      lineNumbers: opts.lineNumbers !== false,
      lineWrapping: !!opts.wrap,
      matchBrackets: true,
      autoCloseBrackets: !opts.readOnly,
      foldGutter: opts.lineNumbers !== false,
      gutters: opts.lineNumbers !== false ? ['CodeMirror-linenumbers', 'CodeMirror-foldgutter'] : [],
      tabSize: 2,
      indentWithTabs: false,
      placeholder: opts.placeholder || '',
      extraKeys: {
        Tab: (c) => (c.somethingSelected() ? c.indentSelection('add') : c.replaceSelection('  ')),
        'Ctrl-F': 'findPersistent',
        'Cmd-F': 'findPersistent',
        'Ctrl-/': 'toggleComment',
        'Cmd-/': 'toggleComment',
        ...(opts.extraKeys || {}),
      },
    });
    if (opts.variables) enableVariables(cm);
    if (opts.onChange) cm.on('change', (_c, change) => { if (change.origin !== 'setValue') opts.onChange(cm.getValue()); });
    // CodeMirror measures layout lazily; refresh once the editor is visible.
    requestAnimationFrame(() => cm.refresh());
    return cm;
  };

  HD.setEditorMode = (cm, mode) => cm.setOption('mode', (MODES[mode] !== undefined ? MODES[mode] : mode) || 'text/plain');

  /** Single-line editor used for the URL bar. */
  HD.lineEditor = (parent, { value, placeholder, onChange, onEnter, onPaste }) => {
    const cm = CodeMirror(parent, {
      value: value || '',
      mode: 'text/plain',
      lineNumbers: false,
      scrollbarStyle: null,
      placeholder,
      lineWrapping: false,
      extraKeys: { Enter: () => onEnter && onEnter(), 'Shift-Enter': () => onEnter && onEnter(), Tab: false, 'Shift-Tab': false },
    });
    cm.getWrapperElement().classList.add('cm-line-editor');
    enableVariables(cm);
    cm.on('beforeChange', (_c, change) => {
      if (change.origin === 'setValue') return;
      const text = change.text.join('\n');
      if (change.origin === 'paste' && onPaste && onPaste(text)) { change.cancel(); return; }
      if (change.text.length > 1) change.update(change.from, change.to, [change.text.join('').replace(/\r/g, '')]);
    });
    cm.on('change', (_c, change) => { if (change.origin !== 'setValue' && onChange) onChange(cm.getValue()); });
    requestAnimationFrame(() => cm.refresh());
    return cm;
  };

  // Hover tooltip for {{variables}} inside any editor.
  let tip = null;
  document.addEventListener('mouseover', (e) => {
    const t = e.target;
    if (!(t instanceof Element) || !t.classList.contains('cm-hd-var')) {
      if (tip && !(t instanceof Element && tip.contains(t))) { tip.remove(); tip = null; }
      return;
    }
    // A variable may be split over multiple spans; gather adjacent ones.
    let text = t.textContent;
    let prev = t.previousSibling;
    while (prev && prev.classList && prev.classList.contains('cm-hd-var') && !text.startsWith('{{')) { text = prev.textContent + text; prev = prev.previousSibling; }
    let next = t.nextSibling;
    while (next && next.classList && next.classList.contains('cm-hd-var') && !text.endsWith('}}')) { text += next.textContent; next = next.nextSibling; }
    const name = text.replace(/^\{\{|\}\}$/g, '').trim();
    const info = HD.variableInfo()[name];
    if (tip) tip.remove();
    const dynamic = DYNAMIC_VARS.includes(name);
    tip = h('div.var-tip',
      h('div.var-tip-name', name),
      info ? [h('div.var-tip-value', info.secret ? '••••••' : info.value || h('em', '(empty)')), h('div.var-tip-scope', info.scope)]
        : dynamic ? h('div.var-tip-scope', 'Dynamic variable — generated on send')
          : h('div.var-tip-missing', 'Unresolved variable — define it in an environment, the collection or globals.'));
    document.body.appendChild(tip);
    const r = t.getBoundingClientRect();
    tip.style.left = `${Math.min(r.left, window.innerWidth - 320)}px`;
    tip.style.top = `${r.bottom + 6}px`;
  });

  /**
   * Editable key/value table.
   * opts: { rows (array, mutated), onChange, description, formdata, secret, keyPlaceholder, valuePlaceholder, bulk, title }
   */
  HD.kvTable = (opts) => {
    const rows = opts.rows;
    const root = h('div.kv');
    let bulkMode = false;
    const changed = () => opts.onChange && opts.onChange();

    const render = (focus) => {
      HD.clear(root);
      const header = h('div.kv-toolbar',
        opts.title ? h('div.kv-title', opts.title) : h('div'),
        h('div.kv-actions',
          opts.extraActions || null,
          opts.bulk !== false ? HD.button(bulkMode ? 'Key-Value Edit' : 'Bulk Edit', () => { bulkMode = !bulkMode; render(); }, { ghost: true, small: true }) : null));
      root.appendChild(header);
      if (bulkMode) {
        const ta = h('textarea.input.kv-bulk', {
          spellcheck: 'false',
          placeholder: 'key:value — one per line. Prefix a line with // to disable it.',
          oninput: () => {
            const parsed = ta.value.split('\n').filter((l) => l.trim()).map((l) => {
              const disabled = l.trim().startsWith('//');
              const line = disabled ? l.trim().slice(2) : l;
              const i = line.indexOf(':');
              const key = (i === -1 ? line : line.slice(0, i)).trim();
              const value = i === -1 ? '' : line.slice(i + 1).trim();
              const prev = rows.find((r) => r.key === key) || {};
              return { ...prev, key, value, enabled: !disabled };
            });
            rows.splice(0, rows.length, ...parsed);
            changed();
          },
        });
        ta.value = rows.filter((r) => r.type !== 'file').map((r) => `${r.enabled === false ? '//' : ''}${r.key}:${r.value || ''}`).join('\n');
        root.appendChild(ta);
        return;
      }

      const table = h('div.kv-table', { class: [opts.description && 'with-desc', opts.formdata && 'with-type', opts.secret && 'with-secret'].filter(Boolean).join(' ') });
      table.appendChild(h('div.kv-row.kv-head',
        h('div.kv-cell.kv-check'),
        h('div.kv-cell', 'Key'),
        opts.formdata ? h('div.kv-cell.kv-type', 'Type') : null,
        h('div.kv-cell', opts.valueLabel || 'Value'),
        opts.secret ? h('div.kv-cell.kv-type', 'Type') : null,
        opts.description ? h('div.kv-cell', 'Description') : null,
        h('div.kv-cell.kv-del')));

      const makeRow = (row, ghost) => {
        const idx = rows.indexOf(row);
        const materialize = () => {
          if (!ghost) return;
          rows.push(row);
          ghost = false;
        };
        const input = (field, placeholder, type = 'text') => h('input.kv-input', {
          value: row[field] || '',
          placeholder,
          type,
          spellcheck: 'false',
          dataset: { field },
          oninput: (e) => {
            row[field] = e.target.value;
            if (ghost) {
              materialize();
              const pos = e.target.selectionStart;
              render({ index: rows.length - 1, field, pos });
              return;
            }
            changed();
          },
        });

        let valueCell;
        if (opts.formdata && row.type === 'file') {
          const files = [].concat(row.src || []).filter(Boolean);
          valueCell = h('div.kv-cell.kv-file',
            HD.button(files.length ? files.map((f) => f.split(/[\\/]/).pop()).join(', ') : 'Select files', async () => {
              const picked = await window.api.openFile({ multi: true });
              if (!picked.length) return;
              row.src = picked.length === 1 ? picked[0] : picked;
              materialize();
              render();
              changed();
            }, { small: true, icon: 'file', title: files.join('\n') || 'Select files' }));
        } else {
          const secret = opts.secret && row.secret;
          const valInput = input('value', opts.valuePlaceholder || 'Value', secret && !row._reveal ? 'password' : 'text');
          valueCell = h('div.kv-cell.kv-value', valInput,
            secret ? h('button.kv-reveal', { type: 'button', title: 'Show / hide value', onclick: () => { row._reveal = !row._reveal; render(); } }, HD.icon('eye')) : null);
        }

        return h('div.kv-row', { class: [ghost && 'ghost', row.enabled === false && 'disabled'].filter(Boolean).join(' ') },
          h('div.kv-cell.kv-check', ghost ? null : h('input', {
            type: 'checkbox', checked: row.enabled !== false, title: 'Enable / disable',
            onchange: (e) => { row.enabled = e.target.checked; render(); changed(); },
          })),
          h('div.kv-cell', input('key', opts.keyPlaceholder || 'Key')),
          opts.formdata ? h('div.kv-cell.kv-type', HD.select([['text', 'Text'], ['file', 'File']], row.type || 'text', (v) => {
            row.type = v;
            materialize();
            render();
            changed();
          }, 'select-small')) : null,
          valueCell,
          opts.secret ? h('div.kv-cell.kv-type', HD.select([['default', 'default'], ['secret', 'secret']], row.secret ? 'secret' : 'default', (v) => {
            row.secret = v === 'secret';
            materialize();
            render();
            changed();
          }, 'select-small')) : null,
          opts.description ? h('div.kv-cell', input('description', 'Description')) : null,
          h('div.kv-cell.kv-del', ghost ? null : h('button.kv-delete', {
            type: 'button', title: 'Delete',
            onclick: () => { rows.splice(idx, 1); render(); changed(); },
          }, HD.icon('trash'))));
      };

      rows.forEach((r) => table.appendChild(makeRow(r, false)));
      if (!opts.readOnly) table.appendChild(makeRow({ key: '', value: '', enabled: true, ...(opts.formdata ? { type: 'text' } : {}) }, true));
      root.appendChild(table);

      if (focus) {
        const rowEls = table.querySelectorAll('.kv-row:not(.kv-head)');
        const el = rowEls[focus.index] && rowEls[focus.index].querySelector(`[data-field="${focus.field}"]`);
        if (el) { el.focus(); el.setSelectionRange(focus.pos, focus.pos); }
      }
      if (focus) changed();
    };
    render();
    root.refresh = () => render();
    return root;
  };
})();
