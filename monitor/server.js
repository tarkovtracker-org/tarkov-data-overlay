const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = Number(process.env.PORT) || 3476;
const PUBLIC_DIR = path.resolve(__dirname, "public");
const MAX_ROWS = Number(process.env.MAX_ROWS) || 250;

const OVERLAY_PATH =
  process.env.TARGET_OVERLAY ||
  path.resolve(__dirname, "../dist/overlay.json");
const API_POLL_MS = Number(process.env.API_POLL_MS) || 120000;
const OVERLAY_POLL_MS = Number(process.env.OVERLAY_POLL_MS) || 30000;

const REMOTE_FETCH_TIMEOUT_MS =
  Number(process.env.REMOTE_FETCH_TIMEOUT_MS) || 10000;
const REMOTE_FETCH_MAX_BYTES =
  Number(process.env.REMOTE_FETCH_MAX_BYTES) || 5 * 1024 * 1024;

const TARKOV_API = "https://api.tarkov.dev/graphql";

const VIEW_CONFIG = {
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

const DEFAULT_VIEW = "tasks";
const DEFAULT_MODE = "regular";

const overlayState = { data: null, updatedAt: null, error: null };
const apiState = {
  regular: { data: null, updatedAt: null, error: null },
  pve: { data: null, updatedAt: null, error: null },
};

const summaryByKey = new Map();
const readLocks = {
  overlay: { isReading: false, pendingRead: false },
  apiRegular: { isReading: false, pendingRead: false },
  apiPve: { isReading: false, pendingRead: false },
};

const clientsByKey = new Map();

function isRemotePath(targetPath) {
  return /^https?:\/\//i.test(targetPath);
}

function normalizeRemoteUrl(input) {
  if (!input) {
    return input;
  }
  try {
    const url = new URL(input);
    if (url.hostname === "github.com" && url.pathname.includes("/blob/")) {
      const parts = url.pathname.split("/").filter(Boolean);
      const blobIndex = parts.indexOf("blob");
      if (blobIndex > -1) {
        const owner = parts[0];
        const repo = parts[1];
        const branch = parts[blobIndex + 1];
        const filePath = parts.slice(blobIndex + 2).join("/");
        if (owner && repo && branch && filePath) {
          return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filePath}`;
        }
      }
    }
  } catch {
    return input;
  }
  return input;
}

function fetchRemoteText(url) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (handler, value) => {
      if (settled) {
        return;
      }
      settled = true;
      handler(value);
    };

    let client = https;
    try {
      const parsedUrl = new URL(url);
      if (parsedUrl.protocol === "http:") {
        client = http;
      } else if (parsedUrl.protocol !== "https:") {
        settle(
          reject,
          new Error(`Unsupported URL protocol: ${parsedUrl.protocol}`),
        );
        return;
      }
    } catch (error) {
      settle(reject, error);
      return;
    }

    const request = client.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        settle(
          reject,
          new Error(`Remote fetch failed with HTTP ${res.statusCode}: ${url}`),
        );
        res.resume();
        return;
      }

      const contentLengthHeader = Array.isArray(res.headers["content-length"])
        ? res.headers["content-length"][0]
        : res.headers["content-length"];
      const expectedBytes = Number(contentLengthHeader);
      if (
        Number.isFinite(expectedBytes) &&
        expectedBytes > REMOTE_FETCH_MAX_BYTES
      ) {
        settle(
          reject,
          new Error(
            `Remote fetch exceeded max size (${expectedBytes} > ${REMOTE_FETCH_MAX_BYTES} bytes): ${url}`,
          ),
        );
        res.resume();
        return;
      }

      res.setEncoding("utf8");
      let data = "";
      let receivedBytes = 0;
      res.on("data", (chunk) => {
        receivedBytes += Buffer.byteLength(chunk, "utf8");
        if (receivedBytes > REMOTE_FETCH_MAX_BYTES) {
          res.destroy(
            new Error(
              `Remote fetch exceeded max size (${receivedBytes} > ${REMOTE_FETCH_MAX_BYTES} bytes): ${url}`,
            ),
          );
          return;
        }
        data += chunk;
      });
      res.on("end", () => {
        settle(resolve, data);
      });
      res.on("error", (error) => {
        settle(reject, error);
      });
    });
    request.setTimeout(REMOTE_FETCH_TIMEOUT_MS, () => {
      request.destroy(
        new Error(
          `Remote fetch timed out after ${REMOTE_FETCH_TIMEOUT_MS}ms: ${url}`,
        ),
      );
    });
    request.on("error", (error) => {
      settle(reject, error);
    });
  });
}

function send(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function safeJoin(base, requestPath) {
  const normalized = path.normalize(path.join(base, requestPath));
  if (!normalized.startsWith(base)) {
    return null;
  }
  return normalized;
}

function serveStatic(res, requestPath) {
  const filePath = safeJoin(PUBLIC_DIR, requestPath);
  if (!filePath) {
    send(res, 403, "Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      send(res, 404, "Not found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType =
      ext === ".html"
        ? "text/html; charset=utf-8"
        : ext === ".css"
          ? "text/css; charset=utf-8"
          : ext === ".js"
            ? "application/javascript; charset=utf-8"
            : "application/octet-stream";

    send(res, 200, data, contentType);
  });
}
function createSection(title, columns, options = {}) {
  return {
    title,
    columns,
    rows: [],
    truncated: false,
    ...options,
  };
}

function pushRow(section, row) {
  if (section.rows.length >= MAX_ROWS) {
    section.truncated = true;
    return;
  }
  section.rows.push(row);
}

function getSummaryKey(view, mode) {
  return `${view}:${mode || ""}`;
}

function normalizeView(view) {
  if (view && VIEW_CONFIG[view]) {
    return view;
  }
  return DEFAULT_VIEW;
}

function normalizeMode(mode) {
  if (mode === "pve" || mode === "regular") {
    return mode;
  }
  return DEFAULT_MODE;
}

function removeClient(key, client) {
  const clients = clientsByKey.get(key);
  if (!clients) {
    return;
  }
  clients.delete(client);
}

function writeSse(key, client, message) {
  if (client.destroyed || client.writableEnded) {
    removeClient(key, client);
    return false;
  }
  try {
    client.write(message);
    return true;
  } catch {
    removeClient(key, client);
    return false;
  }
}

function broadcast(key, event, payload) {
  const message = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  const clients = clientsByKey.get(key) || new Set();
  clients.forEach((client) => {
    writeSse(key, client, message);
  });
}

function getValueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function sortKey(value) {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  const json = JSON.stringify(value);
  return json ?? String(value);
}

function normalizeCompareValue(value) {
  if (Array.isArray(value)) {
    const normalized = value.map(normalizeCompareValue);
    return normalized
      .map((item) => ({ key: sortKey(item), value: item }))
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((item) => item.value);
  }

  if (value && typeof value === "object") {
    const obj = value;
    const keys = Object.keys(obj).sort();
    const normalized = {};
    for (const key of keys) {
      normalized[key] = normalizeCompareValue(obj[key]);
    }
    return normalized;
  }

  return value;
}

function valuesEqual(a, b) {
  if (a === undefined && b === undefined) return true;
  return (
    JSON.stringify(normalizeCompareValue(a)) ===
    JSON.stringify(normalizeCompareValue(b))
  );
}

function formatValue(value, maxLength = 220) {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return value;
  const json = JSON.stringify(value);
  if (!json) return String(value);
  if (json.length <= maxLength) return json;
  return `${json.slice(0, maxLength - 1)}…`;
}

function mergeTaskOverride(base = {}, next = {}) {
  const merged = { ...base, ...next };
  if (base.objectives || next.objectives) {
    merged.objectives = { ...(base.objectives || {}), ...(next.objectives || {}) };
  }
  if (base.objectivesAdd || next.objectivesAdd) {
    merged.objectivesAdd = [
      ...(base.objectivesAdd || []),
      ...(next.objectivesAdd || []),
    ];
  }
  return merged;
}

function mergeTaskOverrides(shared = {}, modeSpecific = {}) {
  const merged = { ...shared };
  for (const [taskId, override] of Object.entries(modeSpecific)) {
    merged[taskId] = mergeTaskOverride(merged[taskId], override);
  }
  return merged;
}

function buildOverrideSections(title, overrides = {}) {
  const section = createSection(`${title} Overrides`, ["Entity", "Field", "Overlay"]);

  for (const [entityId, override] of Object.entries(overrides)) {
    if (!override || typeof override !== "object") {
      pushRow(section, [entityId, "value", formatValue(override)]);
      continue;
    }
    const entries = Object.entries(override);
    if (entries.length === 0) {
      pushRow(section, [entityId, "(empty)", "{}"]); 
      continue;
    }
    for (const [field, value] of entries) {
      pushRow(section, [entityId, field, formatValue(value)]);
    }
  }

  return [section];
}

function buildEditionsSections(editions = {}) {
  const section = createSection("Editions", [
    "Edition",
    "ID",
    "Stash",
    "Rep Bonus",
    "Exclusive Tasks",
    "Excluded Tasks",
  ]);

  for (const [key, edition] of Object.entries(editions)) {
    if (!edition || typeof edition !== "object") {
      pushRow(section, [key, key, "-", "-", "-", "-"]); 
      continue;
    }
    const repCount = edition.traderRepBonus
      ? Object.keys(edition.traderRepBonus).length
      : 0;
    const exclusiveCount = Array.isArray(edition.exclusiveTaskIds)
      ? edition.exclusiveTaskIds.length
      : 0;
    const excludedCount = Array.isArray(edition.excludedTaskIds)
      ? edition.excludedTaskIds.length
      : 0;
    pushRow(section, [
      edition.title || key,
      edition.id || key,
      edition.defaultStashLevel ?? "-",
      repCount ? `${repCount} traders` : "-",
      exclusiveCount || "-",
      excludedCount || "-",
    ]);
  }

  return [section];
}

function buildStoryChapterSections(chapters = {}) {
  const section = createSection("Story Chapters", [
    "Chapter",
    "ID",
    "Order",
    "Objectives",
    "Wiki",
  ]);

  for (const [key, chapter] of Object.entries(chapters)) {
    if (!chapter || typeof chapter !== "object") {
      pushRow(section, [key, key, "-", "-", "-"]); 
      continue;
    }
    const objectiveCount = Array.isArray(chapter.objectives)
      ? chapter.objectives.length
      : 0;
    pushRow(section, [
      chapter.name || key,
      chapter.id || key,
      chapter.order ?? "-",
      objectiveCount,
      chapter.wikiLink || "-",
    ]);
  }

  return [section];
}

function buildTaskAdditionSections(tasksAdd = {}, mode) {
  const section = createSection(`Task Additions (${mode})`, [
    "Task",
    "ID",
    "Trader",
    "Map",
    "Wiki",
  ]);

  for (const [taskId, addition] of Object.entries(tasksAdd)) {
    if (!addition || typeof addition !== "object") {
      pushRow(section, [taskId, taskId, "-", "-", "-"]); 
      continue;
    }
    const traderName = addition.trader?.name || "-";
    const mapName = addition.map?.name || "-";
    pushRow(section, [
      addition.name || taskId,
      addition.id || taskId,
      traderName,
      mapName,
      addition.wikiLink || "-",
    ]);
  }

  return [section];
}

function buildTasksSections(overrides = {}, apiTasks = [], mode) {
  const diffSection = createSection("Task Overrides vs API", [
    "Task",
    "Field",
    "API",
    "Overlay",
    "Status",
  ], { statusColumnIndex: 4 });
  const objectivesAddSection = createSection("Added Objectives", [
    "Task",
    "Objective",
    "Overlay",
  ]);
  const missingSection = createSection("Tasks Missing From API", [
    "Task",
    "Task ID",
  ]);
  const disabledSection = createSection("Disabled Tasks", [
    "Task",
    "Task ID",
  ]);

  const apiById = new Map(apiTasks.map((task) => [task.id, task]));

  for (const [taskId, override] of Object.entries(overrides)) {
    if (!override || typeof override !== "object") {
      continue;
    }
    const apiTask = apiById.get(taskId);
    const taskName = apiTask?.name || override.name || `Task ID ${taskId}`;

    if (!apiTask) {
      pushRow(missingSection, [taskName, taskId]);
      continue;
    }

    if (override.disabled === true) {
      pushRow(disabledSection, [taskName, taskId]);
    }

    const { objectives, objectivesAdd, ...topLevel } = override;

    Object.entries(topLevel).forEach(([field, value]) => {
      if (value === undefined) return;
      const apiValue = apiTask[field];
      const status = valuesEqual(apiValue, value) ? "same" : "override";
      pushRow(diffSection, [
        taskName,
        field,
        formatValue(apiValue),
        formatValue(value),
        status,
      ]);
    });

    if (objectives && typeof objectives === "object") {
      for (const [objectiveId, objOverride] of Object.entries(objectives)) {
        if (!objOverride || typeof objOverride !== "object") continue;
        const apiObjective = apiTask.objectives?.find(
          (objective) => objective.id === objectiveId,
        );
        if (!apiObjective) {
          pushRow(diffSection, [
            taskName,
            `objective:${objectiveId}`,
            "missing",
            formatValue(objOverride),
            "missing",
          ]);
          continue;
        }
        for (const [field, value] of Object.entries(objOverride)) {
          if (value === undefined) continue;
          const apiValue = apiObjective[field];
          const status = valuesEqual(apiValue, value) ? "same" : "override";
          pushRow(diffSection, [
            taskName,
            `objective:${objectiveId}.${field}`,
            formatValue(apiValue),
            formatValue(value),
            status,
          ]);
        }
      }
    }

    if (Array.isArray(objectivesAdd)) {
      objectivesAdd.forEach((objective) => {
        const label = objective.description || objective.id || "Added objective";
        pushRow(objectivesAddSection, [
          taskName,
          label,
          formatValue(objective),
        ]);
      });
    }
  }

  const sections = [diffSection, objectivesAddSection, missingSection, disabledSection];
  return sections;
}

async function loadOverlay() {
  let raw = "";
  let updatedAt = null;
  if (isRemotePath(OVERLAY_PATH)) {
    const remoteUrl = normalizeRemoteUrl(OVERLAY_PATH);
    raw = await fetchRemoteText(remoteUrl);
    updatedAt = new Date().toISOString();
  } else {
    const [fileRaw, stats] = await Promise.all([
      fs.promises.readFile(OVERLAY_PATH, "utf8"),
      fs.promises.stat(OVERLAY_PATH),
    ]);
    raw = fileRaw;
    updatedAt = stats.mtime.toISOString();
  }
  const parsed = JSON.parse(raw);
  return { data: parsed, updatedAt };
}

async function refreshOverlay() {
  const lock = readLocks.overlay;
  if (lock.isReading) {
    lock.pendingRead = true;
    return;
  }
  lock.isReading = true;
  try {
    const { data, updatedAt } = await loadOverlay();
    overlayState.data = data;
    overlayState.updatedAt = updatedAt;
    overlayState.error = null;
    rebuildSummaries();
  } catch (error) {
    overlayState.error = error.message || "Unable to read overlay";
    rebuildSummaries();
  } finally {
    lock.isReading = false;
    if (lock.pendingRead) {
      lock.pendingRead = false;
      refreshOverlay();
    }
  }
}

const TASKS_QUERY = `
  query($gameMode: GameMode) {
    tasks(lang: en, gameMode: $gameMode) {
      id
      name
      minPlayerLevel
      wikiLink
      kappaRequired
      lightkeeperRequired
      map { id name }
      experience
      taskRequirements { task { id name } status }
      traderRequirements { trader { id name } value compareMethod }
      factionName
      requiredPrestige { id name prestigeLevel }
      objectives {
        id
        type
        description
        maps { id name }
        ... on TaskObjectiveBasic { requiredKeys { id name shortName } }
        ... on TaskObjectiveMark { markerItem { id name shortName } requiredKeys { id name shortName } }
        ... on TaskObjectiveExtract { requiredKeys { id name shortName } }
        ... on TaskObjectiveShoot {
          count
          usingWeapon { id name shortName }
          usingWeaponMods { id name shortName }
          wearing { id name shortName }
          notWearing { id name shortName }
          requiredKeys { id name shortName }
        }
        ... on TaskObjectiveItem {
          count
          items { id name shortName }
          foundInRaid
          requiredKeys { id name shortName }
        }
        ... on TaskObjectiveQuestItem {
          count
          questItem { id name shortName }
          requiredKeys { id name shortName }
        }
        ... on TaskObjectiveUseItem {
          count
          useAny { id name shortName }
          requiredKeys { id name shortName }
        }
        ... on TaskObjectiveBuildItem {
          item { id name shortName }
          containsAll { id name shortName }
        }
      }
      startRewards {
        items { item { id name shortName } count }
        traderStanding { trader { id name } standing }
        offerUnlock { id trader { id name } level item { id name shortName } }
        skillLevelReward { name level skill { id name imageLink } }
        traderUnlock { id name }
        achievement { id name description }
        customization { id name customizationType customizationTypeName imageLink }
      }
      finishRewards {
        items { item { id name shortName } count }
        traderStanding { trader { id name } standing }
        offerUnlock { id trader { id name } level item { id name shortName } }
        skillLevelReward { name level skill { id name imageLink } }
        traderUnlock { id name }
        achievement { id name description }
        customization { id name customizationType customizationTypeName imageLink }
      }
    }
  }
`;

async function executeQuery(query, variables) {
  if (typeof fetch !== "function") {
    throw new Error("Global fetch is not available in this Node runtime");
  }
  const response = await fetch(TARKOV_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(
      `API request failed: ${response.status} ${response.statusText}`,
    );
  }

  const result = await response.json();
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error(
      `Invalid GraphQL response: expected an object, got ${getValueType(result)}`,
    );
  }
  if (result.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(result.errors)}`);
  }
  if (!("data" in result)) {
    throw new Error("Invalid GraphQL response: missing data field");
  }
  return result.data;
}

async function fetchApiTasks(mode) {
  const variables = mode ? { gameMode: mode } : undefined;
  const data = await executeQuery(TASKS_QUERY, variables);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(
      `Invalid GraphQL response: expected data to be an object, got ${getValueType(data)}`,
    );
  }
  if (!("tasks" in data)) {
    throw new Error("Invalid GraphQL response: missing data.tasks");
  }
  if (!Array.isArray(data.tasks)) {
    throw new Error(
      `Invalid GraphQL response: expected data.tasks array, got ${getValueType(data.tasks)}`,
    );
  }
  return data.tasks;
}

async function refreshApiTasks(mode) {
  const lock = mode === "pve" ? readLocks.apiPve : readLocks.apiRegular;
  if (lock.isReading) {
    lock.pendingRead = true;
    return;
  }
  lock.isReading = true;
  try {
    const tasks = await fetchApiTasks(mode);
    apiState[mode].data = tasks;
    apiState[mode].updatedAt = new Date().toISOString();
    apiState[mode].error = null;
    rebuildSummaries();
  } catch (error) {
    apiState[mode].error = error.message || "Unable to fetch API tasks";
    rebuildSummaries();
  } finally {
    lock.isReading = false;
    if (lock.pendingRead) {
      lock.pendingRead = false;
      refreshApiTasks(mode);
    }
  }
}

function buildSummary(view, mode) {
  const overlay = overlayState.data;
  if (!overlay) {
    return {
      sections: [],
      error: overlayState.error || "Overlay data not loaded",
    };
  }

  if (view === "tasks") {
    const sharedOverrides = overlay.tasks || {};
    const modeOverrides = overlay.modes?.[mode]?.tasks || {};
    const mergedOverrides = mergeTaskOverrides(sharedOverrides, modeOverrides);
    const apiTasks = apiState[mode]?.data || [];
    return {
      sections: buildTasksSections(mergedOverrides, apiTasks, mode),
      error: overlayState.error || apiState[mode]?.error || null,
    };
  }

  if (view === "tasksAdd") {
    const sharedAdditions = overlay.tasksAdd || {};
    const modeAdditions = overlay.modes?.[mode]?.tasksAdd || {};
    const mergedAdditions = { ...sharedAdditions, ...modeAdditions };
    return {
      sections: buildTaskAdditionSections(mergedAdditions, mode),
      error: overlayState.error || null,
    };
  }

  if (view === "items") {
    return {
      sections: buildOverrideSections("Items", overlay.items || {}),
      error: overlayState.error || null,
    };
  }

  if (view === "hideout") {
    return {
      sections: buildOverrideSections("Hideout", overlay.hideout || {}),
      error: overlayState.error || null,
    };
  }

  if (view === "traders") {
    return {
      sections: buildOverrideSections("Traders", overlay.traders || {}),
      error: overlayState.error || null,
    };
  }

  if (view === "editions") {
    return {
      sections: buildEditionsSections(overlay.editions || {}),
      error: overlayState.error || null,
    };
  }

  if (view === "storyChapters") {
    return {
      sections: buildStoryChapterSections(overlay.storyChapters || {}),
      error: overlayState.error || null,
    };
  }

  if (view === "itemsAdd") {
    return {
      sections: buildOverrideSections("Items Additions", overlay.itemsAdd || {}),
      error: overlayState.error || null,
    };
  }

  return { sections: [], error: "Unknown view" };
}

function rebuildSummaries() {
  Object.keys(VIEW_CONFIG).forEach((view) => {
    if (view === "tasks" || view === "tasksAdd") {
      ["regular", "pve"].forEach((mode) => {
        const key = getSummaryKey(view, mode);
        const summary = buildSummary(view, mode);
        summaryByKey.set(key, summary);
        broadcast(key, "summary", getState(view, mode));
      });
      return;
    }
    const key = getSummaryKey(view, "");
    const summary = buildSummary(view, "");
    summaryByKey.set(key, summary);
    broadcast(key, "summary", getState(view, ""));
  });
}

function getState(view, mode) {
  const config = VIEW_CONFIG[view];
  const key = getSummaryKey(view, config?.requiresMode ? mode : "");
  const summary = summaryByKey.get(key) || { sections: [], error: null };

  return {
    view,
    mode: config?.requiresMode ? mode : null,
    title: config?.title || view,
    lede: config?.lede || "",
    overlay: {
      path: OVERLAY_PATH,
      updatedAt: overlayState.updatedAt,
      meta: overlayState.data?.$meta || null,
      error: overlayState.error,
    },
    api: config?.requiresMode
      ? {
          updatedAt: apiState[mode]?.updatedAt || null,
          error: apiState[mode]?.error || null,
        }
      : null,
    sections: summary.sections,
    error: summary.error,
  };
}

function startOverlayWatcher() {
  if (isRemotePath(OVERLAY_PATH)) {
    setInterval(() => {
      refreshOverlay();
    }, OVERLAY_POLL_MS);
    return;
  }

  fs.watchFile(OVERLAY_PATH, { interval: 1000 }, (curr, prev) => {
    if (curr.mtimeMs !== prev.mtimeMs) {
      refreshOverlay();
    }
  });
}

function startApiPolling() {
  refreshApiTasks("regular");
  refreshApiTasks("pve");
  setInterval(() => refreshApiTasks("regular"), API_POLL_MS);
  setInterval(() => refreshApiTasks("pve"), API_POLL_MS);
}

startOverlayWatcher();
refreshOverlay();
startApiPolling();

const server = http.createServer((req, res) => {
  if (!req.url || !req.method) {
    send(res, 400, "Bad request");
    return;
  }

  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = requestUrl.pathname;

  if (req.method !== "GET") {
    send(res, 405, "Method not allowed");
    return;
  }

  if (pathname === "/latest") {
    const view = normalizeView(
      requestUrl.searchParams.get("view") ||
        requestUrl.searchParams.get("type"),
    );
    const mode = normalizeMode(requestUrl.searchParams.get("mode"));
    const config = VIEW_CONFIG[view];
    send(
      res,
      200,
      JSON.stringify(getState(view, config?.requiresMode ? mode : "")),
      "application/json; charset=utf-8",
    );
    return;
  }

  if (pathname === "/events") {
    const view = normalizeView(
      requestUrl.searchParams.get("view") ||
        requestUrl.searchParams.get("type"),
    );
    const mode = normalizeMode(requestUrl.searchParams.get("mode"));
    const config = VIEW_CONFIG[view];
    const key = getSummaryKey(view, config?.requiresMode ? mode : "");
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    const clients = clientsByKey.get(key) || new Set();
    clientsByKey.set(key, clients);
    clients.add(res);
    let closed = false;
    let keepAlive = null;
    const cleanup = () => {
      if (closed) {
        return;
      }
      closed = true;
      if (keepAlive) {
        clearInterval(keepAlive);
      }
      removeClient(key, res);
      req.off("close", cleanup);
      res.off("close", cleanup);
      res.off("finish", cleanup);
      res.off("error", cleanup);
    };

    req.on("close", cleanup);
    res.on("close", cleanup);
    res.on("finish", cleanup);
    res.on("error", cleanup);

    if (
      !writeSse(
        key,
        res,
        `event: summary\ndata: ${JSON.stringify(getState(view, config?.requiresMode ? mode : ""))}\n\n`,
      )
    ) {
      cleanup();
      return;
    }

    keepAlive = setInterval(() => {
      if (!writeSse(key, res, ": keep-alive\n\n")) {
        cleanup();
      }
    }, 15000);
    return;
  }

  if (
    pathname === "/" ||
    pathname === "/tasks" ||
    pathname === "/tasks-additions" ||
    pathname === "/hideout" ||
    pathname === "/items" ||
    pathname === "/items-additions" ||
    pathname === "/traders" ||
    pathname === "/editions" ||
    pathname === "/story-chapters"
  ) {
    serveStatic(res, "/index.html");
    return;
  }

  const filePath = pathname;
  serveStatic(res, filePath);
});

let currentPort = PORT;

function startServer(port) {
  currentPort = port;
  server.listen(port, () => {
    const address = server.address();
    const activePort =
      typeof address === "object" && address !== null ? address.port : port;
    // eslint-disable-next-line no-console
    console.log(`Overlay monitor running at http://localhost:${activePort}`);
  });
}

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    // eslint-disable-next-line no-console
    console.warn(
      `Port ${currentPort} in use, retrying on a random available port...`,
    );
    // Retry on an ephemeral port assigned by the OS
    startServer(0);
    return;
  }
  // eslint-disable-next-line no-console
  console.error("Failed to start overlay monitor:", error);
});

startServer(currentPort);
