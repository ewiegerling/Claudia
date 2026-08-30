import { createServer } from 'node:http';
import { watch } from 'node:fs';
import { readFile, readdir, stat, statfs } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(APP_DIR, 'public');
const WORKSPACE_DIR = path.dirname(APP_DIR);
const MEMORY_DIR = path.join(WORKSPACE_DIR, 'memory');
const DREAMS_PATH = path.join(WORKSPACE_DIR, 'DREAMS.md');
const DREAMING_DIR = path.join(MEMORY_DIR, 'dreaming');
const OPENCLAW_CONFIG_PATH = path.join(os.homedir(), '.openclaw', 'openclaw.json');
const execFileAsync = promisify(execFile);
const SERVICE_DEFINITIONS = [
  { id: 'claudia-dashboard', name: 'Claudia Dashboard', unit: 'claudia-dashboard.service', description: 'Private operations and memory dashboard' },
  { id: 'openclaw-gateway', name: 'OpenClaw Gateway', unit: 'openclaw-gateway.service', description: 'Agent runtime and integration gateway' },
];

const MIME_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
]);

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; manifest-src 'self'; worker-src 'none'",
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=15552000',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

function createLiveUpdates() {
  const clients = new Set();
  const watchers = [];
  let version = Date.now();
  let debounceTimer = null;

  const broadcast = (event, payload) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of clients) client.write(frame);
  };

  const scheduleChange = (changedPath) => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      version = Date.now();
      broadcast('memory', { version, changed: changedPath || 'memory', at: new Date().toISOString() });
    }, 180);
  };

  const targets = [
    ['MEMORY.md', path.join(WORKSPACE_DIR, 'MEMORY.md')],
    ['IDENTITY.md', path.join(WORKSPACE_DIR, 'IDENTITY.md')],
    ['USER.md', path.join(WORKSPACE_DIR, 'USER.md')],
    ['SOUL.md', path.join(WORKSPACE_DIR, 'SOUL.md')],
    ['DREAMS.md', DREAMS_PATH],
    ['memory', MEMORY_DIR],
  ];
  for (const [label, target] of targets) {
    try {
      const watcher = watch(target, { persistent: false }, (_eventType, filename) => {
        scheduleChange(filename ? `${label}/${filename}`.replace('.md/', '/') : label);
      });
      watcher.on('error', (error) => console.warn(`Memory watcher warning for ${label}:`, error.message));
      watchers.push(watcher);
    } catch (error) {
      console.warn(`Could not watch ${label}:`, error.message);
    }
  }

  const heartbeat = setInterval(() => {
    for (const client of clients) client.write(`: heartbeat ${Date.now()}\n\n`);
  }, 20_000);
  heartbeat.unref();

  return {
    add(response) {
      clients.add(response);
      response.write(`event: ready\ndata: ${JSON.stringify({ version, at: new Date().toISOString() })}\n\n`);
      return () => clients.delete(response);
    },
    close() {
      clearTimeout(debounceTimer);
      clearInterval(heartbeat);
      for (const watcher of watchers) watcher.close();
      for (const client of clients) client.end();
      clients.clear();
    },
    get clientCount() {
      return clients.size;
    },
  };
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
}

