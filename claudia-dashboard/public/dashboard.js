const state = {
  dashboard: null,
  brain: null,
  atlas: null,
  atlasRenderer: null,
  atlasRendererData: null,
  atlasLoading: false,
  atlasDirty: true,
  atlasRevision: 0,
  atlasReloadQueued: false,
  atlasIndexOpen: false,
  atlasLabels: true,
  atlasMotion: !matchMedia('(prefers-reduced-motion: reduce)').matches,
  atlasRegions: new Map(),
  selectedAtlasNode: null,
  projects: null,
  dreams: null,
  voiceStatus: null,
  view: 'overview',
  live: true,
  loading: false,
  selectedDocument: null,
  selectedProject: null,
  cpuHistory: [],
  memoryHistory: [],
  paletteResults: [],
  paletteIndex: 0,
  lastUpdated: null,
};

const voice = {
  stream: null,
  context: null,
  source: null,
  processor: null,
  silentGain: null,
  recording: false,
  recordingChunks: [],
  recordingSamples: 0,
  recordingStartedAt: 0,
  quietForMs: 0,
  speechDetected: false,
  wakeEnabled: false,
  wakeChunks: [],
  wakeSamples: 0,
  wakeBusy: false,
  requestController: null,
  speechToken: 0,
  level: 0,
  levelHistory: Array.from({ length: 72 }, () => 0),
  animationFrame: null,
  conversation: [],
  lastReply: '',
  speechPrimed: false,
  outputContext: null,
  playbackSource: null,
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function setText(selector, value) {
  const element = typeof selector === 'string' ? $(selector) : selector;
  if (element) element.textContent = value ?? '—';
}

function formatNumber(value) {
  return new Intl.NumberFormat('en-US', { notation: Number(value) >= 10_000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(Number(value) || 0);
}

function formatBytes(value, digits = 1) {
  const bytes = Number(value) || 0;
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length);
  return `${(bytes / (1024 ** exponent)).toFixed(digits)} ${units[exponent - 1]}`;
}

function formatUptime(seconds) {
  const days = Math.floor((Number(seconds) || 0) / 86400);
  const hours = Math.floor(((Number(seconds) || 0) % 86400) / 3600);
  return days ? `${days}d ${hours}h` : `${hours}h ${Math.floor(((Number(seconds) || 0) % 3600) / 60)}m`;
}

function formatRelative(value) {
  if (!value) return 'Unknown';
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return String(value);
  const delta = Math.max(0, Date.now() - time);
  if (delta < 60_000) return 'Just now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  if (delta < 604_800_000) return `${Math.floor(delta / 86_400_000)}d ago`;
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(time));
}

function formatDate(value) {
  if (!value) return 'Undated';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(date);
}

function textExcerpt(value, max = 120) {
  const clean = String(value || '').replace(/<!--[^]*?-->/g, ' ').replace(/[`*_#>[\]()]/g, ' ').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trim()}…` : clean;
}

function create(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function toast(message) {
  const region = $('#toast-region');
  const item = create('div', 'toast', message);
  region.append(item);
  setTimeout(() => item.remove(), 3200);
}

function updateClock() {
  const now = new Date();
  setText('#clock-time', new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(now));
  setText('#clock-date', new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(now));
  const hour = now.getHours();
  setText('#greeting', hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening');
}

function setConnection(kind, label, detail) {
  const card = $('.connection-card');
  card.classList.toggle('offline', kind === 'offline');
  card.classList.toggle('paused', kind === 'paused');
  setText('#sidebar-connection', label);
  setText('#sidebar-host', detail);
}

async function fetchJson(path) {
  const response = await fetch(path, { headers: { Accept: 'application/json' }, cache: 'no-store' });
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return response.json();
}

function updateSparkline(selector, history) {
  const svg = $(selector);
  if (!svg || !history.length) return;
  const values = history.length === 1 ? [history[0], history[0]] : history;
  const points = values.map((value, index) => {
    const x = (index / (values.length - 1)) * 110;
    const y = 34 - (Math.max(0, Math.min(100, value)) / 100) * 30;
    return [x, y];
  });
  const line = `M${points.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(' L')}`;
  $('.spark-stroke', svg).setAttribute('d', line);
  $('.spark-fill', svg).setAttribute('d', `${line} L110 38 L0 38 Z`);
}

function setProgress(selector, value) {
  const element = $(selector);
  if (element) element.style.width = `${Math.max(0, Math.min(100, Number(value) || 0))}%`;
}

function renderDashboard() {
  const data = state.dashboard;
  if (!data) return;
  const { resources, host, network, services = [], memory, application } = data;
  const cpu = resources?.cpu?.percent || 0;
  const ram = resources?.memory?.percent || 0;
  const storage = resources?.storage?.percent || 0;
  state.cpuHistory.push(cpu);
  state.memoryHistory.push(ram);
  state.cpuHistory = state.cpuHistory.slice(-18);
  state.memoryHistory = state.memoryHistory.slice(-18);

  setText('#cpu-value', `${cpu.toFixed(1)}%`);
  setText('#cpu-detail', `${host.cpuCores} cores · load ${resources.cpu.load?.[0] ?? '—'}`);
  setText('#memory-value', `${ram.toFixed(1)}%`);
  setText('#memory-detail', `${formatBytes(resources.memory.usedBytes)} of ${formatBytes(resources.memory.totalBytes)}`);
  setText('#storage-value', `${storage.toFixed(1)}%`);
  setText('#storage-detail', `${formatBytes(resources.storage.usedBytes)} used`);
  const totalNetwork = (resources.network?.receivedBytes || 0) + (resources.network?.sentBytes || 0);
  setText('#network-value', formatBytes(totalNetwork));
  setText('#network-detail', `${formatBytes(resources.network?.receivedBytes)} down · ${formatBytes(resources.network?.sentBytes)} up`);
  updateSparkline('#cpu-chart', state.cpuHistory);
  updateSparkline('#memory-chart', state.memoryHistory);
  $('#storage-ring')?.style.setProperty('--ring', `${storage * 3.6}deg`);

  setText('#cpu-row-value', `${cpu.toFixed(1)}%`);
  setText('#memory-row-value', `${ram.toFixed(1)}%`);
  setText('#storage-row-value', `${storage.toFixed(1)}%`);
  setProgress('#cpu-progress', cpu);
  setProgress('#memory-progress', ram);
  setProgress('#storage-progress', storage);
  const health = Math.max(0, Math.round(100 - Math.max(cpu * .55, ram * .62, storage * .72)));
  setText('#pulse-score', health);
  setText('#host-summary', `${host.hostname} · ${host.platform} ${host.architecture} · ${host.cpuCores} cores`);
  setText('#host-uptime', `Uptime ${formatUptime(host.uptimeSeconds)}`);

  const overall = data.overall || 'unknown';
  setText('#overall-status', overall);
  const hero = $('#hero-status');
  hero.classList.remove('degraded', 'critical');
  if (overall === 'degraded') hero.classList.add('degraded');
  if (overall === 'critical') hero.classList.add('critical');
  const copy = overall === 'nominal'
    ? 'Everything is behaving. Suspicious, frankly—but lovely to see.'
    : overall === 'degraded'
      ? 'One signal looks odd. Nothing is on fire; I’m watching it.'
      : overall === 'critical'
        ? 'Something needs attention. The useful details are below.'
        : 'Telemetry is arriving, but the verdict is still loading.';
  setText('#hero-copy', copy);
  state.lastUpdated = new Date(data.generatedAt || Date.now());
  setText('#hero-kicker', `Live system intelligence · updated ${formatRelative(state.lastUpdated)}`);
  setConnection(state.live ? 'live' : 'paused', state.live ? 'Live connection' : 'Auto-refresh paused', host.hostname);

  setText('#network-host', network?.canonicalHost || 'dashboard.example.com');
  setText('#network-upstream', network?.upstream || '127.0.0.1:4317');
  setText('#sidebar-host', `${host.hostname} · ${network?.addresses?.[0]?.address || 'private'}`);
  setText('#memory-documents', memory?.documents ?? '—');
  setText('#memory-words', formatNumber(memory?.words));
  setText('#memory-dailies', formatNumber(memory?.dailyMemories));
  setText('#memory-updated', formatRelative(memory?.lastUpdated));

  renderServices(services);
  if (application?.responseMs) setText('#network-badge', `${application.responseMs}MS`);
}

function renderServices(services) {
  const list = $('#service-list');
  list.replaceChildren();
  if (!services.length) {
    list.append(emptyMini('No service telemetry returned.'));
    return;
  }
  const symbols = { 'claudia-dashboard': 'CD', 'openclaw-gateway': 'OG', 'memory-store': 'M' };
  for (const service of services) {
    const row = create('div', 'service-row');
    const symbol = create('span', 'service-symbol', symbols[service.id] || service.name?.slice(0, 2).toUpperCase());
    symbol.setAttribute('aria-hidden', 'true');
    const content = create('div');
    content.append(create('strong', '', service.name), create('small', '', `${service.detail}${service.latencyMs ? ` · ${service.latencyMs}ms` : ''}`));
    const status = create('span', `service-state ${service.status === 'online' ? '' : service.status}`, service.status);
    status.setAttribute('aria-label', `${service.name}: ${service.status}`);
    row.append(symbol, content, status);
    list.append(row);
  }
}

function emptyMini(message) {
  const node = create('div', 'empty-state');
  node.append(create('span', '', '⌁'), create('p', '', message));
  return node;
}

function renderBrain() {
  const brain = state.brain;
  if (!brain) return;
  setText('#sidebar-vibe', brain.identity?.vibe || brain.identity?.creature || 'Personal AI');
  setText('#memory-total-words', formatNumber(brain.stats?.words));
  renderDocuments($('#memory-search')?.value || '');
  renderActivity();
}

function renderActivity() {
  const list = $('#activity-list');
  const documents = state.brain?.documents || [];
  const daily = documents.filter((doc) => doc.type === 'daily-memory').sort((a, b) => String(b.date || b.modifiedAt).localeCompare(String(a.date || a.modifiedAt)))[0];
  const lines = (daily?.raw || '').split('\n').map((line) => line.match(/^\s*-\s+(.+)/)?.[1]).filter(Boolean).slice(-4).reverse();
  list.replaceChildren();
  if (!lines.length) {
    const item = create('li');
    item.append(create('span', 'timeline-dot'), create('div'));
    $('div', item).append(create('strong', '', 'Quiet is a valid signal'), create('small', '', 'No recent daily activity was found.'));
    list.append(item);
    return;
  }
  setText('#activity-count', `${lines.length} recent`);
  for (const line of lines) {
    const item = create('li');
    const dot = create('span', 'timeline-dot');
    dot.setAttribute('aria-hidden', 'true');
    const content = create('div');
    content.append(create('strong', '', textExcerpt(line, 100)), create('small', '', `${daily.title} · ${formatRelative(daily.modifiedAt)}`));
    item.append(dot, content);
    list.append(item);
  }
}

function renderDocuments(query = '') {
  const list = $('#document-list');
  if (!list || !state.brain) return;
  const needle = query.trim().toLowerCase();
  const docs = state.brain.documents.filter((doc) => !needle || `${doc.title}\n${doc.path}\n${doc.raw}`.toLowerCase().includes(needle));
  setText('#memory-search-summary', `${docs.length} ${docs.length === 1 ? 'document' : 'documents'}${needle ? ` matching “${query.trim()}”` : ''}`);
  list.replaceChildren();
  for (const doc of docs) {
    const button = create('button', `document-button${state.selectedDocument === doc.id ? ' active' : ''}`);
    button.type = 'button';
    button.dataset.documentId = doc.id;
    const icon = create('span', 'doc-icon', doc.type === 'long-term-memory' ? '∞' : '•');
    icon.setAttribute('aria-hidden', 'true');
    const details = create('span');
    details.append(create('strong', '', doc.title), create('small', '', `${formatNumber(doc.wordCount)} words · ${formatRelative(doc.modifiedAt)}`));
    button.append(icon, details);
    button.addEventListener('click', () => selectDocument(doc.id));
    list.append(button);
  }
  if (!docs.length) list.append(emptyMini('Nothing matched. Memory has standards.'));
  if (!state.selectedDocument && docs.length && !needle) selectDocument(docs[0].id, false);
}

function selectDocument(id, focusViewer = true) {
  const doc = state.brain?.documents.find((item) => item.id === id);
  if (!doc) return;
  state.selectedDocument = id;
  $$('.document-button').forEach((button) => button.classList.toggle('active', button.dataset.documentId === id));
  const viewer = $('#document-viewer');
  viewer.replaceChildren();
  const meta = create('div', 'document-meta');
  meta.append(create('span', '', doc.path), create('span', '', `${formatNumber(doc.wordCount)} words`), create('span', '', `Updated ${formatRelative(doc.modifiedAt)}`));
  const content = create('div', 'markdown');
  content.innerHTML = doc.html;
  viewer.append(meta, content);
  if (focusViewer) viewer.focus({ preventScroll: true });
}

function atlasRegionEnabled(region) {
  return state.atlasRegions.get(region) !== false;
}

function ensureAtlasRenderer() {
  if (state.atlasRenderer || !state.atlas || !window.ClaudiaAtlasRenderer) return state.atlasRenderer;
  const canvas = $('#atlas-canvas');
  if (!canvas) return null;
  state.atlasRenderer = new window.ClaudiaAtlasRenderer(canvas, {
    onSelect: (id) => selectAtlasNode(id, { fromCanvas: true }),
  });
  state.atlasRenderer.setMotion(state.atlasMotion);
  state.atlasRenderer.setLabels(state.atlasLabels);
  for (const region of state.atlas.regions || []) {
    state.atlasRenderer.setRegion(region.id, atlasRegionEnabled(region.id));
  }
  state.atlasRenderer.setActive(state.view === 'atlas');
  return state.atlasRenderer;
}

function atlasVisibleNodes(query = $('#atlas-search')?.value || '') {
  const needle = query.trim().toLowerCase();
  return (state.atlas?.nodes || [])
    .filter((node) => atlasRegionEnabled(node.region))
    .filter((node) => !needle || `${node.title} ${node.path} ${node.kindLabel} ${node.regionLabel}`.toLowerCase().includes(needle))
    .sort((a, b) => Number(b.hub) - Number(a.hub) || b.degree - a.degree || a.title.localeCompare(b.title));
}

function renderAtlasIndex(query = $('#atlas-search')?.value || '') {
  const list = $('#atlas-node-list');
  if (!list || (!state.atlasIndexOpen && !query.trim())) return;
  const nodes = atlasVisibleNodes(query);
  const suffix = query.trim() ? ` matching “${query.trim()}”` : '';
  setText('#atlas-index-summary', `${nodes.length} ${nodes.length === 1 ? 'note' : 'notes'}${suffix}`);
  list.replaceChildren();
  if (!nodes.length) {
    list.append(emptyMini('No thoughts matched those filters.'));
    return;
  }
  for (const node of nodes) {
    const item = create('div');
    item.setAttribute('role', 'listitem');
    const button = create('button', `atlas-node-button${state.selectedAtlasNode === node.id ? ' active' : ''}`);
    button.type = 'button';
    button.dataset.atlasNode = node.id;
    const dot = create('i');
    dot.setAttribute('aria-hidden', 'true');
    dot.style.setProperty('--node-color', node.color || 'var(--lilac)');
    const copy = create('span');
    copy.append(create('strong', '', node.title), create('small', '', `${node.kindLabel} · ${node.regionLabel}`));
    button.append(dot, copy, create('em', '', `${node.degree}×`));
    button.addEventListener('click', () => selectAtlasNode(node.id));
    item.append(button);
    list.append(item);
  }
}

function setAtlasIndex(open, { focus = true } = {}) {
  state.atlasIndexOpen = Boolean(open);
  const drawer = $('#atlas-index');
  const toggle = $('#atlas-list-toggle');
  drawer.hidden = !state.atlasIndexOpen;
  toggle.setAttribute('aria-expanded', state.atlasIndexOpen ? 'true' : 'false');
  if (state.atlasIndexOpen) {
    renderAtlasIndex();
    if (focus) $('#atlas-index-close').focus({ preventScroll: true });
  } else if (focus) {
    toggle.focus({ preventScroll: true });
  }
}

function selectAtlasNode(id, { fromCanvas = false } = {}) {
  const node = state.atlas?.nodes.find((item) => item.id === id);
  if (!node) return;
  state.selectedAtlasNode = id;
  if (!fromCanvas) state.atlasRenderer?.selectNode(id);
  $('#atlas-inspector-empty').hidden = true;
  $('#atlas-inspector-content').hidden = false;
  setText('#atlas-node-kind', node.kindLabel);
  setText('#atlas-node-region', node.regionLabel);
  setText('#atlas-node-title', node.title);
  setText('#atlas-node-summary', node.summary || 'A living note in Claudia’s vault.');
  setText('#atlas-node-degree', formatNumber(node.degree));
  setText('#atlas-node-words', formatNumber(node.wordCount));
  setText('#atlas-node-source', String(node.classificationSource || 'inference').replace(/([a-z])([A-Z])/g, '$1 $2'));
  setText('#atlas-node-path', node.path);
  const memoryDocument = state.brain?.documents.find((document) => document.path === node.path);
  const openButton = $('#atlas-open-memory');
  openButton.hidden = !memoryDocument;
  if (memoryDocument) openButton.dataset.documentId = memoryDocument.id;
  else delete openButton.dataset.documentId;
  $$('.atlas-node-button').forEach((button) => button.classList.toggle('active', button.dataset.atlasNode === id));
  const canvas = $('#atlas-canvas');
  canvas?.setAttribute('aria-label', `Interactive Brain Atlas. Selected ${node.title}, ${node.kindLabel}, ${node.degree} connections.`);
  if (matchMedia('(max-width: 620px)').matches && state.atlasIndexOpen) setAtlasIndex(false, { focus: false });
}

function renderAtlas() {
  const atlas = state.atlas;
  if (!atlas) return;
  const stats = atlas.stats || {};
  setText('#atlas-node-total', formatNumber(stats.nodes ?? atlas.nodes?.length));
  setText('#atlas-edge-total', formatNumber(stats.edges ?? atlas.edges?.length));
  setText('#atlas-hub-total', formatNumber(stats.hubs));
  setText('#atlas-connected-total', formatNumber(stats.connected));
  setText('#atlas-unlinked-total', formatNumber(stats.unlinked));
  const density = Number(stats.density) || 0;
  setText('#atlas-density', `${(density <= 1 ? density * 100 : density).toFixed(1)}%`);
  setText('#atlas-updated', `${formatNumber(stats.nodes ?? atlas.nodes?.length)} notes · updated ${formatRelative(atlas.generatedAt)}`);

  for (const region of atlas.regions || []) {
    if (!state.atlasRegions.has(region.id)) state.atlasRegions.set(region.id, true);
    setText(`#atlas-region-${region.id}`, formatNumber(region.count ?? stats.regionCounts?.[region.id]));
    const button = $(`[data-atlas-region="${region.id}"]`);
    button?.setAttribute('aria-pressed', atlasRegionEnabled(region.id) ? 'true' : 'false');
  }

  const renderer = ensureAtlasRenderer();
  if (renderer) {
    if (state.atlasRendererData !== atlas) {
      renderer.setData(atlas);
      state.atlasRendererData = atlas;
    }
    renderer.setSearch($('#atlas-search')?.value || '');
    renderer.setActive(state.view === 'atlas');
  }
  $('#atlas-loading').hidden = true;
  renderAtlasIndex();
  if (state.selectedAtlasNode && atlas.nodes.some((node) => node.id === state.selectedAtlasNode)) {
    selectAtlasNode(state.selectedAtlasNode);
  }
}

async function loadAtlas({ announce = false } = {}) {
  if (state.atlasLoading) {
    state.atlasReloadQueued = true;
    return;
  }
  state.atlasLoading = true;
  state.atlasReloadQueued = false;
  const requestedRevision = state.atlasRevision;
  const loading = $('#atlas-loading');
  loading.hidden = false;
  setText($('strong', loading), 'Mapping the cortex');
  setText($('small', loading), 'Resolving notes and neural pathways…');
  try {
    state.atlas = await fetchJson('/api/atlas');
    state.atlasDirty = state.atlasRevision !== requestedRevision;
    renderAtlas();
    if (announce) toast('Brain Atlas rebuilt from the live vault.');
  } catch (error) {
    console.error(error);
    const title = $('strong', loading);
    const detail = $('small', loading);
    if (title) title.textContent = 'Atlas signal lost';
    if (detail) detail.textContent = 'The vault map could not be rebuilt. Refresh to try again.';
  } finally {
    state.atlasLoading = false;
    if ((state.atlasReloadQueued || state.atlasRevision !== requestedRevision) && state.view === 'atlas') {
      queueMicrotask(() => loadAtlas());
    }
  }
}

function renderProjects() {
  const projects = state.projects?.projects || [];
  setText('#project-total', projects.length);
  const grid = $('#project-grid');
  grid.replaceChildren();
  if (!projects.length) {
    grid.append(emptyMini('No active projects are currently declared in memory.'));
    $('#project-peek').replaceChildren(emptyMini('No active projects.'));
    return;
  }
  for (const project of projects) {
    const button = create('button', `project-card${state.selectedProject === project.id ? ' active' : ''}`);
    button.type = 'button';
    button.dataset.projectId = project.id;
    const header = create('header');
    header.append(create('span', 'project-status', project.status), create('span', 'project-arrow', '↗'));
    const title = create('h2', '', project.name);
    const summary = create('p', '', project.summary);
    const footer = create('footer');
    footer.append(create('span', '', `${project.recentActivity?.length || 0} signals`), create('span', '', `${project.openThreads?.length || 0} open threads`));
    button.append(header, title, summary, footer);
    button.addEventListener('click', () => selectProject(project.id));
    grid.append(button);
  }
  const peek = $('#project-peek');
  peek.replaceChildren();
  const project = projects[0];
  const card = create('div', 'peek-card');
  card.append(create('span', 'project-status', project.status), create('h3', '', project.name), create('p', '', project.summary));
  const footer = create('footer');
  footer.append(create('span', '', `${project.recentActivity?.length || 0} recent signals`), create('span', '', formatRelative(project.updatedAt)));
  card.append(footer);
  peek.append(card);
  if (!state.selectedProject) selectProject(project.id, false);
}

function selectProject(id, scroll = true) {
  const project = state.projects?.projects.find((item) => item.id === id);
  if (!project) return;
  state.selectedProject = id;
  $$('.project-card').forEach((button) => button.classList.toggle('active', button.dataset.projectId === id));
  const detail = $('#project-detail');
  detail.replaceChildren();
  const content = create('div', 'project-detail-content');
  const header = create('header');
  header.append(create('span', 'project-status', project.status), create('h2', '', project.name), create('p', '', project.summary));
  content.append(header);
  if (project.details?.length) {
    const section = create('section', 'detail-section');
    section.append(create('h3', '', 'Project facts'));
    const facts = create('div', 'fact-grid');
    for (const detailItem of project.details.slice(0, 8)) {
      const fact = create('div', 'fact');
      fact.append(create('span', '', detailItem.label), create('strong', '', detailItem.value));
      facts.append(fact);
    }
    section.append(facts);
    content.append(section);
  }
  appendSignals(content, 'Recent activity', project.recentActivity, true);
  appendSignals(content, 'Decisions', project.decisions, true);
  appendSignals(content, 'Open threads', (project.openThreads || []).map((text) => ({ text })), false);
  detail.append(content);
  if (scroll && matchMedia('(max-width: 820px)').matches) detail.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
}

function appendSignals(parent, title, items = [], dated = false) {
  if (!items.length) return;
  const section = create('section', 'detail-section');
  section.append(create('h3', '', title));
  const list = create('ul', 'signal-list');
  for (const item of items.slice(0, 8)) {
    const row = create('li', '', item.text || String(item));
    if (dated && item.date) row.append(create('small', '', formatDate(item.date)));
    list.append(row);
  }
  section.append(list);
  parent.append(section);
}

function renderDreams() {
  const dreams = state.dreams;
  if (!dreams) return;
  setText('#dream-state', dreams.status?.enabled ? 'Dreaming enabled' : 'Dreaming paused');
  setText('#dream-schedule', `${dreams.status?.frequency || 'Schedule unknown'} · ${dreams.status?.timezone || 'local'}`);
  setText('#dream-entry-count', formatNumber(dreams.stats?.entries));
  setText('#dream-report-count', formatNumber(dreams.stats?.reports));
  setText('#dream-word-count', formatNumber(dreams.stats?.words));
  setText('#dream-last', formatRelative(dreams.stats?.lastDreamed));
  const feed = $('#dream-feed');
  feed.replaceChildren();
  const entries = dreams.entries || [];
  if (!entries.length) {
    feed.append(emptyMini('No dream entries yet. Even machines need a night off.'));
    return;
  }
  for (const entry of entries.slice(0, 12)) {
    const card = create('article', 'panel dream-card');
    const header = create('header');
    header.append(create('h2', '', entry.title), create('span', 'phase-chip', entry.phase || 'journal'));
    const content = create('div', 'markdown');
    content.innerHTML = entry.html;
    card.append(header, content);
    feed.append(card);
  }
}

function setVoiceState(kind, title, copy) {
  const stage = $('#voice-stage');
  if (!stage) return;
  stage.dataset.voiceState = kind;
  setText('#voice-state-label', title);
  setText('#voice-live-title', title);
  setText('#voice-live-copy', copy);
  const main = $('#voice-main-button');
  const stop = $('#voice-stop-button');
  const label = $('#voice-main-label');
  main.disabled = kind === 'transcribing' || kind === 'thinking';
  if (kind === 'listening') label.textContent = 'Send recording';
  else if (kind === 'speaking') label.textContent = 'Talk over Claudia';
  else if (kind === 'thinking') label.textContent = 'Claudia is thinking';
  else if (kind === 'transcribing') label.textContent = 'Transcribing locally';
  else label.textContent = 'Start talking';
  stop.hidden = !['thinking', 'speaking', 'transcribing'].includes(kind);
}

function renderVoiceStatus() {
  const status = state.voiceStatus;
  const badge = $('#voice-runtime-badge');
  if (!status || !badge) return;
  const microphoneSupported = Boolean(window.isSecureContext && navigator.mediaDevices?.getUserMedia);
  const available = status.available && microphoneSupported;
  badge.classList.toggle('offline', !available);
  setText('#voice-runtime-label', available ? 'Voice runtime online' : 'Voice runtime limited');
  setText('#voice-runtime-detail', [
    status.transcription ? 'Whisper ready' : 'Whisper offline',
    status.speech ? 'Piper ready' : 'Piper offline',
    status.agent ? 'OpenClaw ready' : 'OpenClaw offline',
    microphoneSupported ? 'secure microphone' : 'microphone unavailable',
  ].join(' · '));
  if (!available) setVoiceState('idle', 'Voice input unavailable', microphoneSupported ? 'The local voice services are not ready.' : 'Open this dashboard over HTTPS in a browser with microphone support.');
  $('#voice-main-button').disabled = !available;
  $('#voice-wake-toggle').disabled = !available;
}

async function loadVoiceStatus() {
  try {
    state.voiceStatus = await fetchJson('/api/voice/status');
  } catch {
    state.voiceStatus = { available: false, transcription: false, speech: false, agent: false };
  }
  renderVoiceStatus();
}

function drawVoiceWaveform() {
  const canvas = $('#voice-waveform');
  if (!canvas) return;
  const context = canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;
  voice.levelHistory.push(voice.level);
  voice.levelHistory = voice.levelHistory.slice(-72);
  context.clearRect(0, 0, width, height);
  const gradient = context.createLinearGradient(0, 0, width, 0);
  gradient.addColorStop(0, 'rgba(185,167,255,.05)');
  gradient.addColorStop(.5, 'rgba(113,239,195,.85)');
  gradient.addColorStop(1, 'rgba(185,167,255,.05)');
  context.strokeStyle = gradient;
  context.lineWidth = 3;
  context.shadowBlur = 14;
  context.shadowColor = 'rgba(113,239,195,.35)';
  context.beginPath();
  voice.levelHistory.forEach((level, index) => {
    const x = index / Math.max(1, voice.levelHistory.length - 1) * width;
    const phase = Math.sin(index * .72) * Math.max(2, level * height * 1.9);
    const y = height / 2 + phase;
    if (!index) context.moveTo(x, y); else context.lineTo(x, y);
  });
  context.stroke();
  context.shadowBlur = 0;
  context.strokeStyle = 'rgba(255,255,255,.05)';
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(0, height / 2);
  context.lineTo(width, height / 2);
  context.stroke();
  voice.level *= .88;
  voice.animationFrame = requestAnimationFrame(drawVoiceWaveform);
}

function downsampleAudio(chunks, inputRate, outputRate = 16_000) {
  const inputLength = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const input = new Float32Array(inputLength);
  let writeOffset = 0;
  for (const chunk of chunks) { input.set(chunk, writeOffset); writeOffset += chunk.length; }
  if (inputRate === outputRate) return input;
  const ratio = inputRate / outputRate;
  const output = new Float32Array(Math.max(1, Math.floor(input.length / ratio)));
  for (let outputIndex = 0; outputIndex < output.length; outputIndex += 1) {
    const start = Math.floor(outputIndex * ratio);
    const end = Math.min(input.length, Math.floor((outputIndex + 1) * ratio));
    let sum = 0;
    for (let inputIndex = start; inputIndex < end; inputIndex += 1) sum += input[inputIndex];
    output[outputIndex] = sum / Math.max(1, end - start);
  }
  return output;
}

function normalizeVoiceAudio(samples) {
  if (!samples.length) return samples;
  let mean = 0;
  for (const sample of samples) mean += sample;
  mean /= samples.length;
  let sumSquares = 0;
  let peak = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const centered = samples[index] - mean;
    samples[index] = centered;
    sumSquares += centered * centered;
    peak = Math.max(peak, Math.abs(centered));
  }
  const rms = Math.sqrt(sumSquares / samples.length);
  if (peak < .0005 || rms < .0001) return samples;
  const gain = Math.max(1, Math.min(24, .96 / peak, .08 / rms));
  if (gain === 1) return samples;
  for (let index = 0; index < samples.length; index += 1) samples[index] *= gain;
  return samples;
}

function encodePcmWav(chunks, inputRate) {
  const samples = normalizeVoiceAudio(downsampleAudio(chunks, inputRate));
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeAscii = (offset, text) => [...text].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)));
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, index) => {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(44 + index * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  });
  return buffer;
}

