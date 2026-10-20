'use strict';

/* Response viewer: body (pretty/raw/preview/visualize), headers, cookies, tests and timeline. */
(() => {
  const { h } = HD;

  const detectLang = (contentType, text) => {
    const ct = (contentType || '').toLowerCase();
    if (/json/.test(ct)) return 'json';
    if (/html/.test(ct)) return 'html';
    if (/xml/.test(ct)) return 'xml';
    if (/javascript/.test(ct)) return 'javascript';
    const t = (text || '').trimStart();
    if (t.startsWith('{') || t.startsWith('[')) return 'json';
    if (/^<!doctype html|^<html/i.test(t)) return 'html';
    if (t.startsWith('<')) return 'xml';
    return 'text';
  };
  HD.detectLang = detectLang;

  const VOID_TAGS = /^<(area|base|br|col|embed|hr|img|input|link|meta|source|track|wbr)\b/i;
  HD.formatXml = (xml) => {
    const tokens = (xml.match(/<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<[^>]+>|[^<]+/g) || []).map((t) => t.trim()).filter(Boolean);
    const isClose = (t) => /^<\//.test(t);
    const isOpen = (t) => /^<[^!?/]/.test(t) && !/\/>$/.test(t) && !VOID_TAGS.test(t);
    const isText = (t) => !t.startsWith('<');
    const out = [];
    let depth = 0;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (isClose(t)) {
        depth = Math.max(0, depth - 1);
        out.push('  '.repeat(depth) + t);
      } else if (isOpen(t)) {
        // Keep <a>text</a> on one line.
        if (tokens[i + 1] && isText(tokens[i + 1]) && tokens[i + 2] && isClose(tokens[i + 2])) {
          out.push('  '.repeat(depth) + t + tokens[i + 1] + tokens[i + 2]);
          i += 2;
        } else if (tokens[i + 1] && isClose(tokens[i + 1])) {
          out.push('  '.repeat(depth) + t + tokens[i + 1]);
          i += 1;
        } else {
          out.push('  '.repeat(depth) + t);
          depth++;
        }
      } else out.push('  '.repeat(depth) + t);
    }
    return out.join('\n');
  };

  const pretty = (text, lang) => {
    if (lang === 'json') {
      try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
    }
    if (lang === 'xml' || lang === 'html') {
      try { return text.length < 2e6 ? HD.formatXml(text) : text; } catch { return text; }
    }
    return text;
  };

  const parseSetCookie = (v) => {
    const [nv, ...attrs] = String(v).split(';');
    const i = nv.indexOf('=');
    const c = { name: nv.slice(0, i).trim(), value: nv.slice(i + 1).trim(), domain: '', path: '', expires: '', httpOnly: false, secure: false };
    for (const a of attrs) {
      const j = a.indexOf('=');
      const k = (j === -1 ? a : a.slice(0, j)).trim().toLowerCase();
      const val = j === -1 ? '' : a.slice(j + 1).trim();
      if (k === 'domain') c.domain = val;
      else if (k === 'path') c.path = val;
      else if (k === 'expires') c.expires = val;
      else if (k === 'max-age') c.expires = `in ${val}s`;
      else if (k === 'httponly') c.httpOnly = true;
      else if (k === 'secure') c.secure = true;
    }
    return c;
  };

  const statusLine = (res, actions) => {
    const t = res.timings || {};
    const timingRows = [
      ['DNS lookup', t.dns], ['TCP connect', t.connect != null ? t.connect - (t.dns || 0) : null],
      ['TLS handshake', t.tls != null ? t.tls - (t.connect || 0) : null],
      ['Time to first byte', t.firstByte != null ? t.firstByte - (t.tls || t.connect || 0) : null],
      ['Download', t.download], ['Total', t.total],
    ].filter(([, v]) => v != null);
    const timeTip = h('div.popover', h('div.popover-title', 'Response time'), timingRows.map(([l, v]) => h('div.kvline', h('span', l), h('span', HD.formatMs(v)))));
    const sizeTip = h('div.popover', h('div.popover-title', 'Response size'),
      h('div.kvline', h('span', 'Headers'), h('span', HD.formatBytes(res.headersSize))),
      h('div.kvline', h('span', 'Body'), h('span', HD.formatBytes(res.bodySize))),
      h('div.kvline', h('span', 'Transferred'), h('span', HD.formatBytes(res.size))));
    return h('div.res-meta',
      h(`span.res-status.${HD.statusClass(res.status)}`, `${res.status} ${res.statusText || ''}`),
      h('span.res-stat.has-popover', h('span.muted', 'Time '), h('b', HD.formatMs(res.time)), timeTip),
      h('span.res-stat.has-popover', h('span.muted', 'Size '), h('b', HD.formatBytes(res.size)), sizeTip),
      res.redirects && res.redirects.length ? h('span.res-stat.muted', `${res.redirects.length} redirect${res.redirects.length > 1 ? 's' : ''}`) : null,
      h('span.spacer'),
      actions);
  };

  /**
   * Renders the response area.
   * result: the object returned by the main process (response, error, tests, sentRequest, visualizer)
   * ui: persisted per-tab view state ({ resTab, bodyView, wrap })
   */
  HD.renderResponse = (root, result, ui, opts = {}) => {
    HD.clear(root);
    const res = result.response;
    const tests = result.tests || [];
    const passed = tests.filter((t) => t.passed && !t.skipped).length;
    const failed = tests.filter((t) => !t.passed).length;
    const headerCount = res ? res.headers.length : 0;
    const setCookies = res ? res.headers.filter(([k]) => k.toLowerCase() === 'set-cookie').map(([, v]) => parseSetCookie(v)) : [];

    const tabs = [
      { id: 'body', label: 'Body' },
      { id: 'cookies', label: 'Cookies', badge: setCookies.length || null },
      { id: 'headers', label: 'Headers', badge: headerCount || null },
      { id: 'tests', label: 'Test Results', badge: tests.length ? `${passed}/${tests.length}` : null, dot: failed > 0 },
      { id: 'timeline', label: 'Timeline' },
    ];
    let active = ui.resTab || 'body';
    if (!res && active !== 'tests' && active !== 'timeline') active = 'body';

    const actions = h('div.res-actions',
      res ? HD.button('', (e) => HD.menu(e, [
        { label: 'Save response to file', onClick: () => window.api.saveResponse({ name: suggestName(res), bodyText: res.bodyText, bodyBase64: res.bodyBase64 }) },
        opts.onSaveExample ? { label: 'Save as example', onClick: opts.onSaveExample } : null,
        { label: 'Copy body', onClick: () => HD.copy(res.bodyText || '') },
        { separator: true },
        { label: 'Clear response', onClick: opts.onClear },
      ]), { icon: 'dots', ghost: true, small: true, title: 'More actions' }) : null);

    const content = h('div.res-content');
    const strip = HD.tabStrip(tabs.filter((t) => res || t.id === 'tests' || t.id === 'timeline' || t.id === 'body'), active, (id) => { ui.resTab = id; HD.save(); HD.renderResponse(root, result, ui, opts); });
    root.appendChild(h('div.res-header', strip, res ? statusLine(res, actions) : null));
    const banner = HD.dependencyBanner && HD.dependencyBanner(result.dependencyRuns);
    if (banner) root.appendChild(banner);
    root.appendChild(content);

    if (active === 'body') {
      if (result.error) {
        content.appendChild(h('div.res-error',
          h('div.res-error-title', 'Could not send request'),
          h('pre.res-error-msg', result.error),
          h('div.muted', 'Check the URL, your network, proxy and SSL settings. Script output is in the Console.')));
      } else if (res) renderBody(content, res, result, ui, () => HD.renderResponse(root, result, ui, opts));
    } else if (active === 'headers') {
      content.appendChild(h('div.table-wrap', h('table.data-table',
        h('thead', h('tr', h('th', 'Key'), h('th', 'Value'))),
        h('tbody', res.headers.map(([k, v]) => h('tr', h('td.mono', k), h('td.mono.break', v)))))));
    } else if (active === 'cookies') {
      content.appendChild(setCookies.length ? h('div.table-wrap', h('table.data-table',
        h('thead', h('tr', ['Name', 'Value', 'Domain', 'Path', 'Expires', 'HttpOnly', 'Secure'].map((x) => h('th', x)))),
        h('tbody', setCookies.map((c) => h('tr', h('td.mono', c.name), h('td.mono.break', c.value), h('td', c.domain), h('td', c.path), h('td', c.expires), h('td', c.httpOnly ? 'true' : 'false'), h('td', c.secure ? 'true' : 'false'))))))
        : h('div.empty-state.small', 'No cookies were set by this response.'));
    } else if (active === 'tests') {
      renderTests(content, result, ui, () => HD.renderResponse(root, result, ui, opts));
    } else if (active === 'timeline') {
      renderTimeline(content, result);
    }
  };

  function suggestName(res) {
    const ct = (res.contentType || '').toLowerCase();
    const ext = /json/.test(ct) ? 'json' : /html/.test(ct) ? 'html' : /xml/.test(ct) ? 'xml' : /png/.test(ct) ? 'png' : /jpe?g/.test(ct) ? 'jpg' : /pdf/.test(ct) ? 'pdf' : 'txt';
    return `response.${ext}`;
  }

  function renderBody(content, res, result, ui, rerender) {
    const isImage = /^image\//i.test(res.contentType || '');
    const lang = detectLang(res.contentType, res.bodyText);
    const views = [{ id: 'pretty', label: 'Pretty' }, { id: 'raw', label: 'Raw' }, { id: 'preview', label: 'Preview' }];
    if (result.visualizer) views.push({ id: 'visualize', label: 'Visualize' });
    let view = ui.bodyView || 'pretty';
    if (isImage && view !== 'raw') view = 'preview';
    if (view === 'visualize' && !result.visualizer) view = 'pretty';
    const langOverride = ui.bodyLang && ui.bodyLang !== 'auto' ? ui.bodyLang : lang;

    const toolbar = h('div.body-toolbar',
      HD.tabStrip(views, view, (id) => { ui.bodyView = id; HD.save(); rerender(); }, 'segmented'),
      view === 'pretty' ? HD.select([['auto', `Auto (${lang.toUpperCase()})`], ['json', 'JSON'], ['xml', 'XML'], ['html', 'HTML'], ['javascript', 'JavaScript'], ['text', 'Text']], ui.bodyLang || 'auto', (v) => { ui.bodyLang = v; HD.save(); rerender(); }, 'select-small') : null,
      h('span.spacer'),
      view !== 'preview' && view !== 'visualize' ? HD.button('', () => { ui.wrap = !ui.wrap; HD.save(); rerender(); }, { icon: 'wrap', ghost: true, small: true, title: 'Toggle line wrap', class: ui.wrap ? 'active' : '' }) : null,
      view !== 'preview' && view !== 'visualize' ? HD.button('', () => { const cm = content.querySelector('.CodeMirror'); if (cm) { cm.CodeMirror.focus(); cm.CodeMirror.execCommand('findPersistent'); } }, { icon: 'search', ghost: true, small: true, title: 'Search (Ctrl+F)' }) : null,
      HD.button('', () => HD.copy(res.bodyText || ''), { icon: 'copy', ghost: true, small: true, title: 'Copy body' }));
    content.appendChild(toolbar);
    const area = h('div.body-area');
    content.appendChild(area);

    if (view === 'preview') {
      if (isImage && res.bodyBase64) {
        area.appendChild(h('div.image-preview', h('img', { src: `data:${res.contentType.split(';')[0]};base64,${res.bodyBase64}`, alt: 'Response image' })));
      } else if (res.bodyText != null) {
        // Sandboxed (no scripts) preview of the HTML.
        const frame = h('iframe.preview-frame', { sandbox: '', referrerpolicy: 'no-referrer' });
        frame.srcdoc = lang === 'html' ? res.bodyText : `<pre style="white-space:pre-wrap;font:12px monospace">${res.bodyText.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</pre>`;
        area.appendChild(frame);
      } else area.appendChild(h('div.empty-state.small', `Binary response (${res.contentType || 'unknown type'}, ${HD.formatBytes(res.bodySize)}). Use "Save response to file".`));
      return;
    }
    if (view === 'visualize') {
      let html;
      try { html = HD.renderTemplate(result.visualizer.template, result.visualizer.data); } catch (e) { html = `<pre>Visualizer error: ${String(e.message)}</pre>`; }
      const frame = h('iframe.preview-frame', { sandbox: '', referrerpolicy: 'no-referrer' });
      frame.srcdoc = `<style>body{font-family:system-ui,sans-serif;font-size:13px}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:4px 8px}</style>${html}`;
      area.appendChild(frame);
      return;
    }
    if (res.bodyText == null) {
      area.appendChild(h('div.empty-state.small', `Binary response (${res.contentType || 'unknown type'}, ${HD.formatBytes(res.bodySize)}).`));
      return;
    }
    const text = view === 'pretty' ? pretty(res.bodyText, langOverride) : res.bodyText;
    HD.editor(area, { value: text, mode: view === 'pretty' ? langOverride : 'text', readOnly: true, wrap: !!ui.wrap });
  }

  function renderTests(content, result, ui, rerender) {
    const tests = result.tests || [];
    if (!tests.length) {
      content.appendChild(h('div.empty-state.small',
        result.testError ? h('div.text-error', `Test script error: ${result.testError}`) : null,
        h('div', 'No tests were run for this request.'),
        h('div.muted', 'Write tests in the "Tests" tab, e.g. pm.test("Status is 200", () => pm.response.to.have.status(200));')));
      return;
    }
    const filter = ui.testFilter || 'all';
    const counts = {
      all: tests.length,
      passed: tests.filter((t) => t.passed && !t.skipped).length,
      skipped: tests.filter((t) => t.skipped).length,
      failed: tests.filter((t) => !t.passed).length,
    };
    content.appendChild(h('div.body-toolbar', HD.tabStrip(['all', 'passed', 'skipped', 'failed'].map((id) => ({ id, label: `${id[0].toUpperCase()}${id.slice(1)} (${counts[id]})` })), filter, (id) => { ui.testFilter = id; rerender(); }, 'segmented')));
    if (result.testError) content.appendChild(h('div.test-script-error', `Test script error: ${result.testError}`));
    if (result.preRequestError) content.appendChild(h('div.test-script-error', `Pre-request script error: ${result.preRequestError}`));
    const shown = tests.filter((t) => filter === 'all' || (filter === 'passed' && t.passed && !t.skipped) || (filter === 'skipped' && t.skipped) || (filter === 'failed' && !t.passed));
    content.appendChild(h('div.test-list', shown.map((t) => h('div.test-item',
      h(`span.test-badge.${t.skipped ? 'skip' : t.passed ? 'pass' : 'fail'}`, t.skipped ? 'SKIPPED' : t.passed ? 'PASS' : 'FAIL'),
      h('div', h('div.test-name', t.name), t.error ? h('div.test-error', t.error) : null)))));
  }

  function renderTimeline(content, result) {
    const s = result.sentRequest;
    const res = result.response;
    if (!s) {
      content.appendChild(h('div.empty-state.small', result.error || 'The request was not sent.'));
      return;
    }
    const section = (title, lines) => h('div.timeline-section', h('div.timeline-title', title), h('pre.timeline-body', lines));
    const parts = [];
    for (const d of result.dependencyRuns || []) {
      parts.push(section(`Auth dependency: ${d.name} (${HD.reasonText(d.reason)})`, [
        `${d.method || ''} ${d.url || ''}`.trim(),
        d.status ? `→ ${d.status} ${d.statusText} (${HD.formatMs(d.time)})` : null,
        Object.keys(d.stored || {}).length ? `Saved variables: ${Object.keys(d.stored).join(', ')}` : null,
        d.error ? `Error: ${d.error}` : null,
      ].filter(Boolean).join('\n')));
    }
    if (res && res.redirects && res.redirects.length) {
      parts.push(section('Redirects', res.redirects.map((r) => `${r.status}  ${r.from}\n   → ${r.to}`).join('\n')));
    }
    parts.push(section('Request', [`${s.method} ${s.url}`, ...s.headers.map(([k, v]) => `${k}: ${v}`)].join('\n')));
    if (s.bodyText) parts.push(section('Request body', s.bodyText.length > 50000 ? s.bodyText.slice(0, 50000) + '\n…' : s.bodyText));
    if (res) {
      parts.push(section('Response', [`HTTP/${res.httpVersion} ${res.status} ${res.statusText}`, ...res.headers.map(([k, v]) => `${k}: ${v}`)].join('\n')));
      const t = res.timings || {};
      parts.push(section('Timing', [
        t.dns != null ? `DNS lookup        ${HD.formatMs(t.dns)}` : null,
        t.connect != null ? `TCP connected     ${HD.formatMs(t.connect)}` : null,
        t.tls != null ? `TLS handshake     ${HD.formatMs(t.tls)}` : null,
        t.firstByte != null ? `First byte        ${HD.formatMs(t.firstByte)}` : null,
        `Total             ${HD.formatMs(t.total)}`,
        res.remoteAddress ? `Remote address    ${res.remoteAddress}` : null,
      ].filter(Boolean).join('\n')));
    }
    content.appendChild(h('div.timeline', parts));
  }
})();
