const pageKey = document.body.dataset.page;
const LOCAL_QUOTE_PROXY = "/api/daily-quote";
const tabConfig = [
  { page: "home", label: "Home", href: "index.html" },
  { page: "experience", label: "Experience", href: "experience.html" },
  { page: "projects", label: "Projects", href: "projects.html" },
  { page: "gallery", label: "Gallery", href: "gallery.html" },
  { page: "contact", label: "Contact", href: "contact.html" },
];
const TAB_ORDER_STORAGE_KEY = "portfolio-tab-order-v2";
let tabOrderMemory = null;

function getDailyQuoteFunctionUrl() {
  if (!supabaseConfigured()) {
    return null;
  }
  return `${normalizeSupabaseUrl(SUPABASE_URL)}/functions/v1/get-daily-quote`;
}

function parseDailyQuotePayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Quote payload is not an object.");
  }

  if (typeof payload.text === "string" && payload.text.trim()) {
    return {
      text: payload.text.trim(),
      author: (payload.author || "Unknown").toString().trim() || "Unknown",
    };
  }

  const firstQuote = Array.isArray(payload) ? payload[0] : null;
  const quoteText = (firstQuote?.q || "").toString().trim();
  const quoteAuthor = (firstQuote?.a || "").toString().trim();

  if (!quoteText) {
    throw new Error("Quote payload is missing text.");
  }

  return {
    text: quoteText,
    author: quoteAuthor || "Unknown",
  };
}

async function fetchDailyQuoteFromUrl(url, options = {}) {
  const response = await fetch(url, { cache: "no-store", ...options });
  if (!response.ok) {
    throw new Error(`Quote request failed (${response.status})`);
  }
  const payload = await response.json();
  return parseDailyQuotePayload(payload);
}

async function fetchDailyQuote() {
  const errors = [];

  const functionUrl = getDailyQuoteFunctionUrl();
  if (functionUrl) {
    try {
      return await fetchDailyQuoteFromUrl(functionUrl, {
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        },
      });
    } catch (error) {
      errors.push(`Supabase quote function: ${error.message}`);
    }
  }

  try {
    return await fetchDailyQuoteFromUrl(LOCAL_QUOTE_PROXY);
  } catch (error) {
    errors.push(`Local quote proxy: ${error.message}`);
  }

  throw new Error(errors.join(" | "));
}

function createQuoteGateElement() {
  const gate = document.createElement("section");
  gate.className = "quote-gate";
  gate.setAttribute("role", "dialog");
  gate.setAttribute("aria-modal", "true");
  gate.setAttribute("aria-label", "Daily quote");
  gate.innerHTML = `
    <div class="quote-gate-backdrop" aria-hidden="true">
      <span class="quote-gate-orb quote-gate-orb-a"></span>
      <span class="quote-gate-orb quote-gate-orb-b"></span>
      <span class="quote-gate-orb quote-gate-orb-c"></span>
    </div>
    <div class="quote-gate-card">
      <p class="quote-gate-kicker">Quote of the Day</p>
      <p class="quote-gate-text" id="quote-gate-text">Summoning today's quote...</p>
      <p class="quote-gate-author" id="quote-gate-author"></p>
      <p class="quote-gate-hint">Click anywhere to enter</p>
    </div>
  `;
  return gate;
}

function revealSiteFromQuoteGate(gate) {
  document.body.classList.remove("quote-gate-open");
  gate.classList.add("is-exiting");
  window.setTimeout(() => {
    gate.remove();
  }, 360);
}

async function initDailyQuoteGate() {
  const gate = createQuoteGateElement();
  const quoteTextElement = gate.querySelector("#quote-gate-text");
  const quoteAuthorElement = gate.querySelector("#quote-gate-author");
  document.body.classList.add("quote-gate-open");
  document.body.appendChild(gate);

  const dismiss = () => revealSiteFromQuoteGate(gate);
  gate.addEventListener("click", dismiss, { once: true });
  gate.addEventListener(
    "keydown",
    (event) => {
      if (event.key === "Enter" || event.key === " " || event.key === "Escape") {
        event.preventDefault();
        dismiss();
      }
    },
    { once: true }
  );
  gate.tabIndex = 0;
  gate.focus();

  try {
    const quote = await fetchDailyQuote();
    quoteTextElement.textContent = `"${quote.text}"`;
    quoteAuthorElement.textContent = `- ${quote.author}`;
  } catch (error) {
    console.error("Daily quote failed:", error);
    quoteTextElement.textContent =
      '"Every day is a chance to build something meaningful. Make this one count."';
    quoteAuthorElement.textContent = "- Portfolio Daily Prompt";
  }
}

