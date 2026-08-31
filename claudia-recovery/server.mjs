import { execFile, spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import crypto from 'node:crypto';
import { appendFile, chmod, lstat, mkdir, readFile, readdir, rename, stat, statfs, unlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_ROOT = path.join(ROOT, 'public');
const DEFAULT_STATE_ROOT = path.join(os.homedir(), '.local', 'state', 'claudia-recovery');
const DEFAULT_ARCHIVE_ROOT = path.join(os.homedir(), '.openclaw', 'recovery');
const DEFAULT_BACKUP_ROOT = path.join(DEFAULT_ARCHIVE_ROOT, 'claudia-backups');
const DEFAULT_VAULT_ROOT = path.join(os.homedir(), '.openclaw', 'workspace');
const MAX_BODY_BYTES = 4_096;
const MAX_AUDIT_BYTES = 1_048_576;
const MINIMUM_SECRET_CHARACTERS = 12;
const MAXIMUM_SECRET_CHARACTERS = 128;
const AUTH_CREDENTIAL_NAME = 'recovery-auth';
const BACKUP_SCHEMA = 'claudia-local-backup.v1';
const BACKUP_ID_PATTERN = /^claudia-\d{8}T\d{6}Z-[a-f0-9]{8}$/u;
const MAXIMUM_BACKUPS = 20;
const MINIMUM_FREE_BACKUP_BYTES = 1_073_741_824;
const MAXIMUM_BACKUP_BYTES = 2_147_483_648;

export const RECOVERY_ACTIONS = Object.freeze({
  restart_gateway: {
    label: 'Restart OpenClaw gateway',
    units: ['openclaw-gateway.service'],
  },
  restart_dashboard: {
    label: 'Restart dashboard',
    units: ['claudia-dashboard.service'],
  },
  restart_voice: {
    label: 'Restart voice stack',
    units: ['claudia-stt.service', 'claudia-tts.service'],
  },
  restart_claudia: {
    label: 'Restart Claudia stack',
    units: [
      'openclaw-gateway.service',
      'claudia-stt.service',
      'claudia-tts.service',
      'claudia-dashboard.service',
    ],
  },
});

export const MONITORED_UNITS = Object.freeze([
  'openclaw-gateway.service',
  'claudia-dashboard.service',
  'claudia-stt.service',
  'claudia-tts.service',
  'claudia-recovery.service',
]);

const STATIC_FILES = Object.freeze({
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/recovery.css': ['recovery.css', 'text/css; charset=utf-8'],
  '/recovery.js': ['recovery.js', 'text/javascript; charset=utf-8'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
});

function secureEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  const width = Math.max(a.length, b.length, 1);
  const paddedA = Buffer.alloc(width);
  const paddedB = Buffer.alloc(width);
  a.copy(paddedA);
  b.copy(paddedB);
  return crypto.timingSafeEqual(paddedA, paddedB) && a.length === b.length;
}

function parseBasicAuthorization(header = '') {
  if (!header.startsWith('Basic ')) return null;
  let decoded;
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  } catch {
    return null;
  }
  const separator = decoded.indexOf(':');
  if (separator < 1) return null;
  return { username: decoded.slice(0, separator), secret: decoded.slice(separator + 1) };
}

function loadAuthCredential(environment = process.env) {
  const explicit = environment.RECOVERY_AUTH_FILE;
  const credentialDirectory = environment.CREDENTIALS_DIRECTORY;
  const credentialPath = explicit || (credentialDirectory && path.join(credentialDirectory, AUTH_CREDENTIAL_NAME));
  if (!credentialPath) throw new Error('Recovery authentication credential is not configured.');
  return readFile(credentialPath, 'utf8').then((value) => {
    const trimmed = value.trim();
    const separator = trimmed.indexOf(':');
    const secretCharacters = [...trimmed.slice(separator + 1)].length;
    if (separator < 1 || secretCharacters < MINIMUM_SECRET_CHARACTERS || secretCharacters > MAXIMUM_SECRET_CHARACTERS) {
      throw new Error(`Recovery credential must use username:password with a ${MINIMUM_SECRET_CHARACTERS}–${MAXIMUM_SECRET_CHARACTERS} character password.`);
    }
    return { username: trimmed.slice(0, separator), secret: trimmed.slice(separator + 1) };
  });
}

function securityHeaders(contentType) {
  return {
    'Cache-Control': 'no-store, max-age=0',
    'Content-Security-Policy': "default-src 'none'; base-uri 'none'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self'; manifest-src 'self'; script-src 'self'; style-src 'self'",
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
    'Referrer-Policy': 'no-referrer',
    'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    ...(contentType ? { 'Content-Type': contentType } : {}),
  };
}

function sendJson(response, statusCode, value, extraHeaders = {}) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    ...securityHeaders('application/json; charset=utf-8'),
    'Content-Length': Buffer.byteLength(body),
    ...extraHeaders,
  });
  response.end(body);
}

