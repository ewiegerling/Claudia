const elements = Object.fromEntries([
  'connection-dot', 'connection-label', 'readiness', 'last-refresh', 'uptime', 'memory', 'disk', 'load',
  'service-grid', 'vault-branch', 'vault-commit', 'vault-pending', 'archive-list', 'audit-list', 'refresh',
  'download-diagnostics', 'confirm-dialog', 'confirm-title', 'confirm-impact', 'execute-action', 'toast',
  'backup-list', 'backup-count', 'backup-capacity', 'create-backup',
].map((id) => [id, document.getElementById(id)]));

const serviceLabels = {
  'openclaw-gateway.service': 'OpenClaw gateway',
  'claudia-dashboard.service': 'Dashboard',
  'claudia-stt.service': 'Speech recognition',
  'claudia-tts.service': 'Speech synthesis',
  'claudia-recovery.service': 'Recovery portal',
};

let pendingAction = null;
let refreshTimer = null;

function formatDuration(seconds) {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function formatDate(value) {
  if (!value) return 'Unknown';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'Unknown';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1_024 && unit < units.length - 1) { value /= 1_024; unit += 1; }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function setText(element, value) { element.textContent = String(value); }

function showToast(message, error = false) {
  setText(elements.toast, message);
  elements.toast.classList.toggle('error', error);
  elements.toast.hidden = false;
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => { elements.toast.hidden = true; }, 5_000);
}

function renderServices(services) {
  elements['service-grid'].replaceChildren(...services.map((service) => {
    const card = document.createElement('article');
    card.className = 'service-card';
    const header = document.createElement('header');
    const title = document.createElement('h3');
    title.textContent = serviceLabels[service.unit] || service.unit;
    title.title = service.unit;
    const light = document.createElement('span');
    light.className = `status-light${service.active === 'active' ? ' online' : ''}`;
    light.setAttribute('aria-hidden', 'true');
    const state = document.createElement('p');
    state.textContent = service.active;
    const detail = document.createElement('small');
    detail.textContent = `${service.sub} // PID ${service.pid || '—'}`;
    header.append(title, light);
    card.append(header, state, detail);
    return card;
  }));
}

function renderArchives(archives) {
  if (!archives.length) {
    const empty = document.createElement('li');
    empty.textContent = 'No local recovery archives found.';
    elements['archive-list'].replaceChildren(empty);
    return;
  }
  elements['archive-list'].replaceChildren(...archives.map((archive) => {
    const item = document.createElement('li');
    const name = document.createElement('strong');
    name.textContent = archive.name;
    const date = document.createElement('span');
    date.textContent = formatDate(archive.modifiedAt);
    item.append(name, date);
    return item;
  }));
}

function renderAudit(audit) {
  if (!audit.length) {
    const empty = document.createElement('li');
    empty.textContent = 'No recovery actions recorded.';
    elements['audit-list'].replaceChildren(empty);
    return;
  }
  elements['audit-list'].replaceChildren(...audit.map((event) => {
    const item = document.createElement('li');
    const action = document.createElement('strong');
    action.textContent = event.action.replaceAll('_', ' ');
    const result = document.createElement('span');
    result.textContent = `${event.outcome} // ${formatDate(event.at)}`;
    item.append(action, result);
    return item;
  }));
}

function renderBackups(payload) {
  const backups = Array.isArray(payload.backups) ? payload.backups : [];
  setText(elements['backup-count'], backups.length);
  setText(elements['backup-capacity'], `${backups.length} of ${payload.maximumBackups} local slots used`);
  if (!backups.length) {
    const empty = document.createElement('p');
    empty.className = 'backup-empty';
    empty.textContent = 'No managed snapshots yet. Create one before you break something important.';
    elements['backup-list'].replaceChildren(empty);
    return;
  }
  elements['backup-list'].replaceChildren(...backups.map((backup) => {
    const card = document.createElement('article');
    card.className = 'backup-card';

    const primary = document.createElement('div');
    primary.className = 'backup-card-primary';
    const title = document.createElement('strong');
    title.textContent = backup.id;
    title.title = backup.id;
    const created = document.createElement('span');
    created.textContent = formatDate(backup.createdAt);
    primary.append(title, created);

    const facts = [
      ['SIZE', formatBytes(backup.bytes)],
      ['COMMIT', backup.commit || 'Uncommitted'],
      ['SHA-256', `${backup.sha256.slice(0, 12)}…`],
    ].map(([label, value]) => {
      const fact = document.createElement('div');
      fact.className = 'backup-fact';
      const name = document.createElement('small');
      name.textContent = label;
      const data = document.createElement('strong');
      data.textContent = value;
      data.title = label === 'SHA-256' ? backup.sha256 : value;
      fact.append(name, data);
      return fact;
    });

    const verify = document.createElement('button');
    verify.className = 'ghost-button backup-verify';
    verify.type = 'button';
    verify.dataset.backupId = backup.id;
    verify.textContent = `Verify integrity · ${formatDate(backup.verifiedAt)}`;
    card.append(primary, ...facts, verify);
    return card;
  }));
}

