const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { URL } = require("url");
const { exec, execSync } = require("child_process");
const { DEFAULT_MODES, VIEW_CONFIG, config, getModeLabel } = require("./lib/config.js");
const {
  buildCraftAddSections,
  buildEditionsSections,
  buildLocaleSections,
  buildOverrideSections,
  buildPrestigeSections,
  buildSeasonalPerkSections,
  buildStoryChapterSections,
  buildTaskAdditionSections,
  buildTasksSections,
  createSection,
  formatValue,
  mergeTaskOverrides,
  pushRow,
  valuesEqual,
} = require("./lib/sections.js");

const PORT = config.port;
const PUBLIC_DIR = config.publicDir;
const MAX_ROWS = config.maxRows;
const OVERLAY_PATH = config.overlayPath;
const API_POLL_MS = config.apiPollMs;
const OVERLAY_POLL_MS = config.overlayPollMs;
const REMOTE_FETCH_TIMEOUT_MS = config.remoteFetchTimeoutMs;
const REMOTE_FETCH_MAX_BYTES = config.remoteFetchMaxBytes;
const TARKOV_JSON_BASE = config.tarkovJsonBase;

// Game modes served by json.tarkov.dev. The list is refreshed at startup from
// the live /endpoints `gameModes` payload (see startModeDiscovery) so the
// monitor follows upstream renames automatically; these defaults apply when
// discovery fails. pvp-season is BSG's Seasonal Character mode (EFT 1.1.0.0).
let supportedModes = [...DEFAULT_MODES];

const DEFAULT_VIEW = "tasks";

const overlayState = { data: null, updatedAt: null, error: null };
const apiState = Object.fromEntries(
  DEFAULT_MODES.map((mode) => [mode, { data: null, updatedAt: null, error: null }])
);

const summaryByKey = new Map();
const readLocks = {
  overlay: { isReading: false, pendingRead: false },
  ...Object.fromEntries(
    DEFAULT_MODES.map((mode) => [mode, { isReading: false, pendingRead: false }])
  ),
};

// Register additional game modes discovered at startup (apiState/readLocks are
// seeded from DEFAULT_MODES so the module works under test without I/O).
function registerModes(modes) {
  if (!Array.isArray(modes)) {
    return;
  }
  let changed = false;
  modes.forEach((mode) => {
    if (typeof mode !== "string" || mode in apiState) {
      return;
    }
    apiState[mode] = { data: null, updatedAt: null, error: null };
    readLocks[mode] = { isReading: false, pendingRead: false };
    changed = true;
  });
  if (changed) {
    supportedModes = Object.keys(apiState);
  }
}

const clientsByKey = new Map();
let overlayFsWatcher = null;