function createTelemetryCollector(liveUpdates, runtimeStats) {
  let cached = null;
  let cachedAt = 0;
  let previousCpu = null;

  const readCpu = async () => {
    const firstLine = (await readFile('/proc/stat', 'utf8')).split('\n')[0];
    const values = firstLine.trim().split(/\s+/).slice(1).map(Number);
    const idle = (values[3] || 0) + (values[4] || 0);
    const total = values.reduce((sum, value) => sum + (value || 0), 0);
    const current = { idle, total };
    let percent = clampPercent((os.loadavg()[0] / Math.max(1, os.cpus().length)) * 100);
    if (previousCpu && total > previousCpu.total) {
      percent = clampPercent(100 * (1 - (idle - previousCpu.idle) / (total - previousCpu.total)));
    }
    previousCpu = current;
    return percent;
  };

  const readNetworkTotals = async () => {
    const source = await readFile('/proc/net/dev', 'utf8');
    return source.split('\n').slice(2).reduce((totals, line) => {
      const match = line.match(/^\s*([^:]+):\s*(.+)$/);
      if (!match || match[1].trim() === 'lo') return totals;
      const fields = match[2].trim().split(/\s+/).map(Number);
      totals.receivedBytes += fields[0] || 0;
      totals.sentBytes += fields[8] || 0;
      return totals;
    }, { receivedBytes: 0, sentBytes: 0 });
  };

  const readService = async (definition) => {
    const started = performance.now();
    try {
      const { stdout } = await execFileAsync('systemctl', [
        '--user', 'show', definition.unit, '--no-pager',
        '--property=ActiveState,SubState,MainPID,ExecMainStartTimestamp',
      ], { timeout: 1500, maxBuffer: 32_768 });
      const properties = Object.fromEntries(stdout.trim().split('\n').map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1)];
      }).filter(([key]) => key));
      const healthy = properties.ActiveState === 'active' && properties.SubState === 'running';
      return {
        ...definition,
        status: healthy ? 'online' : properties.ActiveState === 'activating' ? 'starting' : 'offline',
        detail: healthy ? 'systemd unit running' : `${properties.ActiveState || 'unknown'} · ${properties.SubState || 'unknown'}`,
        latencyMs: Math.max(1, Math.round(performance.now() - started)),
        pid: Number(properties.MainPID) || null,
        startedAt: properties.ExecMainStartTimestamp || null,
      };
    } catch {
      return { ...definition, status: 'unknown', detail: 'Status unavailable', latencyMs: null, pid: null, startedAt: null };
    }
  };

  return async function collectTelemetry() {
    if (cached && Date.now() - cachedAt < 2000) return cached;
    const collectedAt = performance.now();
    const [cpuPercent, storage, networkTotals, brain, services] = await Promise.all([
      readCpu().catch(() => 0),
      statfs(WORKSPACE_DIR).catch(() => null),
      readNetworkTotals().catch(() => ({ receivedBytes: 0, sentBytes: 0 })),
      loadBrain().catch(() => null),
      Promise.all(SERVICE_DEFINITIONS.map(readService)),
    ]);
    const totalMemory = os.totalmem();
    const usedMemory = totalMemory - os.freemem();
    const diskTotal = storage ? storage.blocks * storage.bsize : 0;
    const diskFree = storage ? storage.bavail * storage.bsize : 0;
    const addresses = Object.entries(os.networkInterfaces()).flatMap(([name, entries = []]) => entries
      .filter((entry) => entry.family === 'IPv4' && !entry.internal)
      .map((entry) => ({ name, address: entry.address, cidr: entry.cidr })));
    const memoryService = {
      id: 'memory-store',
      name: 'Memory Store',
      description: 'Live Markdown knowledge source',
      status: brain ? 'online' : 'offline',
      detail: brain ? `${brain.stats.documents} documents · ${brain.stats.words.toLocaleString('en-US')} words` : 'Memory could not be loaded',
      latencyMs: null,
      pid: null,
      startedAt: null,
    };
    const allServices = [...services, memoryService];
    const offline = allServices.filter((service) => service.status === 'offline');
    const unknown = allServices.filter((service) => service.status === 'unknown');
    const overall = offline.length ? 'critical' : unknown.length ? 'degraded' : 'nominal';

    cached = {
      generatedAt: new Date().toISOString(),
      overall,
      readOnly: true,
      host: {
        hostname: os.hostname(),
        platform: os.platform(),
        release: os.release(),
        architecture: os.arch(),
        uptimeSeconds: os.uptime(),
        cpuCores: os.cpus().length,
        nodeVersion: process.version,
      },
      resources: {
        cpu: { percent: Number(cpuPercent.toFixed(1)), load: os.loadavg().map((value) => Number(value.toFixed(2))) },
        memory: { usedBytes: usedMemory, totalBytes: totalMemory, percent: Number(clampPercent(usedMemory / totalMemory * 100).toFixed(1)) },
        storage: { usedBytes: Math.max(0, diskTotal - diskFree), totalBytes: diskTotal, percent: diskTotal ? Number(clampPercent((diskTotal - diskFree) / diskTotal * 100).toFixed(1)) : 0 },
        network: networkTotals,
      },
      network: {
        addresses,
        upstream: '127.0.0.1:4317',
        canonicalHost: 'dashboard.example.com',
        tls: 'Nginx Proxy Manager',
      },
      services: allServices,
      memory: brain ? {
        documents: brain.stats.documents,
        dailyMemories: brain.stats.dailyMemories,
        words: brain.stats.words,
        lastUpdated: brain.stats.lastUpdated,
      } : null,
      application: {
        startedAt: runtimeStats.startedAt,
        requests: runtimeStats.requests,
        errors: runtimeStats.errors,
        liveClients: liveUpdates.clientCount,
        responseMs: Math.max(1, Math.round(performance.now() - collectedAt)),
      },
      alerts: [
        ...offline.map((service) => ({ level: 'critical', title: `${service.name} is offline`, detail: service.detail })),
        ...unknown.map((service) => ({ level: 'warning', title: `${service.name} status is unknown`, detail: service.detail })),
      ],
    };
    cachedAt = Date.now();
    return cached;
  };
}

