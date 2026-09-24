import { readStoredJson, writeStoredJson } from './storage.js?v=98';

const RECENT_KEY = 'lessonRecentColors:v1';
const HEX = /^#[0-9a-f]{6}$/i;
export function recentColors(value, presets) {
  return [...new Set((Array.isArray(value) ? value : [])
    .filter(color => typeof color === 'string' && HEX.test(color))
    .map(color => color.toLowerCase()))]
    .filter(color => !presets.some(option => option.color.toLowerCase() === color)).slice(0, 3);
}

export function hsvToHex(h, s, v) {
  const channel = n => {
    const k = (n + h / 60) % 6;
    return Math.round(255 * v * (1 - s * Math.max(0, Math.min(k, 4 - k, 1))))
      .toString(16).padStart(2, '0');
  };
  return `#${channel(5)}${channel(3)}${channel(1)}`;
}

function hexToHsv(hex) {
  const [r, g, b] = hex.slice(1).match(/../g).map(value => parseInt(value, 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const h = !d ? 0 : max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, max ? d / max : 0, max];
}

export function createLessonColorRow(title, scope, { options, getColor, applyColor, professorName }) {
  const row = document.createElement('div');
  row.className = 'lesson-color-row';
  const heading = document.createElement('div');
  heading.className = 'lesson-color-title';
  heading.textContent = title + (professorName ? ` · ${professorName}` : '') + (scope === 'subgroup-a' ? ' · подгруппа А' : scope === 'subgroup-b' ? ' · подгруппа Б' : '');
  const choices = document.createElement('div');
  choices.className = 'lesson-color-choices';
  row.append(heading, choices);
  let selected = getColor(title, scope);
  let palette;
  let sessionColors = recentColors(readStoredJson(RECENT_KEY), options);
  const beginColorSession = () => { sessionColors = recentColors(readStoredJson(RECENT_KEY), options); };
  const refresh = () => row.closest('.lesson-color-picker')?.dispatchEvent(new Event('refresh-colors'));
  const apply = color => {
    selected = color;
    applyColor(title, scope, color);
    renderChoices();
    refresh();
  };
  const remember = color => {
    // All shade adjustments in one opening replace the same recent-color slot.
    writeStoredJson(RECENT_KEY, recentColors([color, ...sessionColors], options));
    window.dispatchEvent(new CustomEvent('lesson-recent-changed', { detail: recentColors([color, ...sessionColors], options) }));
    refresh();
  };
  const plus = document.createElement('button');
  plus.className = 'lesson-color-choice lesson-color-custom';
  plus.type = 'button';
  plus.setAttribute('aria-label', `Выбрать свой цвет: ${title}`);
  plus.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
  plus.setAttribute('aria-expanded', 'false');
  plus.addEventListener('click', () => {
    const open = palette && !palette.hidden;
    const sheet = row.closest('.lesson-color-picker');
    sheet.querySelectorAll('.lesson-custom-palette').forEach(element => { element.hidden = true; });
    sheet.querySelectorAll('.lesson-color-custom').forEach(element => element.setAttribute('aria-expanded', 'false'));
    if (!open) {
      beginColorSession();
      palette?.remove();
      palette = createPalette(selected, apply, remember);
      row.append(palette);
      plus.setAttribute('aria-expanded', 'true');
    }
  });
  function renderChoices() {
    selected = getColor(title, scope);
    const recent = recentColors(readStoredJson(RECENT_KEY), options);
    plus.classList.toggle('is-selected', Boolean(selected) &&
      ![...options.map(option => option.color.toLowerCase()), ...recent].includes(selected.toLowerCase()));
    const buttons = [...options, ...recent.slice().reverse().map(color => ({ color, label: color }))].map(option => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'lesson-color-choice';
      button.style.setProperty('--choice-color', option.color);
      const color = option.id === 'default' ? null : option.color;
      const active = color === null ? !selected : selected?.toLowerCase() === color.toLowerCase();
      button.classList.toggle('is-selected', active);
      button.setAttribute('aria-pressed', String(active));
      button.setAttribute('aria-label', `${option.label}: ${title}`);
      button.addEventListener('click', () => { apply(color); palette?.remove(); palette = null; plus.setAttribute('aria-expanded', 'false'); });
      return button;
    });
    // Keep the native input connected while its system dialog is open.
    choices.querySelectorAll('button:not(.lesson-color-custom)').forEach(button => button.remove());
    buttons.forEach(button => choices.insertBefore(button, choices.contains(plus) ? plus : null));
    if (!choices.contains(plus)) choices.append(plus);
  }
  row.addEventListener('refresh-colors', renderChoices);
  renderChoices();
  return row;
}

