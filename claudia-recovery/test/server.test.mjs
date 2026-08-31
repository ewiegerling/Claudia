import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
    for (const route of ['/', '/recovery.css', '/api/status', '/api/diagnostics', '/api/backups']) {
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

test('password rotation verifies current access and enforces the 12-character minimum', async () => {
  const rotations = [];
  const instance = await startTestServer({
    authenticationRotator: async (authentication, nextSecret) => {
      rotations.push({ username: authentication.username, nextSecret });
    },
  });
  const validHeaders = {
    'Content-Type': 'application/json',
    Origin: TEST_ORIGIN,
    'X-Claudia-Recovery': 'password-change',
  };
  const replacement = ['Twelve', 'chars', 'minimum', '42!'].join('-');
  const payload = (overrides = {}) => JSON.stringify({
    currentSecret: 'correct-horse-battery-staple-test',
    newSecret: replacement,
    confirmSecret: replacement,
    ...overrides,
  });
  try {
    const unauthorized = await fetch(`${instance.baseUrl}/api/settings/password`, {
      method: 'POST', headers: { ...validHeaders }, body: payload(),
    });
    assert.equal(unauthorized.status, 401);

    for (const headers of [
      { ...validHeaders, Origin: 'https://hostile.example' },
      { 'Content-Type': 'application/json', Origin: TEST_ORIGIN },
    ]) {
      const result = await jsonRequest(instance.baseUrl, '/api/settings/password', { method: 'POST', headers, body: payload() });
      assert.equal(result.response.status, 403);
    }

    for (const overrides of [
      { currentSecret: 'incorrect-current-recovery-secret' },
      { newSecret: '12345678901', confirmSecret: '12345678901' },
      { newSecret: replacement, confirmSecret: `${replacement}-different` },
      { newSecret: 'correct-horse-battery-staple-test', confirmSecret: 'correct-horse-battery-staple-test' },
      { newSecret: ` ${replacement}`, confirmSecret: ` ${replacement}` },
    ]) {
      const result = await jsonRequest(instance.baseUrl, '/api/settings/password', {
        method: 'POST', headers: validHeaders, body: payload(overrides),
      });
      assert.ok([400, 403].includes(result.response.status));
    }

    const extraProperty = await jsonRequest(instance.baseUrl, '/api/settings/password', {
      method: 'POST', headers: validHeaders, body: JSON.stringify({
        currentSecret: 'correct-horse-battery-staple-test', newSecret: replacement, confirmSecret: replacement, command: 'id',
      }),
    });
    assert.equal(extraProperty.response.status, 400);

    const success = await jsonRequest(instance.baseUrl, '/api/settings/password', {
      method: 'POST', headers: validHeaders, body: payload(),
    });
    assert.equal(success.response.status, 200);
    assert.equal(success.body.minimumCharacters, 12);
    assert.deepEqual(rotations, [{ username: 'recovery-test', nextSecret: replacement }]);

    const oldAccess = await fetch(`${instance.baseUrl}/api/status`, { headers: { Authorization: authorization() } });
    assert.equal(oldAccess.status, 401);
    const newAccess = await fetch(`${instance.baseUrl}/api/status`, {
      headers: { Authorization: authorization('recovery-test', replacement) },
    });
    assert.equal(newAccess.status, 200);
    const audit = (await newAccess.json()).audit;
    assert.equal(audit[0].action, 'rotate_recovery_password');
    assert.equal(JSON.stringify(audit).includes(replacement), false);
  } finally { await instance.close(); }
});

test('failed password encryption preserves the existing credential', async () => {
  const instance = await startTestServer({
    authenticationRotator: async () => { throw new Error('local encryption detail must stay private'); },
  });
  try {
    const replacement = ['Valid', 'replacement', 'secret', '42!'].join('-');
    const failed = await jsonRequest(instance.baseUrl, '/api/settings/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: TEST_ORIGIN, 'X-Claudia-Recovery': 'password-change' },
      body: JSON.stringify({
        currentSecret: 'correct-horse-battery-staple-test', newSecret: replacement, confirmSecret: replacement,
      }),
    });
    assert.equal(failed.response.status, 502);
    assert.equal(JSON.stringify(failed.body).includes('encryption detail'), false);
    const existingAccess = await fetch(`${instance.baseUrl}/api/status`, { headers: { Authorization: authorization() } });
    assert.equal(existingAccess.status, 200);
  } finally { await instance.close(); }
});