function readStoredOrder() {
  try {
    return sessionStorage.getItem(TAB_ORDER_STORAGE_KEY);
  } catch {
    return tabOrderMemory;
  }
}

function writeStoredOrder(value) {
  try {
    sessionStorage.setItem(TAB_ORDER_STORAGE_KEY, value);
  } catch {
    tabOrderMemory = value;
  }
}

function clearStoredOrder() {
  try {
    sessionStorage.removeItem(TAB_ORDER_STORAGE_KEY);
  } catch {
    tabOrderMemory = null;
  }
}

function shuffledTabs(items) {
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

function getNavigationType() {
  const entries = performance.getEntriesByType("navigation");
  if (!entries.length) {
    return "navigate";
  }
  return entries[0].type || "navigate";
}

function orderedTabs() {
  if (getNavigationType() === "reload") {
    clearStoredOrder();
  }

  const storedOrder = readStoredOrder();
  if (storedOrder) {
    try {
      const pages = JSON.parse(storedOrder);
      const pageSet = new Set(tabConfig.map((tab) => tab.page));
      if (Array.isArray(pages) && pages.length === tabConfig.length) {
        const hasAllPages =
          new Set(pages).size === tabConfig.length &&
          pages.every((page) => pageSet.has(page));
        if (hasAllPages) {
          return pages
            .map((page) => tabConfig.find((tab) => tab.page === page))
            .filter(Boolean);
        }
      }
    } catch {
      clearStoredOrder();
    }
  }

  const shuffled = shuffledTabs(tabConfig);
  const pages = shuffled.map((tab) => tab.page);
  writeStoredOrder(JSON.stringify(pages));
  return shuffled;
}

function buildTopNav() {
  const nav = document.querySelector("#card-nav");
  if (!nav) {
    return;
  }

  const cards = orderedTabs();
  cards.forEach((tab) => {
    const isCurrent = tab.page === pageKey;
    const card = document.createElement("button");
    card.type = "button";
    card.className = `card-tab${isCurrent ? " is-current" : ""}`;
    card.dataset.page = tab.page;
    card.dataset.href = tab.href;
    card.setAttribute("aria-label", `Reveal ${tab.label} tab`);

    const inner = document.createElement("span");
    inner.className = "playing-card";
    inner.innerHTML = `
      <span class="card-face card-back" aria-hidden="true"></span>
      <span class="card-face card-front">
        <span class="card-front-inner">
          <span class="card-suit" aria-hidden="true">♠</span>
          <span class="card-title">${tab.label}</span>
          <span class="card-divider"></span>
          <span class="card-subtitle">${isCurrent ? "You are here" : "Open tab"}</span>
        </span>
      </span>
    `;
    card.appendChild(inner);

    card.addEventListener("click", () => {
      if (!card.classList.contains("revealed")) {
        card.classList.add("revealed");
        card.setAttribute(
          "aria-label",
          tab.page === pageKey
            ? `${tab.label} tab. You are here.`
            : `${tab.label} tab revealed. Click again to open.`
        );
        return;
      }

      if (tab.page === pageKey) {
        return;
      }
      window.location.href = tab.href;
    });

    nav.appendChild(card);
  });
}

buildTopNav();

function weatherLabelFromCode(code) {
  const labels = {
    0: "Clear sky",
    1: "Mainly clear",
    2: "Partly cloudy",
    3: "Overcast",
    45: "Fog",
    48: "Depositing rime fog",
    51: "Light drizzle",
    53: "Moderate drizzle",
    55: "Dense drizzle",
    56: "Light freezing drizzle",
    57: "Dense freezing drizzle",
    61: "Slight rain",
    63: "Moderate rain",
    65: "Heavy rain",
    66: "Light freezing rain",
    67: "Heavy freezing rain",
    71: "Slight snow fall",
    73: "Moderate snow fall",
    75: "Heavy snow fall",
    77: "Snow grains",
    80: "Slight rain showers",
    81: "Moderate rain showers",
    82: "Violent rain showers",
    85: "Slight snow showers",
    86: "Heavy snow showers",
    95: "Thunderstorm",
    96: "Thunderstorm with hail",
    99: "Thunderstorm with heavy hail",
  };
  return labels[code] || "Weather update available";
}

const SUPABASE_URL =
  window.PORTFOLIO_SUPABASE_URL ||
  window.VITE_PORTFOLIO_SUPABASE_URL ||
  "https://YOUR-PROJECT.supabase.co";
const SUPABASE_ANON_KEY =
  window.PORTFOLIO_SUPABASE_ANON_KEY ||
  window.VITE_PORTFOLIO_SUPABASE_ANON_KEY ||
  "YOUR-SUPABASE-ANON-KEY";
const SUPABASE_WEATHER_TABLE = "portfolio_weather_current";
const SUPABASE_STICKY_NOTES_TABLE = "portfolio_gallery_notes";
const MAX_STICKY_NOTES = 60;
const STICKY_REFRESH_MS = 12000;
const STICKY_LEGACY_COLORS = new Set(["yellow", "blue", "pink", "mint"]);
const STICKY_LEGACY_COLOR_HEX = {
  yellow: "#fff59f",
  blue: "#81d4fa",
  pink: "#f3a9be",
  mint: "#98edc1",
};
const STICKY_USER_NOTES_KEY = "sticky-wall-user-note-ids";
const STICKY_POSITIONS_KEY = "sticky-wall-note-positions";
const STICKY_BOARD_THEME_KEY = "sticky-wall-board-theme";
const STICKY_NOTE_PATTERNS_KEY = "sticky-wall-note-patterns";
const DEFAULT_STICKY_BOARD_THEME = "grid";
const STICKY_BOARD_THEMES = new Set(["grid", "flowers", "stars", "dots", "cork", "waves"]);
const STICKY_NOTE_PATTERNS = new Set(["plain", "flowers", "stars", "dots", "stripes", "hearts"]);
let weatherTimezone = "";
let timezoneTickTimer = null;

function normalizeSupabaseUrl(url) {
  return url.replace(/\/+$/, "").replace(/\/rest\/v1$/i, "");
}

function supabaseConfigured() {
  return (
    SUPABASE_URL.startsWith("https://") &&
    !SUPABASE_URL.includes("YOUR-PROJECT") &&
    SUPABASE_ANON_KEY !== "YOUR-SUPABASE-ANON-KEY"
  );
}

function selectWeatherElements() {
  return {
    card: document.querySelector("#weather-card"),
    status: document.querySelector("#weather-status"),
    content: document.querySelector("#weather-content"),
    city: document.querySelector("#weather-city"),
    temperature: document.querySelector("#weather-temp"),
    description: document.querySelector("#weather-desc"),
    feelsLike: document.querySelector("#weather-feels"),
    wind: document.querySelector("#weather-wind"),
    updated: document.querySelector("#weather-updated"),
    refresh: document.querySelector("#weather-refresh"),
    timezoneTime: document.querySelector("#timezone-time"),
    timezoneName: document.querySelector("#timezone-name"),
  };
}

function setWeatherStatus(elements, message, isError = false) {
  if (!elements.status) {
    return;
  }
  elements.status.textContent = message;
  elements.status.classList.toggle("is-error", isError);
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
  });
  if (!response.ok) {
    throw new Error(`Request failed (${response.status})`);
  }
  return response.json();
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Prefer: "return=representation",
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`Request failed (${response.status})`);
  }
  return response.json();
}

