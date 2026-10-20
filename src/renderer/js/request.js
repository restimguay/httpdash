'use strict';

/* The request editor tab: URL bar, params, auth, headers, body, scripts, settings and the response pane. */
(() => {
  const { h } = HD;
  const S = HD.S;
  const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT', 'PURGE', 'LINK', 'UNLINK', 'COPY', 'LOCK', 'UNLOCK', 'PROPFIND', 'VIEW'];
  HD.METHODS = METHODS;

  const AUTH_TYPES = [
    ['inherit', 'Inherit auth from parent'], ['none', 'No Auth'], ['basic', 'Basic Auth'], ['bearer', 'Bearer Token'],
    ['apikey', 'API Key'], ['digest', 'Digest Auth'], ['oauth2', 'OAuth 2.0'], ['awsv4', 'AWS Signature'],
  ];
  HD.AUTH_TYPES = AUTH_TYPES;

  // Suggested header names. Any header can be set, including ones browsers forbid (Referer, Origin, Host, Cookie).
  const COMMON_HEADERS = ['Accept', 'Accept-Charset', 'Accept-Encoding', 'Accept-Language', 'Authorization', 'Cache-Control', 'Connection',
    'Content-Disposition', 'Content-Encoding', 'Content-Language', 'Content-Type', 'Cookie', 'DNT', 'Forwarded', 'Host', 'If-Match',
    'If-Modified-Since', 'If-None-Match', 'Origin', 'Pragma', 'Range', 'Referer', 'Sec-Fetch-Dest', 'Sec-Fetch-Mode', 'Sec-Fetch-Site',
    'TE', 'Upgrade-Insecure-Requests', 'User-Agent', 'X-API-Key', 'X-Correlation-ID', 'X-CSRF-Token', 'X-Forwarded-For',
    'X-Forwarded-Host', 'X-Forwarded-Proto', 'X-Real-IP', 'X-Request-ID', 'X-Requested-With'];

  const SNIPPETS = {
    pre: [
      ['Get an environment variable', "pm.environment.get('variable_key');"],
      ['Set an environment variable', "pm.environment.set('variable_key', 'variable_value');"],
      ['Get a global variable', "pm.globals.get('variable_key');"],
      ['Set a global variable', "pm.globals.set('variable_key', 'variable_value');"],
      ['Get a collection variable', "pm.collectionVariables.get('variable_key');"],
      ['Set a collection variable', "pm.collectionVariables.set('variable_key', 'variable_value');"],
      ['Add a request header', "pm.request.headers.add({ key: 'X-Header', value: 'value' });"],
      ['Set timestamp variable', "pm.variables.set('now', Date.now());"],
      ['HMAC signature (CryptoJS)', "const signature = CryptoJS.HmacSHA256('message', 'secret').toString(CryptoJS.enc.Base64);\npm.variables.set('signature', signature);"],
      ['Send a request', "pm.sendRequest('https://postman-echo.com/get', (err, response) => {\n  console.log(err ? err : response.json());\n});"],
    ],
    test: [
      ['Status code is 200', "pm.test('Status code is 200', () => {\n  pm.response.to.have.status(200);\n});"],
      ['Response body: JSON value check', "pm.test('Your test name', () => {\n  const jsonData = pm.response.json();\n  pm.expect(jsonData.value).to.eql(100);\n});"],
      ['Response body: contains string', "pm.test('Body matches string', () => {\n  pm.expect(pm.response.text()).to.include('string_you_want_to_search');\n});"],
      ['Response time is less than 200ms', "pm.test('Response time is less than 200ms', () => {\n  pm.expect(pm.response.responseTime).to.be.below(200);\n});"],
      ['Content-Type header is present', "pm.test('Content-Type is present', () => {\n  pm.response.to.have.header('Content-Type');\n});"],
      ['Successful POST request', "pm.test('Successful POST request', () => {\n  pm.expect(pm.response.code).to.be.oneOf([201, 202]);\n});"],
      ['Validate JSON schema', "const schema = {\n  type: 'object',\n  required: ['id'],\n  properties: { id: { type: 'integer' } }\n};\npm.test('Schema is valid', () => {\n  pm.response.to.have.jsonSchema(schema);\n});"],
      ['Save a value to the environment', "const jsonData = pm.response.json();\npm.environment.set('token', jsonData.token);"],
      ['Set next request (runner)', "pm.setNextRequest('Request name');"],
      ['Visualize response as a table', "const template = `\n<table>\n  <tr><th>Key</th><th>Value</th></tr>\n  {{#each rows}}<tr><td>{{key}}</td><td>{{value}}</td></tr>{{/each}}\n</table>`;\nconst data = pm.response.json();\npm.visualizer.set(template, { rows: Object.entries(data).map(([key, value]) => ({ key, value: JSON.stringify(value) })) });"],
    ],
  };

  // ---- URL / params syncing -------------------------------------------------------------------

  const splitUrl = (url) => {
    const hashIdx = url.indexOf('#');
    const noHash = hashIdx === -1 ? url : url.slice(0, hashIdx);
    const q = noHash.indexOf('?');
    return { base: q === -1 ? noHash : noHash.slice(0, q), query: q === -1 ? null : noHash.slice(q + 1), hash: hashIdx === -1 ? '' : url.slice(hashIdx) };
  };
  const parseQuery = (query) => (query == null ? [] : query.split('&').filter((p) => p !== '').map((p) => {
    const i = p.indexOf('=');
    return { key: i === -1 ? p : p.slice(0, i), value: i === -1 ? '' : p.slice(i + 1), enabled: true };
  }));
  const buildQuery = (params) => params.filter((p) => p.enabled !== false && (p.key || p.value)).map((p) => (p.value === '' ? p.key : `${p.key}=${p.value}`)).join('&');

  HD.syncParamsFromUrl = (req) => {
    const { base, query } = splitUrl(req.url || '');
    const parsed = parseQuery(query);
    const old = req.params || [];
    parsed.forEach((p, i) => {
      const prev = old.filter((o) => o.enabled !== false)[i];
      if (prev && prev.description) p.description = prev.description;
    });
    req.params = [...parsed, ...old.filter((o) => o.enabled === false)];
    // Path variables (/:id).
    const names = [...base.matchAll(/\/:([A-Za-z_][\w-]*)/g)].map((m) => m[1]);
    const prevPv = req.pathVariables || [];
    req.pathVariables = names.map((n) => prevPv.find((p) => p.key === n) || { key: n, value: '', enabled: true, description: '' });
  };
  HD.urlFromParams = (req) => {
    const { base, hash } = splitUrl(req.url || '');
    const qs = buildQuery(req.params || []);
    return `${base}${qs ? '?' + qs : ''}${hash}`;
  };

  // ---- View ---------------------------------------------------------------------------------

  HD.views = HD.views || {};

  HD.views.request = (tab, root) => {
    const draft = tab.draft;
    const req = draft.request;
    req.settings = req.settings || {};
    tab.ui = tab.ui || {};
    const ui = tab.ui;
    let urlCm;

    const context = () => {
      const found = HD.find(tab.refId);
      if (!found) return { collection: null, chain: [] };
      return { collection: found.collection, chain: [found.collection, ...found.parents], found };
    };
    HD.variableInfo = () => HD.variableInfoFor(context().collection);

    const markDirty = () => {
      if (!tab.dirty) { tab.dirty = true; HD.renderTabBar(); }
      HD.save();
    };

    // Header: breadcrumb + name + actions.
    const ctx = context();
    const crumbs = ctx.found ? [ctx.collection.name, ...ctx.found.parents.map((p) => p.name)] : [];
    const nameInput = h('input.title-input', {
      value: draft.name, spellcheck: 'false',
      oninput: (e) => { draft.name = e.target.value; markDirty(); },
    });
    const examples = ctx.found && ctx.found.node.examples ? ctx.found.node.examples : [];
    const header = h('div.req-header',
      h('div.breadcrumb', crumbs.map((c) => h('span.crumb', c)), nameInput),
      h('div.req-header-actions',
        examples.length ? HD.button(`Examples (${examples.length})`, (e) => HD.menu(e, examples.map((ex) => ({
          label: `${ex.name} — ${ex.status}`,
          onClick: () => showExample(ex),
        }))), { ghost: true, small: true }) : null,
        HD.button('', () => HD.showCodegen(tab), { icon: 'code', ghost: true, title: 'Generate code snippet' }),
        HD.button('Save', () => HD.saveTab(tab), { icon: 'download', small: true, title: 'Save (Ctrl+S)' })));

    // URL bar.
    const methodSel = h('select.method-select', {
      class: HD.methodClass(req.method),
      onchange: (e) => {
        req.method = e.target.value;
        methodSel.className = `method-select ${HD.methodClass(req.method)}`;
        markDirty();
        HD.renderTabBar();
      },
    }, METHODS.map((m) => h('option', { value: m, selected: m === req.method }, m)));
    if (!METHODS.includes(req.method)) methodSel.appendChild(h('option', { value: req.method, selected: true }, req.method));

    const urlHost = h('div.url-input');
    const sendBtn = h('button.btn.btn-primary.send-btn', { type: 'button', onclick: () => send() }, 'Send');
    const urlBar = h('div.url-bar', methodSel, urlHost, sendBtn);

    // Request sub-tabs.
    const reqTabs = () => [
      { id: 'params', label: 'Params', badge: req.params.filter((p) => p.enabled !== false && p.key).length || null },
      { id: 'auth', label: 'Authorization', dot: req.auth && !['inherit', 'none'].includes(req.auth.type) },
      { id: 'headers', label: 'Headers', badge: req.headers.filter((p) => p.enabled !== false && p.key).length || null },
      { id: 'body', label: 'Body', dot: req.body && req.body.mode !== 'none' },
      { id: 'pre', label: 'Pre-request Script', dot: !!(req.preRequestScript || '').trim() },
      { id: 'tests', label: 'Tests', dot: !!(req.testScript || '').trim() },
      { id: 'settings', label: 'Settings' },
      { id: 'docs', label: 'Docs' },
    ];
    const reqTabHost = h('div.req-tabs-host');
    const reqPanel = h('div.req-panel');
    const renderReqTabs = () => {
      HD.clear(reqTabHost).appendChild(HD.tabStrip(reqTabs(), ui.reqTab || 'params', (id) => { ui.reqTab = id; HD.save(); renderReqTabs(); renderReqPanel(); }));
    };
    const panelChanged = () => { markDirty(); renderReqTabs(); };

    const renderReqPanel = () => {
      HD.clear(reqPanel);
      const t = ui.reqTab || 'params';
      if (t === 'params') renderParams();
      else if (t === 'auth') {
        reqPanel.appendChild(HD.authEditor(req.auth, { onChange: panelChanged, inheritFrom: () => inheritedAuth(context().chain), allowInherit: true, scopes: () => HD.scopesFor(context().collection) }));
        const c = context();
        reqPanel.appendChild(HD.dependencyEditor(req, { kind: 'request', collection: c.collection, parents: c.found ? c.found.parents : [], selfId: tab.refId, onChange: panelChanged }));
      }
      else if (t === 'headers') renderHeaders();
      else if (t === 'body') renderBody();
      else if (t === 'pre') reqPanel.appendChild(HD.scriptEditor(req, 'preRequestScript', SNIPPETS.pre, panelChanged, 'Pre-request scripts run before the request is sent. Collection and folder scripts run first.'));
      else if (t === 'tests') reqPanel.appendChild(HD.scriptEditor(req, 'testScript', SNIPPETS.test, panelChanged, 'Test scripts run after the response is received. Use pm.test() and pm.expect().'));
      else if (t === 'settings') renderSettings();
      else if (t === 'docs') {
        reqPanel.appendChild(h('div.panel-pad',
          h('label.field', h('span', 'Description'),
            h('textarea.input.docs-input', { value: req.description || '', placeholder: 'Describe what this request does, its parameters and expected responses…', oninput: (e) => { req.description = e.target.value; markDirty(); } }))));
      }
    };

    const renderParams = () => {
      reqPanel.appendChild(HD.kvTable({
        title: 'Query Params',
        rows: req.params,
        description: true,
        onChange: () => {
          const url = HD.urlFromParams(req);
          if (url !== req.url) { req.url = url; urlCm.setValue(url); }
          panelChanged();
        },
      }));
      if (req.pathVariables && req.pathVariables.length) {
        reqPanel.appendChild(HD.kvTable({ title: 'Path Variables', rows: req.pathVariables, description: true, readOnly: true, bulk: false, onChange: panelChanged }));
      }
    };

    const renderHeaders = () => {
      const auto = [['User-Agent', S.ws.settings.userAgent || 'HttpDash/1.0'], ['Accept', '*/*'], ['Accept-Encoding', 'gzip, deflate, br'], ['Cache-Control', 'no-cache'], ['Host', '<calculated when request is sent>']];
      if (req.body && req.body.mode !== 'none') auto.push(['Content-Type', '<calculated from body>'], ['Content-Length', '<calculated when request is sent>']);
      const hidden = !ui.showAutoHeaders;
      reqPanel.appendChild(HD.kvTable({
        title: 'Headers',
        rows: req.headers,
        description: true,
        keySuggestions: COMMON_HEADERS,
        onChange: panelChanged,
        extraActions: HD.button(hidden ? `Show ${auto.length} auto-generated` : 'Hide auto-generated', () => { ui.showAutoHeaders = hidden; renderReqPanel(); }, { ghost: true, small: true }),
      }));
      if (!hidden) {
        reqPanel.appendChild(h('div.auto-headers', h('div.kv-title', 'Auto-generated headers (added unless you set them yourself)'),
          auto.map(([k, v]) => h('div.kvline.mono', h('span', k), h('span.muted', v)))));
      }
    };

    const renderBody = () => {
      const b = req.body;
      b.urlencoded = b.urlencoded || [];
      b.formdata = b.formdata || [];
      b.graphql = b.graphql || { query: '', variables: '' };
      const modes = [['none', 'none'], ['formdata', 'form-data'], ['urlencoded', 'x-www-form-urlencoded'], ['raw', 'raw'], ['binary', 'binary'], ['graphql', 'GraphQL']];
      const bar = h('div.body-modes', modes.map(([id, label]) => h('label.radio',
        h('input', { type: 'radio', name: `mode-${tab.id}`, checked: b.mode === id, onchange: () => { b.mode = id; panelChanged(); renderReqPanel(); } }), label)));
      if (b.mode === 'raw') {
        bar.appendChild(HD.select([['text', 'Text'], ['javascript', 'JavaScript'], ['json', 'JSON'], ['html', 'HTML'], ['xml', 'XML']], b.rawLanguage || 'text', (v) => {
          b.rawLanguage = v;
          panelChanged();
          renderReqPanel();
        }, 'select-small'));
        bar.appendChild(h('span.spacer'));
        bar.appendChild(HD.button('Beautify', () => {
          let v = b.raw || '';
          try {
            if (b.rawLanguage === 'json') v = JSON.stringify(JSON.parse(v), null, 2);
            else if (b.rawLanguage === 'xml' || b.rawLanguage === 'html') v = HD.formatXml(v);
          } catch (e) { HD.toast(`Could not beautify: ${e.message}`, 'error'); return; }
          b.raw = v;
          panelChanged();
          renderReqPanel();
        }, { ghost: true, small: true }));
      }
      reqPanel.appendChild(bar);
      const area = h('div.body-editor');
      reqPanel.appendChild(area);
      if (b.mode === 'none') area.appendChild(h('div.empty-state.small', 'This request does not have a body'));
      else if (b.mode === 'raw') {
        const cm = HD.editor(area, { value: b.raw || '', mode: b.rawLanguage || 'text', variables: true, onChange: (v) => { b.raw = v; markDirty(); } });
        if (b.rawLanguage === 'json') {
          const status = h('div.editor-status');
          area.appendChild(status);
          const lint = () => {
            const v = cm.getValue().replace(/\{\{[^{}]+\}\}/g, '0');
            if (!v.trim()) { status.textContent = ''; return; }
            try { JSON.parse(v); status.textContent = ''; status.className = 'editor-status'; } catch (e) { status.textContent = e.message; status.className = 'editor-status error'; }
          };
          cm.on('change', HD.debounce(lint, 300));
          lint();
        }
      } else if (b.mode === 'urlencoded') area.appendChild(HD.kvTable({ rows: b.urlencoded, description: true, onChange: markDirty }));
      else if (b.mode === 'formdata') area.appendChild(HD.kvTable({ rows: b.formdata, formdata: true, description: true, bulk: false, onChange: markDirty }));
      else if (b.mode === 'binary') {
        area.appendChild(h('div.panel-pad', HD.button(b.binary ? b.binary.split(/[\\/]/).pop() : 'Select file', async () => {
          const [f] = await window.api.openFile({});
          if (f) { b.binary = f; panelChanged(); renderReqPanel(); }
        }, { icon: 'file' }), b.binary ? h('div.muted.mono', b.binary) : null));
      } else if (b.mode === 'graphql') {
        const split = h('div.graphql-split');
        const q = h('div.graphql-pane', h('div.pane-label', 'Query'));
        const v = h('div.graphql-pane', h('div.pane-label', 'GraphQL Variables (JSON)'));
        split.append(q, v);
        area.appendChild(split);
        HD.editor(q, { value: b.graphql.query, mode: 'graphql', variables: true, onChange: (x) => { b.graphql.query = x; markDirty(); } });
        HD.editor(v, { value: b.graphql.variables, mode: 'json', variables: true, onChange: (x) => { b.graphql.variables = x; markDirty(); } });
      }
    };

    const renderSettings = () => {
      const s = req.settings;
      const g = S.ws.settings;
      const tri = (key, label, help, globalVal) => h('div.setting-row',
        h('div', h('div.setting-label', label), h('div.setting-help', help)),
        HD.select([['default', `Default (${globalVal ? 'ON' : 'OFF'})`], ['on', 'ON'], ['off', 'OFF']], s[key] === undefined || s[key] === null ? 'default' : s[key] ? 'on' : 'off', (v) => {
          s[key] = v === 'default' ? null : v === 'on';
          markDirty();
        }, 'select-small'));
      reqPanel.appendChild(h('div.panel-pad.settings-list',
        tri('followRedirects', 'Automatically follow redirects', 'Follow HTTP 3xx responses as redirects.', g.followRedirects !== false),
        tri('verifySSL', 'Enable SSL certificate verification', 'Verify SSL certificates when sending a request.', g.verifySSL !== false),
        tri('sendCookies', 'Send cookies from the cookie jar', 'Attach stored cookies and store new ones.', g.sendCookies !== false),
        h('div.setting-row', h('div', h('div.setting-label', 'Request timeout (ms)'), h('div.setting-help', 'Leave empty to use the global setting. 0 means no timeout.')),
          h('input.input.input-small', { type: 'number', min: 0, value: s.timeout == null ? '' : s.timeout, placeholder: String(g.timeout || 0), oninput: (e) => { s.timeout = e.target.value === '' ? null : Number(e.target.value); markDirty(); } }))));
    };

    // Response pane.
    const resPane = h('div.res-pane');
    const renderRes = () => {
      if (S.sending.get(tab.id)) {
        sendBtn.textContent = 'Cancel';
        sendBtn.classList.add('btn-cancel');
        HD.clear(resPane).appendChild(h('div.res-loading', h('div.spinner'), h('div', 'Sending request…'), HD.button('Cancel', () => window.api.cancel(tab.id), { small: true })));
        return;
      }
      sendBtn.textContent = 'Send';
      sendBtn.classList.remove('btn-cancel');
      const result = S.responses.get(tab.id);
      if (!result) {
        HD.clear(resPane).appendChild(h('div.res-empty', h('div.res-empty-title', 'Response'), h('div.muted', 'Enter a URL and click Send to get a response'), h('div.muted.small', 'Ctrl/Cmd + Enter sends the request')));
        return;
      }
      HD.renderResponse(resPane, result, ui, {
        onClear: () => { S.responses.delete(tab.id); renderRes(); },
        onSaveExample: tab.refId && result.response ? async () => {
          const found = HD.find(tab.refId);
          if (!found) return;
          const name = await HD.prompt('Save as example', 'Example name', `${result.response.status} ${result.response.statusText}`);
          if (!name) return;
          found.node.examples = found.node.examples || [];
          found.node.examples.push({ id: HD.uid(), name, status: result.response.status, statusText: result.response.statusText, headers: result.response.headers, body: result.response.bodyText || '', request: HD.clone(req) });
          HD.save();
          HD.toast('Example saved', 'success');
          HD.renderActiveTab();
        } : null,
      });
    };

    const showExample = (ex) => {
      const body = h('div.example-view');
      const m = HD.modal({
        title: `Example: ${ex.name}`, body, width: 800,
        buttons: [
          {
            label: 'Delete example', danger: true,
            onClick: async () => {
              const f = HD.find(tab.refId);
              if (!f || !(await HD.confirm('Delete example', `Delete the example "${ex.name}"?`, { danger: true, okLabel: 'Delete' }))) return false;
              f.node.examples = (f.node.examples || []).filter((x) => x.id !== ex.id);
              HD.save();
              HD.renderActiveTab();
              return true;
            },
          },
          {
            label: 'Rename',
            onClick: async () => {
              const n = await HD.prompt('Rename example', 'Name', ex.name);
              if (!n) return false;
              const f = HD.find(tab.refId);
              const target = f && (f.node.examples || []).find((x) => x.id === ex.id);
              if (target) target.name = n;
              HD.save();
              m.close();
              HD.renderActiveTab();
              return true;
            },
          },
          { label: 'Close', primary: true },
        ],
      });
      const res = { status: ex.status, statusText: ex.statusText, headers: ex.headers || [], bodyText: ex.body, contentType: ((ex.headers || []).find(([k]) => /^content-type$/i.test(k)) || [])[1] || '', size: (ex.body || '').length, bodySize: (ex.body || '').length, headersSize: 0, time: 0 };
      HD.renderResponse(body, { response: res, tests: [] }, {}, { onClear: () => {} });
    };

    // Layout.
    const vertical = (S.ws.ui.layout || 'vertical') === 'vertical';
    const reqSection = h('div.req-section', header, urlBar, reqTabHost, reqPanel);
    const split = h(`div.split-handle.${vertical ? 'horizontal' : 'vertical'}`);
    const body = h(`div.request-view.${vertical ? 'layout-v' : 'layout-h'}`, reqSection, split, resPane);
    root.appendChild(body);
    const sizeKey = vertical ? 'reqHeight' : 'reqWidth';
    if (S.ws.ui[sizeKey]) reqSection.style.flexBasis = `${S.ws.ui[sizeKey]}px`;
    let startSize;
    split.addEventListener('mousedown', () => { startSize = vertical ? reqSection.offsetHeight : reqSection.offsetWidth; });
    HD.splitter(split, {
      axis: vertical ? 'y' : 'x',
      onMove: (d) => {
        const total = vertical ? body.offsetHeight : body.offsetWidth;
        const size = Math.max(120, Math.min(total - 120, startSize + d));
        reqSection.style.flexBasis = `${size}px`;
        S.ws.ui[sizeKey] = size;
      },
      onEnd: () => { HD.save(); document.querySelectorAll('.CodeMirror').forEach((c) => c.CodeMirror && c.CodeMirror.refresh()); },
    });

    urlCm = HD.lineEditor(urlHost, {
      value: req.url,
      placeholder: 'Enter URL or paste cURL',
      onEnter: () => send(),
      onChange: (v) => {
        req.url = v;
        HD.syncParamsFromUrl(req);
        markDirty();
        renderReqTabs();
        if ((ui.reqTab || 'params') === 'params' && !reqPanel.contains(document.activeElement)) renderReqPanel();
        HD.renderTabBar();
      },
      onPaste: (text) => {
        if (!/^\s*curl\s/i.test(text)) return false;
        window.api.importCurl(text).then((parsed) => {
          Object.assign(req, parsed, { preRequestScript: req.preRequestScript, testScript: req.testScript, description: req.description, settings: req.settings });
          if (!draft.name || draft.name === 'Untitled Request') draft.name = parsed.url.replace(/^https?:\/\//, '').split('?')[0].slice(0, 60);
          markDirty();
          HD.renderActiveTab();
          HD.renderTabBar();
          HD.toast('Imported cURL command', 'success');
        }).catch((e) => HD.toast(`Could not parse cURL: ${e.message}`, 'error'));
        return true;
      },
    });

    renderReqTabs();
    renderReqPanel();
    renderRes();

    // ---- Send ---------------------------------------------------------------------------------

    const send = async () => {
      if (S.sending.get(tab.id)) { window.api.cancel(tab.id); return; }
      if (!req.url.trim()) { HD.toast('Enter a request URL', 'warn'); return; }
      const { collection, chain } = context();
      const scopes = HD.scopesFor(collection);
      const g = S.ws.settings;
      const o = req.settings || {};
      const pick = (k) => (o[k] === undefined || o[k] === null ? g[k] : o[k]);
      const settings = { ...g, followRedirects: pick('followRedirects'), verifySSL: pick('verifySSL'), sendCookies: pick('sendCookies'), timeout: o.timeout == null ? g.timeout : o.timeout };
      S.sending.set(tab.id, true);
      HD.renderTabBar();
      if (HD.currentTab() === tab) renderRes();
      let result;
      try {
        result = await window.api.send({
          id: tab.id,
          request: HD.clone(req),
          chain: chain.map((n) => ({ id: n.id, name: n.name, auth: n.auth, preRequestScript: n.preRequestScript, testScript: n.testScript, dependency: n.dependency })),
          collection: collection ? HD.clone(collection) : null,
          scopes,
          settings,
          info: { requestName: draft.name, requestId: tab.refId || tab.id },
        });
      } catch (e) {
        result = { error: e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), tests: [] };
      }
      S.sending.delete(tab.id);
      for (const l of result.logs || []) HD.log(l.level, l.message, { request: draft.name });
      if (result.scopes) HD.applyScopes(scopes, result.scopes, collection);
      S.responses.set(tab.id, result);
      HD.addHistory({
        name: draft.name, method: req.method, url: result.sentRequest ? result.sentRequest.url : req.url,
        status: result.response ? result.response.status : null, time: Date.now(), duration: result.response ? result.response.time : null,
        request: HD.clone(req), collectionId: collection ? collection.id : null, error: result.error || null,
      });
      HD.renderTabBar();
      if (HD.currentTab() === tab) {
        renderRes();
        HD.refreshVarHighlights();
      }
      if (result.skipped) HD.toast('Request skipped by pm.execution.skipRequest()', 'info');
    };
    S.senders.set(tab.id, send);
  };

  function inheritedAuth(chain) {
    for (let i = chain.length - 1; i >= 0; i--) {
      const a = chain[i].auth;
      if (a && a.type && a.type !== 'inherit') return { auth: a, from: chain[i].name };
    }
    return { auth: { type: 'none' }, from: null };
  }

  // ---- Shared editors (also used by collection/folder views) --------------------------------

  HD.scriptEditor = (obj, field, snippets, onChange, help) => {
    const wrap = h('div.script-editor');
    const edHost = h('div.script-code');
    const side = h('div.script-snippets',
      h('div.snippets-help', help),
      h('div.snippets-title', 'Snippets'),
      snippets.map(([label, code]) => h('button.snippet', {
        type: 'button',
        onclick: () => {
          const cur = cm.getValue();
          cm.replaceRange((cur && !cur.endsWith('\n') ? '\n' : '') + code + '\n', CodeMirror.Pos(cm.lastLine()));
          cm.focus();
        },
      }, label)));
    wrap.append(edHost, side);
    const cm = HD.editor(edHost, { value: obj[field] || '', mode: 'javascript', onChange: (v) => { obj[field] = v; onChange(); } });
    return wrap;
  };

  HD.authEditor = (auth, { onChange, inheritFrom, allowInherit, scopes }) => {
    const root = h('div.auth-editor');
    const render = () => {
      HD.clear(root);
      const types = AUTH_TYPES.filter(([t]) => allowInherit || t !== 'inherit');
      const left = h('div.auth-type',
        h('label.field', h('span', 'Type'), HD.select(types, auth.type || 'none', (v) => { auth.type = v; render(); onChange(); })),
        h('div.muted.small', authHelp(auth.type)));
      const right = h('div.auth-fields');
      const t = auth.type || 'none';
      const cfg = (auth[t] = auth[t] || {});
      const field = (key, label, { type = 'text', placeholder = '', options } = {}) => h('label.field', h('span', label), options
        ? HD.select(options, cfg[key] || options[0][0], (v) => { cfg[key] = v; onChange(); })
        : h('input.input', { type, value: cfg[key] || '', placeholder, spellcheck: 'false', oninput: (e) => { cfg[key] = e.target.value; onChange(); } }));

      if (t === 'inherit') {
        const inh = inheritFrom ? inheritFrom() : { auth: { type: 'none' } };
        right.appendChild(h('div.info-box', inh.from
          ? `This request is using ${labelOf(inh.auth.type)} from "${inh.from}".`
          : 'This request is not inheriting any authorization helper. Save it to a collection and configure auth there.'));
      } else if (t === 'none') right.appendChild(h('div.info-box', 'This request does not use any authorization.'));
      else if (t === 'basic') right.append(field('username', 'Username'), field('password', 'Password', { type: 'password' }));
      else if (t === 'bearer') right.append(field('token', 'Token', { placeholder: '{{token}}' }));
      else if (t === 'digest') right.append(field('username', 'Username'), field('password', 'Password', { type: 'password' }), h('div.muted.small', 'The request is sent once to obtain the challenge, then retried with the digest response.'));
      else if (t === 'apikey') right.append(field('key', 'Key'), field('value', 'Value'), field('in', 'Add to', { options: [['header', 'Header'], ['query', 'Query Params']] }));
      else if (t === 'awsv4') right.append(field('accessKey', 'AccessKey'), field('secretKey', 'SecretKey', { type: 'password' }), field('region', 'AWS Region', { placeholder: 'us-east-1' }), field('service', 'Service Name', { placeholder: 'execute-api' }), field('sessionToken', 'Session Token'));
      else if (t === 'oauth2') {
        right.append(
          field('accessToken', 'Access Token', { placeholder: 'Paste a token or get a new one below' }),
          field('headerPrefix', 'Header Prefix', { placeholder: 'Bearer' }),
          field('addTo', 'Add token to', { options: [['header', 'Request Headers'], ['query', 'Query Params']] }),
          h('div.section-title', 'Configure New Token'),
          field('grantType', 'Grant Type', { options: [['client_credentials', 'Client Credentials'], ['password', 'Password Credentials']] }),
          field('accessTokenUrl', 'Access Token URL', { placeholder: 'https://auth.example.com/oauth/token' }),
          field('clientId', 'Client ID'),
          field('clientSecret', 'Client Secret', { type: 'password' }),
          field('scope', 'Scope', { placeholder: 'e.g. read:org' }),
          field('username', 'Username (password grant)'),
          field('password', 'Password (password grant)', { type: 'password' }),
          field('clientAuth', 'Client Authentication', { options: [['header', 'Send as Basic Auth header'], ['body', 'Send client credentials in body']] }),
          HD.button('Get New Access Token', async () => {
            if (!cfg.accessTokenUrl) { HD.toast('Enter the Access Token URL', 'warn'); return; }
            try {
              const tok = await window.api.getOAuth2Token({ config: { grantType: 'client_credentials', ...cfg }, scopes: scopes ? scopes() : {}, settings: S.ws.settings });
              cfg.accessToken = tok.access_token;
              if (tok.token_type && !cfg.headerPrefix) cfg.headerPrefix = /bearer/i.test(tok.token_type) ? 'Bearer' : tok.token_type;
              onChange();
              render();
              HD.toast(`Token received${tok.expires_in ? ` (expires in ${tok.expires_in}s)` : ''}`, 'success');
            } catch (e) {
              HD.toast(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error', 6000);
            }
          }, { primary: true }));
      }
      root.append(left, right);
    };
    render();
    return root;
  };

  const labelOf = (t) => (AUTH_TYPES.find(([x]) => x === t) || [t, t])[1];
  function authHelp(t) {
    return {
      inherit: 'Uses the authorization of the nearest parent folder or collection.',
      none: '',
      basic: 'Sends an Authorization header with base64-encoded username:password.',
      bearer: 'Sends an "Authorization: Bearer <token>" header.',
      apikey: 'Sends a key/value pair as a header or query parameter.',
      digest: 'HTTP Digest authentication (MD5 / SHA-256, qop=auth).',
      oauth2: 'Sends an OAuth 2.0 access token. Tokens can be fetched with client credentials or password grants.',
      awsv4: 'Signs the request with AWS Signature Version 4.',
    }[t] || '';
  }
})();
