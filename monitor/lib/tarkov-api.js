const {
  MAX_RESPONSE_BYTES: TARKOV_JSON_MAX_BYTES,
  createTaskNormalizers,
  buildTaskContext: buildSharedTaskContext,
  fetchCached,
  mapOptionalArray,
  readResponseJson,
  resolveDialogueTraderRefs: resolveSharedDialogueTraderRefs,
} = require('../../src/lib/tarkov-api-shared.cjs');
const { fetchTarkovJson } = require('./tarkov-transport.js');
function getValueType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_RETRIES = 3;
const MAX_BACKOFF_MS = 5000;
const TARKOV_JSON_TIMEOUT_MS = 30000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringId(value) {
  if (typeof value === 'string') return value;
  if (isRecord(value) && typeof value.id === 'string') return value.id;
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
    if (isRecord(entry) && typeof entry.id === 'string') map.set(entry.id, entry);
  }
  return map;
}

function translate(map, key) {
  if (typeof key !== 'string' || UNSAFE_KEYS.has(key)) return undefined;
  const value = map[key];
  return typeof value === 'string' ? value : key;
}

function validateEnvelope(payload, path) {
  if (!isRecord(payload) || !('data' in payload) || payload.data == null) {
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

function isFatalFetchError(error, retryNotFound) {
  return error && (error.fatal || (!retryNotFound && /request failed: 404\b/.test(error.message)));
}

async function fetchEnvelopeAttempt(path, controller) {
  const response = await fetchTarkovJson(path, controller.signal);
  if (!response.ok)
    throw new Error(
      `tarkov.dev request failed: ${response.status} ${response.statusText} (${path})`
    );
  return validateEnvelope(await readResponseJson(response, path, TARKOV_JSON_MAX_BYTES), path);
}

async function fetchEnvelopeOnce(path, retryNotFound = true) {
  if (typeof fetch !== 'function') {
    throw new Error('Global fetch is not available. Node 22.0.0+ is required');
  }
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TARKOV_JSON_TIMEOUT_MS);
    try {
      return await fetchEnvelopeAttempt(path, controller);
    } catch (error) {
      if (isFatalFetchError(error, retryNotFound)) throw error;
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
  const optional = mode === 'pvp-season' && endpoint === 'items';
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

const {
  resolveItemRef,
  resolveItemRefs,
  resolveMapRef,
  resolveTraderRef,
  resolveTaskRef,
  resolveRequiredPrestige,
  adaptObjective,
  adaptReward,
} = createTaskNormalizers({ isRecord, compact, stringId, translate });

function adaptTaskTrader(value, ctx) {
  if (value === undefined) return undefined;
  return resolveTraderRef(value, ctx) || { id: '', name: 'Unknown trader' };
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
  if (!isRecord(raw)) return { id: 'malformed-requirement', type: 'malformed' };
  return compact({
    ...raw,
    id: typeof raw.id === 'string' ? raw.id : 'malformed-requirement',
    type: typeof raw.type === 'string' ? raw.type : 'malformed',
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

function adaptTaskMap(value, ctx) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return resolveMapRef(value, ctx) || { id: '', name: 'Unknown map' };
}

function adaptTask(raw, ctx) {
  const id = stringId(raw) || '';
  return compact({
    id,
    name: translate(ctx.tasksEn, raw.name) || id,
    trader: adaptTaskTrader(raw.trader, ctx),
    minPlayerLevel: raw.minPlayerLevel,
    wikiLink: typeof raw.wikiLink === 'string' ? raw.wikiLink : undefined,
    map: adaptTaskMap(raw.map, ctx),
    kappaRequired: typeof raw.kappaRequired === 'boolean' ? raw.kappaRequired : undefined,
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
    experience: typeof raw.experience === 'number' ? raw.experience : undefined,
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
  const gameMode = mode || 'regular';
  if (typeof gameMode !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(gameMode)) {
    throw new Error('Invalid game mode');
  }
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

module.exports = { fetchApiTasks, fetchEnvelopeOnce };