async function readJsonBody(request) {
  const contentType = request.headers['content-type'] || '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    const error = new Error('Content-Type must be application/json.');
    error.statusCode = 415;
    throw error;
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error('Request body is too large.');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('Request body must be valid JSON.');
    error.statusCode = 400;
    throw error;
  }
}

function parseSystemdProperties(output) {
  return Object.fromEntries(output.trim().split('\n').filter(Boolean).map((line) => {
    const separator = line.indexOf('=');
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
}

async function inspectUnit(unit) {
  try {
    const { stdout } = await execFileAsync('/usr/bin/systemctl', [
      '--user', 'show', unit,
      '--property=Id,LoadState,ActiveState,SubState,MainPID,ExecMainStatus,ActiveEnterTimestamp',
      '--no-pager',
    ], { timeout: 5_000, maxBuffer: 64 * 1024 });
    const properties = parseSystemdProperties(stdout);
    return {
      unit,
      load: properties.LoadState || 'unknown',
      active: properties.ActiveState || 'unknown',
      sub: properties.SubState || 'unknown',
      pid: Number(properties.MainPID || 0),
      exitCode: Number(properties.ExecMainStatus || 0),
      since: properties.ActiveEnterTimestamp || null,
    };
  } catch {
    return { unit, load: 'unknown', active: 'unknown', sub: 'unknown', pid: 0, exitCode: -1, since: null };
  }
}

async function inspectVault(vaultRoot) {
  try {
    const [{ stdout: branch }, { stdout: commit }, { stdout: statusOutput }] = await Promise.all([
      execFileAsync('/usr/bin/git', ['branch', '--show-current'], { cwd: vaultRoot, timeout: 4_000 }),
      execFileAsync('/usr/bin/git', ['rev-parse', '--short=12', 'HEAD'], { cwd: vaultRoot, timeout: 4_000 }),
      execFileAsync('/usr/bin/git', ['status', '--porcelain=v1'], { cwd: vaultRoot, timeout: 4_000, maxBuffer: 256 * 1024 }),
    ]);
    return {
      available: true,
      branch: branch.trim() || 'detached',
      commit: commit.trim(),
      pendingChanges: statusOutput.split('\n').filter(Boolean).length,
    };
  } catch {
    return { available: false, branch: null, commit: null, pendingChanges: null };
  }
}

async function inspectArchives(archiveRoot) {
  try {
    const entries = await readdir(archiveRoot, { withFileTypes: true });
    const archives = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[A-Za-z0-9._-]{1,120}$/.test(entry.name)) continue;
      const details = await stat(path.join(archiveRoot, entry.name));
      archives.push({ name: entry.name, modifiedAt: details.mtime.toISOString() });
    }
    return archives.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)).slice(0, 12);
  } catch {
    return [];
  }
}

async function defaultStatusProvider({ archiveRoot, vaultRoot }) {
  const [services, vault, archives] = await Promise.all([
    Promise.all(MONITORED_UNITS.map(inspectUnit)),
    inspectVault(vaultRoot),
    inspectArchives(archiveRoot),
  ]);
  const memory = {
    total: os.totalmem(),
    free: os.freemem(),
    usedPercent: Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 1_000) / 10,
  };
  let disk = { total: null, free: null, usedPercent: null };
  try {
    const fs = await import('node:fs/promises');
    const details = await fs.statfs(vaultRoot);
    const total = details.blocks * details.bsize;
    const free = details.bavail * details.bsize;
    disk = { total, free, usedPercent: Math.round(((total - free) / total) * 1_000) / 10 };
  } catch {
    // A missing vault is itself visible through vault.available.
  }
  return {
    generatedAt: new Date().toISOString(),
    uptimeSeconds: Math.round(os.uptime()),
    services,
    resources: { memory, disk, loadAverage: os.loadavg().map((value) => Math.round(value * 100) / 100) },
    vault,
    archives,
  };
}