function getWeatherRecordUrl(includeTimezone = true) {
  const selectColumns = includeTimezone
    ? "city,region,country,temperature_c,feels_like_c,wind_kmh,weather_code,weather_summary,weather_timezone,updated_at"
    : "city,region,country,temperature_c,feels_like_c,wind_kmh,weather_code,weather_summary,updated_at";
  const query = `select=${selectColumns}&order=updated_at.desc&limit=1`;
  const baseUrl = normalizeSupabaseUrl(SUPABASE_URL);
  return `${baseUrl}/rest/v1/${SUPABASE_WEATHER_TABLE}?${query}`;
}

function formatLocation(record) {
  const parts = [record.city, record.region, record.country]
    .map((part) => (part || "").trim())
    .filter(Boolean);
  return parts.length ? parts.join(", ") : "Current city unavailable";
}

function toRoundedDisplay(value) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "--";
  }
  return Math.round(value).toString();
}

function formatClockForTimezone(timezone) {
  if (!timezone) {
    return "--:--";
  }
  try {
    return new Date().toLocaleTimeString([], {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    });
  } catch {
    return "--:--";
  }
}

function formatTimezoneLabel(timezone) {
  if (!timezone) {
    return "Timezone unavailable";
  }
  return timezone.replace(/_/g, " ");
}