function renderBackupError() {
  setText(elements['backup-count'], '—');
  setText(elements['backup-capacity'], 'Backup inventory unavailable');
  const unavailable = document.createElement('p');
  unavailable.className = 'backup-empty';
  unavailable.textContent = 'Snapshot storage is unavailable. Core recovery status remains online.';
  elements['backup-list'].replaceChildren(unavailable);
}

function renderStatus(status) {
  const activeServices = status.services.filter((service) => service.active === 'active').length;
  const allReady = activeServices === status.services.length;
  setText(elements.readiness, allReady ? 'NOMINAL' : `${activeServices}/${status.services.length} ONLINE`);
  setText(elements['last-refresh'], `Updated ${formatDate(status.generatedAt)}`);
  setText(elements.uptime, formatDuration(status.uptimeSeconds));
  setText(elements.memory, `${status.resources.memory.usedPercent}%`);
  setText(elements.disk, status.resources.disk.usedPercent === null ? 'N/A' : `${status.resources.disk.usedPercent}%`);
  setText(elements.load, status.resources.loadAverage.join(' / '));
  setText(elements['vault-branch'], status.vault.branch || 'Unavailable');
  setText(elements['vault-commit'], status.vault.commit || 'Unavailable');
  setText(elements['vault-pending'], status.vault.pendingChanges ?? 'Unavailable');
  renderServices(status.services);
  renderArchives(status.archives);
  renderAudit(status.audit);
  elements['connection-dot'].className = 'connection-dot online';
  setText(elements['connection-label'], 'Recovery link online');
}

async function refreshStatus({ silent = false } = {}) {
  elements.refresh.disabled = true;
  try {
    const [response, backupResponse] = await Promise.all([
      fetch('/api/status', { headers: { Accept: 'application/json' }, cache: 'no-store' }),
      fetch('/api/backups', { headers: { Accept: 'application/json' }, cache: 'no-store' }),
    ]);
    if (!response.ok) throw new Error(`Status request failed (${response.status})`);
    renderStatus(await response.json());
    if (backupResponse.ok) {
      renderBackups(await backupResponse.json());
      if (!silent) showToast('Recovery status refreshed.');
    } else {
      renderBackupError();
      if (!silent) showToast(`Core status refreshed; backup inventory failed (${backupResponse.status}).`, true);
    }
  } catch (error) {
    elements['connection-dot'].className = 'connection-dot offline';
    setText(elements['connection-label'], 'Recovery link degraded');
    setText(elements.readiness, 'DEGRADED');
    if (!silent) showToast(error.message, true);
  } finally {
    elements.refresh.disabled = false;
  }
}

function setActionsDisabled(disabled) {
  for (const button of document.querySelectorAll('[data-action]')) button.disabled = disabled;
}

function setBackupControlsDisabled(disabled) {
  elements['create-backup'].disabled = disabled;
  for (const button of document.querySelectorAll('.backup-verify')) button.disabled = disabled;
}

async function runBackupOperation(endpoint, intent, payload, successMessage) {
  setBackupControlsDisabled(true);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Claudia-Recovery': intent },
      body: JSON.stringify(payload),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || `Backup operation failed (${response.status})`);
    showToast(successMessage);
    await refreshStatus({ silent: true });
  } catch (error) {
    showToast(error.message, true);
  } finally {
    setBackupControlsDisabled(false);
  }
}

function updatePasswordStrength() {
  const nextSecret = document.getElementById('new-password').value;
  let score = 0;
  if ([...nextSecret].length >= 12) score += 1;
  if ([...nextSecret].length >= 20) score += 1;
  if (/[a-z]/u.test(nextSecret) && /[A-Z]/u.test(nextSecret)) score += 1;
  if (/\d/u.test(nextSecret) && /[^\w\s]/u.test(nextSecret)) score += 1;
  const labels = ['waiting for input', 'fair', 'good', 'strong', 'excellent'];
  const bar = document.getElementById('password-strength');
  bar.style.width = `${score * 25}%`;
  bar.dataset.score = String(score);
  setText(document.getElementById('password-strength-label'), `Strength: ${labels[score]}`);
}

