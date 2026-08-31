import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRecoveryServer } from '../server.mjs';

export const TEST_USER = 'recovery-test';
export const TEST_SECRET = ['correct', 'horse', 'battery', 'staple', 'test'].join('-');
export const TEST_ORIGIN = 'https://recovery.example.test';

export function authorization(username = TEST_USER, secret = TEST_SECRET) {
  return `Basic ${Buffer.from(`${username}:${secret}`).toString('base64')}`;
}

export function sampleStatus() {
  return {
    generatedAt: '2026-08-30T12:00:00.000Z',
    uptimeSeconds: 93_780,
    services: [
      { unit: 'openclaw-gateway.service', load: 'loaded', active: 'active', sub: 'running', pid: 100, exitCode: 0, since: 'now' },
      { unit: 'claudia-dashboard.service', load: 'loaded', active: 'active', sub: 'running', pid: 101, exitCode: 0, since: 'now' },
      { unit: 'claudia-stt.service', load: 'loaded', active: 'active', sub: 'running', pid: 102, exitCode: 0, since: 'now' },
      { unit: 'claudia-tts.service', load: 'loaded', active: 'active', sub: 'running', pid: 103, exitCode: 0, since: 'now' },
      { unit: 'claudia-recovery.service', load: 'loaded', active: 'active', sub: 'running', pid: 104, exitCode: 0, since: 'now' },
    ],
    resources: {
      memory: { total: 16_000, free: 8_000, usedPercent: 50 },
      disk: { total: 100_000, free: 60_000, usedPercent: 40 },
      loadAverage: [0.2, 0.3, 0.4],
    },
    vault: { available: true, branch: 'main', commit: 'abc123def456', pendingChanges: 2 },
    archives: [{ name: 'panel.example.test-2026-08-30', modifiedAt: '2026-08-30T11:00:00.000Z' }],
  };
}

export async function startTestServer(options = {}) {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'claudia-recovery-test-'));
  const actions = [];
  const app = createRecoveryServer({
    auth: { username: TEST_USER, secret: TEST_SECRET },
    host: '127.0.0.1',
    port: 0,
    allowedOrigins: [TEST_ORIGIN],
    auditPath: path.join(stateRoot, 'audit.jsonl'),
    statusProvider: async () => sampleStatus(),
    actionRunner: async (action) => {
      actions.push(action);
      return { action, label: action.replaceAll('_', ' '), units: ['example.service'] };
    },
    ...options,
  });
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(0, '127.0.0.1', resolve);
  });
  const address = app.server.address();
  return {
    app,
    actions,
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => app.server.close((error) => error ? reject(error) : resolve())),
  };
}