function stopAudioInput() {
  voice.processor?.disconnect();
  voice.source?.disconnect();
  voice.silentGain?.disconnect();
  voice.stream?.getTracks().forEach((track) => track.stop());
  voice.context?.close().catch(() => {});
  voice.stream = null;
  voice.context = null;
  voice.source = null;
  voice.processor = null;
  voice.silentGain = null;
}

function audioFrame(event) {
  const samples = event.inputBuffer.getChannelData(0);
  const copy = new Float32Array(samples);
  let energy = 0;
  for (const sample of copy) energy += sample * sample;
  const rms = Math.sqrt(energy / copy.length);
  voice.level = Math.min(1, rms * 7.5);
  const frameMs = copy.length / voice.context.sampleRate * 1000;
  if (voice.recording) {
    voice.recordingChunks.push(copy);
    voice.recordingSamples += copy.length;
    if (rms >= .0018) {
      voice.speechDetected = true;
      voice.quietForMs = 0;
    } else if (voice.speechDetected) {
      voice.quietForMs += frameMs;
    }
    const elapsed = performance.now() - voice.recordingStartedAt;
    if ((voice.speechDetected && elapsed > 900 && voice.quietForMs > 950) || elapsed > 30_000) queueMicrotask(() => finishVoiceRecording());
    return;
  }
  if (voice.wakeEnabled && !voice.wakeBusy && $('#voice-stage')?.dataset.voiceState === 'idle') {
    voice.wakeChunks.push(copy);
    voice.wakeSamples += copy.length;
    if (voice.wakeSamples >= voice.context.sampleRate * 3.2) queueMicrotask(checkWakePhrase);
  }
}

