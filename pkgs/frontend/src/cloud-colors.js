import { accountHint, accountRequest } from './account-api.js?v=97';

const HEX = /^#[0-9a-f]{6}$/i;
const LEGACY_COLORS_KEY = 'lessonColors:v1';
const LEGACY_RECENT_KEY = 'lessonRecentColors:v1';
const emptyDocument = () => ({ schemaVersion: 1, savedAt: 0, colors: {}, recentColors: [] });

function colorEntries(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .filter(([key, color]) => key.length <= 250 && !['__proto__', 'constructor', 'prototype'].includes(key) && typeof color === 'string' && HEX.test(color))
    .map(([key, color]) => [key, color.toLowerCase()]));
}

function recentColors(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .filter(color => typeof color === 'string' && HEX.test(color))
    .map(color => color.toLowerCase()))].slice(0, 3);
}

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}

function storageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function storageSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* optional local cache */ }
}

function normalizeLocal(saved) {
  const source = saved && typeof saved === 'object' ? saved : {};
  const document = source.document && typeof source.document === 'object' ? source.document : emptyDocument();
  const pending = {};
  let seq = Number.isSafeInteger(source.seq) && source.seq >= 0 ? source.seq : 0;
  if (source.pending && typeof source.pending === 'object' && !Array.isArray(source.pending)) {
    for (const [key, edit] of Object.entries(source.pending)) {
      if (key.length > 250 || ['__proto__', 'constructor', 'prototype'].includes(key) || !edit || !Number.isSafeInteger(edit.seq) || edit.seq < 0 || (edit.value !== null && (typeof edit.value !== 'string' || !HEX.test(edit.value)))) continue;
      pending[key] = { value: typeof edit.value === 'string' ? edit.value.toLowerCase() : null, seq: edit.seq };
      seq = Math.max(seq, edit.seq);
    }
  }
  const recent = source.recent && Number.isSafeInteger(source.recent.seq)
    ? { value: recentColors(source.recent.value), seq: source.recent.seq } : null;
  if (recent) seq = Math.max(seq, recent.seq);
  return {
    document: { schemaVersion: 1, savedAt: Number(document.savedAt) || 0, colors: colorEntries(document.colors), recentColors: recentColors(document.recentColors) },
    pending, seq, recent,
  };
}

export function mergeColors(remote, pending) {
  const colors = { ...remote };
  for (const [key, edit] of Object.entries(pending)) {
    if (edit.value === null) delete colors[key]; else colors[key] = edit.value;
  }
  return colors;
}

export function acknowledgeEdits(pending, sent) {
  for (const [key, edit] of Object.entries(sent)) if (pending[key]?.seq === edit.seq) delete pending[key];
}

// Stage the old device-only palette as normal pending edits. The caller marks
// the migration complete only after the API confirms the resulting JSON.
export function stageLegacyColors(local, legacyColors, legacyRecent) {
  for (const [key, value] of Object.entries(colorEntries(legacyColors))) {
    if (local.pending[key]?.value === value || (!local.pending[key] && local.document.colors[key] === value)) continue;
    local.pending[key] = { value, seq: ++local.seq };
  }
  const recent = recentColors(legacyRecent);
  const current = local.recent?.value || local.document.recentColors;
  if (recent.length && JSON.stringify(recent) !== JSON.stringify(current)) local.recent = { value: recent, seq: ++local.seq };
  return local;
}

export function buildColorDocument(remote, pending, recent) {
  return { schemaVersion: 1, savedAt: Number(remote.savedAt) || 0,
    colors: mergeColors(colorEntries(remote.colors), pending),
    recentColors: recentColors(recent?.value || remote.recentColors) };
}

