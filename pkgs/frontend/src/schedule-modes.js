import { createTeacherDirectory, setupTeacherSuggestions, hasTeacher } from './teacher-suggestions.js?v=97';
import { setupComparison } from './comparison.js?v=97';

export function filterSubgroup(data, subgroup) {
  if (subgroup === 'both') return data;
  return { ...data, classes: (data.classes || []).flatMap(item => {
    if (item.isCommon) return [item];
    const lesson = item[subgroup];
    if (!lesson || !Object.values(lesson).some(Boolean)) return [];
    return [{ ...item, isCommon: true, subgroupA: lesson, subgroupB: null, colorScope: subgroup === 'subgroupA' ? 'subgroup-a' : 'subgroup-b' }];
  }) };
}

export function teacherSchedule(data, name) {
  const slots = new Map();
  for (const item of data.classes || []) {
    const common = item.isCommon === true || item.isCommon === 1;
    for (const side of ['A', 'B']) {
      if (side === 'B' && common) continue;
      const professor = item[`professorName${side}`] || '';
      if (!hasTeacher(professor, name)) continue;
      const key = `${item.dayOfWeek}|${item.startTime?.replace('.', ':')}|${item.endTime?.replace('.', ':')}`;
      if (!slots.has(key)) slots.set(key, { ...item, entries: [] });
      const slot = slots.get(key);
      const lesson = {
        classTitle: item[`classTitle${side}`], professorName: professor,
        classroom: item[`classroom${side}`],
        comments: item[`comments${side}`] || item.comments || '',
      };
      const isLecture = item.isLecture === true || item.isLecture === 1;
      const signature = JSON.stringify([lesson, isLecture, common ? 'common' : `${item.course}/${item.groupName}/${side}`]);
      const audience = `${item.course} курс · группа ${item.groupName}${common ? '' : ` · подгруппа ${side === 'A' ? 'А' : 'Б'}`}`;
      const existing = slot.entries.find(entry => entry.signature === signature);
      if (existing) { if (!existing.audiences.includes(audience)) existing.audiences.push(audience); }
      else slot.entries.push({ signature, lesson, isLecture, label: common ? '' : side === 'A' ? 'А' : 'Б', audiences: [audience] });
    }
  }
  return { teacher: name, classes: [...slots.values()].map(({ entries, ...slot }) => {
    const lessons = entries.map(entry => ({ ...entry, lesson: { ...entry.lesson, comments: [...entry.audiences, entry.lesson.comments].filter(Boolean).join(' · ') } }));
    return { ...slot, isCommon: lessons.length === 1, isLecture: lessons.every(entry => entry.isLecture), subgroupA: lessons[0].lesson, subgroupB: lessons[1]?.lesson || null, teacherLessons: lessons };
  }) };
}