async function ensureAudioInput() {
  if (voice.stream?.active && voice.context) {
    if (voice.context.state === 'suspended') await voice.context.resume();
    return;
  }
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error('Microphone access requires HTTPS and a supported browser.');
  voice.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
  const AudioEngine = window.AudioContext || window.webkitAudioContext;
  voice.context = new AudioEngine({ latencyHint: 'interactive' });
  await voice.context.resume();
  voice.source = voice.context.createMediaStreamSource(voice.stream);
  voice.processor = voice.context.createScriptProcessor(4096, 1, 1);
  voice.silentGain = voice.context.createGain();
  voice.silentGain.gain.value = 0;
  voice.processor.onaudioprocess = audioFrame;
  voice.source.connect(voice.processor);
  voice.processor.connect(voice.silentGain);
  voice.silentGain.connect(voice.context.destination);
}

function playWakeChime() {
  if (!voice.context) return;
  const oscillator = voice.context.createOscillator();
  const gain = voice.context.createGain();
  oscillator.frequency.setValueAtTime(520, voice.context.currentTime);
  oscillator.frequency.exponentialRampToValueAtTime(760, voice.context.currentTime + .12);
  gain.gain.setValueAtTime(.0001, voice.context.currentTime);
  gain.gain.exponentialRampToValueAtTime(.08, voice.context.currentTime + .02);
  gain.gain.exponentialRampToValueAtTime(.0001, voice.context.currentTime + .18);
  oscillator.connect(gain); gain.connect(voice.context.destination);
  oscillator.start(); oscillator.stop(voice.context.currentTime + .19);
}

