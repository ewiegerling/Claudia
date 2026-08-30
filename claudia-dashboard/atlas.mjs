import path from 'node:path';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';

// Brain Atlas v0.2.2 compatibility constants and placement math are adapted
// for this read-only dashboard. Attribution and license: THIRD_PARTY_NOTICES.md.

export const MAX_ATLAS_NODES = 1500;
export const MAX_ATLAS_EDGES = 4000;
export const MAX_ATLAS_FILE_BYTES = 512 * 1024;
export const MAX_ATLAS_TOTAL_BYTES = 16 * 1024 * 1024;
export const MAX_ATLAS_DIRECTORY_VISITS = 1024;
export const MAX_ATLAS_DIRECTORY_DEPTH = 16;

const MAX_CANDIDATE_FILES = 6000;
const MAX_LINKS_PER_FILE = 512;
const MAX_TAGS_PER_FILE = 128;
const MAX_DISCOVERED_EDGES = 24_000;
const HUB_THRESHOLD_PERCENT = 4;

export const ROOT_BRAIN_MARKDOWN = Object.freeze([
  'AGENTS.md',
  'BOOTSTRAP.md',
  'Claudia.md',
  'DREAMS.md',
  'HEARTBEAT.md',
  'IDENTITY.md',
  'MEMORY.md',
  'README.md',
  'SOUL.md',
  'TOOLS.md',
  'USER.md',
]);

export const ATLAS_MARKDOWN_DIRECTORIES = Object.freeze([
  'memory',
  'skills',
  'templates',
  'claudia-dashboard',
]);

const EXCLUDED_COMPONENTS = new Set([
  '.git',
  '.obsidian',
  'node_modules',
  'public-edition',
  'generated',
  'mirrors',
]);

export const KIND_LABELS = Object.freeze({
  person: 'PERSON',
  project: 'PROJECT',
  concept: 'CONCEPT',
  decision: 'DECISION',
  question: 'QUESTION',
  tool: 'TOOL',
  workThread: 'THREAD',
  dailyNote: 'DAILY',
  source: 'SOURCE',
  repo: 'REPO',
  incident: 'INCIDENT',
  organization: 'ORG',
  index: 'INDEX',
  unknown: 'UNKNOWN',
});

const KIND_ALIASES = Object.freeze({
  daily: 'dailyNote',
  dailynote: 'dailyNote',
  journal: 'dailyNote',
  thread: 'workThread',
  workthread: 'workThread',
  moc: 'concept',
  map: 'concept',
  org: 'organization',
  organisation: 'organization',
  company: 'organization',
  repository: 'repo',
  readme: 'index',
});

const TAG_KIND_MAP = Object.freeze({
  project: 'project',
  person: 'person',
  decision: 'decision',
  question: 'question',
  tool: 'tool',
  concept: 'concept',
  source: 'source',
  daily: 'dailyNote',
  moc: 'concept',
  thread: 'workThread',
  index: 'index',
});

const FOLDER_KIND_MAP = Object.freeze({
  people: 'person',
  projects: 'project',
  sources: 'source',
  daily: 'dailyNote',
  journal: 'dailyNote',
  concepts: 'concept',
  topics: 'concept',
  mocs: 'concept',
  maps: 'concept',
  index: 'index',
  home: 'index',
});

export const KIND_TO_REGION = Object.freeze({
  decision: 'frontal',
  question: 'frontal',
  project: 'frontal',
  concept: 'parietal',
  tool: 'parietal',
  workThread: 'parietal',
  person: 'temporal',
  organization: 'temporal',
  source: 'occipital',
  repo: 'occipital',
  dailyNote: 'cerebellum',
  incident: 'cerebellum',
  index: 'stem',
});

const KIND_COLORS = Object.freeze({
  person: '#d4d0c4',
  project: '#c9b896',
  concept: '#a8b3a0',
  decision: '#d4b878',
  question: '#c89878',
  tool: '#9aa4ac',
  workThread: '#b89898',
  dailyNote: '#c9b896',
  source: '#a8b0bc',
  repo: '#a89cb0',
  incident: '#c47878',
  organization: '#c0b888',
  index: '#bcc4cc',
  unknown: '#8e8a82',
});

