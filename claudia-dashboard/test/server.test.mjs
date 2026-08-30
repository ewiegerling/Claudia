import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createDashboardServer, safeMarkdown } from '../server.mjs';

let server;
let baseUrl;

before(async () => {
  server = createDashboardServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test('health endpoint is read-only, private, and hardened', async () => {
  const response = await fetch(`${baseUrl}/api/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, readOnly: true });
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.match(response.headers.get('permissions-policy'), /camera=\(\)/);
  assert.match(response.headers.get('strict-transport-security'), /max-age=15552000/);
  assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(response.headers.get('cache-control'), /no-store/);
});

test('configured authentication protects every sensitive route and redirects proxy HTTP', async () => {
  const previousUsername = process.env.DASHBOARD_AUTH_USER;
  const previousSecret = process.env['DASHBOARD_AUTH_PASSWORD'];
  process.env.DASHBOARD_AUTH_USER = 'audit-user';
  Reflect.set(process.env, 'DASHBOARD_AUTH_PASSWORD', 'example-correct-horse-battery-staple-atlas');
  const protectedServer = createDashboardServer();
  if (previousUsername === undefined) delete process.env.DASHBOARD_AUTH_USER;
  else process.env.DASHBOARD_AUTH_USER = previousUsername;
  if (previousSecret === undefined) Reflect.deleteProperty(process.env, 'DASHBOARD_AUTH_PASSWORD');
  else Reflect.set(process.env, 'DASHBOARD_AUTH_PASSWORD', previousSecret);

  await new Promise((resolve) => protectedServer.listen(0, '127.0.0.1', resolve));
  const protectedUrl = `http://127.0.0.1:${protectedServer.address().port}`;
  const authorization = `Basic ${Buffer.from('audit-user:example-correct-horse-battery-staple-atlas').toString('base64')}`;
  try {
    assert.equal((await fetch(`${protectedUrl}/api/health`)).status, 200);
    const anonymous = await fetch(`${protectedUrl}/api/brain`);
    assert.equal(anonymous.status, 401);
    assert.match(anonymous.headers.get('www-authenticate'), /Claudia Dashboard/);
    assert.equal((await fetch(`${protectedUrl}/api/atlas`, {
      headers: { Authorization: `Basic ${Buffer.from('audit-user:wrong-password-that-is-long-enough').toString('base64')}` },
    })).status, 401);
    assert.equal((await fetch(`${protectedUrl}/api/atlas`, { headers: { Authorization: authorization } })).status, 200);
    const redirect = await fetch(`${protectedUrl}/api/brain?audit=1`, {
      headers: { 'X-Forwarded-Proto': 'http' },
      redirect: 'manual',
    });
    assert.equal(redirect.status, 308);
    assert.equal(redirect.headers.get('location'), 'https://dashboard.example.com/api/brain?audit=1');
  } finally {
    await new Promise((resolve, reject) => protectedServer.close((error) => error ? reject(error) : resolve()));
  }
});

test('password rotation requires authentication, same-origin intent, and a valid replacement', async () => {
  const previousUsername = process.env.DASHBOARD_AUTH_USER;
  const previousSecret = process.env['DASHBOARD_AUTH_PASSWORD'];
  const currentSecret = 'example-current-dashboard-secret-2026';
  const nextSecret = 'example12!Ab';
  process.env.DASHBOARD_AUTH_USER = 'settings-audit';
  Reflect.set(process.env, 'DASHBOARD_AUTH_PASSWORD', currentSecret);
  const rotations = [];
  const protectedServer = createDashboardServer({
    authenticationRotator: async (authentication, replacement) => rotations.push([authentication.username, replacement]),
  });
  if (previousUsername === undefined) delete process.env.DASHBOARD_AUTH_USER;
  else process.env.DASHBOARD_AUTH_USER = previousUsername;
  if (previousSecret === undefined) Reflect.deleteProperty(process.env, 'DASHBOARD_AUTH_PASSWORD');
  else Reflect.set(process.env, 'DASHBOARD_AUTH_PASSWORD', previousSecret);
  await new Promise((resolve) => protectedServer.listen(0, '127.0.0.1', resolve));
  const protectedUrl = `http://127.0.0.1:${protectedServer.address().port}`;
  const authorization = `Basic ${Buffer.from(`settings-audit:${currentSecret}`).toString('base64')}`;
  const makePayload = (current = currentSecret, replacement = nextSecret, confirmation = nextSecret) => JSON.stringify(Object.fromEntries([
    ['currentPassword', current], ['newPassword', replacement], ['confirmPassword', confirmation],
  ]));
  const headers = { Authorization: authorization, 'Content-Type': 'application/json', 'X-Claudia-Settings': 'password-change', Origin: protectedUrl };
  try {
    assert.equal((await fetch(`${protectedUrl}/api/settings/password`, { method: 'POST', body: makePayload(), headers: { ...headers, Authorization: undefined } })).status, 401);
    assert.equal((await fetch(`${protectedUrl}/api/settings/password`, { method: 'POST', body: makePayload(), headers: { ...headers, Origin: 'https://hostile.invalid' } })).status, 403);
    assert.equal((await fetch(`${protectedUrl}/api/settings/password`, { method: 'POST', body: makePayload('incorrect-current-dashboard-secret') , headers })).status, 403);
    assert.equal((await fetch(`${protectedUrl}/api/settings/password`, { method: 'POST', body: makePayload(currentSecret, '12345678901', '12345678901'), headers })).status, 400);
    const success = await fetch(`${protectedUrl}/api/settings/password`, { method: 'POST', body: makePayload(), headers });
    assert.equal(success.status, 200);
    assert.deepEqual(rotations, [['settings-audit', nextSecret]]);
    assert.equal((await fetch(`${protectedUrl}/api/settings/password`, { method: 'POST', body: makePayload(), headers })).status, 409);
    assert.equal((await fetch(`${protectedUrl}/api/brain`, { method: 'DELETE', headers: { Authorization: authorization } })).status, 405);
  } finally {
    await new Promise((resolve, reject) => protectedServer.close((error) => error ? reject(error) : resolve()));
  }
});

test('malformed absolute request targets return 400 without crashing the server', async () => {
  const payload = await new Promise((resolve, reject) => {
    const socket = net.createConnection(server.address().port, '127.0.0.1');
    let response = '';
    socket.setEncoding('utf8');
    socket.setTimeout(3000, () => socket.destroy(new Error('raw request timed out')));
    socket.on('connect', () => socket.end('GET http://[invalid]/ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n'));
    socket.on('data', (chunk) => { response += chunk; });
    socket.on('end', () => resolve(response));
    socket.on('error', reject);
  });
  assert.match(payload, /^HTTP\/1\.1 400 /);
  assert.equal((await fetch(`${baseUrl}/api/health`)).status, 200);
});

test('dashboard API exposes bounded read-only telemetry with current identities', async () => {
  const response = await fetch(`${baseUrl}/api/dashboard`);
  const dashboard = await response.json();
  assert.equal(response.status, 200);
  assert.equal(dashboard.readOnly, true);
  assert.match(dashboard.overall, /^(nominal|degraded|critical)$/);
  assert.ok(dashboard.host.cpuCores > 0);
  assert.ok(dashboard.resources.cpu.percent >= 0 && dashboard.resources.cpu.percent <= 100);
  assert.ok(dashboard.resources.memory.totalBytes > 0);
  assert.ok(dashboard.resources.storage.totalBytes > 0);
  assert.equal(dashboard.network.canonicalHost, 'dashboard.example.com');
  assert.equal(dashboard.network.upstream, '127.0.0.1:4317');
  assert.deepEqual(dashboard.services.map((service) => service.id), ['claudia-dashboard', 'openclaw-gateway', 'memory-store']);
  assert.equal(JSON.stringify(dashboard).includes('/opt/operator'), false);
});

test('retired command API is no longer exposed', async () => {
  const response = await fetch(`${baseUrl}/api/command`);
  assert.equal(response.status, 404);
});

test('memory API reads only fixed Markdown sources and returns sanitized HTML', async () => {
  const response = await fetch(`${baseUrl}/api/brain`);
  const brain = await response.json();
  assert.equal(response.status, 200);
  assert.equal(brain.readOnly, true);
  assert.equal(brain.identity.name, 'Claudia');
  assert.ok(brain.stats.documents >= 2);
  assert.ok(brain.stats.words > 100);
  assert.ok(brain.documents.some((document) => document.path === 'MEMORY.md'));
  assert.ok(brain.documents.every((document) => /^(MEMORY\.md|memory\/[^/]+\.md)$/.test(document.path)));
  assert.equal(brain.documents.some((document) => /<script|onerror\s*=|javascript:/i.test(document.html)), false);
});

test('Markdown sanitizer removes executable content and preserves safe structure', () => {
  const output = safeMarkdown('# Safe\n\n<img src=x onerror=alert(1)>\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(1))\n\n**good**');
  assert.match(output, /<h1>Safe<\/h1>/);
  assert.match(output, /<strong>good<\/strong>/);
  assert.doesNotMatch(output, /<script|<img|onerror|javascript:/i);
});

test('projects, dreams, graph, and history are derived read-only views', async () => {
  const [projectsResponse, dreamsResponse, graphResponse, historyResponse] = await Promise.all([
    fetch(`${baseUrl}/api/projects`),
    fetch(`${baseUrl}/api/dreams`),
    fetch(`${baseUrl}/api/graph`),
    fetch(`${baseUrl}/api/history`),
  ]);
  const [projects, dreams, graph, history] = await Promise.all([
    projectsResponse.json(), dreamsResponse.json(), graphResponse.json(), historyResponse.json(),
  ]);
  assert.equal(projectsResponse.status, 200);
  assert.ok(Array.isArray(projects.projects));
  assert.equal(dreamsResponse.status, 200);
  assert.equal(dreams.readOnly, true);
  assert.ok(Array.isArray(dreams.entries));
  assert.equal(JSON.stringify(dreams).includes('/opt/operator'), false);
  assert.equal(graphResponse.status, 200);
  assert.ok(graph.nodes.length > 0 && graph.links.length > 0);
  assert.equal(historyResponse.status, 200);
  assert.ok(history.snapshots.length > 0);
});

test('Brain Atlas API exposes only bounded, relative, metadata-only topology', async () => {
  const response = await fetch(`${baseUrl}/api/atlas`);
  const atlas = await response.json();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(atlas.readOnly, true);
  assert.equal(Number.isNaN(Date.parse(atlas.generatedAt)), false);
  assert.deepEqual(atlas.regions.map((region) => region.id), [
    'frontal', 'parietal', 'temporal', 'occipital', 'cerebellum', 'stem',
  ]);
  assert.equal(atlas.regions.length, 6);
  assert.ok(atlas.nodes.length > 0 && atlas.nodes.length <= 1500);
  assert.ok(atlas.edges.length <= 4000);
  assert.equal(atlas.stats.nodes, atlas.nodes.length);
  assert.equal(atlas.stats.edges, atlas.edges.length);

  const nodeIds = new Set(atlas.nodes.map((node) => node.id));
  for (const node of atlas.nodes) {
    assert.match(node.path, /^(?:[A-Za-z][\w.-]*\.md|(?:memory|skills|templates|claudia-dashboard)\/[^/].*\.md)$/);
    assert.equal(path.isAbsolute(node.path), false);
    assert.ok(['frontal', 'parietal', 'temporal', 'occipital', 'cerebellum', 'stem'].includes(node.region));
    assert.ok(Number.isFinite(node.position.x));
    assert.ok(Number.isFinite(node.position.y));
    assert.ok(Number.isFinite(node.position.z));
    for (const privateField of ['raw', 'html', 'body', 'content', 'sourceText', 'absolutePath']) {
      assert.equal(privateField in node, false, `${node.path} must not expose ${privateField}`);
    }
  }
  for (const edge of atlas.edges) {
    assert.ok(nodeIds.has(edge.source));
    assert.ok(nodeIds.has(edge.target));
  }
  assert.doesNotMatch(JSON.stringify(atlas), /(?:\/home\/|[A-Z]:\\\\Users\\\\)/);
});

test('new SPA and every local asset are served without remote dependencies', async () => {
  const paths = ['/', '/index.html', '/dashboard.css?v=2', '/atlas.js?v=1', '/dashboard.js?v=2', '/manifest.webmanifest', '/icon.svg'];
  const responses = await Promise.all(paths.map((path) => fetch(`${baseUrl}${path}`)));
  responses.forEach((response) => assert.equal(response.status, 200));
  const html = await responses[0].text();
  assert.match(html, /Claudia Dashboard/);
  assert.match(html, /Memory, without the mausoleum/);
  assert.doesNotMatch(html, /https?:\/\//);
  assert.match(responses[0].headers.get('content-security-policy'), /script-src 'self'/);
  assert.doesNotMatch(responses[0].headers.get('content-security-policy'), /unsafe-inline/);
});

test('legacy panel pages stay retired', async () => {
  for (const path of ['/command.html', '/brain.html', '/graph.html', '/projects.html', '/dreams.html']) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 404, `${path} should be retired`);
  }
});

test('HEAD works for proxy health checks without a response body', async () => {
  for (const path of ['/', '/api/health', '/api/atlas', '/dashboard.css', '/atlas.js']) {
    const response = await fetch(`${baseUrl}${path}`, { method: 'HEAD' });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '');
    assert.ok(Number(response.headers.get('content-length')) > 0 || path === '/api/health');
  }
});

test('live event stream is proxy-safe and immediately ready', async () => {
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/api/events`, { signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  assert.equal(response.headers.get('x-accel-buffering'), 'no');
  const reader = response.body.getReader();
  const { value } = await reader.read();
  assert.match(new TextDecoder().decode(value), /event: ready/);
  controller.abort();
});

test('write methods, malformed paths, and traversal attempts are rejected', async () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    for (const endpoint of ['/api/brain', '/api/atlas']) {
      const response = await fetch(`${baseUrl}${endpoint}`, { method });
      assert.equal(response.status, 405);
      assert.equal(response.headers.get('allow'), 'GET, HEAD');
    }
  }
  for (const path of ['/..%2F..%2FUSER.md', '/%2e%2e%2fMEMORY.md', '/%E0%A4%A']) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 404);
  }
});