async function transcribeWav(wav, intent = 'transcribe') {
  const response = await fetch('/api/voice/transcribe', {
    method: 'POST',
    headers: { 'Content-Type': 'audio/wav', 'X-Claudia-Voice': intent },
    body: wav,
    signal: voice.requestController?.signal,
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || 'Local transcription failed.');
  return payload.transcript || '';
}

async function checkWakePhrase() {
  if (voice.wakeBusy || !voice.wakeEnabled || !voice.context || voice.recording) return;
  voice.wakeBusy = true;
  const chunks = voice.wakeChunks;
  voice.wakeChunks = [];
  voice.wakeSamples = 0;
  try {
    const transcript = await transcribeWav(encodePcmWav(chunks, voice.context.sampleRate), 'wake');
    const match = transcript.match(/\bhey[\s,]+claudia\b[\s,.:;-]*(.*)$/i);
    if (!match) return;
    playWakeChime();
    const remainder = match[1]?.trim();
    if (remainder) await askVoice(remainder);
    else await startVoiceRecording();
  } catch (error) {
    if (error.name !== 'AbortError') console.warn('Wake phrase check failed:', error.message);
  } finally {
    voice.wakeBusy = false;
  }
}

async function startVoiceRecording() {
  try {
    voice.speechToken += 1;
    await ensureAudioInput();
    voice.recordingChunks = [];
    voice.recordingSamples = 0;
    voice.recordingStartedAt = performance.now();
    voice.quietForMs = 0;
    voice.speechDetected = false;
    voice.recording = true;
    setVoiceState('listening', 'Listening', 'Speak naturally. Silence sends automatically, or tap the button when you are done.');
  } catch (error) {
    $('#voice-wake-toggle').checked = false;
    voice.wakeEnabled = false;
    setVoiceState('idle', 'Microphone unavailable', error.message);
    toast(error.message);
  }
}

async function finishVoiceRecording() {
  if (!voice.recording || !voice.context) return;
  voice.recording = false;
  const chunks = voice.recordingChunks;
  const duration = voice.recordingSamples / voice.context.sampleRate;
  voice.recordingChunks = [];
  voice.recordingSamples = 0;
  voice.speechDetected = false;
  if (duration < .2) {
    setVoiceState('idle', 'Recording was too short', 'Try again and say an entire thought this time.');
    return;
  }
  voice.requestController = new AbortController();
  setVoiceState('transcribing', 'Transcribing locally', 'Whisper is turning your noise into something resembling language.');
  try {
    const transcript = await transcribeWav(encodePcmWav(chunks, voice.context.sampleRate));
    await askVoice(transcript);
  } catch (error) {
    if (error.name !== 'AbortError') {
      setVoiceState('idle', 'Transcription failed', error.message);
      toast(error.message);
    }
  } finally {
    voice.requestController = null;
  }
}

function appendVoiceMessage(role, text) {
  voice.conversation.push({ role, text: String(text), at: new Date() });
  voice.conversation = voice.conversation.slice(-20);
  const log = $('#voice-conversation');
  log.querySelector('.voice-empty')?.remove();
  const message = create('div', `voice-message ${role}`);
  message.append(create('small', '', role === 'user' ? 'operator' : 'Claudia'), document.createTextNode(String(text)));
  log.append(message);
  log.scrollTop = log.scrollHeight;
}

function primeSpeechOutput() {
  if (voice.speechPrimed || !$('#voice-speech-toggle')?.checked) return voice.outputContext;
  try {
    const AudioEngine = window.AudioContext || window.webkitAudioContext;
    if (!AudioEngine) throw new Error('This browser has no audio playback engine.');
    if (!voice.outputContext || voice.outputContext.state === 'closed') voice.outputContext = new AudioEngine({ latencyHint: 'interactive' });
    voice.outputContext.resume().catch(() => {});
    const primer = voice.outputContext.createBufferSource();
    primer.buffer = voice.outputContext.createBuffer(1, 1, 22_050);
    primer.connect(voice.outputContext.destination);
    primer.start();
    voice.speechPrimed = true;
    return voice.outputContext;
  } catch {
    voice.speechPrimed = false;
    return null;
  }
}

function decodeVoiceAudio(context, audio) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (handler) => (value) => {
      if (settled) return;
      settled = true;
      handler(value);
    };
    const pending = context.decodeAudioData(audio.slice(0), finish(resolve), finish(reject));
    pending?.then(finish(resolve), finish(reject));
  });
}

