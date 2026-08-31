#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mirrorsRoot = path.resolve(os.homedir(), '.openclaw', 'public-mirrors');
const destination = path.resolve(process.argv[2] || path.join(mirrorsRoot, 'Claudia'));
const guardDirectory = path.resolve(
  process.env.CLAUDIA_PUBLICATION_GUARD_DIR
    || path.join(os.homedir(), '.openclaw', 'publication-guard', 'Claudia'),
);
const privateBlocklistPath = path.join(guardDirectory, 'blocklist.txt');
const privateReplacementsPath = path.join(guardDirectory, 'replacements.json');

if (destination === source || !destination.startsWith(`${mirrorsRoot}${path.sep}`)) {
  throw new Error(`Refusing unsafe public-export destination: ${destination}`);
}

const safeSources = [
  '.obsidian/app.json',
  '.obsidian/appearance.json',
  '.obsidian/community-plugins.json',
  '.obsidian/core-plugins.json',
  '.obsidian/daily-notes.json',
  '.obsidian/graph.json',
  '.obsidian/snippets/claudia-vault.css',
  '.obsidian/templates.json',
  'HEARTBEAT.md',
  'IDENTITY.md',
  'claudia-dashboard/AUDIT.md',
  'claudia-dashboard/README.md',
  'claudia-dashboard/THIRD_PARTY_NOTICES.md',
  'claudia-dashboard/atlas.mjs',
  'claudia-dashboard/package-lock.json',
  'claudia-dashboard/package.json',
  'claudia-dashboard/public/atlas.js',
  'claudia-dashboard/public/dashboard.css',
  'claudia-dashboard/public/dashboard.js',
  'claudia-dashboard/public/icon.svg',
  'claudia-dashboard/public/index.html',
  'claudia-dashboard/public/manifest.webmanifest',
  'claudia-dashboard/server.mjs',
  'claudia-dashboard/voice.mjs',
  'claudia-dashboard/scripts/install-voice-runtime.sh',
  'claudia-dashboard/scripts/lighthouse-voice-audit.mjs',
  'claudia-dashboard/systemd/claudia-dashboard.service',
  'claudia-dashboard/systemd/claudia-stt.service',
  'claudia-dashboard/systemd/claudia-tts.service',
  'claudia-dashboard/tts-server.py',
  'claudia-dashboard/test/accessibility.test.mjs',
  'claudia-dashboard/test/atlas.test.mjs',
  'claudia-dashboard/test/browser.test.mjs',
  'claudia-dashboard/test/cross-browser.test.mjs',
  'claudia-dashboard/test/server.test.mjs',
  'claudia-dashboard/test/voice.test.mjs',
  'claudia-recovery/AUDIT.md',
  'claudia-recovery/README.md',
  'claudia-recovery/package-lock.json',
  'claudia-recovery/package.json',
  'claudia-recovery/public/icon.svg',
  'claudia-recovery/public/index.html',
  'claudia-recovery/public/manifest.webmanifest',
  'claudia-recovery/public/recovery.css',
  'claudia-recovery/public/recovery.js',
  'claudia-recovery/server.mjs',
  'claudia-recovery/systemd/claudia-recovery.service',
  'claudia-recovery/test/accessibility.test.mjs',
  'claudia-recovery/test/browser.test.mjs',
  'claudia-recovery/test/cross-browser.test.mjs',
  'claudia-recovery/test/helpers.mjs',
  'claudia-recovery/test/production-audit.mjs',
  'claudia-recovery/test/server.test.mjs',
  'skills/dual-repo-publisher',
  'skills/openclaw-brain-viewer',
  'templates',
  'scripts/audit-public.mjs',
  'scripts/export-public.mjs',
];