export function setupScheduleModes({ onChange, onTeacher, apiBase, comparison }) {
  const modeStorageKey = 'schedule-mode:v1';
  const savedMode = (() => {
    try { return localStorage.getItem(modeStorageKey); } catch { return null; }
  })();
  const subgroupStorageKey = 'schedule-subgroup:v1';
  const savedSubgroup = (() => {
    try {
      if (savedMode === 'group') return 'both';
      const value = localStorage.getItem(subgroupStorageKey);
      return ['subgroupA', 'subgroupB', 'both'].includes(value) ? value : 'subgroupA';
    } catch { return 'subgroupA'; }
  })();
  const icons = [
    '<path d="M231.65,194.55,198.46,36.75a16,16,0,0,0-19-12.39L132.65,34.42a16.08,16.08,0,0,0-12.3,19l33.19,157.8A16,16,0,0,0,169.16,224a16.25,16.25,0,0,0,3.38-.36l46.81-10.06A16.09,16.09,0,0,0,231.65,194.55ZM136,50.15c0-.06,0-.09,0-.09l46.8-10,3.33,15.87L139.33,66Zm6.62,31.47,46.82-10.05,3.34,15.9L146,97.53Zm6.64,31.57,46.82-10.06,13.3,63.24-46.82,10.06ZM216,197.94l-46.8,10-3.33-15.87L212.67,182,216,197.85C216,197.91,216,197.94,216,197.94ZM104,32H56A16,16,0,0,0,40,48V208a16,16,0,0,0,16,16h48a16,16,0,0,0,16-16V48A16,16,0,0,0,104,32ZM56,48h48V64H56Zm0,32h48v96H56Zm48,128H56V192h48v16Z"></path>',
    '<path d="M251.76,88.94l-120-64a8,8,0,0,0-7.52,0l-120,64a8,8,0,0,0,0,14.12L32,117.87v48.42a15.91,15.91,0,0,0,4.06,10.65C49.16,191.53,78.51,216,128,216a130,130,0,0,0,48-8.76V240a8,8,0,0,0,16,0V199.51a115.63,115.63,0,0,0,27.94-22.57A15.91,15.91,0,0,0,224,166.29V117.87l27.76-14.81a8,8,0,0,0,0-14.12ZM128,200c-43.27,0-68.72-21.14-80-33.71V126.4l76.24,40.66a8,8,0,0,0,7.52,0L176,143.47v46.34C163.4,195.69,147.52,200,128,200Zm80-33.75a97.83,97.83,0,0,1-16,14.25V134.93l16-8.53ZM188,118.94l-.22-.13-56-29.87a8,8,0,0,0-7.52,14.12L171,128l-43,22.93L25,96,128,41.07,231,96Z"></path>',
    '<path d="M104,32H64A16,16,0,0,0,48,48V208a16,16,0,0,0,16,16h40a16,16,0,0,0,16-16V48A16,16,0,0,0,104,32Zm0,176H64V48h40ZM192,32H152a16,16,0,0,0-16,16V208a16,16,0,0,0,16,16h40a16,16,0,0,0,16-16V48A16,16,0,0,0,192,32Zm0,176H152V48h40Z"></path>',
  ];
  const modes = [
    ['subgroup', 'Выберите отображение по подгруппе или группе целиком', 'p.s. Нажмите на время пары, чтобы выбрать цвет для заметки'],
    ['teacher', 'Поиск по фамилии', ''],
    ['compare', 'Сравнение расписаний', ''],
  ];
  const section = document.createElement('section');
  const modeLabels = ['Пары', 'Преподаватели', 'Сравнение'];
  section.className = 'mode-section';
  section.setAttribute('aria-label', 'Режим расписания');
  section.innerHTML = `<div class="mode-grid">${modes.map(([id, title], i) => `<div class="mode-option"><span class="mode-label">${modeLabels[i]}</span><button type="button" class="mode-card" data-mode="${id}" aria-label="${title}" title="${title}" aria-pressed="false"><span class="mode-icon mode-icon-${id}"><svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true">${icons[i]}</svg></span></button></div>`).join('')}</div><p id="mode-description" class="mode-description" aria-live="polite" hidden></p>
    <form id="teacher-form" class="mode-panel" hidden><label for="teacher-name">Поиск по фамилии</label><div class="teacher-input-row"><input id="teacher-name" name="teacher" placeholder="Например, Орлович" autocomplete="off" required maxlength="80"><button type="submit">Найти</button></div></form>
    <section id="compare-panel" class="compare-panel" aria-label="Сравнение расписаний" hidden></section>`;
  document.querySelector('.header').after(section);
  const comparisonController = setupComparison({ panel: document.getElementById('compare-panel'), ...comparison });
  const activateSuggestions = setupTeacherSuggestions({
    form: document.getElementById('teacher-form'),
    loadNames: createTeacherDirectory(apiBase),
    onSelect: onTeacher,
  });
  document.querySelector('.subtitle').textContent = 'Какое расписание посмотрим?';
  const controls = document.querySelector('.controls-section');
  controls.hidden = true;
  const updateControlsHeight = () => document.documentElement.style.setProperty('--controls-height', `${controls.hidden ? 0 : controls.offsetHeight}px`);
  if (typeof ResizeObserver === 'function') new ResizeObserver(updateControlsHeight).observe(controls);
  else window.addEventListener('resize', updateControlsHeight);
  const subgroup = document.createElement('div');
  subgroup.className = 'subgroup-control';
  subgroup.hidden = true;
  subgroup.innerHTML = `<span class="subgroup-label">Подгруппа</span><div class="subgroup-buttons" role="group" aria-label="Подгруппа"><button type="button" data-subgroup="subgroupA" aria-pressed="${savedSubgroup === 'subgroupA'}">А</button><button type="button" data-subgroup="subgroupB" aria-pressed="${savedSubgroup === 'subgroupB'}">Б</button><button type="button" data-subgroup="both" aria-pressed="${savedSubgroup === 'both'}">А+Б</button></div><select id="subgroup-select" hidden><option value="subgroupA">А</option><option value="subgroupB">Б</option><option value="both">А+Б</option></select>`;
  subgroup.querySelector('select').value = savedSubgroup;
  controls.querySelector('.controls-select-row').insertBefore(subgroup, document.getElementById('refresh-schedule-button'));
  const selectSubgroup = value => {
    subgroup.querySelector('select').value = value;
    try { localStorage.setItem(subgroupStorageKey, value); } catch { /* storage unavailable */ }
    subgroup.querySelectorAll('[data-subgroup]').forEach(item => item.setAttribute('aria-pressed', String(item.dataset.subgroup === value)));
  };
  subgroup.querySelectorAll('[data-subgroup]').forEach(button => button.addEventListener('click', () => {
    selectSubgroup(button.dataset.subgroup);
    onChange('subgroup', false);
  }));
  section.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => {
    const mode = button.dataset.mode;
    if (mode === 'subgroup') selectSubgroup('both');
    try { localStorage.setItem(modeStorageKey, mode); } catch { /* storage unavailable */ }
    const description = document.getElementById('mode-description');
    const selected = modes.find(item => item[0] === mode);
    description.textContent = mode === 'compare' ? '' : [selected[1], selected[2]].filter(Boolean).join('\n');
    description.hidden = mode === 'compare';
    section.querySelectorAll('[data-mode]').forEach(card => card.setAttribute('aria-pressed', String(card === button)));
    controls.hidden = !['group', 'subgroup'].includes(mode);
    document.getElementById('refresh-schedule-button').hidden = controls.hidden;
    subgroup.hidden = mode !== 'subgroup';
    updateControlsHeight();
    document.getElementById('teacher-form').hidden = mode !== 'teacher';
    activateSuggestions(mode === 'teacher');
    comparisonController.activate(mode === 'compare');
    onChange(mode, true);
  }));
  document.getElementById('teacher-form').addEventListener('submit', event => {
    event.preventDefault();
    const name = document.getElementById('teacher-name').value.trim();
    if (name) onTeacher(name);
  });
  const initialMode = savedMode === 'group' ? 'subgroup' : savedMode;
  if (modes.some(([id]) => id === initialMode)) {
    try { localStorage.setItem(subgroupStorageKey, savedSubgroup); } catch { /* storage unavailable */ }
    section.querySelector(`[data-mode="${initialMode}"]`)?.click();
  }
  return { refreshComparison: () => comparisonController.refresh() };
}