async function speakVoiceReply(text) {
  voice.lastReply = String(text || '');
  $('#voice-replay-button').disabled = !voice.lastReply;
  if (!$('#voice-speech-toggle').checked) {
    setVoiceState('idle', voice.wakeEnabled ? 'Waiting for “Hey Claudia”' : 'Ready when you are', 'The reply is on screen. Spoken replies are disabled.');
    return false;
  }
  const token = ++voice.speechToken;
  setVoiceState('speaking', 'Building local voice', 'Piper is generating private speech audio on this server.');
  try {
    const response = await fetch('/api/voice/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Claudia-Voice': 'speak' },
      body: JSON.stringify({ text: voice.lastReply }),
      signal: voice.requestController?.signal,
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || 'Local voice generation failed.');
    }
    const audio = await response.arrayBuffer();
    if (token !== voice.speechToken) return false;
    const context = primeSpeechOutput();
    if (!context) throw new Error('The browser audio engine could not be started.');
    await context.resume();
    const decoded = await decodeVoiceAudio(context, audio);
    if (token !== voice.speechToken) return false;
    const source = context.createBufferSource();
    const gain = context.createGain();
    gain.gain.value = .96;
    source.buffer = decoded;
    source.connect(gain).connect(context.destination);
    voice.playbackSource = source;
    setVoiceState('speaking', 'Speaking', 'Tap the microphone to interrupt and talk over me.');
    await new Promise((resolve) => {
      source.onended = resolve;
      source.start();
    });
    if (voice.playbackSource === source) voice.playbackSource = null;
  } catch (error) {
    if (token !== voice.speechToken) return false;
    if (error.name !== 'AbortError') {
      setVoiceState('idle', 'Local voice failed', error.message);
      toast(error.message);
    }
    return false;
  }
  if (token === voice.speechToken) setVoiceState('idle', voice.wakeEnabled ? 'Waiting for “Hey Claudia”' : 'Ready when you are', voice.wakeEnabled ? 'Hands-free listening is active.' : 'Press the microphone whenever your next thought finally arrives.');
  return true;
}