function renderTimezone(elements) {
  if (!elements.timezoneTime || !elements.timezoneName) {
    return;
  }
  elements.timezoneTime.textContent = formatClockForTimezone(weatherTimezone);
  elements.timezoneName.textContent = formatTimezoneLabel(weatherTimezone);
}

function startTimezoneTicker(elements) {
  if (!elements.timezoneTime || !elements.timezoneName) {
    return;
  }
  if (timezoneTickTimer) {
    window.clearInterval(timezoneTickTimer);
  }
  renderTimezone(elements);
  timezoneTickTimer = window.setInterval(() => {
    renderTimezone(elements);
  }, 1000);
}

async function loadLocalWeather(elements) {
  if (!elements.card || !elements.status || !elements.content) {
    return;
  }

  if (!supabaseConfigured()) {
    setWeatherStatus(
      elements,
      "Weather is not configured yet. Add your Supabase URL and anon key in script.js.",
      true
    );
    return;
  }

  if (elements.refresh) {
    elements.refresh.disabled = true;
  }
  elements.content.hidden = true;
  setWeatherStatus(elements, "Loading Ivan's latest city weather...");

  try {
    let weatherRows;
    try {
      weatherRows = await fetchJson(getWeatherRecordUrl(true));
    } catch (error) {
      // Backward compatibility: weather_timezone may not exist until SQL migration is applied.
      if (!`${error?.message || ""}`.includes("400")) {
        throw error;
      }
      weatherRows = await fetchJson(getWeatherRecordUrl(false));
    }
    const record = Array.isArray(weatherRows) ? weatherRows[0] : null;
    if (!record) {
      throw new Error("No weather record found in Supabase.");
    }

    const timestamp = record.updated_at ? new Date(record.updated_at) : null;
    const summary =
      (record.weather_summary || "").trim() ||
      weatherLabelFromCode(record.weather_code);

    elements.city.textContent = formatLocation(record);
    elements.temperature.textContent = toRoundedDisplay(record.temperature_c);
    elements.description.textContent = summary;
    elements.feelsLike.textContent = toRoundedDisplay(record.feels_like_c);
    elements.wind.textContent = toRoundedDisplay(record.wind_kmh);
    weatherTimezone = (record.weather_timezone || "").toString().trim();
    renderTimezone(elements);
    elements.updated.textContent =
      timestamp && !Number.isNaN(timestamp.valueOf())
        ? timestamp.toLocaleString([], {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })
        : "Unknown";

    elements.content.hidden = false;
    setWeatherStatus(elements, "");
  } catch {
    setWeatherStatus(
      elements,
      "Could not load weather from Supabase. Verify setup and try refreshing.",
      true
    );
  } finally {
    if (elements.refresh) {
      elements.refresh.disabled = false;
    }
  }
}

function initWeatherWidget() {
  const weatherElements = selectWeatherElements();
  if (!weatherElements.card) {
    return;
  }

  if (weatherElements.refresh) {
    weatherElements.refresh.addEventListener("click", () => {
      loadLocalWeather(weatherElements);
    });
  }

  startTimezoneTicker(weatherElements);
  loadLocalWeather(weatherElements);
}

initWeatherWidget();

function selectStickyElements() {
  return {
    board: document.querySelector("#sticky-board"),
    status: document.querySelector("#sticky-board-status"),
    form: document.querySelector("#sticky-note-form"),
    name: document.querySelector("#sticky-note-name"),
    text: document.querySelector("#sticky-note-text"),
    color: document.querySelector("#sticky-note-color"),
    pattern: document.querySelector("#sticky-note-pattern"),
  };
}

function setStickyStatus(elements, message, isError = false) {
  if (!elements.status) {
    return;
  }
  elements.status.textContent = message;
  elements.status.classList.toggle("is-error", isError);
}