async function changeRecoveryPassword(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const currentSecret = document.getElementById('current-password').value;
  const newSecret = document.getElementById('new-password').value;
  const confirmSecret = document.getElementById('confirm-password').value;
  const status = document.getElementById('password-status');
  const submit = document.getElementById('password-submit');
  if (newSecret !== confirmSecret) {
    status.textContent = 'The new passwords do not match.';
    document.getElementById('confirm-password').focus();
    return;
  }
  status.textContent = 'Encrypting the new credential…';
  submit.disabled = true;
  window.clearInterval(refreshTimer);
  try {
    const response = await fetch('/api/settings/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Claudia-Recovery': 'password-change' },
      body: JSON.stringify({ currentSecret, newSecret, confirmSecret }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || `Password rotation failed (${response.status})`);
    form.reset();
    updatePasswordStrength();
    status.textContent = 'Password updated. Reconnecting—use the new password when prompted.';
    showToast('Recovery password encrypted and rotated.');
    window.setTimeout(() => location.reload(), 1_600);
  } catch (error) {
    status.textContent = error.message;
    submit.disabled = false;
    refreshTimer = window.setInterval(() => refreshStatus({ silent: true }), 20_000);
  }
}

for (const button of document.querySelectorAll('[data-action]')) {
  button.addEventListener('click', () => {
    pendingAction = button.dataset.action;
    setText(elements['confirm-title'], button.dataset.label);
    setText(elements['confirm-impact'], button.dataset.impact);
    elements['confirm-dialog'].showModal();
  });
}

elements['execute-action'].addEventListener('click', async (event) => {
  event.preventDefault();
  if (!pendingAction) return;
  const action = pendingAction;
  pendingAction = null;
  elements['confirm-dialog'].close();
  setActionsDisabled(true);
  try {
    const response = await fetch('/api/actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ action }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || `Recovery action failed (${response.status})`);
    showToast(`${body.result.label} completed.`);
    await new Promise((resolve) => window.setTimeout(resolve, 1_000));
    await refreshStatus({ silent: true });
  } catch (error) {
    showToast(error.message, true);
  } finally {
    setActionsDisabled(false);
  }
});

elements['confirm-dialog'].addEventListener('close', () => { pendingAction = null; });
elements.refresh.addEventListener('click', () => refreshStatus());
elements['create-backup'].addEventListener('click', () => runBackupOperation(
  '/api/backups', 'backup-create', { operation: 'create' }, 'Local vault snapshot created and verified.',
));
elements['backup-list'].addEventListener('click', (event) => {
  const button = event.target.closest('[data-backup-id]');
  if (!button) return;
  runBackupOperation(
    '/api/backups/verify', 'backup-verify', { backupId: button.dataset.backupId }, 'Backup integrity verified.',
  );
});
document.getElementById('password-form').addEventListener('submit', changeRecoveryPassword);
document.getElementById('new-password').addEventListener('input', updatePasswordStrength);
document.getElementById('show-passwords').addEventListener('change', (event) => {
  const type = event.currentTarget.checked ? 'text' : 'password';
  for (const id of ['current-password', 'new-password', 'confirm-password']) document.getElementById(id).type = type;
});
elements['download-diagnostics'].addEventListener('click', async () => {
  try {
    const response = await fetch('/api/diagnostics', { headers: { Accept: 'application/json' }, cache: 'no-store' });
    if (!response.ok) throw new Error(`Diagnostics request failed (${response.status})`);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'claudia-recovery-diagnostics.json';
    link.click();
    URL.revokeObjectURL(url);
    showToast('Redacted diagnostics downloaded.');
  } catch (error) {
    showToast(error.message, true);
  }
});

document.addEventListener('visibilitychange', () => {
  window.clearInterval(refreshTimer);
  if (!document.hidden) {
    refreshStatus({ silent: true });
    refreshTimer = window.setInterval(() => refreshStatus({ silent: true }), 20_000);
  }
});

refreshStatus({ silent: true });
refreshTimer = window.setInterval(() => refreshStatus({ silent: true }), 20_000);