function parseIsoDate(value) {
  if (!value) {
    return 0;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

// Latest release tag (e.g. "v1.56" -> "1.56") from git, the authority for
// released overlay versions. Falls back to undefined when git is unavailable.
let cachedTagVersion;
let tagVersionLoaded = false;
function getLatestTagVersion() {
  if (tagVersionLoaded) {
    return cachedTagVersion;
  }
  try {
    const tag = execSync("git describe --tags --abbrev=0", {
      cwd: __dirname,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    cachedTagVersion = tag.replace(/^v/, "");
    tagVersionLoaded = true;
  } catch {
    cachedTagVersion = undefined;
  }
  return cachedTagVersion;
}

function versionNums(value) {
  return String(value || "")
    .replace(/^v/i, "")
    .split(/[.\-]/)
    .map((part) => Number.parseInt(part, 10) || 0);
}

function isVersionStale(metaVersion, latestVersion) {
  if (!latestVersion) {
    return false;
  }
  if (!metaVersion) {
    return true;
  }
  const loaded = versionNums(metaVersion);
  const latest = versionNums(latestVersion);
  for (let i = 0; i < Math.max(loaded.length, latest.length); i += 1) {
    const loadedPart = loaded[i] || 0;
    const latestPart = latest[i] || 0;
    if (loadedPart !== latestPart) {
      return loadedPart < latestPart;
    }
  }
  return false;
}

// Rebuild the overlay from sources (npm run build) so the monitor can refresh
// dist/overlay.json instead of only warning that it is stale. This mutating
// endpoint is opt-in via ALLOW_REBUILD=true; REBUILD_TOKEN adds authentication.
const REPO_ROOT = path.resolve(__dirname, "..");
const DEFAULT_OVERLAY_PATH = path.resolve(REPO_ROOT, "dist/overlay.json");
const rebuildState = { running: false, lastRun: null, lastSuccess: null, error: null };

function rebuildOverlay() {
  return new Promise((resolve, reject) => {
    if (process.env.NODE_ENV === "test") {
      resolve({ output: "Rebuild skipped in test environment" });
      return;
    }
    if (rebuildState.running) {
      const error = new Error("A rebuild is already in progress");
      error.conflict = true;
      reject(error);
      return;
    }
    rebuildState.running = true;
    rebuildState.error = null;
    const child = exec("npm run build", {
      cwd: REPO_ROOT,
      timeout: 120000,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, OVERLAY_VERSION: getLatestTagVersion() || "" },
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", (error) => {
      rebuildState.running = false;
      rebuildState.lastRun = new Date().toISOString();
      rebuildState.error = error.message;
      reject(error);
    });
    child.on("exit", (code) => {
      rebuildState.running = false;
      rebuildState.lastRun = new Date().toISOString();
      if (code === 0) {
        rebuildState.lastSuccess = rebuildState.lastRun;
        resolve({ output });
      } else {
        rebuildState.error = `npm run build exited with code ${code}`;
        reject(new Error(rebuildState.error));
      }
    });
  });
}

function isDefaultOverlayPath(targetPath) {
  return path.resolve(targetPath) === DEFAULT_OVERLAY_PATH;
}

function isRebuildEnabled() {
  return (
    process.env.NODE_ENV !== "test" &&
    process.env.ALLOW_REBUILD === "true" &&
    !isRemotePath(OVERLAY_PATH) &&
    isDefaultOverlayPath(OVERLAY_PATH)
  );
}

function safeTokenEqual(actual, expected) {
  const actualBuffer = Buffer.from(actual || "");
  const expectedBuffer = Buffer.from(expected || "");
  return (
    actualBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function getRequestToken(req, requestUrl) {
  const authorization = req.headers.authorization || "";
  const schemeEnd = authorization.indexOf(" ");
  if (schemeEnd > 0 && authorization.slice(0, schemeEnd).toLowerCase() === "bearer") {
    return authorization.slice(schemeEnd + 1).trim();
  }
  return requestUrl.searchParams.get("token") || "";
}

async function refreshOverlayIfStale() {
  if (isRemotePath(OVERLAY_PATH)) {
    return;
  }

  try {
    const stats = await fs.promises.stat(OVERLAY_PATH);
    const currentMtimeMs = stats.mtimeMs;
    const loadedMtimeMs = parseIsoDate(overlayState.updatedAt);

    if (!overlayState.data || currentMtimeMs > loadedMtimeMs) {
      await refreshOverlay();
    }
  } catch (error) {
    overlayState.error = error.message || "Unable to read overlay";
  }
}

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
        settle(reject, new Error(`Unsupported URL protocol: ${parsedUrl.protocol}`));
        return;
      }
    } catch (error) {
      settle(reject, error);
      return;
    }

    const request = client.get(url, (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        settle(reject, new Error(`Remote fetch failed with HTTP ${res.statusCode}: ${url}`));
        res.resume();
        return;
      }

      const contentLengthHeader = Array.isArray(res.headers["content-length"])
        ? res.headers["content-length"][0]
        : res.headers["content-length"];
      const expectedBytes = Number(contentLengthHeader);
      if (Number.isFinite(expectedBytes) && expectedBytes > REMOTE_FETCH_MAX_BYTES) {
        settle(
          reject,
          new Error(
            `Remote fetch exceeded max size (${expectedBytes} > ${REMOTE_FETCH_MAX_BYTES} bytes): ${url}`
          )
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
              `Remote fetch exceeded max size (${receivedBytes} > ${REMOTE_FETCH_MAX_BYTES} bytes): ${url}`
            )
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
        new Error(`Remote fetch timed out after ${REMOTE_FETCH_TIMEOUT_MS}ms: ${url}`)
      );
    });
    request.on("error", (error) => {
      settle(reject, error);
    });
  });
}