function normalizeStickyColor(color) {
  const candidate = typeof color === "string" ? color.trim() : "";
  if (/^#[0-9a-fA-F]{6}$/.test(candidate)) {
    return candidate.toLowerCase();
  }
  const legacy = candidate.toLowerCase();
  if (STICKY_LEGACY_COLORS.has(legacy)) {
    return STICKY_LEGACY_COLOR_HEX[legacy];
  }
  return STICKY_LEGACY_COLOR_HEX.yellow;
}

function stickyColorForDatabase(color) {
  const hex = normalizeStickyColor(color);
  for (const [name, value] of Object.entries(STICKY_LEGACY_COLOR_HEX)) {
    if (value === hex) {
      return name;
    }
  }

  let closestName = "yellow";
  let closestDistance = Number.POSITIVE_INFINITY;
  const target = hexToRgb(hex);
  for (const [name, value] of Object.entries(STICKY_LEGACY_COLOR_HEX)) {
    const candidate = hexToRgb(value);
    const distance =
      (target.r - candidate.r) ** 2 +
      (target.g - candidate.g) ** 2 +
      (target.b - candidate.b) ** 2;
    if (distance < closestDistance) {
      closestDistance = distance;
      closestName = name;
    }
  }
  return closestName;
}

function hexToRgb(hexColor) {
  const hex = hexColor.replace("#", "");
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  };
}

function normalizeStickyPattern(pattern) {
  const candidate = typeof pattern === "string" ? pattern.toLowerCase().trim() : "";
  return STICKY_NOTE_PATTERNS.has(candidate) ? candidate : "plain";
}

function normalizeBoardTheme(theme) {
  const candidate = typeof theme === "string" ? theme.toLowerCase().trim() : "";
  return STICKY_BOARD_THEMES.has(candidate) ? candidate : DEFAULT_STICKY_BOARD_THEME;
}

function stickyTextColorForBackground(hexColor) {
  const hex = hexColor.replace("#", "");
  const red = parseInt(hex.slice(0, 2), 16);
  const green = parseInt(hex.slice(2, 4), 16);
  const blue = parseInt(hex.slice(4, 6), 16);
  const luminance = (0.299 * red + 0.587 * green + 0.114 * blue) / 255;
  return luminance > 0.62 ? "#2f2500" : "#f5f7fa";
}

function shadeStickyColor(hexColor, amount) {
  const hex = hexColor.replace("#", "");
  const red = parseInt(hex.slice(0, 2), 16);
  const green = parseInt(hex.slice(2, 4), 16);
  const blue = parseInt(hex.slice(4, 6), 16);
  const mix = (channel) =>
    Math.max(0, Math.min(255, Math.round(channel + (255 - channel) * amount)));
  const toHex = (channel) => mix(channel).toString(16).padStart(2, "0");
  return `#${toHex(red)}${toHex(green)}${toHex(blue)}`;
}

function getUserStickyNoteIds() {
  try {
    const stored = JSON.parse(sessionStorage.getItem(STICKY_USER_NOTES_KEY) || "[]");
    return new Set(Array.isArray(stored) ? stored.map(String) : []);
  } catch {
    return new Set();
  }
}

function rememberUserStickyNoteId(noteId) {
  if (noteId === null || noteId === undefined) {
    return;
  }
  const ids = getUserStickyNoteIds();
  ids.add(String(noteId));
  sessionStorage.setItem(STICKY_USER_NOTES_KEY, JSON.stringify([...ids]));
}

function readStickyNotePositions() {
  try {
    const stored = JSON.parse(localStorage.getItem(STICKY_POSITIONS_KEY) || "{}");
    return stored && typeof stored === "object" ? stored : {};
  } catch {
    return {};
  }
}

function saveStickyNotePosition(noteId, left, top) {
  const positions = readStickyNotePositions();
  positions[String(noteId)] = { left, top };
  localStorage.setItem(STICKY_POSITIONS_KEY, JSON.stringify(positions));
}

function readStickyNotePatterns() {
  try {
    const stored = JSON.parse(localStorage.getItem(STICKY_NOTE_PATTERNS_KEY) || "{}");
    return stored && typeof stored === "object" ? stored : {};
  } catch {
    return {};
  }
}

function saveStickyNotePattern(noteId, pattern) {
  const patterns = readStickyNotePatterns();
  patterns[String(noteId)] = normalizeStickyPattern(pattern);
  localStorage.setItem(STICKY_NOTE_PATTERNS_KEY, JSON.stringify(patterns));
}

