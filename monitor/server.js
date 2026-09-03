const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { isIP } = require("net");
const { URL } = require("url");
const { exec } = require("child_process");
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
  mergeTaskAdditions,
  mergeTaskOverrides,
  pushRow,
  valuesEqual,
} = require("./lib/sections.js");
const {
  MAX_RESPONSE_BYTES: TARKOV_JSON_MAX_BYTES,
  adaptReward: adaptSharedReward,
  buildTaskContext: buildSharedTaskContext,
  fetchCached,
  getLatestTagVersion: getSharedLatestTagVersion,
  isVersionStale: isSharedVersionStale,
  mapOptionalArray,
  normalizeRequiredPrestige,
  readResponseJson,
  resolveDialogueTraderRefs: resolveSharedDialogueTraderRefs,
  resolveReferenceMatrix,
  verifyOverlaySha256,
} = require("../src/lib/tarkov-api-shared.cjs");

const PORT = config.port;
const PUBLIC_DIR = config.publicDir;
const MAX_ROWS = config.maxRows;
const OVERLAY_PATH = config.overlayPath;
const API_POLL_MS = config.apiPollMs;
const OVERLAY_POLL_MS = config.overlayPollMs;
const REMOTE_FETCH_TIMEOUT_MS = config.remoteFetchTimeoutMs;
const REMOTE_FETCH_MAX_BYTES = config.remoteFetchMaxBytes;
const TARKOV_JSON_BASE = "https://json.tarkov.dev";

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
  overlay: { isReading: false, pendingRead: false, promise: null },
  ...Object.fromEntries(
    DEFAULT_MODES.map((mode) => [mode, { isReading: false, pendingRead: false }])
  ),
};

// Register the exact game modes discovered at startup (apiState/readLocks are
// seeded from DEFAULT_MODES so the module works under test without I/O).
const MAX_DISCOVERED_MODES = 32;
const MAX_SSE_CONNECTIONS = 100;
const MAX_SSE_CONNECTIONS_PER_ADDRESS = 20;
const MAX_SSE_CONNECTIONS_PER_KEY = 10;
const MAX_SSE_BUFFERED_BYTES = 1024 * 1024;
const RESERVED_MODE_NAMES = new Set(["__proto__", "constructor", "prototype"]);

function isSafeModeName(mode) {
  return (
    typeof mode === "string" &&
    !RESERVED_MODE_NAMES.has(mode) &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(mode)
  );
}

function registerModes(modes) {
  if (!Array.isArray(modes)) {
    return;
  }
  const discoveredModes = [...new Set(modes.filter(isSafeModeName))];
  if (discoveredModes.length === 0 || discoveredModes.length > MAX_DISCOVERED_MODES) {
    return;
  }

  const discovered = new Set(discoveredModes);
  for (const mode of Object.keys(apiState)) {
    if (!discovered.has(mode)) {
      delete apiState[mode];
      delete readLocks[mode];
    }
  }
  for (const mode of discoveredModes) {
    if (!Object.prototype.hasOwnProperty.call(apiState, mode)) {
      apiState[mode] = { data: null, updatedAt: null, error: null };
      readLocks[mode] = { isReading: false, pendingRead: false };
    }
  }
  supportedModes = discoveredModes;
}

const clientsByKey = new Map();
const sseConnectionsByAddress = new Map();
let activeSseConnections = 0;
let overlayFsWatcher = null;