async function askVoice(text) {
  const clean = String(text || '').trim();
  if (!clean) return;
  appendVoiceMessage('user', clean);
  voice.requestController?.abort();
  voice.requestController = new AbortController();
  setVoiceState('thinking', 'Claudia is thinking', 'The real OpenClaw agent is handling your request in a dedicated private session.');
  try {
    const response = await fetch('/api/voice/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Claudia-Voice': 'ask' },
      body: JSON.stringify({ text: clean }),
      signal: voice.requestController.signal,
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Voice turn failed.');
    appendVoiceMessage('assistant', payload.reply);
    await speakVoiceReply(payload.reply);
  } catch (error) {
    if (error.name !== 'AbortError') {
      setVoiceState('idle', 'Voice turn failed', error.message);
      toast(error.message);
    }
  } finally {
    voice.requestController = null;
  }
}

async function interruptVoice() {
  voice.recording = false;
  voice.recordingChunks = [];
  voice.recordingSamples = 0;
  voice.speechDetected = false;
  voice.requestController?.abort();
  voice.requestController = null;
  voice.speechToken += 1;
  try { voice.playbackSource?.stop(); } catch {}
  voice.playbackSource = null;
  fetch('/api/voice/cancel', { method: 'POST', headers: { 'X-Claudia-Voice': 'cancel' } }).catch(() => {});
  setVoiceState('idle', voice.wakeEnabled ? 'Waiting for “Hey Claudia”' : 'Interrupted', 'The previous turn was stopped.');
}

async function toggleWakePhrase(event) {
  const enabled = event.currentTarget.checked;
  if (enabled) {
    try {
      primeSpeechOutput();
      await ensureAudioInput();
      voice.wakeEnabled = true;
      voice.wakeChunks = [];
      voice.wakeSamples = 0;
      setVoiceState('idle', 'Waiting for “Hey Claudia”', 'Hands-free listening is active and processed only by the local speech engine.');
    } catch (error) {
      event.currentTarget.checked = false;
      voice.wakeEnabled = false;
      toast(error.message);
    }
  } else {
    voice.wakeEnabled = false;
    voice.wakeChunks = [];
    voice.wakeSamples = 0;
    if (!voice.recording) stopAudioInput();
    setVoiceState('idle', 'Ready when you are', 'Wake listening is off. Press the microphone to speak.');
  }
}

function renderAll() {
  renderDashboard();
  renderBrain();
  renderAtlas();
  renderProjects();
  renderDreams();
}

async function loadAll({ announce = false } = {}) {
  if (state.loading) return;
  state.loading = true;
  const refresh = $('#refresh-button');
  refresh.classList.add('loading');
  refresh.disabled = true;
  try {
    const results = await Promise.allSettled([
      fetchJson('/api/dashboard'),
      fetchJson('/api/brain'),
      fetchJson('/api/projects'),
      fetchJson('/api/dreams'),
    ]);
    const keys = ['dashboard', 'brain', 'projects', 'dreams'];
    let failed = 0;
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') state[keys[index]] = result.value;
      else failed += 1;
    });
    renderAll();
    if (failed === results.length) throw new Error('Dashboard APIs are unavailable');
    if (failed) toast(`${failed} dashboard ${failed === 1 ? 'signal is' : 'signals are'} temporarily unavailable.`);
    else if (announce) toast('Dashboard refreshed. Everything useful is current.');
  } catch (error) {
    console.error(error);
    setConnection('offline', 'Connection lost', 'Retrying shortly');
    setText('#overall-status', 'Offline');
    setText('#hero-copy', 'The dashboard cannot reach its local API. I’ll keep trying.');
    toast('Could not refresh the dashboard.');
  } finally {
    state.loading = false;
    refresh.classList.remove('loading');
    refresh.disabled = false;
  }
}