function resolveStickyPattern(note) {
  if (note?.pattern) {
    return normalizeStickyPattern(note.pattern);
  }
  if (note?.id !== null && note?.id !== undefined) {
    const stored = readStickyNotePatterns()[String(note.id)];
    if (stored) {
      return normalizeStickyPattern(stored);
    }
  }
  return "plain";
}

function applyStickyBoardTheme(elements, theme) {
  const normalized = normalizeBoardTheme(theme);
  if (elements.board) {
    elements.board.dataset.boardTheme = normalized;
  }
  localStorage.setItem(STICKY_BOARD_THEME_KEY, normalized);
}

function initStickyBoardTheme(elements) {
  const saved = localStorage.getItem(STICKY_BOARD_THEME_KEY) || DEFAULT_STICKY_BOARD_THEME;
  applyStickyBoardTheme(elements, saved);
  updateStickyThemeState(elements);
}

function updateStickyThemeState(elements) {
  const activePattern = normalizeStickyPattern(elements.pattern?.value || "plain");
  document.querySelectorAll(".sticky-theme-option[data-note-pattern]").forEach((button) => {
    const isActive = button.dataset.notePattern === activePattern;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-pressed", isActive ? "true" : "false");
  });

  const activeTheme = normalizeBoardTheme(elements.board?.dataset.boardTheme || DEFAULT_STICKY_BOARD_THEME);
  document.querySelectorAll(".sticky-theme-option[data-board-theme]").forEach((button) => {
    const isActive = button.dataset.boardTheme === activeTheme;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-pressed", isActive ? "true" : "false");
  });
}

function updateStickySwatchState(elements) {
  const noteColor = elements.color?.value?.toLowerCase();
  document.querySelectorAll(".sticky-swatch[data-color]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.color?.toLowerCase() === noteColor);
  });
}

function initStickyCustomizationControls(elements) {
  if (elements.color) {
    elements.color.addEventListener("input", () => {
      updateStickySwatchState(elements);
    });
  }

  document.querySelectorAll(".sticky-swatch[data-color]").forEach((button) => {
    button.addEventListener("click", () => {
      if (!elements.color || !button.dataset.color) {
        return;
      }
      elements.color.value = button.dataset.color;
      updateStickySwatchState(elements);
    });
  });

  document.querySelectorAll(".sticky-theme-option[data-note-pattern]").forEach((button) => {
    button.addEventListener("click", () => {
      if (!elements.pattern || !button.dataset.notePattern) {
        return;
      }
      elements.pattern.value = normalizeStickyPattern(button.dataset.notePattern);
      updateStickyThemeState(elements);
    });
  });

  document.querySelectorAll(".sticky-theme-option[data-board-theme]").forEach((button) => {
    button.addEventListener("click", () => {
      if (!button.dataset.boardTheme) {
        return;
      }
      applyStickyBoardTheme(elements, button.dataset.boardTheme);
      updateStickyThemeState(elements);
    });
  });

  updateStickySwatchState(elements);
  updateStickyThemeState(elements);
}

