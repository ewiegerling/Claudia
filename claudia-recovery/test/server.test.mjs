import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { RECOVERY_ACTIONS } from '../server.mjs';
import { authorization, startTestServer, TEST_ORIGIN } from './helpers.mjs';

async function jsonRequest(baseUrl, route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    ...options,
    headers: { Authorization: authorization(), Accept: 'application/json', ...options.headers },
  });
  return { response, body: await response.json() };
}

test('health check is anonymous and deliberately minimal', async () => {
  const instance = await startTestServer();
  try {
    const response = await fetch(`${instance.baseUrl}/healthz`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  } finally { await instance.close(); }
});

test('every page and data route requires authentication', async () => {
  const instance = await startTestServer();
  try {
    for (const route of ['/', '/recovery.css', '/api/status', '/api/diagnostics']) {
      const response = await fetch(`${instance.baseUrl}${route}`);
      assert.equal(response.status, 401, route);
      assert.match(response.headers.get('www-authenticate'), /Claudia Recovery/);
    }
  } finally { await instance.close(); }
});

test('wrong credentials fail and correct credentials succeed', async () => {
  const instance = await startTestServer();
  try {
    const wrong = await fetch(`${instance.baseUrl}/`, { headers: { Authorization: authorization('wrong', 'still-a-long-but-wrong-password') } });
    assert.equal(wrong.status, 401);
    const correct = await fetch(`${instance.baseUrl}/`, { headers: { Authorization: authorization() } });
    assert.equal(correct.status, 200);
    assert.match(await correct.text(), /BREAK-GLASS RECOVERY/);
  } finally { await instance.close(); }
});

test('security headers fail closed on HTML and JSON', async () => {
  const instance = await startTestServer();
  try {
    for (const route of ['/', '/api/status']) {
      const response = await fetch(`${instance.baseUrl}${route}`, { headers: { Authorization: authorization() } });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
      assert.equal(response.headers.get('x-frame-options'), 'DENY');
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(response.headers.get('cache-control'), 'no-store, max-age=0');
      assert.match(response.headers.get('permissions-policy'), /microphone=\(\)/);
      assert.match(response.headers.get('strict-transport-security'), /63072000/);
    }
  } finally { await instance.close(); }
});

test('status and diagnostics expose only bounded recovery metadata', async () => {
  const instance = await startTestServer();
  try {
    const { response, body } = await jsonRequest(instance.baseUrl, '/api/diagnostics');
    assert.equal(response.status, 200);
    assert.equal(body.schema, 'claudia-recovery-diagnostics.v1');
    assert.equal(body.vault.commit, 'abc123def456');
    assert.equal(body.archives.length, 1);
    const serialized = JSON.stringify(body).toLowerCase();
    for (const forbidden of ['password', 'authorization', 'environment', 'private key', '/home/']) {
      assert.equal(serialized.includes(forbidden), false, forbidden);
    }
  } finally { await instance.close(); }
});

test('all and only fixed recovery actions execute', async () => {
  const instance = await startTestServer();
  try {
    for (const action of Object.keys(RECOVERY_ACTIONS)) {
      const { response, body } = await jsonRequest(instance.baseUrl, '/api/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: TEST_ORIGIN },
        body: JSON.stringify({ action }),
      });
      assert.equal(response.status, 200, action);
      assert.equal(body.ok, true);
    }
    assert.deepEqual(instance.actions, Object.keys(RECOVERY_ACTIONS));

    for (const body of [
      { action: 'restart_sshd' },
      { action: 'restart_gateway', unit: 'sshd.service' },
      { command: 'id' },
      { action: '../restart_gateway' },
    ]) {
      const result = await jsonRequest(instance.baseUrl, '/api/actions', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Origin: TEST_ORIGIN }, body: JSON.stringify(body),
      });
      assert.equal(result.response.status, 400);
    }
    assert.equal(instance.actions.length, 4);
  } finally { await instance.close(); }
});