function navigate(view, { focus = true } = {}) {
  const valid = ['overview', 'memory', 'voice', 'atlas', 'projects', 'dreams', 'settings'];
  if (!valid.includes(view)) view = 'overview';
  state.view = view;
  document.body.dataset.view = view;
  $$('[data-view-panel]').forEach((panel) => {
    const active = panel.dataset.viewPanel === view;
    panel.hidden = !active;
    panel.classList.toggle('active', active);
  });
  $$('[data-nav]').forEach((item) => {
    const active = item.dataset.nav === view;
    item.classList.toggle('active', active);
    if (active) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  });
  setText('#current-view-label', view[0].toUpperCase() + view.slice(1));
  state.atlasRenderer?.setActive(view === 'atlas');
  if (view === 'atlas' && (!state.atlas || state.atlasDirty)) loadAtlas();
  if (location.hash !== `#${view}`) history.pushState(null, '', `#${view}`);
  window.scrollTo({ top: 0, behavior: 'auto' });
  if (focus) {
    const heading = $(`#view-${view} h1`);
    if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
  }
}

function paletteItems(query = '') {
  const normalized = query.trim().toLowerCase();
  const views = [
    { icon: '⌂', title: 'Overview', detail: 'Host vitals, services, memory, and network', kind: 'View', action: () => navigate('overview') },
    { icon: '∞', title: 'Memory', detail: 'Search long-term and daily memory', kind: 'View', action: () => navigate('memory') },
    { icon: '◍', title: 'Voice Terminal', detail: 'Talk to Claudia with private local speech recognition', kind: 'View', action: () => navigate('voice') },
    { icon: '◉', title: 'Brain Atlas', detail: 'Explore the living anatomical map of the vault', kind: 'View', action: () => navigate('atlas') },
    { icon: '◇', title: 'Projects', detail: 'Active work, decisions, and open threads', kind: 'View', action: () => navigate('projects') },
    { icon: '◐', title: 'Dreams', detail: 'Nightly synthesis and dream journal', kind: 'View', action: () => navigate('dreams') },
    { icon: '⚙', title: 'Settings', detail: 'Security and dashboard password', kind: 'View', action: () => navigate('settings') },
  ];
  const documents = (state.brain?.documents || []).map((doc) => ({
    icon: doc.type === 'long-term-memory' ? '∞' : '•', title: doc.title, detail: textExcerpt(doc.raw, 90), kind: 'Memory',
    action: () => { navigate('memory'); selectDocument(doc.id); },
  }));
  const projects = (state.projects?.projects || []).map((project) => ({
    icon: '◇', title: project.name, detail: project.summary, kind: 'Project', action: () => { navigate('projects'); selectProject(project.id); },
  }));
  const atlasNodes = (state.atlas?.nodes || []).map((node) => ({
    icon: node.hub ? '✦' : '·', title: node.title, detail: `${node.kindLabel} · ${node.regionLabel} · ${node.degree} links`, kind: 'Atlas',
    action: () => { navigate('atlas'); selectAtlasNode(node.id); },
  }));
  const all = [...views, ...documents, ...projects, ...atlasNodes];
  if (!normalized) return all.slice(0, 10);
  return all.filter((item) => `${item.title} ${item.detail} ${item.kind}`.toLowerCase().includes(normalized)).slice(0, 14);
}

function renderPalette(query = '') {
  state.paletteResults = paletteItems(query);
  state.paletteIndex = Math.min(state.paletteIndex, Math.max(0, state.paletteResults.length - 1));
  const list = $('#command-results');
  list.replaceChildren();
  if (!state.paletteResults.length) {
    list.append(create('div', 'palette-empty', 'No matches. Try a broader thought.'));
    return;
  }
  state.paletteResults.forEach((item, index) => {
    const button = create('button', `palette-result${index === state.paletteIndex ? ' selected' : ''}`);
    button.type = 'button';
    button.setAttribute('role', 'option');
    button.setAttribute('aria-selected', index === state.paletteIndex ? 'true' : 'false');
    const icon = create('span', '', item.icon);
    icon.setAttribute('aria-hidden', 'true');
    const content = create('span');
    content.append(create('strong', '', item.title), create('small', '', item.detail));
    button.append(icon, content, create('em', '', item.kind));
    button.addEventListener('mouseenter', () => { state.paletteIndex = index; updatePaletteSelection(); });
    button.addEventListener('click', () => choosePaletteItem(index));
    list.append(button);
  });
}

function updatePaletteSelection() {
  $$('.palette-result').forEach((button, index) => {
    const selected = index === state.paletteIndex;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-selected', selected ? 'true' : 'false');
    if (selected) button.scrollIntoView({ block: 'nearest' });
  });
}

let paletteTrigger = null;
function openPalette(trigger) {
  paletteTrigger = trigger || document.activeElement;
  state.paletteIndex = 0;
  $('#command-input').value = '';
  renderPalette();
  $('#command-palette').showModal();
  requestAnimationFrame(() => $('#command-input').focus());
}

function closePalette() {
  const dialog = $('#command-palette');
  if (dialog.open) dialog.close();
  paletteTrigger?.focus?.();
}

function choosePaletteItem(index = state.paletteIndex) {
  const item = state.paletteResults[index];
  if (!item) return;
  closePalette();
  item.action();
}

function setLive(enabled) {
  state.live = enabled;
  const button = $('#live-toggle');
  button.setAttribute('aria-pressed', enabled ? 'true' : 'false');
  button.setAttribute('aria-label', enabled ? 'Pause automatic refresh' : 'Resume automatic refresh');
  setConnection(enabled ? 'live' : 'paused', enabled ? 'Live connection' : 'Auto-refresh paused', state.dashboard?.host?.hostname || 'Local telemetry');
  toast(enabled ? 'Automatic refresh resumed.' : 'Automatic refresh paused.');
}

function updatePasswordStrength() {
  const nextSecret = $('#new-password').value;
  let score = 0;
  if (nextSecret.length >= 12) score += 1;
  if (nextSecret.length >= 20) score += 1;
  if (/[a-z]/.test(nextSecret) && /[A-Z]/.test(nextSecret)) score += 1;
  if (/\d/.test(nextSecret) && /[^\w\s]/.test(nextSecret)) score += 1;
  const labels = ['waiting for input', 'fair', 'good', 'strong', 'excellent'];
  $('#password-strength').style.width = `${score * 25}%`;
  $('#password-strength').dataset.score = String(score);
  setText('#password-strength-label', `Strength: ${labels[score]}`);
}

async function changePassword(event) {
  event.preventDefault();
  const currentSecret = $('#current-password').value;
  const nextSecret = $('#new-password').value;
  const confirmation = $('#confirm-password').value;
  const status = $('#password-status');
  const submit = $('#password-submit');
  if (nextSecret !== confirmation) {
    status.textContent = 'The new passwords do not match.';
    $('#confirm-password').focus();
    return;
  }
  status.textContent = 'Encrypting and rotating…';
  submit.disabled = true;
  try {
    const payload = Object.fromEntries([
      ['currentPassword', currentSecret],
      ['newPassword', nextSecret],
      ['confirmPassword', confirmation],
    ]);
    const response = await fetch('/api/settings/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Claudia-Settings': 'password-change' },
      body: JSON.stringify(payload),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Password rotation failed.');
    event.currentTarget.reset();
    updatePasswordStrength();
    status.textContent = 'Password updated. Reconnecting—use the new password when prompted.';
    toast('Password rotated. Reconnect with the new credential.');
    setTimeout(() => location.reload(), 1800);
  } catch (error) {
    status.textContent = error.message;
    submit.disabled = false;
  }
}