const REGION_SHAPES = Object.freeze({
  frontal: { center: { x: 0, y: 0.2, z: 0.85 }, radius: 0.45, label: 'FRONTAL' },
  parietal: { center: { x: 0, y: 0.65, z: -0.1 }, radius: 0.4, label: 'PARIETAL' },
  temporal: { center: { x: 0.65, y: -0.15, z: 0.1 }, radius: 0.32, label: 'TEMPORAL', mirror: true },
  occipital: { center: { x: 0, y: 0.05, z: -0.95 }, radius: 0.36, label: 'OCCIPITAL' },
  cerebellum: { center: { x: 0, y: -0.55, z: -0.78 }, radius: 0.32, label: 'CEREBELLUM' },
  stem: { center: { x: 0, y: -0.85, z: -0.45 }, radius: 0.14, label: 'BRAIN STEM' },
});

const REGION_PRESENTATION = Object.freeze({
  frontal: { shortLabel: 'FRO', description: 'Projects · Decisions', color: KIND_COLORS.project },
  parietal: { shortLabel: 'PAR', description: 'Concepts · Tools', color: KIND_COLORS.concept },
  temporal: { shortLabel: 'TEM', description: 'People · Orgs', color: KIND_COLORS.person },
  occipital: { shortLabel: 'OCC', description: 'Sources · Repos', color: KIND_COLORS.source },
  cerebellum: { shortLabel: 'CER', description: 'Daily · Incidents', color: KIND_COLORS.dailyNote },
  stem: { shortLabel: 'STM', description: 'Index · Routing', color: KIND_COLORS.index },
});

const REGION_ORDER = Object.freeze(['frontal', 'parietal', 'temporal', 'occipital', 'cerebellum', 'stem']);

export const ATLAS_REGIONS = Object.freeze(REGION_ORDER.map((id) => Object.freeze({
  id,
  label: REGION_SHAPES[id].label,
  ...REGION_PRESENTATION[id],
  center: Object.freeze({ ...REGION_SHAPES[id].center }),
  radius: REGION_SHAPES[id].radius,
})));

function normalizeSlashes(value) {
  return value.replaceAll('\\', '/');
}

function isExcludedName(name) {
  return EXCLUDED_COMPONENTS.has(name.toLowerCase());
}

function boundedInteger(value, maximum = Number.MAX_SAFE_INTEGER) {
  return Math.max(0, Math.min(maximum, Number.isFinite(value) ? Math.trunc(value) : 0));
}

function cleanScalar(value) {
  if (typeof value !== 'string') return value;
  let result = value.trim();
  if ((result.startsWith('"') && result.endsWith('"')) || (result.startsWith("'") && result.endsWith("'"))) {
    result = result.slice(1, -1);
  } else {
    result = result.replace(/\s+#.*$/, '').trim();
  }
  return result;
}

function splitInlineList(value) {
  const trimmed = value.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return cleanScalar(trimmed);
  return trimmed.slice(1, -1).split(',').map(cleanScalar).filter(Boolean);
}

export function parseFrontmatter(source) {
  const normalized = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!normalized.startsWith('---\n')) return { attributes: {}, bodyOffset: 0 };
  const end = normalized.indexOf('\n---\n', 4);
  if (end < 0 || end > 64 * 1024) return { attributes: {}, bodyOffset: 0 };

  const attributes = {};
  let listKey = null;
  for (const line of normalized.slice(4, end).split('\n')) {
    const listItem = line.match(/^\s+-\s+(.+)$/);
    if (listItem && listKey) {
      const current = Array.isArray(attributes[listKey]) ? attributes[listKey] : [];
      if (current.length < MAX_TAGS_PER_FILE) current.push(cleanScalar(listItem[1]));
      attributes[listKey] = current;
      continue;
    }
    const match = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!match) {
      listKey = null;
      continue;
    }
    const [, key, rawValue] = match;
    listKey = rawValue.trim() ? null : key;
    attributes[key] = rawValue.trim() ? splitInlineList(rawValue) : [];
  }
  return { attributes, bodyOffset: end + 5 };
}