marked.setOptions({ gfm: true });

function parseFrontmatter(source) {
  if (!source.startsWith('---\n')) return { attributes: {}, body: source };
  const end = source.indexOf('\n---\n', 4);
  if (end === -1) return { attributes: {}, body: source };

  const attributes = {};
  for (const line of source.slice(4, end).split('\n')) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    attributes[key] = value;
  }

  return { attributes, body: source.slice(end + 5) };
}

export function safeMarkdown(markdown) {
  return sanitizeHtml(marked.parse(markdown), {
    allowedTags: [
      'a', 'blockquote', 'br', 'code', 'del', 'em', 'h1', 'h2', 'h3', 'h4',
      'h5', 'h6', 'hr', 'li', 'ol', 'p', 'pre', 'strong', 'table', 'tbody',
      'td', 'th', 'thead', 'tr', 'ul',
    ],
    allowedAttributes: {
      a: ['href', 'title', 'rel'],
      code: ['class'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer' }),
    },
  });
}

function extractIdentity(source) {
  const field = (name) => source.match(new RegExp(`^- \\*\\*${name}:\\*\\*\\s*(.+)$`, 'im'))?.[1]?.trim() || '';
  return {
    name: field('Name') || 'Claudia',
    creature: field('Creature') || 'Personal AI assistant',
    vibe: field('Vibe'),
    emoji: field('Emoji') || '🦂',
  };
}

async function readMemoryDocument(absolutePath, relativePath) {
  const [source, fileStat] = await Promise.all([readFile(absolutePath, 'utf8'), stat(absolutePath)]);
  const { attributes, body } = parseFrontmatter(source);
  const title = attributes.title || body.match(/^#\s+(.+)$/m)?.[1] || path.basename(relativePath, '.md');
  const words = body.trim().match(/\S+/g)?.length || 0;

  return {
    id: relativePath.replaceAll('/', '--').replace(/\.md$/i, ''),
    path: relativePath,
    title,
    type: attributes.type || (relativePath === 'MEMORY.md' ? 'long-term-memory' : 'daily-memory'),
    date: attributes.date || attributes.updated || null,
    timezone: attributes.timezone || null,
    modifiedAt: fileStat.mtime.toISOString(),
    wordCount: words,
    raw: body.trim(),
    html: safeMarkdown(body),
  };
}

async function loadBrain() {
  const identityPath = path.join(WORKSPACE_DIR, 'IDENTITY.md');
  const dailyEntries = await readdir(MEMORY_DIR, { withFileTypes: true }).catch(() => []);
  const dailyFiles = dailyEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .sort((a, b) => b.localeCompare(a));

  const [identitySource, longTerm, ...daily] = await Promise.all([
    readFile(identityPath, 'utf8'),
    readMemoryDocument(path.join(WORKSPACE_DIR, 'MEMORY.md'), 'MEMORY.md'),
    ...dailyFiles.map((name) => readMemoryDocument(path.join(MEMORY_DIR, name), `memory/${name}`)),
  ]);

  const documents = [longTerm, ...daily];
  const latestModified = documents.reduce(
    (latest, document) => document.modifiedAt > latest ? document.modifiedAt : latest,
    documents[0]?.modifiedAt || new Date().toISOString(),
  );

  return {
    identity: extractIdentity(identitySource),
    readOnly: true,
    generatedAt: new Date().toISOString(),
    stats: {
      documents: documents.length,
      dailyMemories: daily.length,
      words: documents.reduce((sum, document) => sum + document.wordCount, 0),
      lastUpdated: latestModified,
    },
    documents,
  };
}

function dreamDiaryEntries(diary) {
  if (!diary) return [];
  const startMarker = '<!-- openclaw:dreaming:diary:start -->';
  const endMarker = '<!-- openclaw:dreaming:diary:end -->';
  const start = diary.raw.indexOf(startMarker);
  const end = diary.raw.indexOf(endMarker);
  const managedBody = start >= 0 && end > start ? diary.raw.slice(start + startMarker.length, end) : diary.raw;
  const datedChunks = managedBody.split(/\n---\n/).map((chunk) => chunk.trim()).filter(Boolean);
  if (datedChunks.length) {
    return datedChunks.map((chunk, index) => {
      const lines = chunk.split('\n');
      const dateLine = lines.shift()?.replace(/^\*|\*$/g, '') || `Dream ${index + 1}`;
      const grounded = /openclaw:dreaming:backfill-entry/.test(chunk);
      const body = lines.join('\n').replace(/<!-- openclaw:dreaming:[\s\S]*?-->/g, '').trim().replace(/^(What Happened|Reflections|Candidates|Possible Lasting Updates)$/gm, '### $1');
      return {
        id: `dream-${index + 1}`,
        phase: grounded ? 'grounded' : 'diary',
        title: dateLine,
        raw: body,
        html: safeMarkdown(`## ${dateLine}\n\n${body}`),
      };
    }).reverse();
  }
  return extractSections(diary.raw).map((section, index) => ({
    id: `dream-${index + 1}`,
    phase: /light/i.test(section.title) ? 'light' : /deep/i.test(section.title) ? 'deep' : /rem|dream|grounded/i.test(section.title) ? 'rem' : 'diary',
    title: section.title,
    raw: section.body,
    html: safeMarkdown(`## ${section.title}\n\n${section.body}`),
  })).reverse();
}

async function loadDreams() {
  const [configSource, diary] = await Promise.all([
    readFile(OPENCLAW_CONFIG_PATH, 'utf8').catch(() => '{}'),
    readMemoryDocument(DREAMS_PATH, 'DREAMS.md').catch(() => null),
  ]);
  let dreaming = {};
  try {
    const config = JSON.parse(configSource);
    dreaming = config?.plugins?.entries?.['memory-core']?.config?.dreaming || {};
  } catch {
    dreaming = {};
  }

  const reports = [];
  for (const phase of ['light', 'rem', 'deep']) {
    const phaseDirectory = path.join(DREAMING_DIR, phase);
    const entries = await readdir(phaseDirectory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.filter((candidate) => candidate.isFile() && candidate.name.endsWith('.md')).sort((a, b) => b.name.localeCompare(a.name)).slice(0, 20)) {
      const report = await readMemoryDocument(path.join(phaseDirectory, entry.name), `memory/dreaming/${phase}/${entry.name}`).catch(() => null);
      if (report) reports.push({
        id: report.id,
        path: report.path,
        title: report.title,
        date: report.date,
        modifiedAt: report.modifiedAt,
        wordCount: report.wordCount,
        phase,
        html: safeMarkdown(report.raw.replaceAll(WORKSPACE_DIR, '[workspace]')),
      });
    }
  }
  reports.sort((a, b) => String(b.date || b.modifiedAt).localeCompare(String(a.date || a.modifiedAt)));

  const sections = dreamDiaryEntries(diary);

  return {
    generatedAt: new Date().toISOString(),
    readOnly: true,
    status: {
      enabled: dreaming.enabled === true,
      frequency: dreaming.frequency || '0 3 * * *',
      timezone: dreaming.timezone || 'local',
      storage: dreaming.storage?.mode || 'separate',
    },
    stats: {
      entries: sections.length,
      reports: reports.length,
      words: diary?.wordCount || 0,
      lastDreamed: diary?.modifiedAt || null,
    },
    diary: diary ? {
      id: diary.id,
      path: diary.path,
      title: diary.title,
      modifiedAt: diary.modifiedAt,
      wordCount: diary.wordCount,
    } : null,
    entries: sections,
    reports,
  };
}

function extractSections(raw) {
  const sections = [];
  let current = null;
  let parent = null;

  for (const line of raw.split('\n')) {
    const heading = line.match(/^(#{2,3})\s+(.+)$/);
    if (heading) {
      if (current) sections.push({ ...current, body: current.lines.join('\n').trim() });
      const depth = heading[1].length;
      const title = heading[2].trim();
      if (depth === 2) parent = title;
      current = { title, depth, parent: depth === 3 ? parent : null, lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }

  if (current) sections.push({ ...current, body: current.lines.join('\n').trim() });
  return sections;
}

function graphId(prefix, value) {
  return `${prefix}:${value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 90)}`;
}

export function buildGraph(brain) {
  const nodes = new Map();
  const links = [];
  const linkIds = new Map();

  const longTerm = brain.documents.find((document) => document.type === 'long-term-memory');
  const daily = brain.documents
    .filter((document) => document.type === 'daily-memory')
    .sort((a, b) => String(a.date || a.modifiedAt).localeCompare(String(b.date || b.modifiedAt)));
  const orderedDocuments = [longTerm, ...daily].filter(Boolean);
  const eras = [
    { index: 0, id: 'origin', label: 'Core identity', date: null, documentId: null },
    ...orderedDocuments.map((document, index) => ({
      index: index + 1,
      id: `era:${document.id}`,
      label: document.type === 'long-term-memory' ? 'Long-term memory' : document.title,
      date: document.date || document.modifiedAt,
      documentId: document.id,
    })),
  ];

  const addNode = (node) => {
    const existing = nodes.get(node.id);
    if (existing) {
      existing.era = Math.min(existing.era ?? node.era ?? 0, node.era ?? existing.era ?? 0);
      existing.lastEra = Math.max(existing.lastEra ?? existing.era ?? 0, node.era ?? 0);
      if (!existing.projectId && node.projectId) existing.projectId = node.projectId;
    } else {
      nodes.set(node.id, { era: 0, lastEra: node.era ?? 0, ...node });
    }
    return node.id;
  };
  const addLink = (source, target, relation, strength = 1, era = 0) => {
    const id = `${source}|${target}|${relation}`;
    if (source === target) return;
    const existing = linkIds.get(id);
    if (existing) {
      existing.era = Math.min(existing.era, era);
      existing.lastEra = Math.max(existing.lastEra, era);
      return;
    }
    const link = { id, source, target, relation, strength, era, lastEra: era };
    linkIds.set(id, link);
    links.push(link);
  };

  addNode({
    id: 'brain',
    label: "Claudia's Brain",
    group: 'brain',
    size: 30,
    description: 'The living center of Claudia’s durable memory.',
  });

  const people = [
    { id: 'person:claudia', label: brain.identity.name || 'Claudia', description: brain.identity.vibe || brain.identity.creature },
    { id: 'person:operator', label: 'operator', description: 'Human, collaborator, and owner of this memory.' },
  ];
  for (const person of people) {
    addNode({ ...person, group: 'person', size: 21 });
    addLink('brain', person.id, 'knows', 1.4);
  }

  for (const [documentIndex, document] of orderedDocuments.entries()) {
    const era = documentIndex + 1;
    const documentId = `document:${document.id}`;
    addNode({
      id: documentId,
      label: document.title,
      group: 'document',
      size: document.type === 'long-term-memory' ? 19 : 14,
      description: `${document.path} · ${document.wordCount} words`,
      path: document.path,
      date: document.date,
      documentId: document.id,
      era,
    });
    addLink('brain', documentId, document.type === 'long-term-memory' ? 'curates' : 'remembers', 1.25, era);

    for (const [index, section] of extractSections(document.raw).entries()) {
      const sectionId = `${graphId('concept', `${document.id}-${section.title}`)}-${index}`;
      const description = section.body
        .replace(/[`*_#>-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 230);
      addNode({
        id: sectionId,
        label: section.title,
        group: 'concept',
        size: section.depth === 2 ? 12 : 9,
        description: description || `Section in ${document.title}`,
        path: document.path,
        documentId: document.id,
        projectId: section.parent?.toLowerCase() === 'active projects' && section.depth === 3 ? graphId('project', section.title) : null,
        era,
      });
      addLink(documentId, sectionId, 'contains', 1, era);

      for (const person of people) {
        const matcher = new RegExp(`\\b${person.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
        if (matcher.test(`${section.title}\n${section.body}`)) addLink(sectionId, person.id, 'mentions', 0.7, era);
      }

      const references = [...section.body.matchAll(/`([^`\n]{2,90})`/g)]
        .map((match) => match[1].trim())
        .filter(Boolean)
        .slice(0, 30);
      for (const reference of references) {
        const referenceId = graphId('reference', reference);
        addNode({
          id: referenceId,
          label: reference,
          group: 'reference',
          size: 7,
          description: `Referenced by ${section.title}`,
          era,
        });
        addLink(sectionId, referenceId, 'references', 0.55, era);
      }
    }
  }

  const nodeList = [...nodes.values()];
  const groups = nodeList.reduce((counts, node) => {
    counts[node.group] = (counts[node.group] || 0) + 1;
    return counts;
  }, {});

  return {
    generatedAt: brain.generatedAt,
    eras,
    nodes: nodeList,
    links,
    stats: { nodes: nodeList.length, links: links.length, groups },
  };
}

export function buildHistory(graph) {
  return {
    generatedAt: graph.generatedAt,
    snapshots: graph.eras.map((era) => {
      const nodes = graph.nodes.filter((node) => node.era <= era.index);
      const nodeIds = new Set(nodes.map((node) => node.id));
      const links = graph.links.filter((link) => link.era <= era.index && nodeIds.has(link.source) && nodeIds.has(link.target));
      return {
        ...era,
        nodeIds: nodes.map((node) => node.id),
        linkIds: links.map((link) => link.id),
        stats: { nodes: nodes.length, links: links.length },
      };
    }),
  };
}

function bulletItems(body) {
  return body.split('\n')
    .map((line) => line.match(/^\s*-\s+(.+)$/)?.[1]?.trim())
    .filter(Boolean);
}

function cleanMarkdownText(value) {
  return value.replace(/[`*_#]/g, '').replace(/\s+/g, ' ').trim();
}

export function buildProjects(brain, graph = buildGraph(brain)) {
  const longTerm = brain.documents.find((document) => document.type === 'long-term-memory');
  const projectSections = extractSections(longTerm?.raw || '')
    .filter((section) => section.depth === 3 && section.parent?.toLowerCase() === 'active projects');
  const dailyDocuments = brain.documents.filter((document) => document.type === 'daily-memory');
  const globalOpenThreads = extractSections(longTerm?.raw || '')
    .filter((section) => section.title.toLowerCase() === 'open threads')
    .flatMap((section) => bulletItems(section.body));

  const projects = projectSections.map((section) => {
    const id = graphId('project', section.title);
    const bullets = bulletItems(section.body);
    const details = bullets.map((item) => {
      const separator = item.indexOf(':');
      return separator > 0
        ? { label: cleanMarkdownText(item.slice(0, separator)), value: cleanMarkdownText(item.slice(separator + 1)) }
        : { label: 'Note', value: cleanMarkdownText(item) };
    });
    const terms = section.title.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length > 4 && term !== 'claudia');
    const activity = [];
    const decisions = [];
    const openThreads = [...globalOpenThreads];

    for (const document of dailyDocuments) {
      for (const dailySection of extractSections(document.raw)) {
        const items = bulletItems(dailySection.body);
        for (const item of items) {
          const clean = cleanMarkdownText(item);
          const relevant = !terms.length || terms.some((term) => clean.toLowerCase().includes(term));
          if (!relevant && projectSections.length > 1) continue;
          const entry = { date: document.date || document.modifiedAt, text: clean, documentId: document.id };
          const title = dailySection.title.toLowerCase();
          if (title === 'decisions') decisions.push(entry);
          else if (title === 'open threads') openThreads.push(clean);
          else activity.push(entry);
        }
      }
    }

    const graphNode = graph.nodes.find((node) => node.projectId === id);
    const relatedLinks = graphNode ? graph.links.filter((link) => link.source === graphNode.id || link.target === graphNode.id) : [];
    return {
      id,
      name: section.title,
      status: 'Active',
      summary: details.find((detail) => detail.label.toLowerCase() === 'goal')?.value || details[0]?.value || 'Active project in Claudia’s memory.',
      details,
      recentActivity: activity.slice(-10).reverse(),
      decisions: decisions.slice(-8).reverse(),
      openThreads: [...new Set(openThreads.map(cleanMarkdownText))],
      graphNodeId: graphNode?.id || null,
      graphStats: { connections: relatedLinks.length },
      updatedAt: brain.stats.lastUpdated,
    };
  });

  return { generatedAt: brain.generatedAt, stats: { projects: projects.length, active: projects.length }, projects };
}

function jsonResponse(response, statusCode, payload, headOnly = false, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    ...SECURITY_HEADERS,
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
    'Content-Type': 'application/json; charset=utf-8',
    ...extraHeaders,
  });
  response.end(headOnly ? undefined : body);
}

async function serveStatic(requestPath, response, headOnly = false) {
  const requested = requestPath === '/' ? '/index.html' : requestPath;
  let decoded;
  try {
    decoded = decodeURIComponent(requested);
  } catch {
    return false;
  }

  const absolutePath = path.resolve(PUBLIC_DIR, `.${decoded}`);
  if (!absolutePath.startsWith(`${PUBLIC_DIR}${path.sep}`)) return false;

  try {
    const file = await readFile(absolutePath);
    const extension = path.extname(absolutePath).toLowerCase();
    response.writeHead(200, {
      ...SECURITY_HEADERS,
      'Cache-Control': 'no-cache',
      'Content-Length': file.length,
      'Content-Type': MIME_TYPES.get(extension) || 'application/octet-stream',
    });
    response.end(headOnly ? undefined : file);
    return true;
  } catch {
    return false;
  }
}

export function createDashboardServer() {
  const liveUpdates = createLiveUpdates();
  const runtimeStats = { startedAt: new Date().toISOString(), requests: 0, errors: 0 };
  const collectTelemetry = createTelemetryCollector(liveUpdates, runtimeStats);
  const server = createServer(async (request, response) => {
    runtimeStats.requests += 1;
    const url = new URL(request.url || '/', 'http://localhost');
    const headOnly = request.method === 'HEAD';

    if (request.method !== 'GET' && !headOnly) {
      return jsonResponse(response, 405, { error: 'Read-only means read-only.' }, headOnly, { Allow: 'GET, HEAD' });
    }

    if (url.pathname === '/api/health') {
      return jsonResponse(response, 200, { ok: true, readOnly: true }, headOnly);
    }

    if (url.pathname === '/api/events') {
      response.writeHead(200, {
        ...SECURITY_HEADERS,
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'Content-Type': 'text/event-stream; charset=utf-8',
        'X-Accel-Buffering': 'no',
      });
      if (headOnly) return response.end();
      response.flushHeaders();
      const remove = liveUpdates.add(response);
      request.on('close', remove);
      return;
    }

    if (url.pathname === '/api/brain') {
      try {
        return jsonResponse(response, 200, await loadBrain(), headOnly);
      } catch (error) {
        console.error(error);
        return jsonResponse(response, 500, { error: 'Memory telemetry is temporarily unavailable.' }, headOnly);
      }
    }

    if (url.pathname === '/api/graph') {
      try {
        const brain = await loadBrain();
        return jsonResponse(response, 200, buildGraph(brain), headOnly);
      } catch (error) {
        console.error(error);
        return jsonResponse(response, 500, { error: 'The graph lost the plot. Check the memory files.' }, headOnly);
      }
    }

    if (url.pathname === '/api/history') {
      try {
        const brain = await loadBrain();
        return jsonResponse(response, 200, buildHistory(buildGraph(brain)), headOnly);
      } catch (error) {
        console.error(error);
        return jsonResponse(response, 500, { error: 'The timeline slipped out of phase.' }, headOnly);
      }
    }

    if (url.pathname === '/api/projects') {
      try {
        const brain = await loadBrain();
        const graph = buildGraph(brain);
        return jsonResponse(response, 200, buildProjects(brain, graph), headOnly);
      } catch (error) {
        console.error(error);
        return jsonResponse(response, 500, { error: 'The project command center lost telemetry.' }, headOnly);
      }
    }

    if (url.pathname === '/api/dreams') {
      try {
        return jsonResponse(response, 200, await loadDreams(), headOnly);
      } catch (error) {
        console.error(error);
        return jsonResponse(response, 500, { error: 'The dream channel slipped into static.' }, headOnly);
      }
    }

    if (url.pathname === '/api/dashboard') {
      try {
        return jsonResponse(response, 200, await collectTelemetry(), headOnly);
      } catch (error) {
        runtimeStats.errors += 1;
        console.error(error);
        return jsonResponse(response, 500, { error: 'Command telemetry is temporarily unavailable.' }, headOnly);
      }
    }

    if (await serveStatic(url.pathname, response, headOnly)) return;
    jsonResponse(response, 404, { error: 'Not found.' }, headOnly);
  });
  server.on('close', () => liveUpdates.close());
  return server;
}

const launchedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (launchedDirectly) {
  const host = process.env.DASHBOARD_HOST || '127.0.0.1';
  const port = Number.parseInt(process.env.DASHBOARD_PORT || '4317', 10);
  const server = createDashboardServer();
  server.listen(port, host, () => {
    console.log(`Claudia Dashboard is online at http://${host}:${port}`);
  });
}