function formatStickyTimestamp(rawValue) {
  const timestamp = rawValue ? new Date(rawValue) : null;
  if (!timestamp || Number.isNaN(timestamp.valueOf())) {
    return "just now";
  }
  return timestamp.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function normalizeAuthor(name) {
  const text = (name || "").toString().trim();
  if (!text) {
    return "Anonymous";
  }
  return text.slice(0, 32);
}

function getStickyNotesSelectUrl(includePattern = false) {
  const columns = includePattern
    ? "id,author,content,color,pattern,created_at"
    : "id,author,content,color,created_at";
  const query = `select=${columns}&order=created_at.desc&limit=${MAX_STICKY_NOTES}`;
  const baseUrl = normalizeSupabaseUrl(SUPABASE_URL);
  return `${baseUrl}/rest/v1/${SUPABASE_STICKY_NOTES_TABLE}?${query}`;
}

function getStickyNotesInsertUrl() {
  const baseUrl = normalizeSupabaseUrl(SUPABASE_URL);
  return `${baseUrl}/rest/v1/${SUPABASE_STICKY_NOTES_TABLE}`;
}

function createStickyNoteElement(note, elements) {
  const article = document.createElement("article");
  article.className = "sticky-note";
  const noteColor = normalizeStickyColor(note.color);
  const notePattern = resolveStickyPattern(note);
  article.dataset.notePattern = notePattern;
  article.style.background = `linear-gradient(145deg, ${noteColor}, ${shadeStickyColor(noteColor, -0.12)})`;
  article.style.color = stickyTextColorForBackground(noteColor);
  article.style.setProperty("--note-rotation", `${(Math.random() * 6 - 3).toFixed(2)}deg`);

  if (note.id !== null && note.id !== undefined) {
    article.dataset.noteId = String(note.id);
  }

  const content = document.createElement("p");
  content.className = "sticky-note-content";
  content.textContent = (note.content || "").toString();
  article.appendChild(content);

  const footer = document.createElement("p");
  footer.className = "sticky-note-footer";
  footer.textContent = `${normalizeAuthor(note.author)} \u00b7 ${formatStickyTimestamp(note.created_at)}`;
  article.appendChild(footer);

  const noteId = note.id;
  const userNoteIds = getUserStickyNoteIds();
  if (noteId !== null && noteId !== undefined && userNoteIds.has(String(noteId))) {
    enableStickyNoteDrag(article, elements.board, noteId);
    const positions = readStickyNotePositions();
    const saved = positions[String(noteId)];
    if (saved && typeof saved.left === "number" && typeof saved.top === "number") {
      article.classList.add("is-positioned");
      article.style.left = `${saved.left}px`;
      article.style.top = `${saved.top}px`;
    }
  }

  return article;
}

function enableStickyNoteDrag(noteEl, board, noteId) {
  if (!board || !noteEl) {
    return;
  }

  noteEl.classList.add("is-draggable");
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let originLeft = 0;
  let originTop = 0;

  noteEl.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) {
      return;
    }

    dragging = true;
    noteEl.setPointerCapture(event.pointerId);
    noteEl.classList.add("is-dragging");

    const boardRect = board.getBoundingClientRect();
    const noteRect = noteEl.getBoundingClientRect();

    if (!noteEl.classList.contains("is-positioned")) {
      noteEl.classList.add("is-positioned");
      noteEl.style.left = `${noteRect.left - boardRect.left + board.scrollLeft}px`;
      noteEl.style.top = `${noteRect.top - boardRect.top + board.scrollTop}px`;
    }

    startX = event.clientX;
    startY = event.clientY;
    originLeft = parseFloat(noteEl.style.left) || 0;
    originTop = parseFloat(noteEl.style.top) || 0;
    event.preventDefault();
  });

  noteEl.addEventListener("pointermove", (event) => {
    if (!dragging) {
      return;
    }

    const deltaX = event.clientX - startX;
    const deltaY = event.clientY - startY;
    const maxLeft = Math.max(0, board.clientWidth - noteEl.offsetWidth);
    const maxTop = Math.max(0, board.scrollHeight - noteEl.offsetHeight);
    const nextLeft = Math.min(maxLeft, Math.max(0, originLeft + deltaX));
    const nextTop = Math.min(maxTop, Math.max(0, originTop + deltaY));
    noteEl.style.left = `${nextLeft}px`;
    noteEl.style.top = `${nextTop}px`;
  });

  const finishDrag = (event) => {
    if (!dragging) {
      return;
    }

    dragging = false;
    if (event?.pointerId !== undefined && noteEl.hasPointerCapture(event.pointerId)) {
      noteEl.releasePointerCapture(event.pointerId);
    }
    noteEl.classList.remove("is-dragging");
    saveStickyNotePosition(noteId, parseFloat(noteEl.style.left) || 0, parseFloat(noteEl.style.top) || 0);
  };

  noteEl.addEventListener("pointerup", finishDrag);
  noteEl.addEventListener("pointercancel", finishDrag);
}

function renderStickyNotes(elements, notes) {
  if (!elements.board) {
    return;
  }
  elements.board.replaceChildren();
  if (!notes.length) {
    const empty = document.createElement("p");
    empty.className = "sticky-empty";
    empty.textContent = "No notes yet. Be the first visitor to leave one.";
    elements.board.appendChild(empty);
    return;
  }

  notes.forEach((note) => {
    elements.board.appendChild(createStickyNoteElement(note, elements));
  });
}

