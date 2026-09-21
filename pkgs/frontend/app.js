import { API_ROOT } from './src/api-root.js?v=97';
import { createLessonColorRow } from "./src/lesson-color-picker.js?v=97";
import {
  getStoredValue as safeGetStorage,
  readStoredJson as readJsonStorage,
  removeStoredValue as safeRemoveStorage,
  setStoredValue as safeSetStorage,
  writeStoredJson as writeJsonStorage,
} from "./src/storage.js?v=97";
import { initializeTelegramWebApp, triggerTelegramHaptic } from "./src/telegram.js?v=97";
import { setStaleNotice, showToast } from "./src/feedback.js?v=97";
import { setupScheduleModes, filterSubgroup, teacherSchedule } from "./src/schedule-modes.js?v=102";
import { requestJson } from "./src/request.js?v=97";
import { setupCloudColors } from "./src/cloud-colors.js?v=99";

let scheduleMode = null;
let teacherRequest = 0;
let restoredSelection = false;
let scheduleRequest = 0;
let groupsRequest = 0;
let selectionRevision = 0;
let selectedTeacher = null;
let modesController = null;
let modeRefreshPending = false;

async function loadTeacher(name, { silent = false, forceRefresh = false } = {}) {
  selectedTeacher = name;
  const request = ++teacherRequest;
  if (!silent) showLoading(true);
  hideError();
  if (!silent) {
    document.getElementById('schedule-container').classList.add('hidden');
    document.getElementById('day-navigation').classList.add('hidden');
  }
  try {
    const result = await requestJson(`${TEACHER_API_BASE}/api/teacher?name=${encodeURIComponent(name)}`, forceRefresh ? { cache: 'no-store' } : {});
    if (!result.success) throw new Error('Не удалось загрузить расписание преподавателя');
    if (request === teacherRequest && scheduleMode === 'teacher') {
      displaySchedule(teacherSchedule(result.data, name));
      setStaleNotice(false);
    }
  } catch (error) {
    if (request === teacherRequest && scheduleMode === 'teacher') {
      if (silent) showToast('Не удалось обновить расписание преподавателя');
      else showError(error.message);
    }
  } finally {
    if (request === teacherRequest) showLoading(false);
  }
}

// ╔═══════════════════════════════════════════════════════════════════╗
// ║                    ВСЕ НАСТРОЙКИ САЙТА — ЗДЕСЬ                     ║
// ╚═══════════════════════════════════════════════════════════════════╝
// Собраны в одном месте в самом начале файла, чтобы не искать нужную
// настройку по всему коду. Ниже по файлу — только логика, её менять
// для обычной подстройки внешнего вида/текстов не требуется.

// --- Адрес API, откуда сайт берёт список групп и расписание ---
const API_BASE_URL = API_ROOT.replace(/\/api$/, '');
const TEACHER_API_BASE = API_BASE_URL;
const SCHEDULE_ENDPOINT = "/api/schedule";
const GROUPS_ENDPOINT = "/api/groups";
const CACHE_SCHEMA_VERSION = 1;
const INACTIVITY_REFRESH_MS = 15 * 60 * 1000;
const LESSON_COLORS_STORAGE_KEY = "lessonColors:v1";
let cloudColors = null;
const LESSON_COLOR_OPTIONS = [
  { id: "default", label: "Обычный цвет", color: "#0b0b0c" },
  { id: "red", label: "Красный", color: "#FF5F56" },
  { id: "yellow", label: "Жёлтый", color: "#fcdb47" },
  { id: "green", label: "Зелёный", color: "#4afa93" },
];

// --- НАСТРОЙКА: текст информационной плашки, которая появляется ПОСЛЕ
// Субботы (под всеми днями недели), без названия дня — просто текст.
// Впишите сюда нужный текст вручную. Перенос строки внутри строки JS
// (через \n) сохранится на экране благодаря white-space: pre-wrap в
// styles.css (.info-panel-text). Пустая строка "" — плашка скрыта
// автоматически (см. renderInfoPanel ниже по файлу). ---
// Предыдущая подпись для быстрого возврата:
// "Поздравляем команду Team Spirit с победой на The International 2026! И Мишу Флаффи с уверенным достижением ранга Рыцарь 5!!"
const INFO_PANEL_TEXT = "";

// ═══════════════════════════════════════════════════════════════════
// НАСТРОЙКА: КНОПКА "НАВЕРХ" (кружок со стрелкой в правом нижнем углу)
// ═══════════════════════════════════════════════════════════════════
const SCROLL_TOP_BTN_CIRCLE_COLOR = "#1C1C1E";
const SCROLL_TOP_BTN_ARROW_COLOR = "#fcfaea";
const SCROLL_TOP_BTN_SIZE = 46;
const SCROLL_TOP_BTN_OFFSET_BOTTOM = 34;
const SCROLL_TOP_BTN_OFFSET_RIGHT = 22;
const SCROLL_TOP_DURATION_MS = 320;

// ═══════════════════════════════════════════════════════════════════
// НАСТРОЙКА: ПЛАШКА ВЫБОРА КУРСА/ГРУППЫ (bottom sheet)
// ═══════════════════════════════════════════════════════════════════
const PICKER_SHEET_ANIMATION_MS = 280;

// ═══════════════════════════════════════════════════════════════════
// НАСТРОЙКА: ПРОКРУТКА К ДНЮ НЕДЕЛИ (кнопки Пн–Сб и автопереход)
// ═══════════════════════════════════════════════════════════════════
// Зазор между прилипшей (sticky) плашкой навигации и началом дня
const DAY_SCROLL_OFFSET_PX = 6;
const DAY_SCROLL_DURATION_MS = 340;

// ═══════════════════════════════════════════════════════════════════
// НАСТРОЙКА: ЛЁГКАЯ ВИБРАЦИЯ (haptic feedback)
// ═══════════════════════════════════════════════════════════════════
const HAPTIC_LEVELS = [null, "light", "medium", "heavy", "rigid", "soft"];

const HAPTIC_PICKER_SELECT = 1;
const HAPTIC_LOAD_BUTTON = 3;
const HAPTIC_SCROLL_TOP = 1;

function triggerHaptic(level) {
  if (!level) return;
  const style = HAPTIC_LEVELS[level];
  triggerTelegramHaptic(style);
}

const appState = {
  currentCourse: null,
  currentGroup: null,
  scheduleData: null,
  currentCourseVersion: null,
  groupVersions: {},
  displayedCourse: null,
  displayedGroup: null,
  isLoading: false,
  isBackgroundRefreshing: false,
  isUsingCachedGroups: false,
  lastActivityAt: Date.now(),
};

