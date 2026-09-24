import { requestJson } from './request.js?v=98';

const normalize = value => value.trim().toLocaleLowerCase('ru').replaceAll('ё', 'е');

export function hasTeacher(value, name) {
  const surnameOf = part => part.trim()
      .replace(/^(?:(?:профессор|проф|доцент|доц|(?:старший|ст\.?)\s*(?:преподаватель|преп|пр)|преподаватель|преп|ассистент|ассист)\.?\s+)+/iu, '')
      .replace(/^(?:[А-ЯЁA-Z]\.\s*){1,2}/u, '')
      .match(/^[А-ЯЁA-Z][а-яёa-z]+(?:-[А-ЯЁA-Z][а-яёa-z]+)*/u)?.[0];
  const query = normalize(surnameOf(name) || name);
  if (!query) return false;
  // Keep initials and role prefixes out of the surname, and compare whole names.
  return String(value || '').split(/[,;\/\n]+/u).some(part => {
    const surname = surnameOf(part);
    return Boolean(surname && normalize(surname) === query);
  });
}

export function createTeacherDirectory(apiBase, request = fetch) {
  let names = null;
  let pending = null;
  return async () => {
    if (names !== null) return names;
    if (!pending) {
      pending = (async () => {
        // Не используем AbortSignal.timeout: старые Telegram WebView не
        // реализуют этот метод и тогда подсказки ломаются ещё до fetch.
        const result = await requestJson(`${apiBase}/api/teachers`, {}, request);
        if (!result.success || !Array.isArray(result.data?.teachers)) throw new Error('Некорректный список преподавателей');
        names = [...new Set(result.data.teachers.filter(name => typeof name === 'string').map(name => name.trim()).filter(Boolean))]
          .sort((a, b) => a.localeCompare(b, 'ru'));
        return names;
      })();
    }
    try { return await pending; }
    finally { pending = null; }
  };
}

export function matchingTeachers(names, query) {
  const prefix = normalize(query);
  return prefix ? names.filter(name => normalize(name).startsWith(prefix)) : [];
}

export function setupTeacherSuggestions({ form, loadNames, onSelect }) {
  const input = form.querySelector('input');
  const status = document.createElement('p');
  status.id = 'teacher-suggestions-status';
  status.setAttribute('role', 'status');
  const list = document.createElement('div');
  list.className = 'teacher-suggestions';
  list.id = 'teacher-suggestions';
  list.setAttribute('role', 'group');
  list.setAttribute('aria-label', 'Подходящие преподаватели');
  list.hidden = true;
  input.setAttribute('aria-controls', list.id);
  input.setAttribute('aria-describedby', status.id);
  input.setAttribute('spellcheck', 'false');
  form.append(status, list);
  let names = [];
  let active = false;
  let loading = false;
  let failed = false;

  function render() {
    list.replaceChildren();
    list.hidden = true;
    if (!active) return;
    if (loading) { status.textContent = 'Загружаем фамилии…'; return; }
    if (failed) { status.textContent = 'Подсказки недоступны. Можно ввести фамилию и нажать «Найти».'; return; }
    const matches = matchingTeachers(names, input.value);
    status.textContent = !input.value.trim() ? 'Начните вводить фамилию' : matches.length ? `Найдено: ${matches.length}` : 'Совпадений нет. Проверьте фамилию.';
    for (const name of matches) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = name;
      let selected = false;
      let touch = null;
      let moved = false;
      const select = () => {
        if (selected || !active) return;
        selected = true;
        input.value = name;
        input.blur();
        list.hidden = true;
        status.textContent = `Выбран преподаватель: ${name}`;
        onSelect(name);
      };
      // iOS may lose the synthetic click when focus/keyboard changes on a tap.
      // Handle a completed tap directly, without cancelling the start of a scroll.
      button.addEventListener('touchstart', event => {
        moved = event.touches.length !== 1;
        const point = event.touches[0];
        touch = moved ? null : { id: point.identifier, x: point.clientX, y: point.clientY, scrollTop: list.scrollTop };
      }, { passive: true });
      const trackTouch = event => {
        if (!touch) return;
        const point = Array.from(event.changedTouches).find(item => item.identifier === touch.id);
        if (point && (Math.hypot(point.clientX - touch.x, point.clientY - touch.y) > 10 || list.scrollTop !== touch.scrollTop)) moved = true;
      };
      button.addEventListener('touchmove', trackTouch, { passive: true });
      button.addEventListener('touchcancel', () => { touch = null; moved = true; });
      button.addEventListener('touchend', event => {
        trackTouch(event);
        if (touch && !moved && event.touches.length === 0) {
          event.preventDefault();
          select();
        }
        touch = null;
      }, { passive: false });
      button.addEventListener('mousedown', event => event.preventDefault());
      button.addEventListener('click', event => {
        if (!moved || event.detail === 0) select();
      });
      list.appendChild(button);
    }
    list.hidden = matches.length === 0;
  }

  input.addEventListener('input', render);
  input.addEventListener('focus', render);
  form.addEventListener('keydown', event => {
    if (event.key === 'Escape') { list.hidden = true; input.focus(); list.hidden = true; }
    if (event.key === 'ArrowDown' && event.target === input && !list.hidden) {
      event.preventDefault();
      list.querySelector('button')?.focus();
    }
  });
  form.addEventListener('submit', () => { list.hidden = true; });
  form.addEventListener('focusout', event => {
    if (event.relatedTarget && !form.contains(event.relatedTarget)) list.hidden = true;
  });
  document.addEventListener('pointerdown', event => {
    if (!form.contains(event.target)) list.hidden = true;
  });

  return async enabled => {
    active = enabled;
    if (!enabled) { list.hidden = true; status.textContent = ''; return; }
    loading = true;
    failed = false;
    render();
    try { names = await loadNames(); }
    catch { failed = true; }
    finally { loading = false; render(); }
  };
}
