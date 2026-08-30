#!/usr/bin/env node

import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
const rootArg = args.find((arg) => !arg.startsWith('--')) || '.';
const blocklistIndex = args.indexOf('--blocklist');
const blocklistPath = blocklistIndex >= 0 ? args[blocklistIndex + 1] : null;
const root = path.resolve(rootArg);

const skippedDirectories = new Set(['.git', 'node_modules', 'coverage']);
const forbiddenPaths = [
  '.obsidian/plugins/',
  'memory/.dreams/',
  'memory/dreaming/',
  'openclaw-workspace-state.json',
  'public-edition/',
  'scripts/private-publication-blocklist.txt',
  'scripts/private-publication-replacements.json',
];

const contentRules = [
  ['private-key', new RegExp(['-----BEGIN ', '(?:RSA |EC |OPENSSH )?', 'PRIVATE KEY-----'].join(''), 'm')],
  ['ssh-public-key', new RegExp(['^ssh-', '(?:ed25519|rsa|ecdsa[^ ]*)', '\\s+[A-Za-z0-9+/]{40,}={0,3}'].join(''), 'm')],
  ['github-token', new RegExp(['(?:gh[pousr]_', '|github_pat_)', '[A-Za-z0-9_]{20,}'].join(''), 'm')],
  ['openai-token', new RegExp(['\\bsk-', '[A-Za-z0-9_-]{20,}'].join(''), 'm')],
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/m],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/m],
  ['credential-assignment', /(?:password|passwd|api[_-]?key|client[_-]?secret|access[_-]?token|auth[_-]?token)\s*[:=]\s*["']?(?!REDACTED|CHANGEME|example)[^\s"']{8,}/im],
  ['private-ipv4', /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/m],
  ['absolute-user-home', /\/(?:home|Users)\/[A-Za-z0-9._-]+(?:\/|\b)/m],
];

async function walk(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && skippedDirectories.has(entry.name)) continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(absolute, relative));
    else if (entry.isFile()) files.push({ absolute, relative });
  }
  return files;
}

let privateTerms = [];
if (blocklistPath) {
  privateTerms = (await readFile(path.resolve(blocklistPath), 'utf8'))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

const findings = [];
for (const file of await walk(root)) {
  const normalized = `${file.relative.replaceAll('\\', '/')}${(await stat(file.absolute)).isDirectory() ? '/' : ''}`;
  if (forbiddenPaths.some((candidate) => normalized === candidate.replace(/\/$/, '') || normalized.startsWith(candidate))) {
    findings.push({ rule: 'forbidden-private-path', file: file.relative });
    continue;
  }

  const buffer = await readFile(file.absolute);
  if (buffer.includes(0)) continue;
  const text = buffer.toString('utf8');
  const isSelf = file.relative.replaceAll('\\', '/') === 'scripts/audit-public.mjs';
  if (!isSelf) {
    for (const [rule, pattern] of contentRules) {
      if (pattern.test(text)) findings.push({ rule, file: file.relative });
    }
  }
  if (privateTerms.some((term) => text.toLowerCase().includes(term.toLowerCase()))) {
    findings.push({ rule: 'private-blocklist', file: file.relative });
  }
}

const unique = [...new Map(findings.map((finding) => [`${finding.rule}\0${finding.file}`, finding])).values()];
if (unique.length) {
  console.error(`Public-safety audit failed with ${unique.length} finding(s):`);
  for (const finding of unique) console.error(`- ${finding.rule}: ${finding.file}`);
  process.exit(1);
}

console.log('Public-safety audit passed: no blocked paths, credentials, keys, private network addresses, user-home paths, or private terms found.');