function initApp() {
  console.log("Инициализация приложения...");
  initializeTelegramWebApp();
  startCloudColors();
  setupEventListeners();
  setupCustomSelects();
  modesController = setupScheduleModes({ apiBase: TEACHER_API_BASE, onTeacher: loadTeacher,
    comparison: {
      apiBase: API_BASE_URL,
      buildLesson: buildClassInfoHTML,
      displayedTime: getDisplayedClassTime,
      decorateLesson(card, title, scope) {
        prepareLessonColor(card, title, scope);
        applyLessonEdge(card);
      },
    },
    onChange(mode) {
    scheduleMode = mode;
    ++teacherRequest;
    ++scheduleRequest;
    showLoading(false);
    hideError();
    document.getElementById('welcome-section').classList.add('hidden');
    document.getElementById('schedule-container').classList.add('hidden');
    document.getElementById('day-navigation').classList.add('hidden');
    if (mode === 'group' || mode === 'subgroup') {
      if (!restoredSelection) {
        restoredSelection = true;
        restoreSavedState();
      } else if (appState.scheduleData) displaySchedule(appState.scheduleData);
      else if (appState.currentCourse && appState.currentGroup) loadSchedule(appState.currentCourse, appState.currentGroup);
    }
  } });
  document.getElementById('welcome-section').classList.add('hidden');
  setupDayNavigation();
  setupStickyDayNav();
  setupScrollTopButton();
  setupInactivityRefresh();
  setupLessonColorPicker();
  console.log("Приложение инициализировано");
  window.dispatchEvent(new Event('schedule-ready'));
}

function normalizeLessonTitle(title) {
  const normalizedTitle = String(title || "").trim().replace(/\s+/g, " ").toLocaleLowerCase("ru-RU");
  return normalizedTitle.includes("физическая культура")
    ? "физическая культура"
    : normalizedTitle;
}

const PHYSICAL_CULTURE_TIME_PATTERN = /\(\s*(\d{1,2}[.:]\d{2})\s*[-–—]\s*(\d{1,2}[.:]\d{2})\s*\)/u;

function getDisplayedLessonTitle(title) {
  const text = String(title || "");
  return normalizeLessonTitle(text) === "физическая культура"
    ? text.replace(PHYSICAL_CULTURE_TIME_PATTERN, "").replace(/\s+/g, " ").trim()
    : text;
}

function getPhysicalCultureTime(classItem) {
  const titles = [classItem?.subgroupA?.classTitle, classItem?.subgroupB?.classTitle];

  for (const title of titles) {
    if (!normalizeLessonTitle(title).includes("физическая культура")) continue;
    const match = String(title).match(PHYSICAL_CULTURE_TIME_PATTERN);
    if (match) return { start: match[1], end: match[2] };
  }

  return null;
}

function getDisplayedClassTime(classItem) {
  const physicalCultureTime = getPhysicalCultureTime(classItem);
  return {
    start: physicalCultureTime?.start || classItem?.startTime,
    end: physicalCultureTime?.end || classItem?.endTime,
  };
}

function formatBreakDuration(minutes) {
  return `${minutes} мин`;
}

function lessonColorKey(title, scope) {
  return `${normalizeLessonTitle(title)}::${scope}`;
}

function getLessonColors() {
  if (cloudColors) return cloudColors.getColors();
  const stored = readJsonStorage(LESSON_COLORS_STORAGE_KEY);
  return stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
}

function startCloudColors() {
  if (!cloudColors) cloudColors = setupCloudColors(() => document.querySelectorAll('[data-lesson-color-key]').forEach(applyLessonEdge), showToast);
}

function getLessonColor(title, scope) {
  const colors = getLessonColors();
  return colors[lessonColorKey(title, scope)] ||
    (scope === "common" ? colors[normalizeLessonTitle(title)] : null) ||
    null;
}

function saveLessonColor(title, scope, color) {
  const key = lessonColorKey(title, scope);
  if (!key) return;
  const colors = getLessonColors();
  if (color) colors[key] = color;
  else delete colors[key];
  if (scope === "common") delete colors[normalizeLessonTitle(title)];
  writeJsonStorage(LESSON_COLORS_STORAGE_KEY, colors);
  cloudColors?.edit(key, color || null);
  if (scope === "common") cloudColors?.edit(normalizeLessonTitle(title), null);
}

function prepareLessonColor(card, title, scope) {
  card.dataset.lessonTitle = title || "";
  card.dataset.lessonColorScope = scope;
  card.dataset.lessonColorKey = lessonColorKey(title, scope);
  card.classList.toggle(
    "is-title-only",
    card.children.length === 1 && card.firstElementChild?.classList.contains("class-detail"),
  );
}

function applyLessonEdge(card) {
  const color = getLessonColor(
    card.dataset.lessonTitle,
    card.dataset.lessonColorScope,
  );
  card.style.removeProperty("--lesson-edge-color");
  card.classList.toggle("has-lesson-edge", Boolean(color));
  if (color) card.style.setProperty("--lesson-edge-color", color);
  card.style.removeProperty("--lesson-type-color");
  if (color) card.style.setProperty("--lesson-type-color", color);
}

function setupLessonColorPicker() {
  const scheduleDays = document.getElementById("schedule-days");
  if (!scheduleDays) return;

  const resetScrollTopButtonOffset = () => {
    const wrapper = document.getElementById("scroll-top-btn-position");
    if (!wrapper) return;
    wrapper.style.bottom = `calc(${SCROLL_TOP_BTN_OFFSET_BOTTOM}px + env(safe-area-inset-bottom, 0px))`;
  };

  const placeScrollTopButtonAbove = (picker) => {
    const wrapper = document.getElementById("scroll-top-btn-position");
    if (!wrapper || !picker?.isConnected) return;
    const pickerTop = picker.getBoundingClientRect().top;
    const bottom = Math.max(
      SCROLL_TOP_BTN_OFFSET_BOTTOM,
      window.innerHeight - pickerTop + 12,
    );
    wrapper.style.bottom = `${bottom}px`;
  };

  const closePicker = () => {
    scheduleDays.querySelector(".lesson-color-picker")?.remove();
    scheduleDays.querySelectorAll('.class-time[aria-expanded="true"]').forEach((time) =>
      time.setAttribute("aria-expanded", "false"),
    );
    resetScrollTopButtonOffset();
  };

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closePicker();
  });

  scheduleDays.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const timeButton = target?.closest(".class-time");
    if (!timeButton) {
      if (!target?.closest(".lesson-color-picker")) closePicker();
      return;
    }

    event.stopPropagation();
    const slot = timeButton.closest(".class-slot");
    if (!slot) return;
    const wasOpen = Boolean(slot.querySelector(".lesson-color-picker"));
    closePicker();
    if (wasOpen) return;

    const picker = document.createElement("div");
    picker.className = "lesson-color-picker";
    picker.setAttribute("role", "group");
    picker.setAttribute("aria-label", "Цвет предмета");
    const handle = document.createElement("button");
    handle.type = "button";
    handle.className = "lesson-color-handle";
    handle.setAttribute("aria-label", "Закрыть выбор цвета");
    handle.addEventListener("click", closePicker);
    let swipeStart = 0;
    handle.addEventListener("pointerdown", event => { swipeStart = event.clientY; handle.setPointerCapture(event.pointerId); });
    handle.addEventListener("pointerup", event => { if (event.clientY - swipeStart > 30) closePicker(); });
    picker.append(handle);
    const lessons = Array.from(slot.querySelectorAll(".class-common, .subgroup"))
      .map((card) => ({
        title: card.dataset.lessonTitle,
        scope: card.dataset.lessonColorScope,
      }))
      .filter(({ title }) => title);
    lessons.forEach(({ title, scope }) =>
      picker.appendChild(buildLessonColorRow(title, scope)),
    );
    if (!lessons.length) return;
    picker.addEventListener('refresh-colors', () => {
      picker.querySelectorAll('.lesson-color-row').forEach(row => row.dispatchEvent(new Event('refresh-colors')));
    });
    slot.appendChild(picker);
    const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => placeScrollTopButtonAbove(picker)) : null;
    resizeObserver?.observe(picker);
    const removalObserver = new MutationObserver(() => {
      if (!picker.isConnected) { resizeObserver?.disconnect(); removalObserver.disconnect(); }
    });
    removalObserver.observe(scheduleDays, { childList: true, subtree: true });
    timeButton.setAttribute("aria-expanded", "true");
    requestAnimationFrame(() => placeScrollTopButtonAbove(picker));
  });

  window.addEventListener("resize", () => {
    const picker = scheduleDays.querySelector(".lesson-color-picker");
    if (picker) placeScrollTopButtonAbove(picker);
  });

  new MutationObserver(() => {
    if (!scheduleDays.querySelector(".lesson-color-picker")) {
      resetScrollTopButtonOffset();
    }
  }).observe(scheduleDays, { childList: true, subtree: true });
}