async function defaultActionRunner(action) {
  const definition = RECOVERY_ACTIONS[action];
  for (const unit of definition.units) {
    await execFileAsync('/usr/bin/systemctl', ['--user', 'restart', unit, '--no-pager'], {
      timeout: 20_000,
      maxBuffer: 128 * 1024,
    });
  }
  return { action, label: definition.label, units: [...definition.units] };
}

async function ensureBackupRoot(backupRoot) {
  await mkdir(backupRoot, { recursive: true, mode: 0o700 });
  const details = await lstat(backupRoot);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw Object.assign(new Error('Backup root is not a private directory.'), { statusCode: 503 });
  }
  await chmod(backupRoot, 0o700);
}

function publicBackupRecord(record) {
  return {
    id: record.id,
    createdAt: record.createdAt,
    bytes: record.bytes,
    sha256: record.sha256,
    verifiedAt: record.verifiedAt,
    commit: record.commit,
    pendingChanges: record.pendingChanges,
  };
}

function validBackupRecord(record) {
  return record
    && record.schema === BACKUP_SCHEMA
    && BACKUP_ID_PATTERN.test(record.id)
    && typeof record.createdAt === 'string'
    && Number.isFinite(Date.parse(record.createdAt))
    && Number.isSafeInteger(record.bytes)
    && record.bytes > 0
    && record.bytes <= MAXIMUM_BACKUP_BYTES
    && typeof record.sha256 === 'string'
    && /^[a-f0-9]{64}$/u.test(record.sha256)
    && (record.verifiedAt === null || (typeof record.verifiedAt === 'string' && Number.isFinite(Date.parse(record.verifiedAt))))
    && (record.commit === null || (typeof record.commit === 'string' && /^[a-f0-9]{7,40}$/u.test(record.commit)))
    && (record.pendingChanges === null || (Number.isSafeInteger(record.pendingChanges) && record.pendingChanges >= 0));
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

async function writeBackupManifest(backupRoot, record) {
  const finalPath = path.join(backupRoot, `${record.id}.json`);
  const temporaryPath = `${finalPath}.next-${crypto.randomUUID()}`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, finalPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

async function listLocalBackups({ backupRoot }) {
  await ensureBackupRoot(backupRoot);
  const entries = await readdir(backupRoot, { withFileTypes: true });
  const records = [];
  for (const entry of entries.slice(0, 200)) {
    if (!entry.isFile() || !/^claudia-\d{8}T\d{6}Z-[a-f0-9]{8}\.json$/u.test(entry.name)) continue;
    try {
      const record = JSON.parse(await readFile(path.join(backupRoot, entry.name), 'utf8'));
      if (!validBackupRecord(record)) continue;
      const archive = await lstat(path.join(backupRoot, `${record.id}.tar.zst`));
      if (!archive.isFile() || archive.isSymbolicLink() || archive.size !== record.bytes) continue;
      records.push(publicBackupRecord(record));
    } catch {
      // Invalid or incomplete backup pairs are omitted rather than exposed.
    }
  }
  return records.sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, MAXIMUM_BACKUPS);
}

async function createLocalBackup({ backupRoot, vaultRoot }) {
  await ensureBackupRoot(backupRoot);
  const existing = await listLocalBackups({ backupRoot });
  if (existing.length >= MAXIMUM_BACKUPS) {
    throw Object.assign(new Error(`Backup limit of ${MAXIMUM_BACKUPS} reached.`), { statusCode: 507 });
  }
  const capacity = await statfs(backupRoot);
  if (capacity.bavail * capacity.bsize < MINIMUM_FREE_BACKUP_BYTES) {
    throw Object.assign(new Error('At least 1 GiB of free space is required for a local snapshot.'), { statusCode: 507 });
  }
  const vaultDetails = await lstat(vaultRoot);
  if (!vaultDetails.isDirectory() || vaultDetails.isSymbolicLink()) {
    throw Object.assign(new Error('Vault root is unavailable or unsafe.'), { statusCode: 503 });
  }
  const now = new Date();
  const stamp = now.toISOString().replaceAll('-', '').replaceAll(':', '').replace(/\.\d{3}Z$/u, 'Z');
  const id = `claudia-${stamp}-${crypto.randomBytes(4).toString('hex')}`;
  const archivePath = path.join(backupRoot, `${id}.tar.zst`);
  const temporaryArchive = `${archivePath}.partial-${crypto.randomUUID()}`;
  try {
    await execFileAsync('/usr/bin/tar', [
      '--create', '--zstd', '--one-file-system', '--file', temporaryArchive,
      '--directory', path.dirname(vaultRoot),
      '--exclude=.git', '--exclude=node_modules', '--exclude=coverage',
      path.basename(vaultRoot),
    ], { timeout: 180_000, maxBuffer: 128 * 1024 });
    await chmod(temporaryArchive, 0o600);
    const archive = await lstat(temporaryArchive);
    if (!archive.isFile() || archive.isSymbolicLink() || archive.size < 1 || archive.size > MAXIMUM_BACKUP_BYTES) {
      throw new Error('Generated backup size is outside the permitted bounds.');
    }
    const [sha256, vault] = await Promise.all([sha256File(temporaryArchive), inspectVault(vaultRoot)]);
    await rename(temporaryArchive, archivePath);
    const record = {
      schema: BACKUP_SCHEMA,
      id,
      createdAt: now.toISOString(),
      bytes: archive.size,
      sha256,
      verifiedAt: now.toISOString(),
      commit: vault.commit,
      pendingChanges: vault.pendingChanges,
    };
    try {
      await writeBackupManifest(backupRoot, record);
    } catch (error) {
      await unlink(archivePath).catch(() => {});
      throw error;
    }
    return publicBackupRecord(record);
  } catch (error) {
    await unlink(temporaryArchive).catch(() => {});
    throw error;
  }
}

async function verifyLocalBackup({ backupRoot, backupId }) {
  if (!BACKUP_ID_PATTERN.test(backupId)) {
    throw Object.assign(new Error('Backup identifier is invalid.'), { statusCode: 400 });
  }
  await ensureBackupRoot(backupRoot);
  const manifestPath = path.join(backupRoot, `${backupId}.json`);
  const archivePath = path.join(backupRoot, `${backupId}.tar.zst`);
  const record = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!validBackupRecord(record) || record.id !== backupId) {
    throw Object.assign(new Error('Backup manifest is invalid.'), { statusCode: 409 });
  }
  const archive = await lstat(archivePath);
  if (!archive.isFile() || archive.isSymbolicLink() || archive.size !== record.bytes) {
    throw Object.assign(new Error('Backup archive metadata does not match its manifest.'), { statusCode: 409 });
  }
  const calculated = await sha256File(archivePath);
  if (!secureEqual(calculated, record.sha256)) {
    throw Object.assign(new Error('Backup integrity verification failed.'), { statusCode: 409 });
  }
  const verified = { ...record, verifiedAt: new Date().toISOString() };
  await writeBackupManifest(backupRoot, verified);
  return publicBackupRecord(verified);
}