const SECURITY_HEADERS = Object.freeze({
  "Content-Security-Policy":
    "default-src 'self'; base-uri 'none'; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'",
  "Permissions-Policy": "camera=(), geolocation=(), microphone=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
});

function responseHeaders(contentType, extra = {}) {
  return {
    ...SECURITY_HEADERS,
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    ...extra,
  };
}

function send(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, responseHeaders(contentType));
  res.end(body);
}

function safeJoin(base, requestPath) {
  const resolvedBase = path.resolve(base);
  const relativeRequest = String(requestPath || "").replace(/^[/\\]+/, "");
  const candidate = path.resolve(resolvedBase, relativeRequest);
  const relative = path.relative(resolvedBase, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return null;
  }
  return candidate;
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
  return supportedModes.includes(mode) ? mode : DEFAULT_MODES[0];
}

function getAvailableLocales() {
  const locales = overlayState.data && overlayState.data.locales;
  return locales && typeof locales === "object" && !Array.isArray(locales)
    ? Object.keys(locales)
    : [];
}

function normalizeLocale(locale) {
  const available = getAvailableLocales();
  if (available.includes(locale)) {
    return locale;
  }
  return available[0] || "en";
}

function parseViewParams(requestUrl) {
  const view = normalizeView(
    requestUrl.searchParams.get("view") || requestUrl.searchParams.get("type")
  );
  const mode = normalizeMode(requestUrl.searchParams.get("mode"));
  const locale = normalizeLocale(requestUrl.searchParams.get("locale"));
  return { view, mode, locale, config: VIEW_CONFIG[view] };
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
      refreshOverlay().catch(() => {});
    }
  }
}

// Tarkov task data is served as static per-mode JSON files at json.tarkov.dev.
// The payloads use id-keyed objects, string-id references between entities, and
// translation placeholders resolved via sibling `_en` endpoints. fetchApiTasks
// fetches the relevant endpoints, resolves references and english translations,
// and returns the same TaskData[] shape the summaries already consume. This
// mirrors src/lib/tarkov-api.ts (the monitor is standalone CommonJS and cannot
// import the ESM/TS adapter without a build step).

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_RETRIES = 3;
const MAX_BACKOFF_MS = 5000;
const TARKOV_JSON_TIMEOUT_MS = 30000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringId(value) {
  if (typeof value === "string") return value;
  if (isRecord(value) && typeof value.id === "string") return value.id;
  return undefined;
}

function compact(value) {
  // Null-prototype result so untrusted keys (e.g. `__proto__` from remote JSON)
  // cannot pollute Object.prototype.
  const result = Object.create(null);
  for (const [key, entry] of Object.entries(value)) {
    if (UNSAFE_KEYS.has(key)) continue;
    if (entry !== undefined) result[key] = entry;
  }
  return result;
}

function toLookup(value) {
  const map = new Map();
  const records = Array.isArray(value) ? value : isRecord(value) ? Object.values(value) : [];
  for (const entry of records) {
    if (isRecord(entry) && typeof entry.id === "string") map.set(entry.id, entry);
  }
  return map;
}

function translate(map, key) {
  if (typeof key !== "string" || UNSAFE_KEYS.has(key)) return undefined;
  const value = map[key];
  return typeof value === "string" ? value : key;
}

function validateEnvelope(payload, path) {
  if (!isRecord(payload) || !("data" in payload) || payload.data == null) {
    const error = new Error(`Invalid json.tarkov.dev response for ${path}: missing data`);
    error.fatal = true;
    throw error;
  }
  if (payload.translations !== undefined && !Array.isArray(payload.translations)) {
    const error = new Error(
      `Invalid json.tarkov.dev response for ${path}: translations is not an array`
    );
    error.fatal = true;
    throw error;
  }
  return payload;
}

async function fetchEnvelopeOnce(path) {
  if (typeof fetch !== "function") {
    throw new Error("Global fetch is not available. Node 22.0.0+ is required");
  }
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TARKOV_JSON_TIMEOUT_MS);
    try {
      const response = await fetch(`${TARKOV_JSON_BASE}/${path}`, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(
          `tarkov.dev request failed: ${response.status} ${response.statusText} (${path})`
        );
      }
      return validateEnvelope(await response.json(), path);
    } catch (error) {
      if (error && error.fatal) throw error;
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt === MAX_RETRIES) break;
      await sleep(Math.min(1000 * 2 ** (attempt - 1), MAX_BACKOFF_MS));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error(`Failed to fetch ${path}`);
}