const staging = await mkdtemp(path.join(os.tmpdir(), 'claudia-public-export-'));
try {
  const privateBlocklist = await readFile(privateBlocklistPath, 'utf8');
  if (!privateBlocklist.trim()) {
    throw new Error(`Refusing public export with an empty private-term blocklist: ${privateBlocklistPath}`);
  }

  const privateReplacements = JSON.parse(await readFile(privateReplacementsPath, 'utf8'));
  if (
    privateReplacements === null
    || Array.isArray(privateReplacements)
    || typeof privateReplacements !== 'object'
    || Object.keys(privateReplacements).length === 0
  ) {
    throw new Error(`Refusing public export with invalid or empty replacements: ${privateReplacementsPath}`);
  }
  for (const [privateValue, publicValue] of Object.entries(privateReplacements)) {
    if (!privateValue || typeof publicValue !== 'string') {
      throw new Error(`Refusing public export with malformed replacements: ${privateReplacementsPath}`);
    }
  }

  for (const relative of safeSources) {
    const from = path.join(source, relative);
    const to = path.join(staging, relative);
    await mkdir(path.dirname(to), { recursive: true });
    await cp(from, to, {
      recursive: true,
      filter: (candidate) => !candidate.split(path.sep).includes('node_modules'),
    });
  }

  await cp(path.join(source, 'public-edition'), staging, { recursive: true, force: true });

  const replacements = [
    [/~\/\.openclaw\/recovery\/claudia-backups/g, '/var/lib/claudia-recovery/backups'],
    [/\b192\.168(?:\.\d{1,3}){2}\b/g, '127.0.0.1'],
    [/\b10(?:\.\d{1,3}){3}\b/g, '127.0.0.1'],
    [/\b172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}\b/g, '127.0.0.1'],
    [/\/(?:home|Users)\/[A-Za-z0-9._-]+\/\.cache\/playwright-libs\/root/g, '/opt/playwright-libs'],
    [/\/(?:home|Users)\/[A-Za-z0-9._-]+\/\.cache\/playwright-libs\/fonts\.conf/g, '/opt/playwright-libs/fonts.conf'],
    [/\/(?:home|Users)\/[A-Za-z0-9._-]+\/\.config\/claudia-dashboard/g, '/etc/claudia-dashboard'],
    [/\/(?:home|Users)\/[A-Za-z0-9._-]+\/\.config\/claudia-recovery/g, '/etc/claudia-recovery'],
    [/\/(?:home|Users)\/[A-Za-z0-9._-]+\/\.local\/lib\/claudia-recovery/g, '/opt/claudia-recovery'],
    [/\/(?:home|Users)\/[A-Za-z0-9._-]+\/\.local\/state\/claudia-recovery/g, '/var/lib/claudia-recovery'],
    [/\/(?:home|Users)\/[A-Za-z0-9._-]+\/\.openclaw\/recovery\/claudia-backups/g, '/var/lib/claudia-recovery/backups'],
    [/\/(?:home|Users)\/[A-Za-z0-9._-]+\/\.openclaw\/workspace/g, '/opt/claudia-vault'],
  ];

  async function sanitizeTree(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await sanitizeTree(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const buffer = await readFile(absolute);
      if (buffer.includes(0)) continue;
      let text = buffer.toString('utf8');
      for (const [pattern, replacement] of replacements) text = text.replace(pattern, replacement);
      for (const [privateValue, publicValue] of Object.entries(privateReplacements)) {
        const escaped = privateValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        text = text.replace(new RegExp(escaped, 'gi'), publicValue);
      }
      text = text.replace(/const BROWSER_ENV = \{[\s\S]*?\n\};/g, 'const BROWSER_ENV = process.env;');
      text = text.replace(/const FIREFOX_ENV = \{[\s\S]*?\n\};/g, 'const FIREFOX_ENV = process.env;');
      await writeFile(absolute, text);
    }
  }

  await sanitizeTree(staging);
  const auditArguments = [
    path.join(source, 'scripts', 'audit-public.mjs'),
    staging,
    '--blocklist',
    privateBlocklistPath,
  ];
  await execFileAsync(process.execPath, auditArguments);

  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(destination, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    await rm(path.join(destination, entry.name), { recursive: true, force: true });
  }
  for (const entry of await readdir(staging)) {
    await cp(path.join(staging, entry), path.join(destination, entry), { recursive: true, force: true });
  }

  console.log(`Sanitized public mirror exported to ${destination}`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