async function rotateRecoveryAuthentication(authentication, nextSecret) {
  const credentialPath = process.env.RECOVERY_AUTH_CREDENTIAL_PATH;
  if (!credentialPath) throw Object.assign(new Error('Password rotation is unavailable.'), { statusCode: 503 });
  const temporaryPath = `${credentialPath}.next-${crypto.randomUUID()}`;
  try {
    await mkdir(path.dirname(credentialPath), { recursive: true, mode: 0o700 });
    await new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/systemd-creds', [
        'encrypt', '--user', `--name=${AUTH_CREDENTIAL_NAME}`, '-', temporaryPath,
      ], { stdio: ['pipe', 'ignore', 'pipe'] });
      let diagnostic = '';
      const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => { diagnostic = `${diagnostic}${chunk}`.slice(-1_000); });
      child.on('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timeout);
        if (code === 0) resolve();
        else reject(new Error(`Credential encryption failed (${code}): ${diagnostic.trim()}`));
      });
      child.stdin.end(`${authentication.username}:${nextSecret}`);
    });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, credentialPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
  setTimeout(() => {
    execFile('/usr/bin/systemctl', ['--user', 'restart', '--no-block', 'claudia-recovery.service'], (error) => {
      if (error) console.error('Recovery restart after password rotation failed:', error.message);
    });
  }, 800).unref();
}

