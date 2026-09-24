import { accountHint, accountRequest } from './account-api.js?v=104';

const HEX = /^#[0-9a-f]{6}$/i;
const LEGACY_COLORS_KEY = 'lessonColors:v1';
const LEGACY_RECENT_KEY = 'lessonRecentColors:v1';
const emptyDocument = () => ({ schemaVersion: 1, savedAt: 0, colors: {}, recentColors: [] });

function colorEntries(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .filter(([key, color]) => key.length <= 512 && !['__proto__', 'constructor', 'prototype'].includes(key) && typeof color === 'string' && HEX.test(color))
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
      if (key.length > 512 || ['__proto__', 'constructor', 'prototype'].includes(key) || !edit || !Number.isSafeInteger(edit.seq) || edit.seq < 0 || (edit.value !== null && (typeof edit.value !== 'string' || !HEX.test(edit.value)))) continue;
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
    if (Object.hasOwn(local.pending, key) || Object.hasOwn(local.document.colors, key)) continue;
    local.pending[key] = { value, seq: ++local.seq };
  }
  const recent = recentColors(legacyRecent);
  const current = local.recent?.value || local.document.recentColors;
  if (!local.recent && !current.length && recent.length) local.recent = { value: recent, seq: ++local.seq };
  return local;
}

export function buildColorDocument(remote, pending, recent) {
  return { schemaVersion: 1, savedAt: Number(remote.savedAt) || 0,
    colors: mergeColors(colorEntries(remote.colors), pending),
    recentColors: recentColors(recent?.value || remote.recentColors) };
}

export function setupCloudColors(onChange, onError, { request = accountRequest, hint = accountHint } = {}) {
  const uid = hint();
  if (!uid) return null;
  const key = `colors:account:${uid}`;
  const migrationKey = `colors:legacy-imported:${uid}:v2`;
  const ownerKey = 'colors:legacy-owner:v2';
  const local = normalizeLocal(readJson(key, null));
  // The compatibility cache has no user identity. Claim it once, never for
  // each account sharing this browser. New paints no longer write to it.
  const owner = storageGet(ownerKey);
  const hasOtherAccount = (() => {
    try { return Object.keys(localStorage).some(k => k.startsWith('colors:account:') && k !== key); }
    catch { return true; }
  })();
  const mayImport = owner === uid || (!owner && !hasOtherAccount);
  if (mayImport && !owner) storageSet(ownerKey, uid);
  const legacy = {
    colors: mayImport ? colorEntries(readJson(LEGACY_COLORS_KEY, {})) : {},
    recent: mayImport ? recentColors(readJson(LEGACY_RECENT_KEY, [])) : [],
  };
  let migrationPending = !storageGet(migrationKey) && (Object.keys(legacy.colors).length > 0 || legacy.recent.length > 0);

  let running = false, timer, disposed = false, reportedError = false, lastRead = 0, failures = 0;
  // A revision is valid only alongside the document fetched in this session.
  let revision = null;
  const active = () => !disposed && hint() === uid;
  const dirty = () => Object.keys(local.pending).length > 0 || Boolean(local.recent);
  function persist() { storageSet(key, JSON.stringify(local)); }
  function paint() {
    if (!active()) return;
    storageSet(LEGACY_RECENT_KEY, JSON.stringify(local.recent?.value || local.document.recentColors));
    onChange?.();
  }
  const queue = (ms = 3000) => {
    clearTimeout(timer);
    if (active()) timer = setTimeout(() => void sync(), ms);
  };
  async function sync(refresh = false) {
    if (running || !active()) return;
    clearTimeout(timer);
    running = true;
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        if (revision === null || (refresh && !dirty())) {
          const current = await request('colors');
          if (!active()) return;
          if (String(current.userId) !== uid) throw new Error('Учётная запись изменилась.');
          revision = current.revision;
          lastRead = Date.now();
          local.document = buildColorDocument(current.document, {}, null);
          if (migrationPending) stageLegacyColors(local, legacy.colors, legacy.recent);
          persist(); paint();
        }
        if (!dirty()) {
          if (migrationPending) { storageSet(migrationKey, 'already-current'); migrationPending = false; }
          break;
        }
        const sent = JSON.parse(JSON.stringify(local.pending)), recent = local.recent && JSON.parse(JSON.stringify(local.recent));
        const document = buildColorDocument(local.document, sent, recent);
        let saved;
        try {
          saved = await request('colors', { revision, document }, 'PUT', { keepalive: true });
        } catch (error) {
          // Rebase only our pending keys on the newer full document.
          if (error.status !== 409) throw error;
          revision = null;
          if (attempt === 2) throw error;
          continue;
        }
        if (!active()) return;
        if (String(saved.userId) !== uid) throw new Error('Учётная запись изменилась.');
        acknowledgeEdits(local.pending, sent);
        if (recent && local.recent?.seq === recent.seq) local.recent = null;
        local.document = buildColorDocument(saved.document, {}, null);
        revision = saved.revision;
        if (migrationPending) {
          storageSet(migrationKey, 'uploaded');
          migrationPending = false;
        }
        persist(); paint();
        break;
      }
      reportedError = false; failures = 0;
    } catch (error) {
      failures++;
      // An interrupted PUT may have committed. Fetch before retrying it.
      revision = null;
      if (error.status !== 409) console.warn('Цвета пока не синхронизированы:', error.message);
      if (dirty() && !reportedError && error.status !== 409) {
        onError?.(`Цвета сохранены на устройстве. Сервер: ${error.message}`);
        reportedError = true;
      }
    } finally {
      if (active()) persist();
      running = false;
      if (dirty()) queue(failures ? Math.min(300000, 10000 * 2 ** Math.min(failures, 5)) : 3000);
    }
  }
  const refresh = () => { if (!document.hidden && (dirty() || Date.now() - lastRead >= 60000)) void sync(true); };
  const flush = () => { if (dirty()) void sync(); };
  const visibility = () => document.hidden ? flush() : refresh();
  const recentChanged = event => {
    if (!active()) return;
    const value = recentColors(event.detail);
    if (JSON.stringify(value) === JSON.stringify(local.recent?.value || local.document.recentColors)) return;
    local.recent = { value, seq: ++local.seq }; persist(); queue();
  };
  window.addEventListener('focus', refresh);
  window.addEventListener('online', refresh);
  window.addEventListener('pagehide', flush);
  window.addEventListener('lesson-recent-changed', recentChanged);
  document.addEventListener('visibilitychange', visibility);
  const interval = setInterval(refresh, 600000);
  persist(); paint(); void sync();
  return {
    getColors: () => active() ? mergeColors(local.document.colors, local.pending) : {},
    edit(key, value) {
      if (!active() || typeof key !== 'string' || key.length > 512 || ['__proto__', 'constructor', 'prototype'].includes(key)) return;
      const color = value === null ? null : typeof value === 'string' && HEX.test(value) ? value.toLowerCase() : undefined;
      if (color === undefined || (mergeColors(local.document.colors, local.pending)[key] || null) === color) return;
      local.pending[key] = { value: color, seq: ++local.seq }; persist(); paint(); queue();
    },
    sync,
    stop() {
      disposed = true; clearTimeout(timer); clearInterval(interval);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('online', refresh);
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('lesson-recent-changed', recentChanged);
      document.removeEventListener('visibilitychange', visibility);
    },
  };
}