export function setupCloudColors(onChange, onError) {
  const uid = accountHint();
  if (!uid) return null;
  const key = `colors:account:${uid}`;
  const migrationKey = `colors:legacy-imported:${uid}:v2`;
  let local = normalizeLocal(readJson(key, null));
  const legacy = {
    colors: colorEntries(readJson(LEGACY_COLORS_KEY, {})),
    recent: recentColors(readJson(LEGACY_RECENT_KEY, [])),
  };
  let migrationPending = !storageGet(migrationKey) && (Object.keys(legacy.colors).length > 0 || legacy.recent.length > 0);
  if (migrationPending) stageLegacyColors(local, legacy.colors, legacy.recent);
  else if (!storageGet(migrationKey)) storageSet(migrationKey, 'empty');

  let running = false, timer, disposed = false, reportedError = false, lastRead = 0, failures = 0;
  const dirty = () => Object.keys(local.pending).length > 0 || Boolean(local.recent);
  function persist() { try { localStorage.setItem(key, JSON.stringify(local)); } catch { /* server still available */ } }
  function paint() {
    const colors = mergeColors(local.document.colors, local.pending);
    try {
      localStorage.setItem(LEGACY_COLORS_KEY, JSON.stringify(colors));
      localStorage.setItem(LEGACY_RECENT_KEY, JSON.stringify(local.recent?.value || local.document.recentColors));
    } catch { /* optional compatibility cache */ }
    onChange?.();
  }
  const queue = (ms = 3000) => { clearTimeout(timer); timer = setTimeout(sync, ms); };
  async function sync() {
    if (running || disposed || accountHint() !== uid) return;
    running = true;
    try {
      // Always read latest before merging edits; timestamps never order writes.
      const current = await accountRequest('colors');
      lastRead = Date.now();
      if (String(current.userId) !== uid) throw new Error('Учётная запись изменилась.');
      local.document = buildColorDocument(current.document, {}, null);
      // Re-stage after the GET too: the cached document may have matched the
      // legacy palette while the actual server document was still empty.
      if (migrationPending) stageLegacyColors(local, legacy.colors, legacy.recent);
      paint();
      if (dirty()) {
        const sent = JSON.parse(JSON.stringify(local.pending)), recent = local.recent && { ...local.recent };
        const document = buildColorDocument(local.document, sent, recent);
        const saved = await accountRequest('colors', { revision: current.revision, document }, 'PUT');
        acknowledgeEdits(local.pending, sent);
        if (recent && local.recent?.seq === recent.seq) local.recent = null;
        local.document = buildColorDocument(saved.document, {}, null);
        if (migrationPending) {
          storageSet(migrationKey, 'uploaded');
          migrationPending = false;
        }
        paint();
      } else if (migrationPending) {
        storageSet(migrationKey, 'already-current');
        migrationPending = false;
      }
      persist();
      reportedError = false; failures = 0;
    } catch (error) {
      failures++;
      if (error.status !== 409) console.warn('Цвета пока не синхронизированы:', error.message);
      if (dirty() && !reportedError && error.status !== 409) {
        onError?.(`Цвета сохранены на устройстве. Сервер: ${error.message}`);
        reportedError = true;
      }
    } finally { running = false; if (dirty()) queue(Math.min(300000, 10000 * 2 ** Math.min(failures, 5))); }
  }
  const refresh = () => { if (!document.hidden && (dirty() || Date.now() - lastRead >= 60000)) void sync(); };
  window.addEventListener('focus', refresh);
  window.addEventListener('online', refresh);
  document.addEventListener('visibilitychange', refresh);
  const interval = setInterval(refresh, 600000);
  window.addEventListener('lesson-recent-changed', event => {
    local.recent = { value: recentColors(event.detail), seq: ++local.seq }; persist(); queue();
  });
  persist(); paint(); void sync();
  return {
    getColors: () => mergeColors(local.document.colors, local.pending),
    edit(key, value) { local.pending[key] = { value: value?.toLowerCase() || null, seq: ++local.seq }; persist(); queue(); },
    stop() { disposed = true; clearTimeout(timer); clearInterval(interval); window.removeEventListener('focus', refresh); window.removeEventListener('online', refresh); document.removeEventListener('visibilitychange', refresh); },
  };
}
