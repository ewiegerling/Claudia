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
  const valid = ['overview', 'memory', 'atlas', 'projects', 'dreams', 'settings'];
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
  if (nextSecret.length >= 20) score += 1;
  if (nextSecret.length >= 28) score += 1;
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
}

async function init() {
  updateClock();
  setInterval(updateClock, 30_000);
  bindEvents();
  $('#atlas-motion').setAttribute('aria-pressed', state.atlasMotion ? 'true' : 'false');
  navigate(location.hash.slice(1) || 'overview', { focus: false });
  await loadAll();
  connectEvents();
  setInterval(() => { if (state.live && !document.hidden) loadAll(); }, 20_000);
  setInterval(() => {
    if (state.lastUpdated) setText('#hero-kicker', `Live system intelligence · updated ${formatRelative(state.lastUpdated)}`);
  }, 30_000);
}

init();
