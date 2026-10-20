'use strict';

const { newCollection, newFolder, newRequestItem, newEnvironment } = require('../core/model');

const DEFAULT_SETTINGS = {
  timeout: 0,
  followRedirects: true,
  maxRedirects: 10,
  verifySSL: true,
  sendCookies: true,
  sendNoCache: true,
  userAgent: 'HttpDash/1.0',
  maxResponseBytes: 50 * 1024 * 1024,
  historyLimit: 200,
  theme: 'system',
  fontSize: 13,
  proxy: { enabled: false, host: '', port: 8080, username: '', password: '', bypass: 'localhost,127.0.0.1' },
};

// The workspace a new user starts with: one example collection and environment.
function seedWorkspace() {
  const env = newEnvironment('httpbin');
  env.values = [{ key: 'baseUrl', value: 'https://httpbin.org', enabled: true }, { key: 'token', value: 'secret-token', enabled: true, secret: true }];

  const col = newCollection('Example: httpbin');
  col.description = 'Example requests against https://httpbin.org. Select the "httpbin" environment to run them.';
  col.variables = [{ key: 'userId', value: '42', enabled: true }];
  col.testScript = "pm.test('Response time is below 5s', () => pm.expect(pm.response.responseTime).to.be.below(5000));";

  const basics = newFolder('Basics');
  basics.items.push(
    newRequestItem('Get with query params', {
      url: '{{baseUrl}}/get?userId={{userId}}&q=hello',
      params: [{ key: 'userId', value: '{{userId}}', enabled: true }, { key: 'q', value: 'hello', enabled: true }],
      testScript: "pm.test('Status is 200', () => pm.response.to.have.status(200));\npm.test('Echoes query', () => {\n  const json = pm.response.json();\n  pm.expect(json.args.q).to.eql('hello');\n});",
    }),
    newRequestItem('Post JSON', {
      method: 'POST',
      url: '{{baseUrl}}/post',
      body: { mode: 'raw', rawLanguage: 'json', raw: '{\n  "id": "{{$guid}}",\n  "name": "{{$randomFullName}}",\n  "createdAt": "{{$isoTimestamp}}"\n}', urlencoded: [], formdata: [], binary: '', graphql: { query: '', variables: '' } },
      testScript: "pm.test('JSON was echoed', () => pm.expect(pm.response.json().json).to.have.property('name'));\npm.environment.set('lastId', pm.response.json().json.id);",
    }),
    newRequestItem('Bearer auth', {
      url: '{{baseUrl}}/bearer',
      auth: { type: 'bearer', bearer: { token: '{{token}}' } },
      testScript: "pm.test('Authenticated', () => pm.response.to.have.status(200));",
    }),
  );
  const misc = newFolder('Status & redirects');
  misc.items.push(
    newRequestItem('Status 418', { url: '{{baseUrl}}/status/418' }),
    newRequestItem('Redirect', { url: '{{baseUrl}}/redirect/2' }),
    newRequestItem('Set cookie', { url: '{{baseUrl}}/cookies/set?flavor=chocolate' }),
  );
  col.items.push(basics, misc);

  return {
    version: 1,
    collections: [col],
    environments: [env],
    activeEnvironmentId: env.id,
    globals: [],
    history: [],
    settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
    tabs: [],
    activeTabId: null,
    ui: { sidebarWidth: 300, sidebarTab: 'collections', responseHeight: null, layout: 'vertical' },
  };
}

module.exports = { seedWorkspace, DEFAULT_SETTINGS };