// Cache is scoped to a single fetchApiTasks call so concurrent endpoint reads
// within one refresh are deduped, while each poll cycle fetches fresh data.
function fetchEnvelope(cache, path) {
  const existing = cache.get(path);
  if (existing) return existing;
  const promise = fetchEnvelopeOnce(path).catch((error) => {
    cache.delete(path);
    throw error;
  });
  cache.set(path, promise);
  return promise;
}

async function fetchTranslations(cache, mode, endpoint) {
  const envelope = await fetchEnvelope(cache, `${mode}/${endpoint}_en`);
  return isRecord(envelope.data) ? envelope.data : {};
}

function resolveItemRef(value, ctx) {
  const id = stringId(value);
  const inline = isRecord(value) ? value : undefined;
  const raw = (id ? ctx.itemsById.get(id) || ctx.questItemsById.get(id) : undefined) || inline;
  if (!id && !raw) return undefined;
  const name =
    translate(ctx.itemsEn, raw && raw.name) ||
    (inline && typeof inline.name === "string" ? inline.name : undefined);
  const shortName =
    translate(ctx.itemsEn, raw && raw.shortName) ||
    (inline && typeof inline.shortName === "string" ? inline.shortName : undefined);
  return compact({ id: id || "", name, shortName });
}

function resolveItemRefs(value, ctx) {
  if (!Array.isArray(value)) return undefined;
  return value.map((entry) => resolveItemRef(entry, ctx)).filter(Boolean);
}

function resolveItemRefMatrix(value, ctx) {
  if (!Array.isArray(value)) return undefined;
  return value
    .map((group) => {
      const list = Array.isArray(group) ? group : [group];
      return list.map((entry) => resolveItemRef(entry, ctx)).filter(Boolean);
    })
    .filter((group) => group.length > 0);
}

function resolveMapRef(value, ctx) {
  const id = stringId(value);
  if (!id) return undefined;
  const raw = ctx.mapsById.get(id);
  return compact({ id, name: translate(ctx.mapsEn, raw && raw.name) });
}

function resolveMapRefs(value, ctx) {
  if (!Array.isArray(value)) return undefined;
  return value.map((entry) => resolveMapRef(entry, ctx)).filter(Boolean);
}

function resolveTraderRef(value, ctx) {
  const id = stringId(value);
  if (!id) return undefined;
  const raw = ctx.tradersById.get(id);
  return compact({ id, name: translate(ctx.tradersEn, raw && raw.name) });
}

function resolveTaskRef(value, ctx) {
  const id = stringId(value);
  if (!id) return undefined;
  const raw = ctx.tasksById.get(id);
  return compact({ id, name: translate(ctx.tasksEn, raw && raw.name) });
}

function resolveRequiredPrestige(value, ctx) {
  const id = stringId(value);
  if (!id) return undefined;
  const raw = ctx.prestigeById.get(id);
  if (!raw) return undefined;
  return {
    id,
    name: translate(ctx.tasksEn, raw.name) || id,
    prestigeLevel: typeof raw.prestigeLevel === "number" ? raw.prestigeLevel : 0,
  };
}

function resolveZone(value, ctx) {
  if (!isRecord(value)) return value;
  return compact({ ...value, map: resolveMapRef(value.map, ctx) });
}

