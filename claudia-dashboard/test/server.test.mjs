import assert from 'node:assert/strict';
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

test('new SPA and every local asset are served without remote dependencies', async () => {
  const paths = ['/', '/index.html', '/dashboard.css?v=1', '/dashboard.js?v=1', '/manifest.webmanifest', '/icon.svg'];
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
  for (const path of ['/', '/api/health', '/dashboard.css']) {
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
    const response = await fetch(`${baseUrl}/api/brain`, { method });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET, HEAD');
  }
  for (const path of ['/..%2F..%2FUSER.md', '/%2e%2e%2fMEMORY.md', '/%E0%A4%A']) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 404);
  }
});