test('state changes require the exact trusted origin', async () => {
  const instance = await startTestServer();
  try {
    for (const origin of [undefined, 'https://evil.example', `${TEST_ORIGIN}.evil.example`]) {
      const headers = { 'Content-Type': 'application/json' };
      if (origin) headers.Origin = origin;
      const { response } = await jsonRequest(instance.baseUrl, '/api/actions', {
        method: 'POST', headers, body: JSON.stringify({ action: 'restart_gateway' }),
      });
      assert.equal(response.status, 403);
    }
    assert.deepEqual(instance.actions, []);
  } finally { await instance.close(); }
});

test('POST bodies require JSON and reject malformed or oversized input', async () => {
  const instance = await startTestServer();
  try {
    const wrongType = await jsonRequest(instance.baseUrl, '/api/actions', {
      method: 'POST', headers: { 'Content-Type': 'text/plain', Origin: TEST_ORIGIN }, body: '{}',
    });
    assert.equal(wrongType.response.status, 415);
    const malformed = await jsonRequest(instance.baseUrl, '/api/actions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: TEST_ORIGIN }, body: '{',
    });
    assert.equal(malformed.response.status, 400);
    const oversized = await jsonRequest(instance.baseUrl, '/api/actions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: TEST_ORIGIN }, body: JSON.stringify({ action: 'x'.repeat(5_000) }),
    });
    assert.equal(oversized.response.status, 413);
  } finally { await instance.close(); }
});

test('unknown methods and traversal-like routes are rejected', async () => {
  const instance = await startTestServer();
  try {
    for (const [route, method] of [['/../server.mjs', 'GET'], ['/%2e%2e/server.mjs', 'GET'], ['/api/status', 'POST'], ['/', 'DELETE']]) {
      const response = await fetch(`${instance.baseUrl}${route}`, { method, headers: { Authorization: authorization() } });
      assert.equal(response.status, 404, `${method} ${route}`);
    }
  } finally { await instance.close(); }
});

test('authentication failures are rate limited', async () => {
  const instance = await startTestServer({ authLimit: { maximum: 2, windowMs: 60_000 } });
  try {
    for (let index = 0; index < 2; index += 1) {
      const response = await fetch(`${instance.baseUrl}/`, { headers: { Authorization: authorization('wrong', `wrong-password-value-${index}-long`) } });
      assert.equal(response.status, 401);
    }
    const blocked = await fetch(`${instance.baseUrl}/`, { headers: { Authorization: authorization() } });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers.get('retry-after'), '300');
  } finally { await instance.close(); }
});

test('successful and failed actions write redacted local audit evidence', async () => {
  const instance = await startTestServer({
    actionRunner: async (action) => {
      if (action === 'restart_voice') throw new Error('sensitive internal failure details');
      return { action, label: 'Gateway', units: ['openclaw-gateway.service'] };
    },
  });
  try {
    const ok = await jsonRequest(instance.baseUrl, '/api/actions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: TEST_ORIGIN }, body: JSON.stringify({ action: 'restart_gateway' }),
    });
    assert.equal(ok.response.status, 200);
    const failed = await jsonRequest(instance.baseUrl, '/api/actions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: TEST_ORIGIN }, body: JSON.stringify({ action: 'restart_voice' }),
    });
    assert.equal(failed.response.status, 502);
    assert.equal(JSON.stringify(failed.body).includes('sensitive'), false);
    const status = await jsonRequest(instance.baseUrl, '/api/status');
    assert.deepEqual(status.body.audit.map((entry) => entry.outcome), ['failed', 'completed']);
    assert.equal(JSON.stringify(status.body.audit).includes('password'), false);
  } finally { await instance.close(); }
});

test('source contains no shell execution or user-controlled process arguments', async () => {
  const source = await readFile(new URL('../server.mjs', import.meta.url), 'utf8');
  assert.equal(/\bexec\s*\(/.test(source), false);
  assert.equal(/shell\s*:\s*true/.test(source), false);
  assert.match(source, /Object\.hasOwn\(RECOVERY_ACTIONS, body\.action\)/);
  assert.match(source, /execFileAsync\('\/usr\/bin\/systemctl'/);
});