function createPalette(initial, apply, remember) {
  const panel = document.createElement('div');
  panel.className = 'lesson-custom-palette';
  panel.innerHTML = `<div class="lesson-palette-main"><div class="lesson-sv" tabindex="0" role="group" aria-label="Насыщенность и яркость: стрелки влево и вправо меняют насыщенность, вверх и вниз — яркость"><span class="lesson-sv-cursor"></span></div><input class="lesson-hue" type="range" min="0" max="360" value="0" aria-label="Цветовой тон"></div><div class="lesson-color-tools"><div class="lesson-hex-panel"><input class="lesson-hex" aria-label="Цвет HEX" maxlength="7" spellcheck="false"><button type="button" class="lesson-copy" aria-label="Копировать цвет" title="Копировать цвет"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2"></rect><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"></path></svg></button></div><button type="button" class="lesson-color-reset">Сбросить</button></div>`;
  const sv = panel.querySelector('.lesson-sv'), cursor = panel.querySelector('.lesson-sv-cursor');
  const hue = panel.querySelector('.lesson-hue'), hex = panel.querySelector('.lesson-hex');
  let [h, s, v] = hexToHsv(HEX.test(initial || '') ? initial : '#6b5cff');
  const paint = (commit = false) => {
    const color = hsvToHex(h, s, v);
    hue.value = h;
    sv.style.setProperty('--picker-hue-color', hsvToHex(h, 1, 1));
    cursor.style.left = `${s * 100}%`;
    cursor.style.top = `${(1 - v) * 100}%`;
    hex.value = color.toUpperCase();
    hex.setAttribute('aria-invalid', 'false');
    if (commit) apply(color);
  };
  const pointer = event => {
    const rect = sv.getBoundingClientRect();
    s = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    v = 1 - Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
    paint(true);
  };
  sv.addEventListener('pointerdown', event => { sv.setPointerCapture(event.pointerId); pointer(event); });
  sv.addEventListener('pointermove', event => { if (sv.hasPointerCapture(event.pointerId)) pointer(event); });
  sv.addEventListener('pointerup', event => { pointer(event); sv.releasePointerCapture(event.pointerId); remember(hex.value); });
  sv.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    s = Math.max(0, Math.min(1, s + (event.key === 'ArrowRight' ? .02 : event.key === 'ArrowLeft' ? -.02 : 0)));
    v = Math.max(0, Math.min(1, v + (event.key === 'ArrowUp' ? .02 : event.key === 'ArrowDown' ? -.02 : 0)));
    paint(true); remember(hex.value);
  });
  hue.addEventListener('input', () => { h = Number(hue.value); paint(true); });
  hue.addEventListener('change', () => remember(hex.value));
  hex.addEventListener('input', () => {
    const value = hex.value.startsWith('#') ? hex.value : `#${hex.value}`;
    hex.setAttribute('aria-invalid', String(!HEX.test(value)));
    if (HEX.test(value)) { [h, s, v] = hexToHsv(value); paint(true); }
  });
  hex.addEventListener('change', () => { if (HEX.test(hex.value)) remember(hex.value); });
  panel.querySelector('.lesson-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(hex.value);
    } catch {
      hex.focus();
      hex.select();
    }
  });
  panel.querySelector('.lesson-color-reset').addEventListener('click', () => {
    apply(null);
    panel.hidden = true;
    panel.closest('.lesson-color-row').querySelector('.lesson-color-custom').setAttribute('aria-expanded', 'false');
  });
  paint();
  return panel;
}