function buildLessonColorRow(title, scope) {
  return createLessonColorRow(title, scope, {
    options: LESSON_COLOR_OPTIONS,
    getColor: getLessonColor,
    applyColor(title, scope, color) {
      saveLessonColor(title, scope, color);
      updateLessonCards(title, scope);
    },
  });
}
function updateLessonCards(title, scope) {
  const key = lessonColorKey(title, scope);
  document.querySelectorAll(".class-common, .subgroup").forEach((card) => {
    if (card.dataset.lessonColorKey === key) applyLessonEdge(card);
  });
}

const courseCacheKey = (course) => `scheduleCache:v${CACHE_SCHEMA_VERSION}:course:${course}`;
const groupCacheKey = (course, group) =>
  `scheduleCache:v${CACHE_SCHEMA_VERSION}:course:${course}:group:${encodeURIComponent(group)}`;

function setupEventListeners() {
  const courseSelect = document.getElementById("course-select");
  const groupSelect = document.getElementById("group-select");
  const refreshButton = document.getElementById("refresh-schedule-button");

  courseSelect.addEventListener("change", async (e) => {
    ++selectionRevision;
    ++groupsRequest;
    const course = e.target.value;
    appState.currentCourse = course;
    resetSelectedGroup();
    appState.currentCourseVersion = null;
    appState.groupVersions = {};
    if (course) {
      safeSetStorage("selectedCourse", course);
      safeRemoveStorage("selectedGroup");
      await loadGroups(course);
    } else {
      safeRemoveStorage("selectedCourse");
      safeRemoveStorage("selectedGroup");
      groupSelect.innerHTML = '<option value="">Сначала выберите курс</option>';
      groupSelect.disabled = true;
      syncSelectTrigger(groupSelect);
    }
  });

  groupSelect.addEventListener("change", (e) => {
    ++selectionRevision;
    clearVisibleSchedule();
    appState.currentGroup = e.target.value;
    if (appState.currentGroup) {
      safeSetStorage("selectedGroup", appState.currentGroup);
      loadSchedule(appState.currentCourse, appState.currentGroup);
    } else {
      safeRemoveStorage("selectedGroup");
    }
  });

  refreshButton?.addEventListener("click", refreshScheduleManually);
}

const PICKER_SELECT_TRIGGERS = {
  "course-select": {
    trigger: "course-select-trigger",
    text: "course-select-trigger-text",
    title: "Курс",
  },
  "group-select": {
    trigger: "group-select-trigger",
    text: "group-select-trigger-text",
    title: "Группа",
  },
};

function syncSelectTrigger(selectEl) {
  if (!selectEl) return;
  const map = PICKER_SELECT_TRIGGERS[selectEl.id];
  if (!map) return;
  const trigger = document.getElementById(map.trigger);
  const textEl = document.getElementById(map.text);
  if (!trigger || !textEl) return;

  const selectedOption = selectEl.options[selectEl.selectedIndex];
  textEl.textContent = selectEl.value || '—';
  trigger.setAttribute('aria-label', `${map.title}: ${selectedOption?.textContent || 'Не выбрана'}`);
  trigger.classList.toggle("placeholder", !selectEl.value);
  trigger.disabled = selectEl.disabled;
}

function setupCustomSelects() {
  const overlay = document.getElementById("picker-overlay");
  const sheet = document.getElementById("picker-sheet");
  const titleEl = document.getElementById("picker-sheet-title");
  const listEl = document.getElementById("picker-sheet-list");
  const closeBtn = document.getElementById("picker-sheet-close");
  if (!overlay || !sheet || !listEl) return;

  overlay.style.setProperty(
    "--picker-anim-ms",
    PICKER_SHEET_ANIMATION_MS + "ms",
  );

  let activeSelect = null;
  let closeTimer = null;

  function renderList(selectEl) {
    listEl.innerHTML = "";
    Array.from(selectEl.options).forEach((opt) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "picker-sheet-item";
      if (!opt.value) item.classList.add("picker-sheet-item-placeholder");
      if (opt.value && opt.value === selectEl.value)
        item.classList.add("active");

      const labelSpan = document.createElement("span");
      labelSpan.textContent = opt.textContent;
      item.appendChild(labelSpan);

      if (opt.value && opt.value === selectEl.value) {
        item.insertAdjacentHTML(
          "beforeend",
          `
                    <svg class="picker-sheet-item-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M20 6 9 17l-5-5"/>
                    </svg>`,
        );
      }

      item.addEventListener("click", () => {
        triggerHaptic(HAPTIC_PICKER_SELECT);
        selectEl.value = opt.value;
        selectEl.dispatchEvent(new Event("change", { bubbles: true }));
        syncSelectTrigger(selectEl);
        closePicker();
      });

      listEl.appendChild(item);
    });
  }

  function openPicker(selectEl) {
    if (!selectEl || selectEl.disabled) return;
    clearTimeout(closeTimer);
    activeSelect = selectEl;
    const map = PICKER_SELECT_TRIGGERS[selectEl.id];
    titleEl.textContent = map ? map.title : "";
    renderList(selectEl);

    overlay.classList.remove("hidden");
    requestAnimationFrame(() => {
      overlay.classList.add("open");
    });
    document.body.style.overflow = "hidden";

    const trigger = map ? document.getElementById(map.trigger) : null;
    if (trigger) trigger.setAttribute("aria-expanded", "true");
  }

  function closePicker() {
    overlay.classList.remove("open");
    document.body.style.overflow = "";

    const map = activeSelect ? PICKER_SELECT_TRIGGERS[activeSelect.id] : null;
    const trigger = map ? document.getElementById(map.trigger) : null;
    if (trigger) trigger.setAttribute("aria-expanded", "false");

    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      overlay.classList.add("hidden");
    }, PICKER_SHEET_ANIMATION_MS);
  }

  Object.keys(PICKER_SELECT_TRIGGERS).forEach((selectId) => {
    const map = PICKER_SELECT_TRIGGERS[selectId];
    const trigger = document.getElementById(map.trigger);
    const selectEl = document.getElementById(selectId);
    if (!trigger || !selectEl) return;
    trigger.addEventListener("click", () => openPicker(selectEl));
    syncSelectTrigger(selectEl);
  });

  if (closeBtn) closeBtn.addEventListener("click", closePicker);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) closePicker();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && overlay.classList.contains("open")) closePicker();
  });
}