function adaptObjective(raw, ctx) {
  return compact({
    ...raw,
    id: stringId(raw) || "",
    description: translate(ctx.tasksEn, raw.description),
    maps: resolveMapRefs(raw.maps, ctx),
    items: resolveItemRefs(raw.items, ctx),
    item: raw.item !== undefined ? resolveItemRef(raw.item, ctx) : undefined,
    markerItem: raw.markerItem !== undefined ? resolveItemRef(raw.markerItem, ctx) : undefined,
    questItem: raw.questItem !== undefined ? resolveItemRef(raw.questItem, ctx) : undefined,
    useAny: resolveItemRefs(raw.useAny, ctx),
    containsAll: resolveItemRefs(raw.containsAll, ctx),
    usingWeapon: resolveItemRefs(raw.usingWeapon, ctx),
    usingWeaponMods: resolveItemRefMatrix(raw.usingWeaponMods, ctx),
    requiredKeys: resolveItemRefMatrix(raw.requiredKeys, ctx),
    wearing: resolveItemRefMatrix(raw.wearing, ctx),
    notWearing: resolveItemRefs(raw.notWearing, ctx),
    zones: Array.isArray(raw.zones) ? raw.zones.map((zone) => resolveZone(zone, ctx)) : undefined,
    possibleLocations: Array.isArray(raw.possibleLocations)
      ? raw.possibleLocations.map((location) => resolveZone(location, ctx))
      : undefined,
  });
}

function adaptReward(raw, ctx) {
  if (!isRecord(raw)) return undefined;
  return compact({
    ...raw,
    items: Array.isArray(raw.items)
      ? raw.items
          .filter(isRecord)
          .map((entry) => compact({ ...entry, item: resolveItemRef(entry.item, ctx) }))
      : undefined,
    traderStanding: Array.isArray(raw.traderStanding)
      ? raw.traderStanding
          .filter(isRecord)
          .map((entry) => compact({ ...entry, trader: resolveTraderRef(entry.trader, ctx) }))
      : undefined,
    offerUnlock: Array.isArray(raw.offerUnlock)
      ? raw.offerUnlock.filter(isRecord).map((entry) =>
          compact({
            ...entry,
            trader: resolveTraderRef(entry.trader, ctx),
            item: resolveItemRef(entry.item, ctx),
          })
        )
      : undefined,
  });
}

function adaptTaskRequirement(raw, ctx) {
  if (!isRecord(raw)) return raw;
  return compact({ ...raw, task: resolveTaskRef(raw.task, ctx) });
}

function adaptTraderRequirement(raw, ctx) {
  if (!isRecord(raw)) return raw;
  return compact({ ...raw, trader: resolveTraderRef(raw.trader, ctx) });
}

function adaptTask(raw, ctx) {
  const id = stringId(raw) || "";
  return compact({
    id,
    name: translate(ctx.tasksEn, raw.name) || id,
    minPlayerLevel: typeof raw.minPlayerLevel === "number" ? raw.minPlayerLevel : undefined,
    wikiLink: typeof raw.wikiLink === "string" ? raw.wikiLink : undefined,
    map: raw.map === null ? null : resolveMapRef(raw.map, ctx),
    kappaRequired: typeof raw.kappaRequired === "boolean" ? raw.kappaRequired : undefined,
    lightkeeperRequired:
      typeof raw.lightkeeperRequired === "boolean" ? raw.lightkeeperRequired : undefined,
    factionName: typeof raw.factionName === "string" ? raw.factionName : undefined,
    requiredPrestige: resolveRequiredPrestige(raw.requiredPrestige, ctx),
    experience: typeof raw.experience === "number" ? raw.experience : undefined,
    taskRequirements: Array.isArray(raw.taskRequirements)
      ? raw.taskRequirements.map((req) => adaptTaskRequirement(req, ctx))
      : undefined,
    traderRequirements: Array.isArray(raw.traderRequirements)
      ? raw.traderRequirements.map((req) => adaptTraderRequirement(req, ctx))
      : undefined,
    objectives: Array.isArray(raw.objectives)
      ? raw.objectives.filter(isRecord).map((objective) => adaptObjective(objective, ctx))
      : undefined,
    startRewards: adaptReward(raw.startRewards, ctx),
    finishRewards: adaptReward(raw.finishRewards, ctx),
  });
}