function flattenMetadataValues(value) {
  if (Array.isArray(value)) return value.flatMap(flattenMetadataValues);
  if (!['string', 'number', 'boolean'].includes(typeof value)) return [];
  return String(value).split(/[,\s]+/).map((item) => item.replace(/^#/, '').trim().toLowerCase()).filter(Boolean);
}

function extractInlineTags(body) {
  const tags = [];
  const pattern = /(^|[\s(>])#([\p{L}\p{N}_][\p{L}\p{N}_/-]*)/gmu;
  for (const match of body.matchAll(pattern)) {
    tags.push(match[2].toLowerCase());
    if (tags.length >= MAX_TAGS_PER_FILE) break;
  }
  return tags;
}

function cleanLinkReference(raw) {
  let value = raw.trim();
  if (value.startsWith('<')) {
    const close = value.indexOf('>');
    if (close < 0) return null;
    value = value.slice(1, close);
  } else {
    value = value.split(/\s+["']/)[0].trim();
  }
  try {
    value = decodeURIComponent(value);
  } catch {
    return null;
  }
  value = normalizeSlashes(value).split('#')[0].split('^')[0].trim();
  if (!value || value.startsWith('/') || value.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(value)) return null;
  return value;
}

function extractLinks(body) {
  const links = [];
  const add = (value) => {
    const cleaned = cleanLinkReference(value);
    if (cleaned && links.length < MAX_LINKS_PER_FILE) links.push(cleaned);
  };

  for (const match of body.matchAll(/!?\[\[([^\]\n]+)\]\]/g)) {
    add(match[1].split('|')[0]);
    if (links.length >= MAX_LINKS_PER_FILE) break;
  }
  if (links.length < MAX_LINKS_PER_FILE) {
    for (const match of body.matchAll(/!?\[[^\]\n]*\]\(([^)\n]+)\)/g)) {
      const candidate = cleanLinkReference(match[1]);
      if (candidate && /\.md$/i.test(candidate.split(/[?#]/)[0])) links.push(candidate);
      if (links.length >= MAX_LINKS_PER_FILE) break;
    }
  }
  return links.slice(0, MAX_LINKS_PER_FILE);
}

function countWords(body) {
  let count = 0;
  for (const _match of body.matchAll(/[\p{L}\p{N}]+(?:['’.-][\p{L}\p{N}]+)*/gu)) count += 1;
  return count;
}

export function parseNoteMetadata(source) {
  const normalized = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const { attributes, bodyOffset } = parseFrontmatter(normalized);
  const body = normalized.slice(bodyOffset);
  const frontmatterTags = flattenMetadataValues(attributes.tags);
  const inlineTags = extractInlineTags(body);
  return {
    frontmatter: attributes,
    tags: [...inlineTags, ...frontmatterTags].slice(0, MAX_TAGS_PER_FILE),
    links: extractLinks(body),
    wordCount: boundedInteger(countWords(body), MAX_ATLAS_FILE_BYTES),
  };
}

export function normalizeKind(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/[-_\s]/g, '').toLowerCase();
  const exact = Object.keys(KIND_LABELS).find((kind) => kind.toLowerCase() === normalized);
  return exact || KIND_ALIASES[normalized] || null;
}

export function normalizeRegion(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().replace(/[-_\s]/g, '').toLowerCase();
  if (normalized === 'brainstem') return 'stem';
  return REGION_ORDER.find((region) => region.toLowerCase() === normalized) || null;
}

export function classifyKind(notePath, frontmatter = {}, tags = []) {
  for (const key of ['kind', 'type', 'category']) {
    const values = Array.isArray(frontmatter[key]) ? frontmatter[key] : [frontmatter[key]];
    for (const value of values) {
      const kind = normalizeKind(value);
      if (kind) return { kind, source: 'frontmatter' };
    }
  }
  for (const tag of tags) {
    const kind = TAG_KIND_MAP[String(tag).replace(/^#/, '').trim().toLowerCase()];
    if (kind) return { kind, source: 'tag' };
  }
  const parts = notePath.split('/');
  for (const folder of parts.slice(0, -1)) {
    const kind = FOLDER_KIND_MAP[folder.toLowerCase()];
    if (kind) return { kind, source: 'folder' };
  }
  const basename = path.posix.basename(notePath, path.posix.extname(notePath));
  if (/^\d{4}-\d{2}-\d{2}/.test(basename)) return { kind: 'dailyNote', source: 'filename' };
  const normalizedName = basename.trim().toLowerCase();
  if (/(^|[\s-])moc$/.test(normalizedName) || normalizedName.startsWith('map of ')) {
    return { kind: 'concept', source: 'filename' };
  }
  if (['home', 'index', '_readme', 'readme'].includes(normalizedName)) {
    return { kind: 'index', source: 'filename' };
  }
  return { kind: 'concept', source: 'default' };
}

export function classifyRegion(kind, frontmatter = {}) {
  for (const key of ['brain_region', 'brainRegion', 'lobe', 'region']) {
    const values = Array.isArray(frontmatter[key]) ? frontmatter[key] : [frontmatter[key]];
    for (const value of values) {
      const region = normalizeRegion(value);
      if (region) return { region, source: 'frontmatter' };
    }
  }
  return { region: KIND_TO_REGION[kind] || 'parietal', source: 'kind' };
}

export function fnv1a(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}

function folderCluster(notePath, kind, region, radius) {
  const firstSlash = notePath.indexOf('/');
  const folder = firstSlash > 0 ? notePath.slice(0, firstSlash).toLowerCase() : null;
  const hash = fnv1a(`${region}:${folder || kind}`);
  const n = (hash & 0xffff) / 0xffff;
  const a = ((hash >>> 16) & 0xffff) / 0xffff;
  const c = ((Math.imul(hash, 17) >>> 0) & 0xffff) / 0xffff;
  const longitude = n * Math.PI * 2;
  const latitude = Math.acos(2 * a - 1);
  const distance = radius * (0.18 + c * 0.24);
  return {
    x: distance * Math.sin(latitude) * Math.cos(longitude),
    y: distance * Math.sin(latitude) * Math.sin(longitude),
    z: distance * Math.cos(latitude),
  };
}

export function assignAtlasPosition(node) {
  const hash = fnv1a(node.id);
  const n = (hash & 0xffff) / 0xffff;
  const a = ((hash >>> 16) & 0xffff) / 0xffff;
  const c = ((Math.imul(hash, 31) >>> 0) & 0xffff) / 0xffff;
  const region = node.region || KIND_TO_REGION[node.kind] || 'parietal';
  const shape = REGION_SHAPES[region];
  const cluster = folderCluster(node.path, node.kind, region, shape.radius);
  const longitude = n * Math.PI * 2;
  const latitude = Math.acos(2 * a - 1);
  const distance = shape.radius * (node.hub ? 0.08 : 0.08 + c * 0.13);
  const xOffset = distance * Math.sin(latitude) * Math.cos(longitude);
  const yOffset = distance * Math.sin(latitude) * Math.sin(longitude);
  const zOffset = distance * Math.cos(latitude);
  let centerX = shape.center.x;
  if (shape.mirror && n > 0.5) centerX = -centerX;
  return {
    x: centerX + cluster.x + xOffset,
    y: shape.center.y + cluster.y + yOffset,
    z: shape.center.z + cluster.z + zOffset,
  };
}

async function safeEntryStat(absolutePath) {
  try {
    const entry = await lstat(absolutePath);
    return entry.isSymbolicLink() ? null : entry;
  } catch {
    return null;
  }
}

async function collectAllowedMarkdown(workspaceDir) {
  const candidates = [];
  let candidateTruncated = false;
  let traversalTruncated = false;
  let directoryLimitReached = false;
  let directoryVisits = 0;
  let maxDirectoryDepth = 0;

  const addCandidate = (relativePath) => {
    if (candidates.length >= MAX_CANDIDATE_FILES) {
      candidateTruncated = true;
      return;
    }
    candidates.push(relativePath);
  };

  for (const filename of ROOT_BRAIN_MARKDOWN) {
    const entry = await safeEntryStat(path.join(workspaceDir, filename));
    if (entry?.isFile()) addCandidate(filename);
  }

  const walk = async (relativeDirectory) => {
    if (candidateTruncated || directoryLimitReached) return;
    const directoryDepth = relativeDirectory.split('/').length;
    if (directoryDepth > MAX_ATLAS_DIRECTORY_DEPTH) {
      traversalTruncated = true;
      return;
    }
    if (directoryVisits >= MAX_ATLAS_DIRECTORY_VISITS) {
      traversalTruncated = true;
      directoryLimitReached = true;
      return;
    }
    const absoluteDirectory = path.join(workspaceDir, ...relativeDirectory.split('/'));
    const directoryStat = await safeEntryStat(absoluteDirectory);
    if (!directoryStat?.isDirectory()) return;
    directoryVisits += 1;
    maxDirectoryDepth = Math.max(maxDirectoryDepth, directoryDepth);
    let entries;
    try {
      entries = await readdir(absoluteDirectory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const directoryEntry of entries) {
      if (candidateTruncated || directoryLimitReached) break;
      if (isExcludedName(directoryEntry.name) || directoryEntry.isSymbolicLink()) continue;
      const relativePath = `${relativeDirectory}/${directoryEntry.name}`;
      if (directoryEntry.isDirectory() && directoryDepth >= MAX_ATLAS_DIRECTORY_DEPTH) {
        traversalTruncated = true;
        continue;
      }
      const entry = await safeEntryStat(path.join(workspaceDir, ...relativePath.split('/')));
      if (!entry) continue;
      if (entry.isDirectory()) await walk(relativePath);
      else if (entry.isFile() && /\.md$/i.test(directoryEntry.name)) addCandidate(relativePath);
    }
  };

  for (const directory of ATLAS_MARKDOWN_DIRECTORIES) await walk(directory);
  return {
    candidates: [...new Set(candidates)].sort((a, b) => a.localeCompare(b)),
    candidateTruncated,
    traversalTruncated,
    directoryVisits,
    maxDirectoryDepth,
  };
}

async function readBoundedFile(absolutePath, remainingBytes) {
  let handle;
  try {
    handle = await open(absolutePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const fileStat = await handle.stat();
    if (!fileStat.isFile() || fileStat.size > MAX_ATLAS_FILE_BYTES || fileStat.size > remainingBytes) return null;
    const buffer = Buffer.alloc(boundedInteger(fileStat.size, MAX_ATLAS_FILE_BYTES));
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    return {
      source: buffer.subarray(0, offset).toString('utf8'),
      bytes: offset,
      modifiedAt: fileStat.mtime.toISOString(),
      modifiedMs: fileStat.mtimeMs,
    };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function buildLinkIndex(notes) {
  const exact = new Set(notes.map((note) => note.path));
  const basenameMatches = new Map();
  for (const note of notes) {
    const basename = path.posix.basename(note.path).replace(/\.md$/i, '').toLowerCase();
    const matches = basenameMatches.get(basename) || [];
    matches.push(note.path);
    basenameMatches.set(basename, matches);
  }
  return { exact, basenameMatches };
}

export function resolveAtlasLink(rawTarget, sourcePath, index) {
  const cleaned = cleanLinkReference(rawTarget);
  if (!cleaned) return null;
  const withExtension = /\.md$/i.test(cleaned) ? cleaned : `${cleaned}.md`;
  const normalized = path.posix.normalize(withExtension);
  if (normalized !== '..' && !normalized.startsWith('../') && index.exact.has(normalized)) return normalized;

  const sourceDirectory = path.posix.dirname(sourcePath);
  const sibling = path.posix.normalize(path.posix.join(sourceDirectory === '.' ? '' : sourceDirectory, withExtension));
  if (sibling !== '..' && !sibling.startsWith('../') && index.exact.has(sibling)) return sibling;

  const basename = path.posix.basename(withExtension).replace(/\.md$/i, '').toLowerCase();
  const matches = index.basenameMatches.get(basename) || [];
  return matches.length === 1 ? matches[0] : null;
}

function edgePair(source, target) {
  return source.localeCompare(target) <= 0 ? [source, target] : [target, source];
}

function edgeKey(source, target) {
  const [left, right] = edgePair(source, target);
  return `${left.length}:${left}${right}`;
}

function compareEdge(left, right) {
  return left.source.localeCompare(right.source) || left.target.localeCompare(right.target);
}

function calculateDegrees(edges) {
  const degrees = new Map();
  for (const edge of edges) {
    degrees.set(edge.source, (degrees.get(edge.source) || 0) + 1);
    degrees.set(edge.target, (degrees.get(edge.target) || 0) + 1);
  }
  return degrees;
}

function calculateEndpointSideCounts(edges) {
  const left = new Map();
  const right = new Map();
  for (const edge of edges) {
    left.set(edge.source, (left.get(edge.source) || 0) + 1);
    right.set(edge.target, (right.get(edge.target) || 0) + 1);
  }
  return { left, right };
}

function markHubs(nodes) {
  if (!nodes.length) return nodes;
  const hubCount = Math.max(1, Math.ceil(nodes.length * (HUB_THRESHOLD_PERCENT / 100)));
  const hubs = new Set([...nodes]
    .filter((node) => node.degree > 0)
    .sort((left, right) => right.degree - left.degree || left.id.localeCompare(right.id))
    .slice(0, hubCount)
    .map((node) => node.id));
  return nodes.map((node) => ({ ...node, hub: hubs.has(node.id) }));
}

function inferKindFromLinks(classification, note, degree, endpointSideCounts) {
  if (classification.source !== 'default') return classification;
  const rightCount = endpointSideCounts.right.get(note.path) || 0;
  const leftCount = endpointSideCounts.left.get(note.path) || 0;
  if (rightCount >= 8 && leftCount <= 2) return { kind: 'index', source: 'linkBehavior' };
  if (leftCount >= 10 && rightCount <= 2) return { kind: 'source', source: 'linkBehavior' };
  const basename = path.posix.basename(note.path, '.md');
  if (degree >= 12 && /index|home|map/i.test(basename)) return { kind: 'index', source: 'linkBehavior' };
  return classification;
}

function edgeId(source, target) {
  return `edge:${source.length}:${source}${target}`;
}

function isoFromMaxModified(notes) {
  if (!notes.length) return new Date(0).toISOString();
  return new Date(Math.max(...notes.map((note) => note.modifiedMs))).toISOString();
}

export async function loadAtlas(workspaceDir) {
  if (typeof workspaceDir !== 'string' || !workspaceDir.trim()) throw new TypeError('workspaceDir must be a non-empty path');
  const root = path.resolve(workspaceDir);
  const rootStat = await safeEntryStat(root);
  if (!rootStat?.isDirectory()) throw new Error('workspaceDir must be a real directory, not a symlink');

  const {
    candidates,
    candidateTruncated,
    traversalTruncated,
    directoryVisits,
    maxDirectoryDepth,
  } = await collectAllowedMarkdown(root);
  const notes = [];
  let bytesRead = 0;
  let skippedFiles = 0;
  let byteTruncated = false;
  for (const relativePath of candidates) {
    const result = await readBoundedFile(path.join(root, ...relativePath.split('/')), MAX_ATLAS_TOTAL_BYTES - bytesRead);
    if (!result) {
      skippedFiles += 1;
      byteTruncated = true;
      continue;
    }
    bytesRead += result.bytes;
    const metadata = parseNoteMetadata(result.source);
    notes.push({
      path: relativePath,
      ...metadata,
      modifiedAt: result.modifiedAt,
      modifiedMs: result.modifiedMs,
    });
  }

  const linkIndex = buildLinkIndex(notes);
  const discoveredEdges = new Map();
  let linkTruncated = false;
  for (const note of notes) {
    for (const targetReference of note.links) {
      const target = resolveAtlasLink(targetReference, note.path, linkIndex);
      if (!target || target === note.path) continue;
      const [source, destination] = edgePair(note.path, target);
      discoveredEdges.set(edgeKey(source, destination), { source, target: destination });
      if (discoveredEdges.size >= MAX_DISCOVERED_EDGES) {
        linkTruncated = true;
        break;
      }
    }
    if (linkTruncated) break;
  }

  let edges = [...discoveredEdges.values()].sort(compareEdge);
  const initialDegrees = calculateDegrees(edges);
  const endpointSideCounts = calculateEndpointSideCounts(edges);
  let nodes = notes.map((note) => {
    const initial = classifyKind(note.path, note.frontmatter, note.tags);
    const inferred = inferKindFromLinks(initial, note, initialDegrees.get(note.path) || 0, endpointSideCounts);
    const { region } = classifyRegion(inferred.kind, note.frontmatter);
    return {
      id: note.path,
      path: note.path,
      title: path.posix.basename(note.path, path.posix.extname(note.path)),
      kind: inferred.kind,
      kindLabel: KIND_LABELS[inferred.kind] || String(inferred.kind).toUpperCase(),
      region,
      regionLabel: REGION_SHAPES[region].label,
      color: KIND_COLORS[inferred.kind] || KIND_COLORS.unknown,
      degree: initialDegrees.get(note.path) || 0,
      hub: false,
      classificationSource: inferred.source,
      wordCount: note.wordCount,
      modifiedAt: note.modifiedAt,
    };
  });

  if (nodes.length > MAX_ATLAS_NODES) {
    nodes = [...nodes]
      .sort((left, right) => right.degree - left.degree || left.id.localeCompare(right.id))
      .slice(0, MAX_ATLAS_NODES)
      .sort((left, right) => left.id.localeCompare(right.id));
  }
  const retainedIds = new Set(nodes.map((node) => node.id));
  edges = edges.filter((edge) => retainedIds.has(edge.source) && retainedIds.has(edge.target));

  if (edges.length > MAX_ATLAS_EDGES) {
    const nodeKinds = new Map(nodes.map((node) => [node.id, node.kind]));
    edges = [...edges]
      .sort((left, right) => {
        const leftCrossesKinds = nodeKinds.get(left.source) !== nodeKinds.get(left.target) ? 1 : 0;
        const rightCrossesKinds = nodeKinds.get(right.source) !== nodeKinds.get(right.target) ? 1 : 0;
        return leftCrossesKinds - rightCrossesKinds || compareEdge(left, right);
      })
      .slice(0, MAX_ATLAS_EDGES)
      .sort(compareEdge);
  }

  const degrees = calculateDegrees(edges);
  nodes = markHubs(nodes.map((node) => ({ ...node, degree: degrees.get(node.id) || 0 })))
    .map((node) => ({ ...node, position: assignAtlasPosition(node) }))
    .sort((left, right) => left.id.localeCompare(right.id));
  edges = edges.map((edge) => ({ id: edgeId(edge.source, edge.target), ...edge }));

  const regionCounts = Object.fromEntries(REGION_ORDER.map((region) => [region, 0]));
  const kindCounts = Object.fromEntries(Object.keys(KIND_LABELS).map((kind) => [kind, 0]));
  for (const node of nodes) {
    regionCounts[node.region] = boundedInteger(regionCounts[node.region] + 1, MAX_ATLAS_NODES);
    kindCounts[node.kind] = boundedInteger((kindCounts[node.kind] || 0) + 1, MAX_ATLAS_NODES);
  }
  const connected = nodes.filter((node) => node.degree > 0).length;
  const possibleEdges = nodes.length > 1 ? nodes.length * (nodes.length - 1) / 2 : 0;
  const density = possibleEdges ? Math.min(1, edges.length / possibleEdges) : 0;

  return {
    readOnly: true,
    generatedAt: isoFromMaxModified(notes),
    regions: ATLAS_REGIONS.map((region) => ({ ...region, center: { ...region.center } })),
    nodes,
    edges,
    stats: {
      nodes: boundedInteger(nodes.length, MAX_ATLAS_NODES),
      edges: boundedInteger(edges.length, MAX_ATLAS_EDGES),
      hubs: boundedInteger(nodes.filter((node) => node.hub).length, MAX_ATLAS_NODES),
      connected: boundedInteger(connected, MAX_ATLAS_NODES),
      unlinked: boundedInteger(nodes.length - connected, MAX_ATLAS_NODES),
      density: Number(density.toFixed(6)),
      words: boundedInteger(nodes.reduce((sum, node) => sum + node.wordCount, 0), MAX_ATLAS_TOTAL_BYTES),
      bytesRead: boundedInteger(bytesRead, MAX_ATLAS_TOTAL_BYTES),
      filesConsidered: boundedInteger(candidates.length, MAX_CANDIDATE_FILES),
      skippedFiles: boundedInteger(skippedFiles, MAX_CANDIDATE_FILES),
      directoriesVisited: boundedInteger(directoryVisits, MAX_ATLAS_DIRECTORY_VISITS),
      maxDirectoryDepth: boundedInteger(maxDirectoryDepth, MAX_ATLAS_DIRECTORY_DEPTH),
      maxDegree: boundedInteger(Math.max(0, ...nodes.map((node) => node.degree)), MAX_ATLAS_NODES - 1),
      regionCounts,
      kindCounts,
      truncated: candidateTruncated || traversalTruncated || byteTruncated || linkTruncated || notes.length > MAX_ATLAS_NODES || discoveredEdges.size > MAX_ATLAS_EDGES,
      limits: {
        nodes: MAX_ATLAS_NODES,
        edges: MAX_ATLAS_EDGES,
        fileBytes: MAX_ATLAS_FILE_BYTES,
        totalBytes: MAX_ATLAS_TOTAL_BYTES,
        directoryVisits: MAX_ATLAS_DIRECTORY_VISITS,
        directoryDepth: MAX_ATLAS_DIRECTORY_DEPTH,
      },
    },
  };
}