function setupDayNavigation() {
  const navButtons = document.querySelectorAll(".day-nav-btn");
  navButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const day = btn.getAttribute("data-day");
      scrollToDay(day);
      // Сразу снимаем фокус с кнопки после тапа — доп. страховка от
      // "залипающей" рамки/обводки, которую некоторые Android WebView
      // (в т.ч. внутри Telegram) рисуют вокруг сфокусированной кнопки
      // и не всегда корректно скрывают через одни только CSS-правила.
      btn.blur();
    });
  });
}

// Следит за маячком #day-nav-sentinel (см. index.html) через
// IntersectionObserver: как только он уходит из видимой области —
// значит #day-navigation (у неё position: sticky в styles.css) реально
// прилипла к верху экрана, и на неё добавляется класс .is-stuck
// (тень снизу — см. styles.css). Ранее эта функция была только в
// комментариях и нигде не вызывалась, поэтому класс .is-stuck никогда
// не добавлялся.
function setupStickyDayNav() {
  const sentinel = document.getElementById("day-nav-sentinel");
  const nav = document.getElementById("day-navigation");
  if (!sentinel || !nav || typeof IntersectionObserver !== 'function') return;

  // root — тот же скролл-контейнер, что и у остального сайта
  // (.main-content). Если его вдруг нет в разметке, передаём null —
  // тогда IntersectionObserver будет ориентироваться на viewport.
  const root = document.querySelector(".main-content") || null;

  const observer = new IntersectionObserver(
    ([entry]) => {
      nav.classList.toggle("is-stuck", !entry.isIntersecting);
    },
    { root, threshold: 0 },
  );
  observer.observe(sentinel);
}

function getScrollingElement() {
  const candidates = [
    document.querySelector(".main-content"),
    document.documentElement,
    document.body,
  ];
  for (const el of candidates) {
    if (el && el.scrollHeight - el.clientHeight > 1) return el;
  }
  return document.documentElement;
}

function scrollToDay(day, behavior = "smooth") {
  const target = document.getElementById(`day-${day}`);
  if (!target) return false;

  const el = getScrollingElement();
  const targetRect = target.getBoundingClientRect();

  // Высчитываем высоту липкой шапки навигации, чтобы дни не прятались под ней
  const nav = document.getElementById("day-navigation");
  const navHeight =
    nav && !nav.classList.contains("hidden") ? nav.offsetHeight : 0;

  // Вычисляем дистанцию с учётом высоты шапки
  const controls = document.querySelector('.controls-section');
  const controlsHeight = controls && !controls.hidden ? controls.offsetHeight : 0;
  const delta = targetRect.top - navHeight - controlsHeight - DAY_SCROLL_OFFSET_PX;

  if (Math.abs(delta) > 0.5) {
    if (behavior === "instant") {
      el.scrollTop += delta;
    } else {
      animateScrollTo(el, el.scrollTop + delta, DAY_SCROLL_DURATION_MS);
    }
  }

  return true;
}

const WEEKDAY_NAMES_RU = [
  "Воскресенье",
  "Понедельник",
  "Вторник",
  "Среда",
  "Четверг",
  "Пятница",
  "Суббота",
];
const SCHEDULE_DAY_NAMES = WEEKDAY_NAMES_RU.slice(1);

function scrollToCurrentDay() {
  const todayIndex = new Date().getDay();
  for (let i = 0; i < 7; i++) {
    const dayName = WEEKDAY_NAMES_RU[(todayIndex + i) % 7];
    if (scrollToDay(dayName, "instant")) return;
  }
}

// ═══════════════════════════════════════════════════════════════════
// ОБРАБОТКА СКРОЛЛА (Scroll Spy и кнопка "Наверх")
// ═══════════════════════════════════════════════════════════════════

function updateScrollTopVisibility() {
  const btn = document.getElementById("scroll-top-btn");
  const controlsSection = document.querySelector(".controls-section");
  const scheduleContainer = document.getElementById("schedule-container");
  if (!btn || !controlsSection || !scheduleContainer) return;

  const scheduleVisible = !scheduleContainer.classList.contains("hidden");
  if (!scheduleVisible) {
    btn.classList.remove("visible");
    return;
  }

  const scrolledPastTop = getScrollingElement().scrollTop > 300;
  btn.classList.toggle("visible", scrolledPastTop);
}

// Подсвечивает текущий активный день в липкой навигации
function updateActiveDay() {
  const dayBlocks = document.querySelectorAll(".day-block");
  if (dayBlocks.length === 0) return;

  const nav = document.getElementById("day-navigation");
  if (!nav || nav.classList.contains("hidden")) return;

  const navRect = nav.getBoundingClientRect();
  // Линия срабатывания: сразу под прилипшей шапкой + небольшой буфер
  const triggerLine = navRect.bottom + DAY_SCROLL_OFFSET_PX + 20;

  let activeDay = null;
  for (const block of dayBlocks) {
    const rect = block.getBoundingClientRect();
    if (rect.top <= triggerLine) {
      activeDay = block.id.replace("day-", "");
    } else {
      break;
    }
  }

  // Если доскроллили до самого низа (с учетом overscroll) — выделяем последний день
  const scrollEl = getScrollingElement();
  const isAtBottom =
    scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight - 2;
  if (isAtBottom && dayBlocks.length > 0) {
    activeDay = dayBlocks[dayBlocks.length - 1].id.replace("day-", "");
  }

  // Если мы на самом верху и расписание видно — выделяем первый день (или снимаем выделение)
  if (!activeDay) {
    const firstBlock = dayBlocks[0];
    if (
      firstBlock &&
      firstBlock.getBoundingClientRect().top < window.innerHeight
    ) {
      activeDay = firstBlock.id.replace("day-", "");
    }
  }

  document.querySelectorAll(".day-nav-btn").forEach((b) => {
    b.classList.toggle("active", b.getAttribute("data-day") === activeDay);
  });
}

// Единый обработчик для всех зависимых от скролла функций
function handleGlobalScroll() {
  updateScrollTopVisibility();
  updateActiveDay();
}

function positionScrollTopButton() {}