test('local vault snapshots are private, bounded, and detect archive tampering', async () => {
  const vaultRoot = await mkdtemp(path.join(os.tmpdir(), 'claudia-recovery-vault-'));
  await mkdir(path.join(vaultRoot, 'memory'));
  await writeFile(path.join(vaultRoot, 'MEMORY.md'), '# Test memory\nprivate-but-not-secret\n');
  await writeFile(path.join(vaultRoot, 'memory', '2026-08-31.md'), '# Daily memory\n');
  const instance = await startTestServer({ vaultRoot });
  const validHeaders = {
    'Content-Type': 'application/json',
    Origin: TEST_ORIGIN,
    'X-Claudia-Recovery': 'backup-create',
  };
  try {
    const empty = await jsonRequest(instance.baseUrl, '/api/backups');
    assert.equal(empty.response.status, 200);
    assert.deepEqual(empty.body.backups, []);
    assert.equal(empty.body.maximumBackups, 20);
    assert.equal(empty.body.localOnly, true);

    for (const headers of [
      { ...validHeaders, Origin: 'https://hostile.example' },
      { 'Content-Type': 'application/json', Origin: TEST_ORIGIN },
    ]) {
      const rejected = await jsonRequest(instance.baseUrl, '/api/backups', {
        method: 'POST', headers, body: JSON.stringify({ operation: 'create' }),
      });
      assert.equal(rejected.response.status, 403);
    }
    const extraProperty = await jsonRequest(instance.baseUrl, '/api/backups', {
      method: 'POST', headers: validHeaders, body: JSON.stringify({ operation: 'create', path: '/etc' }),
    });
    assert.equal(extraProperty.response.status, 400);

    const created = await jsonRequest(instance.baseUrl, '/api/backups', {
      method: 'POST', headers: validHeaders, body: JSON.stringify({ operation: 'create' }),
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.body.ok, true);
    assert.match(created.body.backup.id, /^claudia-\d{8}T\d{6}Z-[a-f0-9]{8}$/u);
    assert.match(created.body.backup.sha256, /^[a-f0-9]{64}$/u);
    assert.equal(created.body.backup.commit, null);

    const backupRoot = path.join(instance.stateRoot, 'backups');
    const archivePath = path.join(backupRoot, `${created.body.backup.id}.tar.zst`);
    const manifestPath = path.join(backupRoot, `${created.body.backup.id}.json`);
    for (const filePath of [archivePath, manifestPath]) {
      const details = await stat(filePath);
      assert.equal(details.mode & 0o777, 0o600);
    }
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    assert.equal(manifest.schema, 'claudia-local-backup.v1');
    assert.equal(JSON.stringify(manifest).includes(vaultRoot), false);

    const inventory = await jsonRequest(instance.baseUrl, '/api/backups');
    assert.equal(inventory.body.backups.length, 1);
    assert.equal(inventory.body.backups[0].id, created.body.backup.id);

    const verifyHeaders = {
      'Content-Type': 'application/json',
      Origin: TEST_ORIGIN,
      'X-Claudia-Recovery': 'backup-verify',
    };
    const verified = await jsonRequest(instance.baseUrl, '/api/backups/verify', {
      method: 'POST', headers: verifyHeaders, body: JSON.stringify({ backupId: created.body.backup.id }),
    });
    assert.equal(verified.response.status, 200);
    assert.equal(verified.body.backup.id, created.body.backup.id);

    const traversal = await jsonRequest(instance.baseUrl, '/api/backups/verify', {
      method: 'POST', headers: verifyHeaders, body: JSON.stringify({ backupId: '../../etc/passwd' }),
    });
    assert.equal(traversal.response.status, 400);

    await appendFile(archivePath, 'tamper');
    const tampered = await jsonRequest(instance.baseUrl, '/api/backups/verify', {
      method: 'POST', headers: verifyHeaders, body: JSON.stringify({ backupId: created.body.backup.id }),
    });
    assert.equal(tampered.response.status, 409);
    assert.equal(JSON.stringify(tampered.body).includes(archivePath), false);

    const status = await jsonRequest(instance.baseUrl, '/api/status');
    assert.deepEqual(
      status.body.audit.slice(0, 3).map((entry) => [entry.action, entry.outcome]),
      [
        ['verify_local_backup', 'failed'],
        ['verify_local_backup', 'completed'],
        ['create_local_backup', 'completed'],
      ],
    );
  } finally {
    await instance.close();
    await rm(vaultRoot, { recursive: true, force: true });
  }
});

test('backup failures are redacted and never mutate the existing inventory', async () => {
  const existing = [{
    id: 'claudia-20260831T090000Z-deadbeef',
    createdAt: '2026-08-31T09:00:00.000Z',
    bytes: 1024,
    sha256: 'a'.repeat(64),
    verifiedAt: '2026-08-31T09:00:00.000Z',
    commit: 'abc123def456',
    pendingChanges: 2,
  }];
  const instance = await startTestServer({
    backupLister: async () => existing,
    backupCreator: async () => { throw new Error('/opt/operator/private credential detail'); },
  });
  try {
    const failed = await jsonRequest(instance.baseUrl, '/api/backups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: TEST_ORIGIN, 'X-Claudia-Recovery': 'backup-create' },
      body: JSON.stringify({ operation: 'create' }),
    });
    assert.equal(failed.response.status, 502);
    assert.equal(JSON.stringify(failed.body).includes('/home/'), false);
    const inventory = await jsonRequest(instance.baseUrl, '/api/backups');
    assert.deepEqual(inventory.body.backups, existing);
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