async function loadStickyNotes(elements, silent = false) {
  if (!elements.board || !elements.status) {
    return;
  }

  if (!supabaseConfigured()) {
    renderStickyNotes(elements, []);
    setStickyStatus(
      elements,
      "Sticky wall is not configured yet. Add your Supabase URL and anon key in script.js.",
      true
    );
    return;
  }

  if (!silent) {
    setStickyStatus(elements, "Loading notes...");
  }

  try {
    let rows;
    try {
      rows = await fetchJson(getStickyNotesSelectUrl(true));
    } catch {
      rows = await fetchJson(getStickyNotesSelectUrl(false));
    }
    const notes = Array.isArray(rows)
      ? rows
          .filter((row) => typeof row.content === "string" && row.content.trim())
          .map((row) => ({
            id: row.id,
            author: normalizeAuthor(row.author),
            content: row.content.toString().trim().slice(0, 220),
            color: normalizeStickyColor(row.color),
            pattern: row.pattern ? normalizeStickyPattern(row.pattern) : resolveStickyPattern({ id: row.id }),
            created_at: row.created_at,
          }))
      : [];
    renderStickyNotes(elements, notes);
    setStickyStatus(elements, `${notes.length} note${notes.length === 1 ? "" : "s"} on the wall.`);
  } catch {
    if (!silent) {
      setStickyStatus(elements, "Could not load notes right now. Please try again.", true);
    }
  }
}

async function submitStickyNote(event, elements) {
  event.preventDefault();
  if (!elements.form || !elements.text || !elements.name || !elements.color) {
    return;
  }

  const author = normalizeAuthor(elements.name.value);
  const content = elements.text.value.toString().trim();
  const color = stickyColorForDatabase(elements.color.value);
  const pattern = normalizeStickyPattern(elements.pattern?.value || "plain");

  if (!content) {
    setStickyStatus(elements, "Write a short message before posting.", true);
    elements.text.focus();
    return;
  }

  if (content.length > 220) {
    setStickyStatus(elements, "Notes must be 220 characters or fewer.", true);
    elements.text.focus();
    return;
  }

  const submitButton = elements.form.querySelector('button[type="submit"]');
  if (submitButton) {
    submitButton.disabled = true;
  }
  setStickyStatus(elements, "Posting your note...");

  try {
    let rows;
    try {
      rows = await postJson(getStickyNotesInsertUrl(), [{ author, content, color, pattern }]);
    } catch {
      rows = await postJson(getStickyNotesInsertUrl(), [{ author, content, color }]);
    }
    const created = Array.isArray(rows) ? rows[0] : null;
    if (created?.id !== null && created?.id !== undefined) {
      rememberUserStickyNoteId(created.id);
      saveStickyNotePattern(created.id, pattern);
    }
    elements.form.reset();
    if (elements.color) {
      elements.color.value = STICKY_LEGACY_COLOR_HEX.yellow;
    }
    if (elements.pattern) {
      elements.pattern.value = "plain";
    }
    updateStickySwatchState(elements);
    updateStickyThemeState(elements);
    setStickyStatus(elements, "Note posted! Refreshing wall...");
    await loadStickyNotes(elements, true);
    setStickyStatus(elements, "Your note is now live. Drag it anywhere on the wall.");
  } catch {
    setStickyStatus(
      elements,
      "Could not post note. Please try again in a moment.",
      true
    );
  } finally {
    if (submitButton) {
      submitButton.disabled = false;
    }
  }
}

function initStickyWall() {
  const elements = selectStickyElements();
  if (!elements.board || !elements.form) {
    return;
  }

  elements.form.addEventListener("submit", (event) => {
    submitStickyNote(event, elements);
  });

  initStickyBoardTheme(elements);
  initStickyCustomizationControls(elements);
  loadStickyNotes(elements);
  window.setInterval(() => {
    loadStickyNotes(elements, true);
  }, STICKY_REFRESH_MS);
}

initStickyWall();

const contactForm = document.querySelector("#contact-form");

if (contactForm) {
  contactForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const formData = new FormData(contactForm);
    const name = formData.get("name")?.toString().trim() || "Portfolio Visitor";
    const email = formData.get("email")?.toString().trim() || "";
    const message = formData.get("message")?.toString().trim() || "";

    const subject = encodeURIComponent(`Portfolio Message from ${name}`);
    const body = encodeURIComponent(
      `Name: ${name}\nEmail: ${email}\n\nMessage:\n${message}`
    );
    window.location.href = `mailto:i2luo@uwaterloo.ca?subject=${subject}&body=${body}`;
  });
}

if (pageKey === "home") {
  initDailyQuoteGate();
}