function animateScrollTo(el, targetTop, duration) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    el.scrollTop = targetTop;
    return;
  }
  const startTop = el.scrollTop;
  const distance = targetTop - startTop;
  if (Math.abs(distance) < 1) return;

  const startTime = performance.now();
  function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }
  function step(now) {
    const elapsed = now - startTime;
    const t = Math.min(elapsed / duration, 1);
    el.scrollTop = startTop + distance * easeOutCubic(t);
    if (t < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

function scrollAppToTop() {
  animateScrollTo(getScrollingElement(), 0, SCROLL_TOP_DURATION_MS);
}

function setupScrollTopButton() {
  const btn = document.getElementById("scroll-top-btn");
  const wrapper = document.getElementById("scroll-top-btn-position");
  if (!btn || !wrapper) return;

  btn.style.width = SCROLL_TOP_BTN_SIZE + "px";
  btn.style.height = SCROLL_TOP_BTN_SIZE + "px";
  btn.style.backgroundColor = SCROLL_TOP_BTN_CIRCLE_COLOR;
  btn.style.color = SCROLL_TOP_BTN_ARROW_COLOR;

  wrapper.style.right = `calc(${SCROLL_TOP_BTN_OFFSET_RIGHT}px + env(safe-area-inset-right, 0px))`;
  wrapper.style.bottom = `calc(${SCROLL_TOP_BTN_OFFSET_BOTTOM}px + env(safe-area-inset-bottom, 0px))`;

  btn.addEventListener("click", () => {
    triggerHaptic(HAPTIC_SCROLL_TOP);
    scrollAppToTop();
  });

  const scrollContainer = document.querySelector(".main-content");
  if (scrollContainer) {
    scrollContainer.addEventListener("scroll", handleGlobalScroll, {
      passive: true,
    });
  }
  window.addEventListener("scroll", handleGlobalScroll, { passive: true });
  window.addEventListener("resize", handleGlobalScroll);

  handleGlobalScroll();
}

async function restoreSavedState() {
  const revision = selectionRevision;
  const savedCourse = safeGetStorage("selectedCourse");
  const savedGroup = safeGetStorage("selectedGroup");
  if (savedCourse) {
    appState.currentCourse = savedCourse;
    const courseSelect = document.getElementById("course-select");
    courseSelect.value = savedCourse;
    syncSelectTrigger(courseSelect);

    // Показываем сохранённое расписание сразу, пока в фоне проверяется версия курса.
    const cachedCourse = readJsonStorage(courseCacheKey(savedCourse));
    const cachedSchedule = savedGroup
      ? readJsonStorage(groupCacheKey(savedCourse, savedGroup))
      : null;
    const cachedGroup = cachedCourse?.groups?.find((group) => group.groupName === savedGroup);
    if (cachedCourse?.groups?.length && cachedSchedule?.data?.classes?.length && cachedGroup &&
        cachedSchedule.version === (cachedGroup.version || cachedCourse.version)) {
      const groupSelect = document.getElementById("group-select");
      groupSelect.innerHTML = '<option value="">Выберите группу</option>';
      cachedCourse.groups.forEach((group) => {
        const option = document.createElement("option");
        option.value = group.groupName;
        option.textContent = group.groupName;
        groupSelect.appendChild(option);
      });
      if (Array.from(groupSelect.options).some((option) => option.value === savedGroup)) {
        appState.currentCourseVersion = cachedCourse.version || null;
        appState.groupVersions = Object.fromEntries(
          cachedCourse.groups.map((group) => [group.groupName, group.version || cachedCourse.version || null]),
        );
        appState.currentGroup = savedGroup;
        groupSelect.value = savedGroup;
        groupSelect.disabled = false;
        syncSelectTrigger(groupSelect);
        appState.scheduleData = cachedSchedule.data;
        displaySchedule(cachedSchedule.data);
        requestAnimationFrame(scrollToCurrentDay);
      }
    }

    const groupsLoaded = await loadGroups(savedCourse);
    if (revision !== selectionRevision || appState.currentCourse !== savedCourse || (appState.currentGroup && appState.currentGroup !== savedGroup)) return;
    if (groupsLoaded && savedGroup) {
      const groupSelect = document.getElementById("group-select");
      if (
        Array.from(groupSelect.options).some((opt) => opt.value === savedGroup)
      ) {
        appState.currentGroup = savedGroup;
        groupSelect.value = savedGroup;
        syncSelectTrigger(groupSelect);
        await loadSchedule(savedCourse, savedGroup);
        requestAnimationFrame(scrollToCurrentDay);
      } else if (appState.currentGroup === savedGroup) {
        resetSelectedGroup();
      }
    }
  }
}

async function loadGroups(course, options = {}) {
  const request = ++groupsRequest;
  const { forceRefresh = false, silent = false } = options;
  const groupSelect = document.getElementById("group-select");
  const initialCache = readJsonStorage(courseCacheKey(course));
  if (initialCache?.groups?.length) {
    appState.currentCourseVersion = initialCache.version || null;
    appState.groupVersions = Object.fromEntries(
      initialCache.groups.map((group) => [group.groupName, group.version || initialCache.version || null]),
    );
    groupSelect.innerHTML = '<option value="">Выберите группу</option>';
    initialCache.groups.forEach((group) => {
      const option = document.createElement("option");
      option.value = group.groupName;
      option.textContent = group.groupName;
      groupSelect.appendChild(option);
    });
    groupSelect.disabled = false;
  } else {
    groupSelect.innerHTML = '<option value="">Загрузка...</option>';
    groupSelect.disabled = true;
  }
  groupSelect.value = appState.currentGroup || '';
  syncSelectTrigger(groupSelect);
  if (!silent) hideError();
  try {
    const url = new URL(API_BASE_URL + GROUPS_ENDPOINT);
    url.searchParams.append("course", course);
    const result = await requestJson(url, forceRefresh ? { cache: "no-store" } : {});

    if (result.success && Array.isArray(result.data?.groups)) {
      if (request !== groupsRequest || appState.currentCourse !== String(course)) return false;
      appState.isUsingCachedGroups = false;
      groupSelect.innerHTML = '<option value="">Выберите группу</option>';

      const sortedGroups = [...result.data.groups].sort((a, b) =>
        a.groupName.localeCompare(b.groupName, "ru", { numeric: true }),
      );

      appState.currentCourseVersion = result.data.version || result.data.updatedAt || null;
      appState.groupVersions = Object.fromEntries(
        sortedGroups.map((group) => [group.groupName, group.version || appState.currentCourseVersion]),
      );
      writeJsonStorage(courseCacheKey(course), {
        version: appState.currentCourseVersion,
        updatedAt: result.data.updatedAt || null,
        groups: sortedGroups,
      });

      sortedGroups.forEach((group) => {
        const option = document.createElement("option");
        option.value = group.groupName;
        option.textContent = group.groupName;
        groupSelect.appendChild(option);
      });
      groupSelect.disabled = false;
      groupSelect.value = appState.currentGroup || '';
      syncSelectTrigger(groupSelect);
      return true;
    } else {
      throw new Error("Группы не найдены");
    }
  } catch (error) {
    if (request !== groupsRequest || appState.currentCourse !== String(course)) return false;
    console.error(error);
    const cached = readJsonStorage(courseCacheKey(course));
    if (cached?.groups?.length && appState.currentCourse === String(course)) {
      appState.isUsingCachedGroups = true;
      appState.currentCourseVersion = cached.version || null;
      appState.groupVersions = Object.fromEntries(
        cached.groups.map((group) => [group.groupName, group.version || cached.version || null]),
      );
      groupSelect.innerHTML = '<option value="">Выберите группу</option>';
      cached.groups.forEach((group) => {
        const option = document.createElement("option");
        option.value = group.groupName;
        option.textContent = group.groupName;
        groupSelect.appendChild(option);
      });
      groupSelect.disabled = false;
      groupSelect.value = appState.currentGroup || '';
      syncSelectTrigger(groupSelect);
      return true;
    }
    // ИСПРАВЛЕНО: Человечная ошибка сети, если fetch выкинул TypeError (нет интернета)
    const msg =
      error.name === "TypeError"
        ? "Проверьте подключение к интернету"
        : error.message;
    if (!silent && ['group', 'subgroup'].includes(scheduleMode)) showError(`Не удалось загрузить список групп: ${msg}`);
    groupSelect.innerHTML = '<option value="">Ошибка загрузки</option>';
    appState.isUsingCachedGroups = false;
    syncSelectTrigger(groupSelect);
    return false;
  }
}

async function loadSchedule(course, group, options = {}) {
  if (!['group', 'subgroup'].includes(scheduleMode)) return { ok: false, cancelled: true };
  const request = ++scheduleRequest;
  const isCurrent = () => request === scheduleRequest &&
    appState.currentCourse === String(course) && appState.currentGroup === String(group) &&
    ['group', 'subgroup'].includes(scheduleMode);
  const { forceRefresh = false, silent = false } = options;
  const groupVersion = appState.groupVersions[group] || appState.currentCourseVersion;
  const cached = readJsonStorage(groupCacheKey(course, group));
  if (!silent) {
    showLoading(true);
    hideError();
  }
  try {
    if (!forceRefresh && cached?.version && cached.version === groupVersion && cached.data) {
      appState.scheduleData = cached.data;
      displaySchedule(cached.data);
      setStaleNotice(appState.isUsingCachedGroups);
      return { ok: true, changed: false, fromCache: true };
    }

    const url = new URL(API_BASE_URL + SCHEDULE_ENDPOINT);
    url.searchParams.append("course", course);
    url.searchParams.append("group", group);
    const data = await requestJson(url, forceRefresh ? { cache: "no-store" } : {});

    // ИСПРАВЛЕНО: Защита от состояния гонки (Race condition)
    // Если юзер быстро нажал на другую группу пока летел запрос — игнорируем ответ
    if (
      !isCurrent()
    ) {
      return { ok: false, cancelled: true };
    }

    if (data.success) {
      const scheduleChanged = JSON.stringify(appState.scheduleData) !== JSON.stringify(data.data);
      appState.scheduleData = data.data;
      if (groupVersion) {
        writeJsonStorage(groupCacheKey(course, group), {
          version: groupVersion,
          data: data.data,
        });
      }
      if (scheduleChanged || !silent) displaySchedule(data.data);
      setStaleNotice(false);
      return { ok: true, changed: scheduleChanged, fromCache: false };
    } else {
      throw new Error(data.message || "Ошибка при получении данных");
    }
  } catch (error) {
    if (!isCurrent()) return { ok: false, cancelled: true };
    console.error(error);
    // ИСПРАВЛЕНО: Человечная ошибка сети, если fetch выкинул TypeError (нет интернета)
    const msg =
      error.name === "TypeError"
        ? "Проверьте подключение к интернету"
        : error.message;
    const hasVisibleFallback = Boolean(
      cached?.data ||
      (appState.scheduleData &&
        appState.displayedCourse === String(course) &&
        appState.displayedGroup === String(group)),
    );
    if (hasVisibleFallback) {
      if (cached?.data && (
        !appState.scheduleData ||
        appState.displayedCourse !== String(course) ||
        appState.displayedGroup !== String(group)
      )) {
        appState.scheduleData = cached.data;
        displaySchedule(cached.data);
      }
      setStaleNotice(true);
    } else if (!silent) {
      showError(`Ошибка загрузки: ${msg}`);
    }
    return { ok: false, error: msg, fromCache: hasVisibleFallback };
  } finally {
    if (isCurrent()) showLoading(false);
  }
}

async function refreshScheduleManually() {
  if (scheduleMode !== 'group' && scheduleMode !== 'subgroup') return;
  const course = appState.currentCourse;
  const group = appState.currentGroup;
  if (!course || !group || appState.isBackgroundRefreshing) return;

  const refreshButton = document.getElementById("refresh-schedule-button");
  appState.isBackgroundRefreshing = true;
  refreshButton?.classList.add("is-refreshing");
  try {
    const groupsLoaded = await loadGroups(course, { forceRefresh: true, silent: true });
    if (appState.currentCourse !== course || appState.currentGroup !== group) return;
    if (!groupsLoaded) { showToast('Не удалось проверить обновления'); return; }
    const groupSelect = document.getElementById("group-select");
    const groupStillExists = groupsLoaded && Array.from(groupSelect.options).some(
      (option) => option.value === group,
    );
    if (!groupStillExists) {
      resetSelectedGroup();
      showToast("Группа больше не найдена");
      return;
    }

    groupSelect.value = group;
    syncSelectTrigger(groupSelect);
    const result = await loadSchedule(course, group, { forceRefresh: true, silent: true });
    if (result?.ok) {
      triggerHaptic(HAPTIC_PICKER_SELECT);
      showToast(result.changed ? "Расписание обновлено" : "Изменений нет");
    } else if (!result?.cancelled) {
      showToast(`Не обновилось: ${result?.error || "нет связи"}`);
    }
  } finally {
    appState.isBackgroundRefreshing = false;
    refreshButton?.classList.remove("is-refreshing");
  }
}

function setupInactivityRefresh() {
  const markActivity = () => {
    const now = Date.now();
    const inactiveFor = now - appState.lastActivityAt;
    appState.lastActivityAt = now;
    if (inactiveFor >= INACTIVITY_REFRESH_MS) refreshCurrentSchedule();
  };

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    markActivity();
  });
  window.addEventListener("focus", markActivity);
  window.addEventListener("pageshow", markActivity);
  document.addEventListener("pointerdown", markActivity, { passive: true });
  document.addEventListener("keydown", markActivity);
}