function parseIsoDate(value) {
  if (!value) {
    return 0;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

// Highest release tag (e.g. "v1.56" -> "1.56") from git, the authority for
// released overlay versions. Read it once at startup so requests cannot spawn
// a synchronous git process on the event loop.
const STARTUP_TAG_VERSION = getSharedLatestTagVersion(__dirname);

function getLatestTagVersion() {
  return STARTUP_TAG_VERSION;
}

// Rebuild the overlay from sources (npm run build) so the monitor can refresh
// dist/overlay.json instead of only warning that it is stale. This mutating
// endpoint is opt-in via ALLOW_REBUILD=true and a non-empty REBUILD_TOKEN.
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

/** Recognize the listener values that stay on the local machine. */
function isLoopbackHost(host) {
  const normalized = String(host || '').replace(/^\[|\]$/g, '').toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    /^::ffff:127\.0\.0\.1$/.test(normalized)
  );
}

/** Rebuild tokens are safe only locally or behind an explicitly trusted HTTPS proxy. */
function isTrustedRebuildTransport() {
  return isLoopbackHost(config.host) || process.env.TRUSTED_HTTPS_PROXY === 'true';
}

function isRebuildEnabled() {
  return (
    process.env.NODE_ENV !== "test" &&
    process.env.ALLOW_REBUILD === "true" &&
    isTrustedRebuildTransport() &&
    !isRemotePath(OVERLAY_PATH) &&
    isDefaultOverlayPath(OVERLAY_PATH) &&
    typeof process.env.REBUILD_TOKEN === "string" &&
    process.env.REBUILD_TOKEN.length > 0
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

function getRequestToken(req) {
  const authorization = req.headers.authorization || "";
  const schemeEnd = authorization.indexOf(" ");
  if (schemeEnd > 0 && authorization.slice(0, schemeEnd).toLowerCase() === "bearer") {
    return authorization.slice(schemeEnd + 1).trim();
  }
}

async function refreshOverlayIfStale() {
  if (isRemotePath(OVERLAY_PATH)) {
    if (!overlayState.data) {
      await refreshOverlay();
    }
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
    overlayState.error = redactErrorMessage(error, "Unable to read overlay");
  }
}

function isRemotePath(targetPath) {
  return /^https?:\/\//i.test(targetPath);
}

/** Return a safe source label without disclosing operator-supplied paths. */
function publicOverlaySource(targetPath = OVERLAY_PATH) {
  return isRemotePath(targetPath) ? "remote overlay" : "local overlay";
}

/** Remove URLs and configured local paths from messages sent to unauthenticated clients. */
function redactErrorMessage(error, fallback = "Unable to read overlay") {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (!message) return fallback;
  return message
    .replace(/https?:\/\/[^\s"'<>)}\]]+/gi, "[remote overlay]")
    .split(OVERLAY_PATH)
    .join(publicOverlaySource());
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
    let deadlineTimer;
    const settle = (handler, value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(deadlineTimer);
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
        settle(reject, new Error(`Remote fetch failed with HTTP ${res.statusCode}`));
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
          new Error(`Remote fetch exceeded max size (${expectedBytes} > ${REMOTE_FETCH_MAX_BYTES} bytes)`)
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
              `Remote fetch exceeded max size (${receivedBytes} > ${REMOTE_FETCH_MAX_BYTES} bytes)`
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
    // ClientRequest.setTimeout() is an inactivity timeout: a peer can keep
    // this promise alive indefinitely by trickling bytes. Use a total
    // deadline so a remote overlay cannot stall monitor refresh forever.
    deadlineTimer = setTimeout(() => {
      request.destroy(
        new Error(`Remote fetch timed out after ${REMOTE_FETCH_TIMEOUT_MS}ms`)
      );
    }, REMOTE_FETCH_TIMEOUT_MS);
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

function applyResponseHeaders(res, contentType, extra = {}) {
  res.setHeaders(new Headers(responseHeaders(contentType, extra)));
}

function send(res, status, body, contentType = "text/plain; charset=utf-8") {
  applyResponseHeaders(res, contentType);
  res.writeHead(status);
  res.end(body);
}

function handleResponseFailure(res) {
  if (res.destroyed || res.writableEnded) {
    return;
  }
  try {
    if (res.headersSent) {
      res.end();
    } else {
      send(res, 500, "Internal server error");
    }
  } catch {
    if (!res.destroyed) {
      res.destroy();
    }
  }
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

function getSummaryKey(view, mode = "", locale = "") {
  return `${view}:${mode}:${locale}`;
}

function normalizeView(view) {
  if (view && VIEW_CONFIG[view]) {
    return view;
  }
  return DEFAULT_VIEW;
}

function normalizeMode(mode) {
  if (supportedModes.includes(mode)) return mode;
  if (supportedModes.includes(DEFAULT_MODES[0])) return DEFAULT_MODES[0];
  return supportedModes[0] || DEFAULT_MODES[0];
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
  return { view, mode, config: VIEW_CONFIG[view] };
}

async function resolveViewParams(requestUrl) {
  const params = parseViewParams(requestUrl);
  await refreshOverlayIfStale().catch(() => {});
  const locale = normalizeLocale(requestUrl.searchParams.get("locale"));
  const scope = {
    mode: params.config?.requiresMode ? params.mode : "",
    locale: params.config?.requiresLocale ? locale : "",
  };
  const key = getSummaryKey(params.view, scope.mode, scope.locale);
  return { ...params, locale, key };
}

function removeClient(key, client) {
  const clients = clientsByKey.get(key);
  if (!clients) {
    return;
  }
  clients.delete(client);
  if (clients.size === 0) {
    clientsByKey.delete(key);
  }
}

function writeSse(key, client, message) {
  if (client.destroyed || client.writableEnded) {
    removeClient(key, client);
    return false;
  }
  try {
    client.write(message);
    if (
      typeof client.writableLength === "number" &&
      client.writableLength > MAX_SSE_BUFFERED_BYTES
    ) {
      removeClient(key, client);
      if (typeof client.destroy === "function") client.destroy();
      return false;
    }
    return true;
  } catch {
    removeClient(key, client);
    if (typeof client.destroy === "function") client.destroy();
    return false;
  }
}

/** Use the original client address only when a trusted proxy is configured. */
function getSseClientAddress(req) {
  const socketAddress = req.socket?.remoteAddress || "unknown";
  if (process.env.TRUSTED_HTTPS_PROXY !== "true") return socketAddress;

  const forwardedFor = req.headers?.["x-forwarded-for"];
  const firstForwarded = Array.isArray(forwardedFor)
    ? forwardedFor[0]
    : typeof forwardedFor === "string"
      ? forwardedFor.split(",", 1)[0]
      : undefined;
  const candidate = firstForwarded?.trim();
  return candidate && isIP(candidate) ? candidate : socketAddress;
}

function reserveSseConnection(address = "unknown") {
  const currentForAddress = sseConnectionsByAddress.get(address) || 0;
  if (
    activeSseConnections >= MAX_SSE_CONNECTIONS ||
    currentForAddress >= MAX_SSE_CONNECTIONS_PER_ADDRESS
  ) {
    return undefined;
  }
  activeSseConnections += 1;
  sseConnectionsByAddress.set(address, currentForAddress + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeSseConnections -= 1;
    const remainingForAddress = (sseConnectionsByAddress.get(address) || 1) - 1;
    if (remainingForAddress > 0) {
      sseConnectionsByAddress.set(address, remainingForAddress);
    } else {
      sseConnectionsByAddress.delete(address);
    }
  };
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
  if (!verifyOverlaySha256(parsed)) {
    throw new Error("Overlay is missing a valid build digest");
  }
  return { data: parsed, updatedAt };
}

async function refreshOverlay() {
  const lock = readLocks.overlay;
  if (lock.isReading) {
    lock.pendingRead = true;
    await lock.promise;
    return;
  }

  lock.isReading = true;
  lock.promise = (async () => {
    try {
      const { data, updatedAt } = await loadOverlay();
      overlayState.data = data;
      overlayState.updatedAt = updatedAt;
      overlayState.error = null;
      rebuildSummaries();
    } catch (error) {
      overlayState.error = redactErrorMessage(error, "Unable to read overlay");
      rebuildSummaries();
    }
  })();

  try {
    await lock.promise;
  } finally {
    lock.isReading = false;
    lock.promise = null;
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
const TARKOV_USER_AGENT =
  "tarkov-data-overlay (+https://github.com/tarkovtracker-org/tarkov-data-overlay)";

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

async function fetchEnvelopeOnce(path, retryNotFound = true) {
  if (typeof fetch !== "function") {
    throw new Error("Global fetch is not available. Node 22.0.0+ is required");
  }
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TARKOV_JSON_TIMEOUT_MS);
    try {
      const response = await fetch(`${TARKOV_JSON_BASE}/${path}`, {
        headers: { Accept: "application/json", "User-Agent": TARKOV_USER_AGENT },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(
          `tarkov.dev request failed: ${response.status} ${response.statusText} (${path})`
        );
      }
      return validateEnvelope(await readResponseJson(response, path, TARKOV_JSON_MAX_BYTES), path);
    } catch (error) {
      if (
        error &&
        (error.fatal || (!retryNotFound && /request failed: 404\b/.test(error.message)))
      ) {
        throw error;
      }
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
function fetchEnvelope(cache, path, retryNotFound = true) {
  return fetchCached(cache, path, (requestedPath) =>
    fetchEnvelopeOnce(requestedPath, retryNotFound)
  );
}

async function fetchTranslations(cache, mode, endpoint) {
  const optional = mode === "pvp-season" && endpoint === "items";
  try {
    const envelope = await fetchEnvelope(cache, `${mode}/${endpoint}_en`, !optional);
    if (!isRecord(envelope.data)) {
      const error = new Error(
        `Invalid json.tarkov.dev response for ${mode}/${endpoint}_en: expected data object`
      );
      error.fatal = true;
      throw error;
    }
    return envelope.data;
  } catch (error) {
    if (optional && error instanceof Error && /request failed: 404\b/.test(error.message)) {
      return {};
    }
    throw error;
  }
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
  return resolveReferenceMatrix(value, (entry) => resolveItemRef(entry, ctx));
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
  if (value === undefined) return undefined;
  const id = stringId(value);
  const inline = isRecord(value) ? value : undefined;
  const raw = ctx.prestigeById.get(id) || inline;
  return normalizeRequiredPrestige(id, translate(ctx.tasksEn, raw && raw.name), raw);
}

function adaptTaskTrader(value, ctx) {
  if (value === undefined) return undefined;
  return resolveTraderRef(value, ctx) || { id: "", name: "Unknown trader" };
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
  return adaptSharedReward(raw, ctx, { isRecord, compact, resolveItemRef, resolveTraderRef });
}

function adaptTaskRequirement(raw, ctx) {
  if (!isRecord(raw)) return raw;
  return compact({ ...raw, task: resolveTaskRef(raw.task, ctx) });
}

function adaptTaskRequirementGroup(value, ctx) {
  return Array.isArray(value) ? value.map((req) => adaptTaskRequirement(req, ctx)) : [];
}

function adaptTraderRequirement(raw, ctx) {
  if (!isRecord(raw)) return raw;
  return compact({ ...raw, trader: resolveTraderRef(raw.trader, ctx) });
}

function adaptOtherRequirement(raw, ctx) {
  if (!isRecord(raw)) return { id: "malformed-requirement", type: "malformed" };
  return compact({
    ...raw,
    id: typeof raw.id === "string" ? raw.id : "malformed-requirement",
    type: typeof raw.type === "string" ? raw.type : "malformed",
    traders: resolveSharedDialogueTraderRefs(raw.traders, ctx, resolveTraderRef),
  });
}

function adaptKeyRequirement(raw, ctx) {
  if (!isRecord(raw)) return raw;
  return compact({
    ...raw,
    map: resolveMapRef(raw.map, ctx),
    keys: resolveItemRefs(raw.keys, ctx),
  });
}

function adaptTask(raw, ctx) {
  const id = stringId(raw) || "";
  return compact({
    id,
    name: translate(ctx.tasksEn, raw.name) || id,
    trader: adaptTaskTrader(raw.trader, ctx),
    minPlayerLevel: raw.minPlayerLevel,
    wikiLink: typeof raw.wikiLink === "string" ? raw.wikiLink : undefined,
    map:
      raw.map === undefined
        ? undefined
        : raw.map === null
          ? null
          : resolveMapRef(raw.map, ctx) || { id: "", name: "Unknown map" },
    kappaRequired: typeof raw.kappaRequired === "boolean" ? raw.kappaRequired : undefined,
    lightkeeperRequired: raw.lightkeeperRequired,
    factionName: raw.factionName,
    requiredPrestige: resolveRequiredPrestige(raw.requiredPrestige, ctx),
    taskRequirements: mapOptionalArray(raw.taskRequirements, (req) =>
      adaptTaskRequirement(req, ctx)
    ),
    taskRequirementGroups: mapOptionalArray(raw.taskRequirementGroups, (group) =>
      adaptTaskRequirementGroup(group, ctx)
    ),
    traderRequirements: mapOptionalArray(raw.traderRequirements, (req) =>
      adaptTraderRequirement(req, ctx)
    ),
    otherRequirements: mapOptionalArray(raw.otherRequirements, (requirement) =>
      adaptOtherRequirement(requirement, ctx)
    ),
    neededKeys: mapOptionalArray(raw.neededKeys, (requirement) =>
      adaptKeyRequirement(requirement, ctx)
    ),
    availableDelaySecondsMin: raw.availableDelaySecondsMin,
    availableDelaySecondsMax: raw.availableDelaySecondsMax,
    experience: typeof raw.experience === "number" ? raw.experience : undefined,
    objectives: Array.isArray(raw.objectives)
      ? raw.objectives.filter(isRecord).map((objective) => adaptObjective(objective, ctx))
      : undefined,
    startRewards: adaptReward(raw.startRewards, ctx),
    finishRewards: adaptReward(raw.finishRewards, ctx),
  });
}

async function buildTaskContext(cache, mode, tasksData) {
  return buildSharedTaskContext(cache, mode, tasksData, {
    fetchEnvelope,
    fetchTranslations,
    isRecord,
    toLookup,
  });
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
  const tasks = [];
  const seenIds = new Set();
  for (const [sourceKey, rawTask] of Object.entries(tasksData.tasks)) {
    if (!isRecord(rawTask)) {
      const error = new Error(
        `Invalid json.tarkov.dev response for ${gameMode}/tasks: task '${sourceKey}' is not an object`
      );
      error.fatal = true;
      throw error;
    }
    const id = stringId(rawTask);
    if (!id) {
      const error = new Error(
        `Invalid json.tarkov.dev response for ${gameMode}/tasks: task '${sourceKey}' has no id`
      );
      error.fatal = true;
      throw error;
    }
    if (seenIds.has(id)) {
      const error = new Error(
        `Invalid json.tarkov.dev response for ${gameMode}/tasks: duplicate task id '${id}'`
      );
      error.fatal = true;
      throw error;
    }
    seenIds.add(id);
    tasks.push(adaptTask(rawTask, ctx));
  }
  return tasks;
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
    try {
      const mergedAdditions = mergeTaskAdditions(sharedAdditions, modeAdditions);
      return {
        sections: buildTaskAdditionSections(mergedAdditions, mode),
        error: overlayState.error || null,
      };
    } catch (error) {
      return {
        sections: [],
        error:
          overlayState.error ||
          (error instanceof Error ? error.message : String(error)) ||
          "Unable to build task additions summary",
      };
    }
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
      sections: buildPrestigeSections(overlay.modes?.regular?.prestige || {}),
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
    const modes = config.requiresMode ? supportedModes : [""];
    const availableLocales = getAvailableLocales();
    const locales = config.requiresLocale
      ? availableLocales.length > 0
        ? availableLocales
        : ["en"]
      : [""];

    modes.forEach((mode) => {
      locales.forEach((locale) => {
        const key = getSummaryKey(view, mode, locale);
        const summary = buildSummary(view, mode, locale);
        summaryByKey.set(key, summary);
        broadcast(key, "summary", getState(view, mode, locale));
      });
    });
  });
}

function getState(view, mode, locale) {
  const config = VIEW_CONFIG[view];
  const scope = {
    mode: config?.requiresMode ? mode : "",
    locale: config?.requiresLocale ? locale : "",
  };
  const key = getSummaryKey(view, scope.mode, scope.locale);
  const summary = summaryByKey.get(key) || { sections: [], error: null };
  const meta = overlayState.data?.$meta || null;
  const latestVersion = getLatestTagVersion();
  const stale = isSharedVersionStale(meta && meta.version, latestVersion);

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
      path: publicOverlaySource(),
      updatedAt: overlayState.updatedAt,
      meta,
      version: meta ? meta.version : null,
      latestVersion,
      stale,
      error: overlayState.error ? redactErrorMessage(overlayState.error) : null,
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
    error: summary.error ? redactErrorMessage(summary.error, "") : null,
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
      const requestToken = getRequestToken(req);
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
    resolveViewParams(requestUrl)
      .then(({ view, mode, locale, config }) => {
        send(
          res,
          200,
          JSON.stringify(
            getState(view, config?.requiresMode ? mode : "", config?.requiresLocale ? locale : "")
          ),
          "application/json; charset=utf-8"
        );
      })
      .catch(() => handleResponseFailure(res));
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
          error: rebuildState.error ? redactErrorMessage(rebuildState.error, "") : null,
        },
        overlay: {
          updatedAt: overlayState.updatedAt,
          error: overlayState.error ? redactErrorMessage(overlayState.error) : null,
          meta: overlayState.data?.$meta || null,
        },
        api: apiHealth,
      }),
      "application/json; charset=utf-8"
    );
    return;
  }

  if (pathname === "/events") {
    const clientAddress = getSseClientAddress(req);
    const releaseSseSlot = reserveSseConnection(clientAddress);
    if (!releaseSseSlot) {
      send(
        res,
        503,
        JSON.stringify({ ok: false, error: "Too many live event connections" }),
        "application/json; charset=utf-8"
      );
      return;
    }
    req.once("close", releaseSseSlot);
    res.once("close", releaseSseSlot);
    res.once("finish", releaseSseSlot);
    res.once("error", releaseSseSlot);

    resolveViewParams(requestUrl)
      .then(({ view, mode, locale, config, key }) => {
        if (res.destroyed || res.writableEnded) {
          releaseSseSlot();
          return;
        }
        const clients = clientsByKey.get(key) || new Set();
        if (clients.size >= MAX_SSE_CONNECTIONS_PER_KEY) {
          releaseSseSlot();
          send(
            res,
            429,
            JSON.stringify({ ok: false, error: "Too many event connections for this view" }),
            "application/json; charset=utf-8"
          );
          return;
        }

        applyResponseHeaders(res, "text/event-stream", { Connection: "keep-alive" });
        res.writeHead(200);
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
          releaseSseSlot();
          removeClient(key, res);
          req.off("close", cleanup);
          res.off("close", cleanup);
          res.off("finish", cleanup);
          res.off("error", cleanup);
          req.off("close", releaseSseSlot);
          res.off("close", releaseSseSlot);
          res.off("finish", releaseSseSlot);
          res.off("error", releaseSseSlot);
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
      })
      .catch(() => {
        releaseSseSlot();
        handleResponseFailure(res);
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
  server.listen({ port, host: config.host }, () => {
    const address = server.address();
    const activePort = typeof address === "object" && address !== null ? address.port : port;
    // eslint-disable-next-line no-console
    console.log(`Overlay monitor running at http://${config.host}:${activePort}`);
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
    MAX_DISCOVERED_MODES,
    MAX_SSE_CONNECTIONS,
    MAX_SSE_CONNECTIONS_PER_ADDRESS,
    MAX_SSE_CONNECTIONS_PER_KEY,
    MAX_SSE_BUFFERED_BYTES,
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
    mergeTaskAdditions,
    mergeTaskOverrides,
    rebuildSummaries,
    valuesEqual,
    formatValue,
    normalizeView,
    normalizeMode,
    normalizeLocale,
    getSummaryKey,
    parseViewParams,
    handleResponseFailure,
    getLatestTagVersion,
    isVersionStale: isSharedVersionStale,
    registerModes,
    rebuildOverlay,
    isRebuildEnabled,
    isDefaultOverlayPath,
    isLoopbackHost,
    isTrustedRebuildTransport,
    getSseClientAddress,
    publicOverlaySource,
    redactErrorMessage,
    safeJoin,
    writeSse,
    reserveSseConnection,
    fetchRemoteText,
    createSection,
    pushRow,
    overlayState,
    apiState,
    server,
    VIEW_CONFIG,
    SECURITY_HEADERS,
  };
}