function validReplacementSecret(value) {
  if (typeof value !== 'string') return false;
  const length = [...value].length;
  return length >= MINIMUM_SECRET_CHARACTERS
    && length <= MAXIMUM_SECRET_CHARACTERS
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

async function rotateAuditLog(auditPath) {
  try {
    const details = await stat(auditPath);
    if (details.size > MAX_AUDIT_BYTES) await rename(auditPath, `${auditPath}.1`);
  } catch {
    // No log yet.
  }
}

async function appendAudit(auditPath, event) {
  await mkdir(path.dirname(auditPath), { recursive: true, mode: 0o700 });
  await rotateAuditLog(auditPath);
  await appendFile(auditPath, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
}

async function recentAudit(auditPath) {
  try {
    return (await readFile(auditPath, 'utf8')).trim().split('\n').filter(Boolean).slice(-20).reverse().map((line) => {
      try {
        const entry = JSON.parse(line);
        return { at: entry.at, action: entry.action, outcome: entry.outcome };
      } catch {
        return null;
      }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function createFailureLimiter({ maximum = 6, windowMs = 5 * 60_000 } = {}) {
  const failures = new Map();
  return {
    blocked(key) {
      const current = failures.get(key);
      if (!current || Date.now() - current.startedAt > windowMs) {
        failures.delete(key);
        return false;
      }
      return current.count >= maximum;
    },
    fail(key) {
      const current = failures.get(key);
      if (!current || Date.now() - current.startedAt > windowMs) {
        failures.set(key, { count: 1, startedAt: Date.now() });
      } else {
        current.count += 1;
      }
    },
    clear(key) { failures.delete(key); },
  };
}

export function createRecoveryServer(options = {}) {
  const auth = options.auth;
  if (!auth?.username || !auth?.secret) throw new Error('A recovery username and password are required.');
  const host = options.host || '127.0.0.1';
  const port = Number(options.port || 4318);
  const auditPath = options.auditPath || path.join(DEFAULT_STATE_ROOT, 'audit.jsonl');
  const archiveRoot = options.archiveRoot || DEFAULT_ARCHIVE_ROOT;
  const backupRoot = options.backupRoot || process.env.RECOVERY_BACKUP_ROOT || DEFAULT_BACKUP_ROOT;
  const vaultRoot = options.vaultRoot || DEFAULT_VAULT_ROOT;
  const allowedOrigins = new Set(options.allowedOrigins || [
    'https://recovery.example.com',
    `http://${host}:${port}`,
  ]);
  const statusProvider = options.statusProvider || defaultStatusProvider;
  const actionRunner = options.actionRunner || defaultActionRunner;
  const authenticationRotator = options.authenticationRotator || rotateRecoveryAuthentication;
  const backupLister = options.backupLister || listLocalBackups;
  const backupCreator = options.backupCreator || createLocalBackup;
  const backupVerifier = options.backupVerifier || verifyLocalBackup;
  const authLimiter = createFailureLimiter(options.authLimit);
  let actionInFlight = false;

  const server = http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url || '/', 'http://recovery.local');
    const remote = request.socket.remoteAddress || 'unknown';
    const method = request.method || 'GET';

    if (requestUrl.pathname === '/healthz' && method === 'GET') {
      sendJson(response, 200, { ok: true });
      return;
    }

    if (authLimiter.blocked(remote)) {
      sendJson(response, 429, { error: 'Too many authentication failures. Try again later.' }, { 'Retry-After': '300' });
      return;
    }
    const presented = parseBasicAuthorization(request.headers.authorization);
    const authenticated = presented
      && secureEqual(presented.username, auth.username)
      && secureEqual(presented.secret, auth.secret);
    if (!authenticated) {
      authLimiter.fail(remote);
      sendJson(response, 401, { error: 'Authentication required.' }, {
        'WWW-Authenticate': 'Basic realm="Claudia Recovery", charset="UTF-8"',
      });
      return;
    }
    authLimiter.clear(remote);

    try {
      if (requestUrl.pathname === '/api/status' && method === 'GET') {
        const status = await statusProvider({ archiveRoot, vaultRoot });
        sendJson(response, 200, { ...status, audit: await recentAudit(auditPath) });
        return;
      }

      if (requestUrl.pathname === '/api/diagnostics' && method === 'GET') {
        const status = await statusProvider({ archiveRoot, vaultRoot });
        sendJson(response, 200, {
          schema: 'claudia-recovery-diagnostics.v1',
          ...status,
          audit: await recentAudit(auditPath),
        }, { 'Content-Disposition': 'attachment; filename="claudia-recovery-diagnostics.json"' });
        return;
      }

      if (requestUrl.pathname === '/api/backups' && method === 'GET') {
        const backups = await backupLister({ backupRoot, vaultRoot });
        sendJson(response, 200, { backups, maximumBackups: MAXIMUM_BACKUPS, localOnly: true });
        return;
      }

      if (requestUrl.pathname === '/api/backups' && method === 'POST') {
        const origin = request.headers.origin;
        if (!origin || !allowedOrigins.has(origin) || request.headers['x-claudia-recovery'] !== 'backup-create') {
          sendJson(response, 403, { error: 'Backup creation requires trusted same-origin intent.' });
          return;
        }
        if (actionInFlight) {
          sendJson(response, 409, { error: 'Another recovery operation is already running.' });
          return;
        }
        const body = await readJsonBody(request);
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || body.operation !== 'create') {
          sendJson(response, 400, { error: 'Body must request only local backup creation.' });
          return;
        }
        actionInFlight = true;
        const startedAt = new Date().toISOString();
        try {
          const backup = await backupCreator({ backupRoot, vaultRoot });
          await appendAudit(auditPath, { at: startedAt, action: 'create_local_backup', outcome: 'completed' });
          sendJson(response, 201, { ok: true, backup });
        } catch {
          await appendAudit(auditPath, { at: startedAt, action: 'create_local_backup', outcome: 'failed' });
          sendJson(response, 502, { error: 'Local backup creation failed. Existing backups were not changed.' });
        } finally {
          actionInFlight = false;
        }
        return;
      }

      if (requestUrl.pathname === '/api/backups/verify' && method === 'POST') {
        const origin = request.headers.origin;
        if (!origin || !allowedOrigins.has(origin) || request.headers['x-claudia-recovery'] !== 'backup-verify') {
          sendJson(response, 403, { error: 'Backup verification requires trusted same-origin intent.' });
          return;
        }
        if (actionInFlight) {
          sendJson(response, 409, { error: 'Another recovery operation is already running.' });
          return;
        }
        const body = await readJsonBody(request);
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || typeof body.backupId !== 'string' || !BACKUP_ID_PATTERN.test(body.backupId)) {
          sendJson(response, 400, { error: 'A valid managed backup identifier is required.' });
          return;
        }
        actionInFlight = true;
        const startedAt = new Date().toISOString();
        try {
          const backup = await backupVerifier({ backupRoot, backupId: body.backupId });
          await appendAudit(auditPath, { at: startedAt, action: 'verify_local_backup', outcome: 'completed' });
          sendJson(response, 200, { ok: true, backup });
        } catch {
          await appendAudit(auditPath, { at: startedAt, action: 'verify_local_backup', outcome: 'failed' });
          sendJson(response, 409, { error: 'Backup integrity verification failed.' });
        } finally {
          actionInFlight = false;
        }
        return;
      }

      if (requestUrl.pathname === '/api/settings/password' && method === 'POST') {
        const origin = request.headers.origin;
        if (!origin || !allowedOrigins.has(origin) || request.headers['x-claudia-recovery'] !== 'password-change') {
          sendJson(response, 403, { error: 'Password rotation requires trusted same-origin intent.' });
          return;
        }
        if (actionInFlight) {
          sendJson(response, 409, { error: 'Another recovery operation is already running.' });
          return;
        }
        const body = await readJsonBody(request);
        const validShape = body
          && typeof body === 'object'
          && !Array.isArray(body)
          && Object.keys(body).sort().join(',') === 'confirmSecret,currentSecret,newSecret'
          && typeof body.currentSecret === 'string'
          && typeof body.newSecret === 'string'
          && typeof body.confirmSecret === 'string';
        if (!validShape) {
          sendJson(response, 400, { error: 'Password rotation body is invalid.' });
          return;
        }
        if (!secureEqual(body.currentSecret, auth.secret)) {
          sendJson(response, 403, { error: 'The current recovery password is incorrect.' });
          return;
        }
        if (!validReplacementSecret(body.newSecret)) {
          sendJson(response, 400, { error: `The new password must contain ${MINIMUM_SECRET_CHARACTERS}–${MAXIMUM_SECRET_CHARACTERS} characters with no leading, trailing, or control whitespace.` });
          return;
        }
        if (body.newSecret !== body.confirmSecret) {
          sendJson(response, 400, { error: 'The new passwords do not match.' });
          return;
        }
        if (secureEqual(body.newSecret, auth.secret)) {
          sendJson(response, 400, { error: 'The new password must differ from the current password.' });
          return;
        }
        actionInFlight = true;
        const startedAt = new Date().toISOString();
        try {
          await authenticationRotator(auth, body.newSecret);
          auth.secret = body.newSecret;
          await appendAudit(auditPath, { at: startedAt, action: 'rotate_recovery_password', outcome: 'completed' });
          sendJson(response, 200, { ok: true, minimumCharacters: MINIMUM_SECRET_CHARACTERS });
        } catch {
          await appendAudit(auditPath, { at: startedAt, action: 'rotate_recovery_password', outcome: 'failed' });
          sendJson(response, 502, { error: 'Recovery password rotation failed. The existing password is unchanged.' });
        } finally {
          actionInFlight = false;
        }
        return;
      }

      if (requestUrl.pathname === '/api/actions' && method === 'POST') {
        const origin = request.headers.origin;
        if (!origin || !allowedOrigins.has(origin)) {
          sendJson(response, 403, { error: 'Request origin is not allowed.' });
          return;
        }
        if (actionInFlight) {
          sendJson(response, 409, { error: 'Another recovery action is already running.' });
          return;
        }
        const body = await readJsonBody(request);
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || typeof body.action !== 'string') {
          sendJson(response, 400, { error: 'Body must contain only a recovery action.' });
          return;
        }
        if (!Object.hasOwn(RECOVERY_ACTIONS, body.action)) {
          sendJson(response, 400, { error: 'Unknown recovery action.' });
          return;
        }
        actionInFlight = true;
        const startedAt = new Date().toISOString();
        try {
          const result = await actionRunner(body.action);
          await appendAudit(auditPath, { at: startedAt, action: body.action, outcome: 'completed' });
          sendJson(response, 200, { ok: true, result });
        } catch {
          await appendAudit(auditPath, { at: startedAt, action: body.action, outcome: 'failed' });
          sendJson(response, 502, { error: 'The recovery action failed. Check service status and the local journal.' });
        } finally {
          actionInFlight = false;
        }
        return;
      }

      if ((method === 'GET' || method === 'HEAD') && Object.hasOwn(STATIC_FILES, requestUrl.pathname)) {
        const [file, contentType] = STATIC_FILES[requestUrl.pathname];
        const body = await readFile(path.join(PUBLIC_ROOT, file));
        response.writeHead(200, {
          ...securityHeaders(contentType),
          'Content-Length': body.length,
        });
        response.end(method === 'HEAD' ? undefined : body);
        return;
      }

      sendJson(response, 404, { error: 'Not found.' });
    } catch (error) {
      sendJson(response, error.statusCode || 500, {
        error: error.statusCode ? error.message : 'Internal recovery portal error.',
      });
    }
  });

  return { server, host, port };
}

async function main() {
  const host = process.env.RECOVERY_HOST || '127.0.0.1';
  const port = Number(process.env.RECOVERY_PORT || 4318);
  const auth = await loadAuthCredential();
  const allowedOrigins = (process.env.RECOVERY_ALLOWED_ORIGINS || `https://recovery.example.com,http://${host}:${port}`)
    .split(',').map((value) => value.trim()).filter(Boolean);
  const app = createRecoveryServer({ auth, host, port, allowedOrigins });
  app.server.listen(port, host, () => {
    console.log(`Claudia Recovery listening on http://${host}:${port}`);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
