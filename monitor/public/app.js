const overlayStatusEl = document.getElementById("overlay-status");
const apiStatusEl = document.getElementById("api-status");
const overlayBuildEl = document.getElementById("overlay-build");
const emptyEl = document.getElementById("empty");
const sectionsEl = document.getElementById("sections");
const titleEl = document.getElementById("page-title");
const ledeEl = document.getElementById("page-lede");
const navEl = document.getElementById("nav");
const summaryEl = document.getElementById("summary");
const modeSwitchEl = document.getElementById("mode-switch");

let pollTimer = null;
let eventSource = null;
let latestFetchController = null;

const viewConfig = {
  tasks: {
    title: "Task Overrides",
    lede: "Corrections from the overlay compared to tarkov.dev.",
    requiresMode: true,
  },
  tasksAdd: {
    title: "Task Additions",
    lede: "Tasks added by the overlay that are missing from tarkov.dev.",
    requiresMode: true,
  },
  items: {
    title: "Item Overrides",
    lede: "Item corrections included in the overlay build.",
    requiresMode: false,
  },
  hideout: {
    title: "Hideout Overrides",
    lede: "Hideout corrections included in the overlay build.",
    requiresMode: false,
  },
  traders: {
    title: "Trader Overrides",
    lede: "Trader corrections included in the overlay build.",
    requiresMode: false,
  },
  editions: {
    title: "Editions",
    lede: "Game editions defined by the overlay.",
    requiresMode: false,
  },
  storyChapters: {
    title: "Story Chapters",
    lede: "Storyline chapter additions in the overlay.",
    requiresMode: false,
  },
  itemsAdd: {
    title: "Item Additions",
    lede: "Items added by the overlay.",
    requiresMode: false,
  },
};

const viewRoutes = {
  tasks: "tasks",
  "tasks-additions": "tasksAdd",
  items: "items",
  hideout: "hideout",
  traders: "traders",
  editions: "editions",
  "story-chapters": "storyChapters",
  "items-additions": "itemsAdd",
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
  return mode === "pve" ? "pve" : "regular";
}

let currentView = getViewFromPath();
let currentMode = getModeFromUrl();

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
  modeSwitchEl.querySelectorAll("button").forEach((button) => {
    const isActive = button.dataset.mode === currentMode;
    button.setAttribute("aria-pressed", isActive ? "true" : "false");
    if (isActive) {
      button.classList.add("active");
    } else {
      button.classList.remove("active");
    }
  });
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

function renderSections(sections) {
  if (!sectionsEl || !emptyEl) {
    return;
  }

  sectionsEl.innerHTML = "";
  let hasRows = false;

  (sections || []).forEach((section) => {
    if (!section.rows || section.rows.length === 0) {
      return;
    }
    hasRows = true;
    const wrapper = document.createElement("div");
    wrapper.className = "section";

    const title = document.createElement("h2");
    title.textContent = section.title;
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
    section.rows.forEach((rowValues) => {
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
}

function renderSummary(sections) {
  if (!summaryEl) {
    return;
  }
  const totalRows = (sections || []).reduce(
    (acc, section) => acc + (section.rows ? section.rows.length : 0),
    0,
  );
  summaryEl.innerHTML = "";

  const cards = [
    { label: "Sections", value: (sections || []).length },
    { label: "Rows", value: totalRows },
  ];
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

function updateStatus(state) {
  if (!state) {
    return;
  }

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
  }
  if (apiStatusEl) {
    if (!state.api) {
      apiStatusEl.textContent = "API not required";
    } else if (state.api.error) {
      apiStatusEl.textContent = "API error";
    } else {
      apiStatusEl.textContent = "API synced";
    }
  }

  if (overlayBuildEl) {
    const meta = state.overlay?.meta;
    const generated = meta?.generated
      ? new Date(meta.generated).toLocaleString()
      : "n/a";
    const version = meta?.version ? `v${meta.version}` : "";
    overlayBuildEl.textContent = [version, generated].filter(Boolean).join(" · ") || "n/a";
  }

  renderSummary(state.sections);
  renderSections(state.sections);
}

function updateUrlMode() {
  const config = viewConfig[currentView];
  const url = new URL(window.location.href);
  if (config?.requiresMode) {
    url.searchParams.set("mode", currentMode);
  } else {
    url.searchParams.delete("mode");
  }
  window.history.replaceState({}, "", url);
}

async function fetchLatest() {
  if (latestFetchController) {
    latestFetchController.abort();
  }
  latestFetchController = new AbortController();
  try {
    const response = await fetch(
      `/latest?view=${currentView}&mode=${currentMode}`,
      { cache: "no-store", signal: latestFetchController.signal },
    );
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

function connectEvents() {
  if (!window.EventSource) {
    return false;
  }

  if (eventSource) {
    eventSource.close();
  }
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }

  eventSource = new EventSource(
    `/events?view=${currentView}&mode=${currentMode}`,
  );
  eventSource.addEventListener("summary", (event) => {
    updateStatus(JSON.parse(event.data));
  });
  eventSource.onerror = () => {
    if (overlayStatusEl) {
      overlayStatusEl.textContent = "Connection lost";
    }
    eventSource.close();
    startPolling();
    fetchLatest();
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
      updateUrlMode();
      fetchLatest();
      connectEvents();
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
  updateTitle();
  updateUrlMode();
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
    const nextView = getViewFromPath();
    currentMode = getModeFromUrl();
    currentView = nextView;
    updateNav();
    updateModeSwitch();
    updateTitle();
    updateUrlMode();
    fetchLatest();
    connectEvents();
  });
}

function init() {
  updateNav();
  updateModeSwitch();
  updateTitle();
  initModeSwitch();
  initNavRouting();
  updateUrlMode();
  fetchLatest();
  if (!connectEvents()) {
    startPolling();
  }
}

init();
