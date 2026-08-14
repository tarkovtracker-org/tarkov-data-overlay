const overlayStatusEl = document.getElementById("overlay-status");
const apiStatusEl = document.getElementById("api-status");
const overlayBuildEl = document.getElementById("overlay-build");
const overlayAgeEl = document.getElementById("overlay-age");
const emptyEl = document.getElementById("empty");
const sectionsEl = document.getElementById("sections");
const titleEl = document.getElementById("page-title");
const ledeEl = document.getElementById("page-lede");
const navEl = document.getElementById("nav");
const summaryEl = document.getElementById("summary");
const modeSwitchEl = document.getElementById("mode-switch");
const localeWrapEl = document.getElementById("locale-wrap");
const localeSelectEl = document.getElementById("locale-select");
const refreshBtnEl = document.getElementById("refresh-btn");
const searchEl = document.getElementById("search");
const errorBannerEl = document.getElementById("error-banner");

let pollTimer = null;
let eventSource = null;
let latestFetchController = null;
let ageTimer = null;
let sseRetryMs = 1000;
let lastState = null;
let filterText = "";
let renderedSections = [];

const viewMeta = window.viewMeta;
if (
  !viewMeta ||
  !Array.isArray(viewMeta.DEFAULT_MODES) ||
  !viewMeta.MODE_LABELS ||
  !viewMeta.VIEW_CONFIG?.tasks ||
  typeof viewMeta.buildViewParams !== "function"
) {
  const message = "Monitor configuration failed to load. Refresh the page to try again.";
  if (errorBannerEl) {
    errorBannerEl.textContent = message;
    errorBannerEl.style.display = "block";
  }
  throw new Error(message);
}

const fallbackModes = viewMeta.DEFAULT_MODES;
const fallbackModeLabels = viewMeta.MODE_LABELS;
const viewConfig = viewMeta.VIEW_CONFIG;
const buildViewParams = viewMeta.buildViewParams;

const viewRoutes = {
  tasks: "tasks",
  "tasks-additions": "tasksAdd",
  items: "items",
  hideout: "hideout",
  traders: "traders",
  editions: "editions",
  "story-chapters": "storyChapters",
  "items-additions": "itemsAdd",
  prestige: "prestige",
  locales: "locales",
  "seasonal-perks": "seasonalPerks",
  crafts: "craftsAdd",
};

function getViewFromPath() {
  const [segment] = window.location.pathname.split("/").filter(Boolean);
  if (!segment) {
    return "tasks";
  }
  return viewRoutes[segment] || "tasks";
}

function getModeFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const mode = params.get("mode");
  const modes = lastState?.modes || fallbackModes;
  return modes.includes(mode) ? mode : "regular";
}

function getLocaleFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const locale = params.get("locale");
  return locale ? locale : "en";
}

let currentView = getViewFromPath();
let currentMode = getModeFromUrl();
let currentLocale = getLocaleFromUrl();

function updateNav() {
  if (!navEl) {
    return;
  }
  navEl.querySelectorAll("a").forEach((link) => {
    if (link.dataset.view === currentView) {
      link.classList.add("active");
    } else {
      link.classList.remove("active");
    }
  });
}

