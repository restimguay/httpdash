'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { discover, syncValues, variableName } = require('../src/core/discovery');

// Fake registries that answer like Consul, Eureka, the Kubernetes API and a custom JSON endpoint.
let server;
let base;
const seen = {};
test.before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    seen[url.pathname] = { headers: req.headers, query: Object.fromEntries(url.searchParams) };
    const json = (o, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    const p = url.pathname;
    if (p === '/v1/catalog/services') return json({ consul: [], orders: ['v2', 'http'], users: ['v1'], 'payment-gateway': ['v2'] });
    if (p === '/v1/health/service/orders') return json([{ Node: { Address: '10.0.0.9' }, Service: { ID: 'o1', Address: '10.0.1.5', Port: 8080 }, Checks: [{ Status: 'passing' }] }]);
    if (p === '/v1/health/service/users') return json([{ Node: { Address: '10.0.0.7' }, Service: { ID: 'u1', Address: '', Port: 9000 }, Checks: [{ Status: 'passing' }] }]);
    if (p === '/v1/health/service/payment-gateway') return json([]);
    if (p === '/eureka/apps') return json({ applications: { application: [
      { name: 'ORDERS-SERVICE', instance: [{ instanceId: 'a', hostName: 'orders.local', status: 'DOWN', port: { $: 8080, '@enabled': 'true' } }, { instanceId: 'b', hostName: 'orders2.local', status: 'UP', port: { $: 8081, '@enabled': 'true' }, securePort: { $: 443, '@enabled': 'false' } }] },
      { name: 'BILLING', instance: { instanceId: 'c', hostName: 'billing.local', status: 'UP', homePageUrl: 'https://billing.example.com/', port: { $: 80, '@enabled': 'true' } } },
    ] } });
    if (p === '/api/v1/namespaces/shop/services') {
      if (req.headers.authorization !== 'Bearer k8s-token') return json({ message: 'Unauthorized' }, 401);
      return json({ items: [
        { metadata: { name: 'cart', namespace: 'shop' }, spec: { clusterIP: '10.96.0.10', ports: [{ name: 'metrics', port: 9090 }, { name: 'http', port: 8080 }] }, status: {} },
        { metadata: { name: 'web', namespace: 'shop' }, spec: { clusterIP: '10.96.0.11', ports: [{ name: 'https', port: 443 }] }, status: { loadBalancer: { ingress: [{ hostname: 'web.example.com' }] } } },
        { metadata: { name: 'db', namespace: 'shop' }, spec: { clusterIP: 'None', ports: [{ port: 5432 }] }, status: {} },
      ] });
    }
    if (p === '/registry.json') return json({ data: { services: [{ id: 'search', host: '10.1.1.1', port: 7700 }, { id: 'broken' }] } });
    if (p === '/map.json') return json({ inventory: 'http://inv:8080/', reports: { url: 'http://rep:9000' } });
    return json({ error: 'not found' }, 404);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

test('Consul: healthy instances, node address fallback, token header, skips the consul service', async () => {
  const { services, warnings } = await discover({ provider: 'consul', url: base, token: 'c-tok', datacenter: 'dc1' });
  assert.deepStrictEqual(services.map((s) => [s.name, s.url]), [['orders', 'http://10.0.1.5:8080'], ['users', 'http://10.0.0.7:9000']]);
  assert.match(warnings.join(), /payment-gateway: no healthy instances/);
  assert.strictEqual(seen['/v1/catalog/services'].headers['x-consul-token'], 'c-tok');
  assert.strictEqual(seen['/v1/health/service/orders'].query.passing, '1');
  assert.strictEqual(seen['/v1/health/service/orders'].query.dc, 'dc1');
  const tagged = await discover({ provider: 'consul', url: base, tag: 'v2' });
  assert.deepStrictEqual(tagged.services.map((s) => s.name), ['orders']);
});

test('Eureka: only UP instances, homePageUrl preferred, lowercased names', async () => {
  const { services } = await discover({ provider: 'eureka', url: base });
  assert.deepStrictEqual(services.map((s) => [s.name, s.url]), [['billing', 'https://billing.example.com'], ['orders-service', 'http://orders2.local:8081']]);
});

test('Kubernetes: cluster DNS, cluster IP and external modes; bearer token required', async () => {
  const cfg = { provider: 'kubernetes', url: base, namespace: 'shop', token: 'k8s-token' };
  const dns = await discover(cfg);
  assert.deepStrictEqual(dns.services.map((s) => [s.name, s.url]), [
    ['cart', 'http://cart.shop.svc.cluster.local:8080'], ['db', 'http://db.shop.svc.cluster.local:5432'], ['web', 'https://web.shop.svc.cluster.local']]);
  const ip = await discover({ ...cfg, addressMode: 'cluster-ip' });
  assert.deepStrictEqual(ip.services.map((s) => s.url), ['http://10.96.0.10:8080', 'https://10.96.0.11']);
  assert.match(ip.warnings.join(), /db: headless/);
  const ext = await discover({ ...cfg, addressMode: 'external' });
  assert.deepStrictEqual(ext.services.map((s) => s.url), ['https://web.example.com']);
  await assert.rejects(discover({ ...cfg, token: 'wrong' }), /401/);
});

test('Custom JSON: list path, name field and URL template; object maps', async () => {
  const { services, warnings } = await discover({ provider: 'json', url: `${base}/registry.json`, listPath: 'data.services', nameField: 'id', urlField: 'http://{host}:{port}' });
  assert.deepStrictEqual(services.map((s) => [s.name, s.url]), [['search', 'http://10.1.1.1:7700']]);
  assert.strictEqual(warnings.length, 1);
  const map = await discover({ provider: 'json', url: `${base}/map.json` });
  assert.deepStrictEqual(map.services.map((s) => [s.name, s.url]), [['inventory', 'http://inv:8080'], ['reports', 'http://rep:9000']]);
  await assert.rejects(discover({ provider: 'json', url: `${base}/nope` }), /404/);
});

test('variable names follow the pattern', () => {
  assert.strictEqual(variableName('{name}_url', 'Payment Gateway'), 'payment_gateway_url');
  assert.strictEqual(variableName('{NAME}_BASE', 'orders-service'), 'ORDERS_SERVICE_BASE');
});

test('syncing updates in place: adds, updates, removes discovered rows and keeps user rows', () => {
  const values = [{ key: 'token', value: 'abc', enabled: true }];
  let diff = syncValues(values, [{ name: 'orders', url: 'http://a' }, { name: 'users', url: 'http://b' }], { sourceId: 's1' });
  assert.deepStrictEqual(diff.added, ['orders_url', 'users_url']);
  diff = syncValues(values, [{ name: 'orders', url: 'http://a2' }, { name: 'billing', url: 'http://c' }], { sourceId: 's1' });
  assert.deepStrictEqual(diff, { added: ['billing_url'], updated: ['orders_url'], removed: ['users_url'], unchanged: [] });
  assert.deepStrictEqual(values.map((v) => [v.key, v.value]), [['token', 'abc'], ['orders_url', 'http://a2'], ['billing_url', 'http://c']]);
  diff = syncValues(values, [], { sourceId: 's1', keepMissing: true });
  assert.strictEqual(diff.removed.length, 0);
});