async function buildTaskContext(cache, mode, tasksData) {
  const [itemsEnvelope, mapsEnvelope, tradersEnvelope, itemsEn, tasksEn, mapsEn, tradersEn] =
    await Promise.all([
      fetchEnvelope(cache, `${mode}/items`),
      fetchEnvelope(cache, `${mode}/maps`),
      fetchEnvelope(cache, `${mode}/traders`),
      fetchTranslations(cache, mode, "items"),
      fetchTranslations(cache, mode, "tasks"),
      fetchTranslations(cache, mode, "maps"),
      fetchTranslations(cache, mode, "traders"),
    ]);

  const itemsData = isRecord(itemsEnvelope.data) ? itemsEnvelope.data : {};
  const mapsData = isRecord(mapsEnvelope.data) ? mapsEnvelope.data : {};

  return {
    itemsById: toLookup(itemsData.items),
    questItemsById: toLookup(tasksData.questItems),
    tasksById: toLookup(tasksData.tasks),
    mapsById: toLookup(mapsData.maps),
    tradersById: toLookup(tradersEnvelope.data),
    prestigeById: toLookup(tasksData.prestige),
    itemsEn,
    tasksEn,
    mapsEn,
    tradersEn,
  };
}

async function fetchApiTasks(mode) {
  const gameMode = mode || "regular";
  // Per-call cache: dedupe concurrent endpoint reads within this refresh while
  // ensuring each poll cycle fetches fresh data from json.tarkov.dev.
  const cache = new Map();
  const tasksEnvelope = await fetchEnvelope(cache, `${gameMode}/tasks`);
  const tasksData = isRecord(tasksEnvelope.data) ? tasksEnvelope.data : undefined;
  if (!tasksData || !isRecord(tasksData.tasks)) {
    throw new Error(
      `Invalid json.tarkov.dev response for ${gameMode}/tasks: expected data.tasks object, got ${getValueType(
        tasksData && tasksData.tasks
      )}`
    );
  }
  const ctx = await buildTaskContext(cache, gameMode, tasksData);
  return Object.values(tasksData.tasks)
    .filter(isRecord)
    .map((task) => adaptTask(task, ctx));
}

async function refreshApiTasks(mode) {
  const lock = readLocks[mode];
  if (!lock) {
    return;
  }
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
      refreshApiTasks(mode).catch(() => {});
    }
  }
}

function buildSummary(view, mode, locale) {
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
      sections: buildTasksSections(mergedOverrides, apiTasks),
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

  if (view === "prestige") {
    return {
      sections: buildPrestigeSections(overlay.prestige || {}),
      error: overlayState.error || null,
    };
  }

  if (view === "locales") {
    return {
      sections: buildLocaleSections(overlay.locales || {}, locale),
      error: overlayState.error || null,
    };
  }

  if (view === "seasonalPerks") {
    return {
      sections: buildSeasonalPerkSections(overlay.seasonalPerks || {}),
      error: overlayState.error || null,
    };
  }

  if (view === "craftsAdd") {
    return {
      sections: buildCraftAddSections(overlay.craftsAdd || {}),
      error: overlayState.error || null,
    };
  }

  return { sections: [], error: "Unknown view" };
}

function rebuildSummaries() {
  Object.keys(VIEW_CONFIG).forEach((view) => {
    const config = VIEW_CONFIG[view];
    if (config.requiresMode) {
      supportedModes.forEach((mode) => {
        const key = getSummaryKey(view, mode);
        const summary = buildSummary(view, mode);
        summaryByKey.set(key, summary);
        broadcast(key, "summary", getState(view, mode, ""));
      });
      return;
    }
    if (config.requiresLocale) {
      const locales = getAvailableLocales();
      if (locales.length === 0) {
        const key = getSummaryKey(view, "en");
        const summary = buildSummary(view, "", "en");
        summaryByKey.set(key, summary);
        broadcast(key, "summary", getState(view, "", "en"));
        return;
      }
      locales.forEach((locale) => {
        const key = getSummaryKey(view, locale);
        const summary = buildSummary(view, "", locale);
        summaryByKey.set(key, summary);
        broadcast(key, "summary", getState(view, "", locale));
      });
      return;
    }
    const key = getSummaryKey(view, "");
    const summary = buildSummary(view, "", "");
    summaryByKey.set(key, summary);
    broadcast(key, "summary", getState(view, "", ""));
  });
}

