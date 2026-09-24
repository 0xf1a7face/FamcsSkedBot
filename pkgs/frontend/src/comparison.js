import { COMPARISON_DAYS, comparisonDay, selectionKey, clockTime } from './comparison-model.js?v=98';
import { readStoredJson, writeStoredJson } from './storage.js?v=98';
import { requestJson } from './request.js?v=98';

async function requestData(url, options = {}) {
  const result = await requestJson(url, options);
  if (!result.success) throw new Error('Schedule request failed');
  return result.data;
}

export function bindComparisonDayInput(button, activate, readScrollTop = () => 0) {
  let touch = null;
  let moved = false;
  let suppressClickUntil = 0;
  const trackTouch = event => {
    if (!touch) return;
    const point = Array.from(event.changedTouches || []).find(item => item.identifier === touch.id);
    if (point && (Math.hypot(point.clientX - touch.x, point.clientY - touch.y) > 10 || readScrollTop() !== touch.scrollTop)) moved = true;
  };
  button.addEventListener('touchstart', event => {
    moved = event.touches.length !== 1;
    const point = event.touches[0];
    touch = moved ? null : { id: point.identifier, x: point.clientX, y: point.clientY, scrollTop: readScrollTop() };
  }, { passive: true });
  button.addEventListener('touchmove', trackTouch, { passive: true });
  button.addEventListener('touchcancel', () => {
    touch = null;
    moved = true;
    suppressClickUntil = Date.now() + 800;
  });
  button.addEventListener('touchend', event => {
    trackTouch(event);
    const tapped = touch && !moved && event.touches.length === 0;
    touch = null;
    suppressClickUntil = Date.now() + 800;
    if (!tapped) return;
    event.preventDefault();
    activate(true);
  }, { passive: false });
  button.addEventListener('click', event => {
    if (event.detail !== 0 && Date.now() < suppressClickUntil) return;
    activate(false);
  });
}