async function refreshCurrentSchedule() {
  if (scheduleMode === 'teacher' || scheduleMode === 'compare') {
    if (modeRefreshPending) return;
    modeRefreshPending = true;
    try {
      if (scheduleMode === 'teacher' && selectedTeacher) {
        await loadTeacher(selectedTeacher, { forceRefresh: true, silent: true });
      } else if (scheduleMode === 'compare') {
        await modesController?.refreshComparison();
      }
    } finally {
      modeRefreshPending = false;
    }
    return;
  }
  if (scheduleMode !== 'group' && scheduleMode !== 'subgroup') return;
  const course = appState.currentCourse;
  const group = appState.currentGroup;
  if (!course || !group || appState.isBackgroundRefreshing) return;

  appState.isBackgroundRefreshing = true;
  try {
    const groupsLoaded = await loadGroups(course, { forceRefresh: true, silent: true });
    if (!groupsLoaded || appState.currentCourse !== course || appState.currentGroup !== group) return;

    const groupSelect = document.getElementById("group-select");
    const groupStillExists = Array.from(groupSelect.options).some(
      (option) => option.value === group,
    );
    if (!groupStillExists) { resetSelectedGroup(); return; }

    groupSelect.value = group;
    syncSelectTrigger(groupSelect);
    await loadSchedule(course, group, { forceRefresh: true, silent: true });
  } finally {
    appState.isBackgroundRefreshing = false;
  }
}