function getState(view, mode, locale) {
  const config = VIEW_CONFIG[view];
  const key = getSummaryKey(
    view,
    config?.requiresLocale ? locale : config?.requiresMode ? mode : ""
  );
  const summary = summaryByKey.get(key) || { sections: [], error: null };
  const meta = overlayState.data?.$meta || null;
  const latestVersion = getLatestTagVersion();
  const stale = isVersionStale(meta && meta.version, latestVersion);

  return {
    view,
    mode: config?.requiresMode ? mode : null,
    locale: config?.requiresLocale ? locale : null,
    locales: getAvailableLocales(),
    modes: supportedModes,
    modeLabels: Object.fromEntries(supportedModes.map((entry) => [entry, getModeLabel(entry)])),
    title: config?.title || view,
    lede: config?.lede || "",
    overlay: {
      path: OVERLAY_PATH,
      updatedAt: overlayState.updatedAt,
      meta,
      version: meta ? meta.version : null,
      latestVersion,
      stale,
      error: overlayState.error,
    },
    api: config?.requiresMode
      ? {
          updatedAt: apiState[mode]?.updatedAt || null,
          error: apiState[mode]?.error || null,
        }
      : null,
    rebuild: {
      enabled: isRebuildEnabled(),
      running: rebuildState.running,
      lastSuccess: rebuildState.lastSuccess,
    },
    sections: summary.sections,
    error: summary.error,
  };
}

function startOverlayWatcher() {
  if (isRemotePath(OVERLAY_PATH)) {
    const poll = () => {
      refreshOverlay()
        .catch(() => {})
        .finally(() => setTimeout(poll, OVERLAY_POLL_MS));
    };
    setTimeout(poll, 0);
    return;
  }

  const overlayDir = path.dirname(OVERLAY_PATH);
  const overlayFile = path.basename(OVERLAY_PATH);
  try {
    overlayFsWatcher = fs.watch(overlayDir, (eventType, filename) => {
      const isOverlayFile = typeof filename === "string" ? filename === overlayFile : true;
      if (!isOverlayFile) {
        return;
      }
      if (eventType === "rename" || eventType === "change") {
        refreshOverlay().catch(() => {});
      }
    });
    overlayFsWatcher.on("error", () => {});
  } catch {
    // fs.watch may fail on some filesystems; watchFile below remains as fallback.
  }

  fs.watchFile(OVERLAY_PATH, { interval: 1000 }, (curr, prev) => {
    if (curr.mtimeMs !== prev.mtimeMs) {
      refreshOverlay().catch(() => {});
    }
  });
  refreshOverlay().catch(() => {});
}

function startApiPolling() {
  const schedulePoll = (mode) => {
    refreshApiTasks(mode)
      .catch(() => {})
      .finally(() => setTimeout(() => schedulePoll(mode), API_POLL_MS));
  };
  supportedModes.forEach((mode) => schedulePoll(mode));
}

// Refresh the supported game-mode list from json.tarkov.dev /endpoints so mode
// renames upstream (e.g. pvp-season) propagate without redeploying.
async function startModeDiscovery() {
  try {
    const envelope = await fetchEnvelopeOnce("endpoints");
    const gameModes = envelope.data && envelope.data.gameModes;
    registerModes(gameModes);
  } catch {
    // Keep the defaults; polling still works.
  }
}

if (process.env.NODE_ENV !== "test") {
  startOverlayWatcher();
  startModeDiscovery()
    .catch(() => {})
    .finally(() => startApiPolling());
}