export function setupComparison({ panel, apiBase, buildLesson, decorateLesson, displayedTime }) {
  const storageKey = 'schedule-comparison:v1';
  const columns = [];
  const cache = new Map();
  let initialized = false;
  let groupRequest = 0;
  let adding = false;
  let day = COMPARISON_DAYS[0];
  panel.innerHTML = `
    <div class="comparison-navigation">
      <div class="comparison-toolbar">
        <div class="comparison-heading-scroll"><div class="comparison-headings"></div></div>
        <button type="button" class="comparison-add" aria-label="Добавить группу к сравнению" aria-expanded="false">+</button>
      </div>
      <nav class="comparison-days day-navigation-days" aria-label="Переход к дню недели"></nav>
    </div>
    <form class="comparison-picker" hidden>
      <label>Курс<select name="course" required><option value="">Выберите курс</option></select></label>
      <label>Группа<select name="group" required disabled><option value="">Сначала выберите курс</option></select></label>
      <label>Подгруппа<select name="subgroup"><option value="subgroupA">А</option><option value="subgroupB">Б</option></select></label>
      <div class="comparison-picker-actions"><button type="submit" disabled>Добавить</button><button type="button" class="comparison-cancel">Отмена</button></div>
      <p class="comparison-picker-status" role="status"></p>
    </form>
    <p class="comparison-status" role="status"></p>
    <div class="comparison-scroll" tabindex="0" role="region" aria-label="Сравнение расписаний. Прокручивайте влево и вправо">
      <div class="comparison-content"></div>
    </div>`;
  const form = panel.querySelector('form');
  const course = form.elements.course;
  const group = form.elements.group;
  const subgroup = form.elements.subgroup;
  const submit = form.querySelector('[type="submit"]');
  const add = panel.querySelector('.comparison-add');
  const pickerStatus = panel.querySelector('.comparison-picker-status');
  const status = panel.querySelector('.comparison-status');
  const scroller = panel.querySelector('.comparison-scroll');
  const content = panel.querySelector('.comparison-content');
  const headings = panel.querySelector('.comparison-headings');
  const headingScroll = panel.querySelector('.comparison-heading-scroll');
  const main = panel.closest('.main-content');
  const navigation = panel.querySelector('.comparison-navigation');
  scroller.addEventListener('scroll', () => { headingScroll.scrollLeft = scroller.scrollLeft; }, { passive: true });
  headingScroll.addEventListener('scroll', () => { scroller.scrollLeft = headingScroll.scrollLeft; }, { passive: true });
  for (const option of document.querySelector('#course-select').options) {
    if (option.value) course.add(new Option(option.textContent, option.value));
  }
  const dayNav = panel.querySelector('.comparison-days');
  for (const [index, name] of COMPARISON_DAYS.entries()) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'day-nav-btn';
    button.textContent = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'][index];
    button.title = name;
    button.dataset.day = name;
    bindComparisonDayInput(button, immediate => {
      const target = [...content.querySelectorAll('.comparison-day-heading')].find(item => item.dataset.day === name);
      if (!target || !main) return;
      const top = Math.max(0, main.scrollTop + target.getBoundingClientRect().top - main.getBoundingClientRect().top - navigation.offsetHeight - 16);
      day = name;
      updateDayButtons();
      if (immediate) {
        main.scrollTop = top;
        return;
      }
      try {
        main.scrollTo({ top, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      } catch {
        main.scrollTop = top;
      }
    }, () => main?.scrollTop || 0);
    dayNav.append(button);
  }
  const updateWidth = width => {
    // Two equally sized groups share the available area beside the fixed clock.
    if (width > 0) panel.style.setProperty('--comparison-column-width', `${Math.max(112, (width - 52) / 2)}px`);
  };
  if (typeof ResizeObserver === 'function') new ResizeObserver(([entry]) => updateWidth(entry.contentRect.width)).observe(scroller);
  else window.addEventListener('resize', () => updateWidth(scroller.clientWidth));
  main?.addEventListener('scroll', () => {
    if (panel.hidden) return;
    const top = main.getBoundingClientRect().top + navigation.offsetHeight + 24;
    const targets = [...content.querySelectorAll('.comparison-day-heading')];
    day = targets[0]?.dataset.day;
    for (const target of targets) {
      if (target.getBoundingClientRect().top > top) break;
      day = target.dataset.day;
    }
    updateDayButtons();
  }, { passive: true });

  function updateDayButtons() {
    for (const button of dayNav.children) {
      button.classList.toggle('active', button.dataset.day === day);
      button.setAttribute('aria-pressed', String(button.dataset.day === day));
    }
  }

  function persist() {
    writeStoredJson(storageKey, columns.map(({ course, group, subgroup }) => ({ course, group, subgroup })));
  }
  function showPicker(show) {
    form.hidden = !show;
    add.setAttribute('aria-expanded', String(show));
    if (show) course.focus();
    else add.focus();
  }
  add.addEventListener('click', () => showPicker(form.hidden));
  panel.querySelector('.comparison-cancel').addEventListener('click', () => showPicker(false));
  form.addEventListener('keydown', event => { if (event.key === 'Escape') showPicker(false); });
  course.addEventListener('change', async () => {
    const request = ++groupRequest;
    const selectedCourse = course.value;
    group.replaceChildren(new Option(selectedCourse ? 'Загрузка…' : 'Сначала выберите курс', ''));
    group.disabled = true;
    submit.disabled = true;
    pickerStatus.textContent = '';
    if (!selectedCourse) return;
    try {
      const url = new URL('/api/groups', apiBase);
      url.searchParams.set('course', selectedCourse);
      const data = await requestData(url);
      if (!Array.isArray(data?.groups)) throw new Error();
      if (request !== groupRequest) return;
      group.replaceChildren(new Option('Выберите группу', ''));
      for (const item of [...data.groups].sort((a, b) => a.groupName.localeCompare(b.groupName, 'ru', { numeric: true }))) {
        group.add(new Option(item.groupName, item.groupName));
      }
      group.disabled = false;
      if (!data.groups.length) pickerStatus.textContent = 'Для этого курса пока нет групп.';
    } catch {
      if (request !== groupRequest) return;
      group.replaceChildren(new Option('Не удалось загрузить группы', ''));
      pickerStatus.textContent = 'Не удалось загрузить группы. Проверьте соединение и выберите курс ещё раз.';
    }
  });
  group.addEventListener('change', () => { submit.disabled = !group.value || adding; });

  async function loadColumn(column, force = false) {
    const request = column.request = (column.request || 0) + 1;
    column.loading = true;
    column.error = '';
    render();
    const key = JSON.stringify([column.course, column.group]);
    try {
      if (force) cache.delete(key);
      if (!cache.has(key)) {
        const url = new URL('/api/schedule', apiBase);
        url.searchParams.set('course', column.course);
        url.searchParams.set('group', column.group);
        const pending = (async () => {
          const data = await requestData(url, force ? { cache: 'no-store' } : {});
          if (!Array.isArray(data?.classes)) throw new Error();
          return data;
        })();
        cache.set(key, pending);
        pending.catch(() => { if (cache.get(key) === pending) cache.delete(key); });
      }
      const data = await cache.get(key);
      if (column.request === request) column.data = data;
    } catch {
      if (column.request === request) column.error = 'Не удалось загрузить расписание';
    } finally {
      if (column.request === request) { column.loading = false; render(); }
    }
  }

  async function refresh() {
    // Refresh each group once, sharing its request between both subgroups.
    const refreshed = new Set();
    await Promise.all(columns.map(column => {
      const key = JSON.stringify([column.course, column.group]);
      const force = !refreshed.has(key);
      refreshed.add(key);
      return loadColumn(column, force);
    }));
  }
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (adding || !course.value || !group.value || group.disabled) return;
    const selection = { course: course.value, group: group.value, subgroup: subgroup.value };
    if (columns.some(column => selectionKey(column) === selectionKey(selection))) {
      pickerStatus.textContent = 'Эта подгруппа уже добавлена.';
      return;
    }
    adding = true;
    submit.disabled = true;
    columns.push(selection);
    persist();
    showPicker(false);
    const loading = loadColumn(selection);
    scroller.scrollLeft = scroller.scrollWidth;
    await loading;
    adding = false;
    submit.disabled = !group.value || group.disabled;
  });

  function header(column, index) {
    const cell = document.createElement('div');
    cell.className = 'comparison-column-heading';
    const title = document.createElement('strong');
    title.textContent = `${column.course}к ${column.group}гр ${column.subgroup === 'subgroupB' ? 'Б' : 'А'}`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Убрать из сравнения: ${title.textContent}`);
    remove.addEventListener('click', () => {
      columns.splice(index, 1);
      persist();
      render();
      add.focus();
    });
    cell.append(title, remove);
    if (column.loading || column.error) {
      const message = document.createElement('span');
      message.textContent = column.loading ? 'Загрузка…' : column.error;
      cell.append(message);
      if (column.error) {
        const retry = document.createElement('button');
        retry.type = 'button';
        retry.textContent = 'Повторить';
        retry.addEventListener('click', () => loadColumn(column, true));
        cell.append(retry);
      }
    }
    return cell;
  }

  function render() {
    const scrollLeft = scroller.scrollLeft;
    content.replaceChildren();
    headings.replaceChildren();
    dayNav.hidden = !columns.length;
    scroller.hidden = !columns.length;
    updateDayButtons();
    status.classList.toggle('is-empty', !columns.length);
    status.textContent = columns.length ? '' : 'Добавьте группы кнопкой +. Расписание можно листать вниз и вбок.';
    if (!columns.length) return;
    headings.style.gridTemplateColumns = `52px repeat(${columns.length}, var(--comparison-column-width))`;
    const timeHeading = document.createElement('span');
    timeHeading.className = 'comparison-clock';
    headings.append(timeHeading);
    columns.forEach((column, index) => headings.append(header(column, index)));
    let skipped = 0;
    for (const name of COMPARISON_DAYS) {
      const model = comparisonDay(columns, name, displayedTime);
      skipped += model.skipped;
      const heading = document.createElement('h3');
      heading.className = 'comparison-day-heading';
      heading.textContent = name;
      heading.dataset.day = name;
      const isSunday = name === 'Воскресенье';
      if (isSunday && !model.schedules.some(item => item.entries.length)) continue;
      content.append(heading);
      const grid = document.createElement('div');
      grid.className = 'comparison-day-grid';
      grid.style.gridTemplateColumns = `52px repeat(${columns.length}, var(--comparison-column-width))`;
      // One row per actual lesson interval; breaks are not rendered as lessons.
      const ranges = [...new Map(model.schedules.flatMap(schedule => schedule.entries).map(entry => [`${entry.start}/${entry.end}`, entry])).values()].sort((a, b) => a.start - b.start || a.end - b.end);
      for (let i = 0; i < ranges.length; i++) {
        const time = document.createElement('div');
        time.className = 'comparison-clock comparison-time';
        time.style.gridRow = String(i + 1);
        time.style.gridColumn = '1';
        const start = document.createElement('span');
        start.textContent = clockTime(ranges[i].start);
        const end = document.createElement('span');
        end.textContent = clockTime(ranges[i].end);
        time.append(start, end);
        grid.append(time);
      }
      model.schedules.forEach((schedule, columnIndex) => {
        if (!ranges.length) {
          const empty = document.createElement('p');
          empty.className = 'day-empty comparison-empty';
          empty.style.gridColumn = String(columnIndex + 2);
          empty.textContent = columns[columnIndex].loading ? 'Загрузка…' : columns[columnIndex].error ? 'Нет данных' : 'Занятий нет';
          grid.append(empty);
        }
        for (const entry of schedule.entries) {
          const cell = document.createElement('div');
          cell.className = 'comparison-slot';
          cell.style.gridColumn = String(columnIndex + 2);
          cell.style.gridRow = String(ranges.findIndex(range => range.start === entry.start && range.end === entry.end) + 1);
          for (const item of entry.lessons) {
            const card = document.createElement('div');
            card.className = 'subgroup comparison-lesson';
            card.innerHTML = buildLesson(item.lesson, item.isLecture);
            card.setAttribute('aria-label', `${columns[columnIndex].group} группа, ${clockTime(entry.start)}–${clockTime(entry.end)}`);
            decorateLesson(card, item.lesson.classTitle, item.scope, item.lesson.professorName);
            cell.append(card);
          }
          grid.append(cell);
        }
      });
      content.append(grid);
    }
    if (skipped) status.textContent += ' Некоторые занятия имеют некорректное время и не показаны.';
    dayNav.lastElementChild.hidden = !content.querySelector('[data-day="Воскресенье"]');
    scroller.scrollLeft = scrollLeft;
    headingScroll.scrollLeft = scrollLeft;
  }
  render();
  return {
    refresh,
    activate(active) {
      panel.hidden = !active;
      if (active) updateWidth(scroller.clientWidth);
      if (!active) { form.hidden = true; add.setAttribute('aria-expanded', 'false'); return; }
      if (!initialized) {
        initialized = true;
        const saved = readStoredJson(storageKey);
        if (Array.isArray(saved)) {
          const allowedCourses = [...course.options].map(option => option.value).filter(Boolean);
          for (const selection of saved) {
            if (!selection || !allowedCourses.includes(String(selection.course)) || typeof selection.group !== 'string' || !selection.group || !['subgroupA', 'subgroupB'].includes(selection.subgroup)) continue;
            if (!columns.some(column => selectionKey(column) === selectionKey(selection))) columns.push({ course: String(selection.course), group: selection.group, subgroup: selection.subgroup });
          }
          columns.forEach(column => loadColumn(column));
        }
      }
      render();
    },
  };
}