function renderInfoPanel() {
  const panel = document.getElementById("info-panel");
  const textEl = document.getElementById("info-panel-text");
  if (!panel || !textEl) return;

  const text = (INFO_PANEL_TEXT || "").trim();
  if (text) {
    textEl.textContent = INFO_PANEL_TEXT;
    panel.classList.remove("hidden");
  } else {
    panel.classList.add("hidden");
  }
}

function formatTime(time) {
  if (time === null || time === undefined) return "";
  return String(time).replace(/\./g, ":");
}

function timeToMinutes(time) {
  if (time === null || time === undefined) return Infinity;
  const match = String(time)
    .trim()
    .match(/^(\d{1,2})[:.](\d{2})$/);
  if (!match) return Infinity;
  const hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  return hours * 60 + minutes;
}

function pluralizeLessons(count) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return `${count} пара`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return `${count} пары`;
  }
  return `${count} пар`;
}

function displaySchedule(scheduleData) {
  if (!scheduleMode || scheduleMode === 'compare') return;
  if ((scheduleMode === 'teacher') !== Boolean(scheduleData.teacher)) return;
  if (scheduleMode === 'subgroup') scheduleData = filterSubgroup(scheduleData, document.getElementById('subgroup-select').value);
  const scheduleContainer = document.getElementById("schedule-container");
  const welcomeSection = document.getElementById("welcome-section");
  const scheduleDays = document.getElementById("schedule-days");
  const emptyState = document.getElementById("empty-state");
  const scheduleTitle = document.getElementById("schedule-title");
  const scheduleMetadata = document.getElementById("schedule-metadata");
  document.querySelector('.schedule-info').appendChild(scheduleMetadata);
  document.querySelector('.schedule-info').hidden = scheduleMode !== 'teacher';
  const dayNavigation = document.getElementById("day-navigation");

  welcomeSection.classList.add("hidden");
  scheduleContainer.classList.remove("hidden");
  dayNavigation.classList.remove("hidden");
  appState.displayedCourse = String(appState.currentCourse);
  appState.displayedGroup = String(appState.currentGroup);
  renderInfoPanel();

  scheduleTitle.hidden = scheduleMode !== 'teacher';
  const updatedAt = scheduleData.updatedAt ? new Date(scheduleData.updatedAt) : null;
  const updatedText = updatedAt && !Number.isNaN(updatedAt.getTime())
    ? `${updatedAt.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", timeZone: "Europe/Minsk" })} в ${updatedAt.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Minsk" })}`
    : "неизвестно";
  scheduleMetadata.textContent = updatedText === 'неизвестно' ? 'Дата обновления неизвестна' : `Обновлено ${updatedText}`;
  document.getElementById('refresh-schedule-button').hidden = scheduleMode === 'teacher';
  document.querySelector('.empty-state-hint').textContent = scheduleMode === 'teacher' ? 'Проверьте фамилию преподавателя' : 'Попробуйте выбрать другую группу или подгруппу';
  if (scheduleMode === 'teacher') {
    scheduleTitle.textContent = `Преподаватель: ${scheduleData.teacher}`;
    scheduleMetadata.textContent = 'Занятия по всем курсам';
    document.getElementById('info-panel').classList.add('hidden');
  }

  scheduleDays.innerHTML = "";
  const classes = scheduleData.classes || [];

  if (classes.length === 0) {
    emptyState.classList.remove("hidden");
    handleGlobalScroll();
    return;
  }
  emptyState.classList.add("hidden");

  const groupedByDay = new Map();
  classes.forEach((cls) => {
    const day = cls.dayOfWeekName;
    if (!groupedByDay.has(day)) groupedByDay.set(day, []);
    groupedByDay.get(day).push(cls);
  });

  groupedByDay.forEach((dayClasses) => {
    dayClasses.sort((a, b) => {
      const aTime = getDisplayedClassTime(a);
      const bTime = getDisplayedClassTime(b);
      const diff = timeToMinutes(aTime.start) - timeToMinutes(bTime.start);
      if (diff !== 0) return diff;
      return timeToMinutes(aTime.end) - timeToMinutes(bTime.end);
    });
  });

  SCHEDULE_DAY_NAMES.forEach((day) => {
    const dayClasses = groupedByDay.get(day) || [];
    const dayBlock = document.createElement("div");
    const isToday = WEEKDAY_NAMES_RU[new Date().getDay()] === day;
    dayBlock.className = `day-block${isToday ? " is-today" : ""}`;
    dayBlock.id = `day-${day}`;

    const dayHeader = document.createElement("div");
    dayHeader.className = "day-header";
    const dayMeta = isToday
      ? '<span class="today-label" aria-label="Сегодня"></span>'
      : dayClasses.length
        ? `<span class="day-meta">${pluralizeLessons(dayClasses.length)}</span>`
        : "";
    const displayedDay = day ? day.charAt(0).toLocaleUpperCase("ru-RU") + day.slice(1) : "";
    dayHeader.innerHTML = `<span class="day-name">${escapeHtml(displayedDay)}</span>${dayMeta}`;
    dayBlock.appendChild(dayHeader);
    if (day === 'Понедельник' && scheduleMode !== 'teacher') {
      dayBlock.appendChild(scheduleMetadata);
    }

    const classesContainer = document.createElement("div");
    classesContainer.className = "classes-container";

    if (!dayClasses.length) {
      const emptyDay = document.createElement("p");
      emptyDay.className = "day-empty";
      emptyDay.textContent = "Занятий нет";
      classesContainer.appendChild(emptyDay);
    }

    let occupiedUntil = -Infinity;
    dayClasses.forEach((cls, classIndex) => {
      const slotDiv = document.createElement("div");
      slotDiv.className = "class-slot" + (cls.isLecture ? " is-lecture" : "");

      const timeDiv = document.createElement("button");
      timeDiv.type = "button";
      timeDiv.className = "class-time";
      timeDiv.setAttribute("aria-label", `Выбрать цвет для пары ${formatTime(cls.startTime)}–${formatTime(cls.endTime)}`);
      timeDiv.setAttribute("aria-expanded", "false");
      const timeStart = document.createElement("span");
      timeStart.className = "time-start";

      const displayedTime = getDisplayedClassTime(cls);
      timeStart.textContent = formatTime(displayedTime.start);

      const timeEnd = document.createElement("span");
      timeEnd.className = "time-end";

      timeEnd.textContent = formatTime(displayedTime.end);

      timeDiv.appendChild(timeStart);
      timeDiv.appendChild(timeEnd);
      slotDiv.appendChild(timeDiv);

      const infoDiv = document.createElement("div");
      infoDiv.className = "class-info";

      if (cls.teacherLessons?.length > 1) {
        infoDiv.classList.add('class-split', 'teacher-split');
        for (const entry of cls.teacherLessons) {
          const cell = document.createElement('div');
          cell.className = 'subgroup';
          cell.innerHTML = buildClassInfoHTML(entry.lesson, entry.isLecture);
          prepareLessonColor(cell, entry.lesson.classTitle, entry.label === 'Б' ? 'subgroup-b' : entry.label === 'А' ? 'subgroup-a' : 'common');
          applyLessonEdge(cell);
          if (entry.label) {
            const marker = document.createElement('span');
            marker.className = 'subgroup-marker';
            marker.textContent = entry.label;
            marker.setAttribute('aria-hidden', 'true');
            cell.setAttribute('aria-label', `Подгруппа ${entry.label}`);
            cell.prepend(marker);
          }
          infoDiv.appendChild(cell);
        }
      } else if (cls.isCommon) {
        infoDiv.classList.add("class-common");
        infoDiv.innerHTML = buildClassInfoHTML(cls.subgroupA, cls.isLecture);
        prepareLessonColor(infoDiv, cls.subgroupA?.classTitle, cls.colorScope || "common");
        applyLessonEdge(infoDiv);
      } else {
        infoDiv.classList.add("class-split");
        const left = document.createElement("div");
        left.className = "subgroup subgroup-a";
        left.innerHTML = buildClassInfoHTML(cls.subgroupA, cls.isLecture);
        prepareLessonColor(left, cls.subgroupA?.classTitle, "subgroup-a");
        applyLessonEdge(left);
        const right = document.createElement("div");
        right.className = "subgroup subgroup-b";
        right.innerHTML = buildClassInfoHTML(cls.subgroupB, cls.isLecture);
        prepareLessonColor(right, cls.subgroupB?.classTitle, "subgroup-b");
        applyLessonEdge(right);
        for (const [cell, label] of [[left, 'А'], [right, 'Б']]) {
          const marker = document.createElement('span');
          marker.className = 'subgroup-marker';
          marker.textContent = label;
          marker.setAttribute('aria-hidden', 'true');
          cell.setAttribute('aria-label', `Подгруппа ${label}`);
          cell.prepend(marker);
        }
        infoDiv.appendChild(left);
        infoDiv.appendChild(right);
      }
      slotDiv.appendChild(infoDiv);
      classesContainer.appendChild(slotDiv);

      const nextClass = dayClasses[classIndex + 1];
      occupiedUntil = Math.max(occupiedUntil, timeToMinutes(displayedTime.end));
      if (nextClass) {
        const nextTime = getDisplayedClassTime(nextClass);
        const breakMinutes = timeToMinutes(nextTime.start) - occupiedUntil;
        if (Number.isFinite(breakMinutes) && breakMinutes > 35) {
          const windowSlot = document.createElement("div");
          windowSlot.className = "class-slot class-window-break";

          const duration = document.createElement("div");
          duration.className = "class-time class-window-duration";
          duration.textContent = formatBreakDuration(breakMinutes);

          const windowInfo = document.createElement("div");
          windowInfo.className = "class-info";
          windowInfo.innerHTML = `
            <div class="class-common class-window-card">
              <span class="class-title">Форточка</span>
            </div>`;

          windowSlot.appendChild(duration);
          windowSlot.appendChild(windowInfo);
          classesContainer.appendChild(windowSlot);
        }
      }
    });

    dayBlock.appendChild(classesContainer);
    scheduleDays.appendChild(dayBlock);
  });

  // Сразу после отрисовки расписания обновляем липкую навигацию
  requestAnimationFrame(handleGlobalScroll);
}