const server = http.createServer((req, res) => {
  if (!req.url || !req.method) {
    send(res, 400, "Bad request");
    return;
  }

  let requestUrl;
  try {
    // A fixed base avoids treating the untrusted Host header as URL syntax.
    requestUrl = new URL(req.url, "http://localhost");
  } catch {
    send(res, 400, "Bad request");
    return;
  }
  const pathname = requestUrl.pathname;

  if (pathname === "/rebuild") {
    if (req.method !== "POST") {
      send(res, 405, "Method not allowed");
      return;
    }
    if (!isRebuildEnabled()) {
      send(
        res,
        503,
        JSON.stringify({ ok: false, error: "Rebuild is disabled" }),
        "application/json; charset=utf-8"
      );
      return;
    }
    const token = process.env.REBUILD_TOKEN;
    if (typeof token === "string" && token.length > 0) {
      const requestToken = getRequestToken(req, requestUrl);
      if (!requestToken || !safeTokenEqual(requestToken, token)) {
        send(
          res,
          401,
          JSON.stringify({ ok: false, error: "Invalid rebuild token" }),
          "application/json; charset=utf-8"
        );
        return;
      }
    }
    rebuildOverlay()
      .then((result) => {
        send(
          res,
          200,
          JSON.stringify({ ok: true, output: result.output }),
          "application/json; charset=utf-8"
        );
      })
      .catch((error) => {
        send(
          res,
          error.conflict ? 409 : 500,
          JSON.stringify({ ok: false, error: error.message }),
          "application/json; charset=utf-8"
        );
      });
    return;
  }

  if (req.method !== "GET") {
    send(res, 405, "Method not allowed");
    return;
  }

  if (pathname === "/latest") {
    const { view, mode, locale, config } = parseViewParams(requestUrl);
    refreshOverlayIfStale()
      .catch(() => {})
      .finally(() => {
        send(
          res,
          200,
          JSON.stringify(
            getState(view, config?.requiresMode ? mode : "", config?.requiresLocale ? locale : "")
          ),
          "application/json; charset=utf-8"
        );
      });
    return;
  }

  if (pathname === "/health") {
    const apiHealth = supportedModes.map((mode) => ({
      mode,
      updatedAt: apiState[mode]?.updatedAt || null,
      error: apiState[mode]?.error || null,
    }));
    send(
      res,
      200,
      JSON.stringify({
        ok:
          !overlayState.error &&
          apiHealth.length > 0 &&
          apiHealth.every((entry) => !entry.error && entry.updatedAt),
        uptime: process.uptime(),
        modes: supportedModes,
        rebuild: {
          enabled: isRebuildEnabled(),
          running: rebuildState.running,
          lastRun: rebuildState.lastRun,
          lastSuccess: rebuildState.lastSuccess,
          error: rebuildState.error,
        },
        overlay: {
          updatedAt: overlayState.updatedAt,
          error: overlayState.error,
          meta: overlayState.data?.$meta || null,
        },
        api: apiHealth,
      }),
      "application/json; charset=utf-8"
    );
    return;
  }

  if (pathname === "/events") {
    const { view, mode, locale, config } = parseViewParams(requestUrl);
    const key = getSummaryKey(
      view,
      config?.requiresLocale ? locale : config?.requiresMode ? mode : ""
    );
    refreshOverlayIfStale()
      .catch(() => {})
      .finally(() => {
        res.writeHead(200, responseHeaders("text/event-stream", { Connection: "keep-alive" }));
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
            `event: summary\ndata: ${JSON.stringify(
              getState(view, config?.requiresMode ? mode : "", config?.requiresLocale ? locale : "")
            )}\n\n`
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
      });
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
    pathname === "/story-chapters" ||
    pathname === "/prestige" ||
    pathname === "/locales" ||
    pathname === "/seasonal-perks" ||
    pathname === "/crafts"
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
    const activePort = typeof address === "object" && address !== null ? address.port : port;
    // eslint-disable-next-line no-console
    console.log(`Overlay monitor running at http://localhost:${activePort}`);
  });
}

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    // eslint-disable-next-line no-console
    console.warn(`Port ${currentPort} in use, retrying on a random available port...`);
    // Retry on an ephemeral port assigned by the OS
    startServer(0);
    return;
  }
  // eslint-disable-next-line no-console
  console.error("Failed to start overlay monitor:", error);
});

if (process.env.NODE_ENV !== "test") {
  startServer(currentPort);
}
// Export functions for testing
if (process.env.NODE_ENV === "test") {
  module.exports = {
    MAX_ROWS,
    buildTasksSections,
    buildSummary,
    buildOverrideSections,
    buildEditionsSections,
    buildStoryChapterSections,
    buildTaskAdditionSections,
    buildPrestigeSections,
    buildLocaleSections,
    buildSeasonalPerkSections,
    buildCraftAddSections,
    mergeTaskOverrides,
    rebuildSummaries,
    valuesEqual,
    formatValue,
    normalizeView,
    normalizeMode,
    getLatestTagVersion,
    isVersionStale,
    rebuildOverlay,
    isRebuildEnabled,
    isDefaultOverlayPath,
    safeJoin,
    createSection,
    pushRow,
    overlayState,
    apiState,
    server,
    VIEW_CONFIG,
    SECURITY_HEADERS,
  };
}