function connectEvents() {
  const source = new EventSource('/api/events');
  source.addEventListener('ready', () => {
    if (state.live) setConnection('live', 'Live connection', state.dashboard?.host?.hostname || 'Local telemetry');
  });
  source.addEventListener('memory', () => {
    state.atlasDirty = true;
    state.atlasRevision += 1;
    if (state.live) {
      loadAll();
      if (state.view === 'atlas') loadAtlas();
    }
  });
  source.onerror = () => {
    if (state.live) setConnection('offline', 'Reconnecting', 'Live updates interrupted');
  };
  return source;
}

function bindEvents() {
  $$('[data-nav]').forEach((item) => item.addEventListener('click', (event) => {
    event.preventDefault();
    navigate(item.dataset.nav);
  }));
  $('#refresh-button').addEventListener('click', () => loadAll({ announce: true }));
  $('#service-refresh').addEventListener('click', () => loadAll({ announce: true }));
  $('#live-toggle').addEventListener('click', () => setLive(!state.live));
  $('#password-form').addEventListener('submit', changePassword);
  $('#new-password').addEventListener('input', updatePasswordStrength);
  $('#show-passwords').addEventListener('change', (event) => {
    const type = event.currentTarget.checked ? 'text' : 'password';
    ['#current-password', '#new-password', '#confirm-password'].forEach((selector) => { $(selector).type = type; });
  });
  $('#voice-main-button').addEventListener('click', async () => {
    primeSpeechOutput();
    const kind = $('#voice-stage').dataset.voiceState;
    if (kind === 'listening') await finishVoiceRecording();
    else if (kind === 'speaking') { await interruptVoice(); await startVoiceRecording(); }
    else if (kind === 'idle') await startVoiceRecording();
  });
  $('#voice-stop-button').addEventListener('click', interruptVoice);
  $('#voice-wake-toggle').addEventListener('change', toggleWakePhrase);
  $('#voice-speech-toggle').addEventListener('change', (event) => {
    if (event.currentTarget.checked) primeSpeechOutput();
  });
  $('#voice-text-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    primeSpeechOutput();
    const input = $('#voice-text-input');
    const value = input.value.trim();
    if (!value) return;
    input.value = '';
    await askVoice(value);
  });
  $('#voice-clear-button').addEventListener('click', () => {
    voice.conversation = [];
    voice.lastReply = '';
    $('#voice-replay-button').disabled = true;
    const log = $('#voice-conversation');
    log.replaceChildren();
    const empty = create('div', 'voice-empty');
    empty.append(create('span', '', '⌁'), create('p', '', 'Conversation display cleared. The dedicated agent session remains private.'));
    log.append(empty);
  });
  $('#voice-replay-button').addEventListener('click', async () => {
    if (!voice.lastReply) return;
    if (!$('#voice-speech-toggle').checked) $('#voice-speech-toggle').checked = true;
    await speakVoiceReply(voice.lastReply);
  });
  $('#memory-search').addEventListener('input', (event) => renderDocuments(event.target.value));
  $('#command-trigger').addEventListener('click', (event) => openPalette(event.currentTarget));
  $('#mobile-command')?.addEventListener('click', (event) => openPalette(event.currentTarget));
  $('#atlas-search').addEventListener('input', (event) => {
    const query = event.target.value;
    state.atlasRenderer?.setSearch(query);
    if (query.trim() && !state.atlasIndexOpen) setAtlasIndex(true, { focus: false });
    renderAtlasIndex(query);
  });
  $('#atlas-list-toggle').addEventListener('click', () => setAtlasIndex(!state.atlasIndexOpen));
  $('#atlas-index-close').addEventListener('click', () => setAtlasIndex(false));
  $('#atlas-labels').addEventListener('click', (event) => {
    state.atlasLabels = !state.atlasLabels;
    event.currentTarget.setAttribute('aria-pressed', state.atlasLabels ? 'true' : 'false');
    state.atlasRenderer?.setLabels(state.atlasLabels);
  });
  $('#atlas-motion').addEventListener('click', (event) => {
    state.atlasMotion = !state.atlasMotion;
    event.currentTarget.setAttribute('aria-pressed', state.atlasMotion ? 'true' : 'false');
    state.atlasRenderer?.setMotion(state.atlasMotion);
    toast(state.atlasMotion ? 'Atlas motion resumed.' : 'Atlas motion paused.');
  });
  $('#atlas-reset').addEventListener('click', () => state.atlasRenderer?.reset());
  $('#atlas-zoom-in').addEventListener('click', () => state.atlasRenderer?.zoomBy(.16));
  $('#atlas-zoom-out').addEventListener('click', () => state.atlasRenderer?.zoomBy(-.16));
  $$('[data-atlas-region]').forEach((button) => button.addEventListener('click', () => {
    const region = button.dataset.atlasRegion;
    const enabled = !atlasRegionEnabled(region);
    state.atlasRegions.set(region, enabled);
    button.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    state.atlasRenderer?.setRegion(region, enabled);
    renderAtlasIndex();
  }));
  $('#atlas-open-memory').addEventListener('click', (event) => {
    const documentId = event.currentTarget.dataset.documentId;
    if (!documentId) return;
    navigate('memory');
    selectDocument(documentId);
  });
  $('#command-close').addEventListener('click', closePalette);
  $('#command-input').addEventListener('input', (event) => { state.paletteIndex = 0; renderPalette(event.target.value); });
  $('#command-input').addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); state.paletteIndex = Math.min(state.paletteResults.length - 1, state.paletteIndex + 1); updatePaletteSelection(); }
    if (event.key === 'ArrowUp') { event.preventDefault(); state.paletteIndex = Math.max(0, state.paletteIndex - 1); updatePaletteSelection(); }
    if (event.key === 'Enter') { event.preventDefault(); choosePaletteItem(); }
  });
  $('#command-palette').addEventListener('click', (event) => {
    if (event.target === event.currentTarget) closePalette();
  });
  $('#command-palette').addEventListener('close', () => paletteTrigger?.focus?.());
  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); openPalette($('#command-trigger')); }
  });
  window.addEventListener('hashchange', () => navigate(location.hash.slice(1) || 'overview', { focus: false }));
  document.addEventListener('visibilitychange', () => {
    state.atlasRenderer?.setActive(state.view === 'atlas' && !document.hidden);
    if (!document.hidden && state.live && state.lastUpdated && Date.now() - state.lastUpdated.getTime() > 30_000) loadAll();
  });
  window.addEventListener('pagehide', () => { interruptVoice(); stopAudioInput(); voice.outputContext?.close().catch(() => {}); });
}

async function init() {
  updateClock();
  setInterval(updateClock, 30_000);
  bindEvents();
  $('#atlas-motion').setAttribute('aria-pressed', state.atlasMotion ? 'true' : 'false');
  navigate(location.hash.slice(1) || 'overview', { focus: false });
  await loadAll();
  await loadVoiceStatus();
  drawVoiceWaveform();
  connectEvents();
  setInterval(() => { if (state.live && !document.hidden) loadAll(); }, 20_000);
  setInterval(() => {
    if (state.lastUpdated) setText('#hero-kicker', `Live system intelligence · updated ${formatRelative(state.lastUpdated)}`);
  }, 30_000);
  setInterval(loadVoiceStatus, 60_000);
}

init();