function buildClassInfoHTML(subgroup, isLecture = false) {
  if (
    !subgroup ||
    (!subgroup.classTitle &&
      !subgroup.professorName &&
      !subgroup.classroom &&
      !subgroup.comments)
  ) {
    return '<div style="color: var(--ink-faint); font-size: 16px; margin: auto;">—</div>';
  }

  const isPhysicalCulture = normalizeLessonTitle(subgroup.classTitle).includes("физическая культура");
  const lectureHTML = isPhysicalCulture
    ? ""
    : `<span class="class-type${isLecture ? "" : " practice"}">${isLecture ? "Лекция" : "ПЗ"}</span>`;
  const professorHTML = subgroup.professorName
    ? `<span class="class-professor">${escapeHtml(subgroup.professorName)}</span>`
    : "";
  const roomHTML = subgroup.classroom
    ? `<span class="class-room">${escapeHtml(subgroup.classroom)}</span>`
    : "";
  const primaryMetaHTML = professorHTML
    ? `<div class="class-primary-meta">${professorHTML}</div>`
    : "";
  const secondaryMetaHTML = subgroup.comments
    ? `<div class="class-secondary-meta">
        <span class="class-comments">${escapeHtml(subgroup.comments)}</span>
      </div>`
    : "";
  const footerHTML = lectureHTML || roomHTML
    ? `<div class="class-footer">${lectureHTML}${roomHTML}</div>`
    : "";
  return `
        <div class="class-detail">
            <span class="class-title">${escapeHtml(getDisplayedLessonTitle(subgroup.classTitle))}</span>
        </div>
        ${primaryMetaHTML}
        ${secondaryMetaHTML}
        ${footerHTML}`;
}

function showLoading(show) {
  document.getElementById("loading-spinner").classList.toggle("hidden", !show);
  document.getElementById("refresh-schedule-button").disabled = show;
}

function clearVisibleSchedule() {
  ++scheduleRequest;
  appState.scheduleData = null;
  document.getElementById('schedule-container').classList.add('hidden');
  document.getElementById('day-navigation').classList.add('hidden');
  hideError();
  showLoading(false);
}

function resetSelectedGroup() {
  appState.currentGroup = null;
  safeRemoveStorage('selectedGroup');
  const select = document.getElementById('group-select');
  select.value = '';
  if (select.options[0]) select.options[0].textContent = 'Не выбрана';
  syncSelectTrigger(select);
  clearVisibleSchedule();
  showLoading(false);
}

function showError(msg) {
  const el = document.getElementById("error-message");
  if (el) {
    el.textContent = msg;
    el.classList.remove("hidden");
  }
}

function hideError() {
  const el = document.getElementById("error-message");
  if (el) el.classList.add("hidden");
}

function escapeHtml(text) {
  if (typeof text !== "string") return "";
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

window.addEventListener('telegram-ready', initializeTelegramWebApp);
window.addEventListener('telegram-ready', startCloudColors);
window.addEventListener("error", (e) => {
  if (
    e.message &&
    (e.message.includes("Telegram") || e.message.includes("Script error"))
  )
    return;
  showError("Произошла неожиданная ошибка. Попробуйте обновить страницу.");
});
window.addEventListener("unhandledrejection", (e) => {
  console.error(e.reason);
});
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initApp);
} else {
  initApp();
}