function updateModeSwitch() {
  const config = viewConfig[currentView];
  if (!modeSwitchEl) {
    return;
  }
  if (!config?.requiresMode) {
    modeSwitchEl.style.display = "none";
    return;
  }
  modeSwitchEl.style.display = "flex";

  const modes = lastState?.modes || fallbackModes;
  const labels = lastState?.modeLabels || fallbackModeLabels;

  modeSwitchEl.querySelectorAll("button[data-mode]").forEach((button) => {
    const isActive = button.dataset.mode === currentMode;
    button.setAttribute("aria-pressed", isActive ? "true" : "false");
    if (isActive) {
      button.classList.add("active");
    } else {
      button.classList.remove("active");
    }
  });

  // Keep buttons in sync with the modes the server discovered.
  modes.forEach((mode) => {
    if (modeSwitchEl.querySelector(`button[data-mode="${mode}"]`)) {
      return;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.mode = mode;
    button.textContent = labels[mode] || mode;
    button.setAttribute(
      "aria-pressed",
      mode === currentMode ? "true" : "false",
    );
    if (mode === currentMode) {
      button.classList.add("active");
    }
    button.addEventListener("click", () => {
      if (mode === currentMode) {
        return;
      }
      currentMode = mode;
      updateModeSwitch();
      updateUrl();
      fetchLatest();
      connectEvents();
    });
    modeSwitchEl.appendChild(button);
  });

  modeSwitchEl.querySelectorAll("button[data-mode]").forEach((button) => {
    if (!modes.includes(button.dataset.mode)) {
      button.remove();
    }
  });
}

function updateLocaleSelector() {
  const config = viewConfig[currentView];
  if (!localeWrapEl || !localeSelectEl) {
    return;
  }
  if (!config?.requiresLocale) {
    localeWrapEl.style.display = "none";
    return;
  }
  localeWrapEl.style.display = "flex";

  const available = lastState?.locales || [];
  const options = available.length > 0 ? available : ["en"];
  if (!options.includes(currentLocale)) {
    currentLocale = options[0];
  }

  const currentValue = localeSelectEl.value;
  if (currentValue !== currentLocale) {
    localeSelectEl.innerHTML = "";
    options.forEach((locale) => {
      const option = document.createElement("option");
      option.value = locale;
      option.textContent = locale;
      localeSelectEl.appendChild(option);
    });
    localeSelectEl.value = currentLocale;
  }
}

function updateTitle() {
  const config = viewConfig[currentView];
  if (titleEl) {
    titleEl.textContent = config?.title || "Overlay";
  }
  if (ledeEl) {
    ledeEl.textContent = config?.lede || "";
  }
}

function rowMatchesFilter(rowValues) {
  if (!filterText) {
    return true;
  }
  const needle = filterText.toLowerCase();
  return rowValues.some((value) =>
    String(value ?? "").toLowerCase().includes(needle),
  );
}

function renderSections(sections) {
  if (!sectionsEl || !emptyEl) {
    return;
  }

  renderedSections = sections || [];
  sectionsEl.innerHTML = "";
  let hasRows = false;

  renderedSections.forEach((section) => {
    if (!section.rows || section.rows.length === 0) {
      return;
    }
    const visibleRows = section.rows.filter((row) =>
      rowMatchesFilter(row),
    );
    if (visibleRows.length === 0) {
      return;
    }
    hasRows = true;
    const wrapper = document.createElement("div");
    wrapper.className = "section";

    const title = document.createElement("h2");
    title.textContent = section.title;
    const count = document.createElement("span");
    count.className = "section-count";
    count.textContent = `${visibleRows.length}${
      visibleRows.length !== section.rows.length
        ? ` / ${section.rows.length}`
        : ""
    }`;
    title.appendChild(count);
    wrapper.appendChild(title);

    if (section.truncated) {
      const note = document.createElement("div");
      note.className = "note";
      note.textContent = "Display is truncated. Increase MAX_ROWS if needed.";
      wrapper.appendChild(note);
    }

    const table = document.createElement("table");
    table.className = "table";
    const thead = document.createElement("thead");
    const headRow = document.createElement("tr");
    section.columns.forEach((column) => {
      const th = document.createElement("th");
      th.textContent = column;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    visibleRows.forEach((rowValues) => {
      const row = document.createElement("tr");
      rowValues.forEach((value, index) => {
        const td = document.createElement("td");
        const textValue = value ?? "";
        if (section.statusColumnIndex === index) {
          const badge = document.createElement("span");
          badge.className = `badge ${String(textValue).toLowerCase()}`;
          badge.textContent = textValue;
          td.appendChild(badge);
        } else {
          const displayText = String(textValue);
          if (
            displayText.length > 60 ||
            displayText.startsWith("{") ||
            displayText.startsWith("[")
          ) {
            const span = document.createElement("span");
            span.className = "value";
            span.textContent = displayText;
            td.appendChild(span);
          } else {
            td.textContent = displayText;
          }
        }
        row.appendChild(td);
      });
      tbody.appendChild(row);
    });
    table.appendChild(tbody);
    wrapper.appendChild(table);
    sectionsEl.appendChild(wrapper);
  });

  emptyEl.style.display = hasRows ? "none" : "block";
  emptyEl.textContent = filterText
    ? "No rows match the current filter."
    : "No data to display.";
}

function countBadges(sections, statuses) {
  let total = 0;
  (sections || []).forEach((section) => {
    if (section.statusColumnIndex === undefined) {
      return;
    }
    section.rows.forEach((row) => {
      const badgeValue = row[section.statusColumnIndex];
      if (statuses.includes(String(badgeValue).toLowerCase())) {
        total += 1;
      }
    });
  });
  return total;
}

function renderSummary(sections) {
  if (!summaryEl) {
    return;
  }
  const totalRows = (sections || []).reduce(
    (acc, section) => acc + (section.rows ? section.rows.length : 0),
    0,
  );
  const sectionCount = (sections || []).filter(
    (section) => section.rows && section.rows.length > 0,
  ).length;
  summaryEl.innerHTML = "";

  const overrides = countBadges(sections, ["override", "changed", "missing"]);
  const cards = [
    { label: "Sections", value: sectionCount },
    { label: "Rows", value: totalRows },
  ];
  if (overrides > 0) {
    cards.push({ label: "Corrections", value: overrides });
  }
  cards.forEach((card) => {
    const el = document.createElement("div");
    el.className = "summary-card";
    const label = document.createElement("div");
    label.className = "summary-label";
    label.textContent = card.label;
    const value = document.createElement("div");
    value.className = "summary-value";
    value.textContent = String(card.value);
    el.appendChild(label);
    el.appendChild(value);
    summaryEl.appendChild(el);
  });
}

function timeAgo(iso) {
  if (!iso) {
    return "n/a";
  }
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) {
    return "n/a";
  }
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} d ago`;
}

function startAgeTicker() {
  if (ageTimer) {
    return;
  }
  const tick = () => {
    if (lastState?.overlay?.updatedAt && overlayAgeEl) {
      overlayAgeEl.textContent = timeAgo(lastState.overlay.updatedAt);
    }
  };
  tick();
  ageTimer = window.setInterval(tick, 30000);
}

let rebuilding = false;

async function requestRebuild() {
  if (rebuilding) {
    return;
  }
  rebuilding = true;
  const button = document.getElementById("update-overlay-btn");
  const setButtonLabel = (label) => {
    if (button) {
      button.textContent = label;
    }
  };
  setButtonLabel("Building…");
  if (button) {
    button.disabled = true;
  }
  try {
    const response = await fetch("/rebuild", { method: "POST" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || `Rebuild failed (${response.status})`);
    }
    // Poll until the freshly built overlay is picked up (or timeout).
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await fetchLatest();
      if (lastState?.overlay && !lastState.overlay.stale) {
        break;
      }
    }
    if (lastState?.overlay?.stale) {
      throw new Error("Rebuild finished but the overlay is still stale");
    }
  } catch (error) {
    const bannerState = {
      ...(lastState || {}),
      error: `Rebuild: ${error.message}`,
    };
    updateErrorBanner(bannerState);
  } finally {
    rebuilding = false;
    setButtonLabel("Update overlay");
    if (button) {
      button.disabled = false;
    }
  }
}

function updateErrorBanner(state) {
  if (!errorBannerEl) {
    return;
  }
  const messages = [];
  if (state?.overlay?.error) {
    messages.push(`Overlay: ${state.overlay.error}`);
  }
  if (state?.api?.error) {
    messages.push(`API (${state.mode || "all"}): ${state.api.error}`);
  }
  if (state?.overlay?.stale) {
    messages.push(
      `Overlay build outdated: v${state.overlay.version || "?"} loaded, v${state.overlay.latestVersion} released`,
    );
  }
  if (state?.error && !messages.includes(state.error)) {
    messages.push(state.error);
  }

  errorBannerEl.innerHTML = "";
  if (messages.length === 0) {
    errorBannerEl.style.display = "none";
    return;
  }
  const span = document.createElement("span");
  span.textContent = messages.join(" · ");
  errorBannerEl.appendChild(span);

  if (state?.overlay?.stale && state?.rebuild?.enabled && !rebuilding) {
    const button = document.createElement("button");
    button.type = "button";
    button.id = "update-overlay-btn";
    button.className = "update-btn";
    button.textContent = "Update overlay";
    button.addEventListener("click", requestRebuild);
    errorBannerEl.appendChild(button);
  }
  errorBannerEl.style.display = "block";
}

function updateStatus(state) {
  if (!state) {
    return;
  }

  lastState = state;

  if (titleEl) {
    titleEl.textContent = state.title || "Overlay";
  }
  if (ledeEl) {
    ledeEl.textContent = state.lede || "";
  }

  if (overlayStatusEl) {
    overlayStatusEl.textContent = state.overlay?.error
      ? "Overlay error"
      : "Overlay synced";
    overlayStatusEl.className = `status ${
      state.overlay?.error ? "is-error" : "is-ok"
    }`;
  }
  if (apiStatusEl) {
    if (!state.api) {
      apiStatusEl.textContent = "API not required";
      apiStatusEl.className = "status is-muted";
    } else if (state.api.error) {
      apiStatusEl.textContent = "API error";
      apiStatusEl.className = "status is-error";
    } else {
      apiStatusEl.textContent = "API synced";
      apiStatusEl.className = "status is-ok";
    }
  }

  if (overlayBuildEl) {
    const meta = state.overlay?.meta;
    const generated = meta?.generated
      ? new Date(meta.generated).toLocaleString()
      : "n/a";
    const version = meta?.version ? `v${meta.version}` : "";
    const parts = [version, generated].filter(Boolean);
    overlayBuildEl.textContent = parts.join(" · ") || "n/a";
    overlayBuildEl.className = `updated ${
      state.overlay?.stale ? "is-stale" : ""
    }`;
    overlayBuildEl.title = state.overlay?.stale
      ? `Latest release is v${state.overlay.latestVersion}`
      : "";
  }

  if (overlayAgeEl) {
    overlayAgeEl.textContent = timeAgo(state.overlay?.updatedAt);
  }

  updateModeSwitch();
  updateLocaleSelector();
  updateErrorBanner(state);
  renderSummary(state.sections);
  renderSections(state.sections);
}

function updateUrl() {
  const config = viewConfig[currentView];
  const url = new URL(window.location.href);
  if (config?.requiresMode) {
    url.searchParams.set("mode", currentMode);
  } else {
    url.searchParams.delete("mode");
  }
  if (config?.requiresLocale) {
    url.searchParams.set("locale", currentLocale);
  } else {
    url.searchParams.delete("locale");
  }
  window.history.replaceState({}, "", url);
}

async function fetchLatest() {
  if (latestFetchController) {
    latestFetchController.abort();
  }
  latestFetchController = new AbortController();
  try {
    const params = buildViewParams(currentView, currentMode, currentLocale);
    const response = await fetch(`/latest?${params}`, {
      cache: "no-store",
      signal: latestFetchController.signal,
    });
    if (!response.ok) {
      throw new Error("latest_fetch_failed");
    }
    const data = await response.json();
    updateStatus(data);
  } catch (error) {
    if (error && error.name === "AbortError") {
      return;
    }
    if (overlayStatusEl) {
      overlayStatusEl.textContent = "Load error";
    }
  } finally {
    latestFetchController = null;
  }
}

function startPolling() {
  if (pollTimer) {
    return;
  }
  pollTimer = window.setInterval(fetchLatest, 5000);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function connectEvents() {
  if (!window.EventSource) {
    return false;
  }

  if (eventSource) {
    eventSource.close();
  }
  stopPolling();

  const params = buildViewParams(currentView, currentMode, currentLocale);
  eventSource = new EventSource(`/events?${params}`);
  eventSource.addEventListener("summary", (event) => {
    sseRetryMs = 1000;
    updateStatus(JSON.parse(event.data));
  });
  eventSource.onerror = () => {
    if (overlayStatusEl) {
      overlayStatusEl.textContent = "Connection lost";
    }
    eventSource.close();
    eventSource = null;
    // Keep polling while SSE is down; retry the stream with backoff.
    startPolling();
    fetchLatest();
    const delay = sseRetryMs;
    sseRetryMs = Math.min(sseRetryMs * 2, 30000);
    window.setTimeout(() => {
      if (!eventSource) {
        connectEvents();
      }
    }, delay);
  };
  return true;
}

function initModeSwitch() {
  if (!modeSwitchEl) {
    return;
  }
  modeSwitchEl.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => {
      const mode = button.dataset.mode;
      if (!mode || mode === currentMode) {
        return;
      }
      currentMode = mode;
      updateModeSwitch();
      updateUrl();
      fetchLatest();
      connectEvents();
    });
  });
}

function initLocaleSelector() {
  if (!localeSelectEl) {
    return;
  }
  localeSelectEl.addEventListener("change", () => {
    const locale = localeSelectEl.value;
    if (!locale || locale === currentLocale) {
      return;
    }
    currentLocale = locale;
    updateUrl();
    fetchLatest();
    connectEvents();
  });
}

function initSearch() {
  if (!searchEl) {
    return;
  }
  searchEl.addEventListener("input", () => {
    filterText = searchEl.value.trim();
    renderSections(renderedSections);
  });
}

function initRefreshButton() {
  if (!refreshBtnEl) {
    return;
  }
  refreshBtnEl.addEventListener("click", () => {
    if (refreshBtnEl.disabled) {
      return;
    }
    const originalLabel = refreshBtnEl.textContent;
    refreshBtnEl.disabled = true;
    refreshBtnEl.textContent = "Refreshing…";
    fetchLatest().finally(() => {
      window.setTimeout(() => {
        refreshBtnEl.disabled = false;
        refreshBtnEl.textContent = originalLabel;
      }, 400);
    });
  });
}

function setView(nextView) {
  if (!nextView || nextView === currentView) {
    return;
  }
  currentView = nextView;
  updateNav();
  updateModeSwitch();
  updateLocaleSelector();
  updateTitle();
  updateUrl();
  fetchLatest();
  connectEvents();
}

function initNavRouting() {
  if (!navEl) {
    return;
  }
  navEl.addEventListener("click", (event) => {
    const target = event.target.closest("a[data-view]");
    if (!target) {
      return;
    }
    event.preventDefault();
    const nextView = target.dataset.view;
    if (!nextView) {
      return;
    }
    const href = target.getAttribute("href") || "/";
    window.history.pushState({ view: nextView }, "", href);
    setView(nextView);
  });

  window.addEventListener("popstate", () => {
    currentView = getViewFromPath();
    currentMode = getModeFromUrl();
    currentLocale = getLocaleFromUrl();
    updateNav();
    updateModeSwitch();
    updateLocaleSelector();
    updateTitle();
    updateUrl();
    fetchLatest();
    connectEvents();
  });
}

function init() {
  updateNav();
  updateModeSwitch();
  updateLocaleSelector();
  updateTitle();
  initModeSwitch();
  initLocaleSelector();
  initSearch();
  initRefreshButton();
  initNavRouting();
  updateUrl();
  startAgeTicker();
  fetchLatest();
  if (!connectEvents()) {
    startPolling();
  }
}

init();
