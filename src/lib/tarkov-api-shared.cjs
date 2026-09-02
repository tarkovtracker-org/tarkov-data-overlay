'use strict';

const { createHash } = require('node:crypto');
const { execSync } = require('node:child_process');

/**
 * Helpers shared by the TypeScript API client and the standalone CommonJS
 * monitor. Keep the module limited to built-in/runtime APIs so both runtimes
 * can consume it without a build step.
 */

const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Parse the supported release-tag formats into comparable version parts. */
function parseVersionTag(tag) {
  const match = /^v(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/.exec(tag);
  if (!match) return undefined;
  const parts = [match[1], match[2], match[3] || '0'].map(Number);
  if (!parts.every(Number.isSafeInteger)) return undefined;
  return {
    tag,
    major: parts[0],
    minor: parts[1],
    patch: parts[2],
    prerelease: match[4] ? match[4].split('.') : undefined,
  };
}

/** Compare parsed release tags using semver precedence. */
function compareVersionTags(left, right) {
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  if (!left.prerelease && !right.prerelease) return left.tag.localeCompare(right.tag);
  if (!left.prerelease) return 1;
  if (!right.prerelease) return -1;

  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) {
      const difference = Number(leftPart) - Number(rightPart);
      if (difference !== 0) return difference;
    } else if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    } else if (leftPart !== rightPart) {
      return leftPart < rightPart ? -1 : 1;
    }
  }
  return 0;
}

/** Return the highest supported release tag, or undefined when git is unavailable. */
function getLatestTagVersion(cwd) {
  try {
    const tag = execSync("git tag --list 'v*'", {
      cwd: cwd || process.cwd(),
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .split('\n')
      .map((candidate) => candidate.trim())
      .map(parseVersionTag)
      .filter(Boolean)
      .sort(compareVersionTags)
      .at(-1);
    return tag ? tag.tag.replace(/^v/, '') : undefined;
  } catch {
    return undefined;
  }
}

/** Return the next minor release tag, or the initial release tag when none exist. */
function getNextTagVersion(cwd) {
  const latest = getLatestTagVersion(cwd);
  if (latest === undefined) return 'v1.0';

  const match = /^(\d+)\.(\d+)/.exec(latest);
  if (!match) throw new Error(`Unsupported latest release version: ${latest}`);

  const minor = Number(match[2]);
  if (!Number.isSafeInteger(minor) || minor === Number.MAX_SAFE_INTEGER) {
    throw new Error(`Latest release minor version cannot be incremented: ${latest}`);
  }
  return `v${match[1]}.${minor + 1}`;
}

function fetchCached(cache, path, load) {
  const existing = cache.get(path);
  if (existing) return existing;
  const promise = load(path).catch((error) => {
    cache.delete(path);
    throw error;
  });
  cache.set(path, promise);
  return promise;
}

function resolveReferenceMatrix(value, resolveReference) {
  if (!Array.isArray(value)) return undefined;
  return value
    .map((group) => {
      const list = Array.isArray(group) ? group : [group];
      return list.map(resolveReference).filter(Boolean);
    })
    .filter((group) => group.length > 0);
}

function normalizeRequiredPrestige(id, name, raw) {
  const prestigeLevel =
    raw && typeof raw.prestigeLevel === 'number' && Number.isFinite(raw.prestigeLevel)
      ? raw.prestigeLevel
      : -1;
  if (id === undefined) {
    // Additions and some upstream payloads may provide the complete inline
    // requirement without a separate prestige ID.
    return typeof name === 'string' && prestigeLevel >= 0
      ? { name, prestigeLevel }
      : { name: 'Unknown prestige requirement', prestigeLevel: -1 };
  }
  if (id.length === 0) {
    return { id, name: 'Unknown prestige requirement', prestigeLevel: -1 };
  }
  return { id, name: typeof name === 'string' ? name : id, prestigeLevel };
}

/** Require an endpoint collection before indexing it. */
function requireCollection(value, path, isRecord) {
  if (!Array.isArray(value) && !isRecord(value)) {
    throw new Error(`Invalid json.tarkov.dev response for ${path}: expected a collection`);
  }
  return value;
}

/** Merge shared and mode-specific task patches without losing nested fields. */
function mergeTaskOverride(base, next) {
  const shared = isRecord(base) ? base : {};
  const modeSpecific = isRecord(next) ? next : {};
  const merged = { ...shared, ...modeSpecific };

  if (shared.objectives !== undefined || modeSpecific.objectives !== undefined) {
    if (
      (shared.objectives !== undefined && !isRecord(shared.objectives)) ||
      (modeSpecific.objectives !== undefined && !isRecord(modeSpecific.objectives))
    ) {
      throw new Error('Task override objectives must be objects');
    }
    const mergedObjectives = new Map(Object.entries(shared.objectives || {}));
    for (const [objectiveId, objectivePatch] of Object.entries(modeSpecific.objectives || {})) {
      const existingPatch = mergedObjectives.get(objectiveId);
      mergedObjectives.set(
        objectiveId,
        isRecord(existingPatch) && isRecord(objectivePatch)
          ? { ...existingPatch, ...objectivePatch }
          : objectivePatch
      );
    }
    merged.objectives = Object.fromEntries(mergedObjectives);
  }

  if (shared.objectivesAdd !== undefined || modeSpecific.objectivesAdd !== undefined) {
    if (
      (shared.objectivesAdd !== undefined && !Array.isArray(shared.objectivesAdd)) ||
      (modeSpecific.objectivesAdd !== undefined && !Array.isArray(modeSpecific.objectivesAdd))
    ) {
      throw new Error('Task override objectivesAdd must be arrays');
    }
    merged.objectivesAdd = [...(shared.objectivesAdd || []), ...(modeSpecific.objectivesAdd || [])];
  }

  return merged;
}

/** Validate and index task additions by their embedded task ID. */
function indexTaskAdditions(additions, scope) {
  if (additions === undefined) return new Map();
  if (!isRecord(additions)) {
    throw new Error(`Task additions '${scope}' must be an object`);
  }

  const indexed = new Map();
  for (const [sourceKey, addition] of Object.entries(additions)) {
    if (!isRecord(addition) || typeof addition.id !== 'string' || addition.id.length === 0) {
      throw new Error(`Task addition '${scope}.${sourceKey}' has no valid id`);
    }
    const trader = addition.trader;
    if (
      !isRecord(trader) ||
      typeof trader.name !== 'string' ||
      trader.name.length === 0 ||
      (trader.id !== undefined && typeof trader.id !== 'string')
    ) {
      throw new Error(`Task addition '${scope}.${sourceKey}' has an invalid trader`);
    }
    if (indexed.has(addition.id)) {
      throw new Error(`Task addition '${scope}' contains duplicate id '${addition.id}'`);
    }
    indexed.set(addition.id, addition);
  }
  return indexed;
}

/** Select shared and mode-specific additions, with optional disabled entries. */
function selectTaskAdditions(shared, modeSpecific, includeDisabled = false) {
  const selected = new Map();
  for (const [id, addition] of indexTaskAdditions(shared, 'tasksAdd')) {
    if (includeDisabled || addition.disabled !== true) selected.set(id, addition);
  }
  for (const [id, addition] of indexTaskAdditions(modeSpecific, 'mode tasksAdd')) {
    if (addition.disabled === true && !includeDisabled) selected.delete(id);
    else selected.set(id, addition);
  }
  return selected;
}

/** Map endpoint arrays densely so malformed or sparse entries stay visible. */
function mapOptionalArray(value, mapper) {
  if (value === undefined) return undefined;
  const entries = Array.isArray(value)
    ? Array.from({ length: value.length }, (_, index) => value[index])
    : [value];
  return entries.map((entry) => mapper(entry) ?? null);
}

/** Preserve unresolved dialogue trader references for fail-closed evaluation. */
function resolveDialogueTraderRefs(value, context, resolveTraderRef) {
  if (!Array.isArray(value)) return undefined;
  return Array.from({ length: value.length }, (_, index) => {
    const resolved = resolveTraderRef(value[index], context);
    return resolved && typeof resolved.name === 'string'
      ? resolved
      : { id: '', name: 'Unknown trader' };
  });
}

/** Read a JSON response with a bounded body and a fatal validation error. */
async function readResponseJson(
  response,
  path,
  maxBytes = DEFAULT_MAX_RESPONSE_BYTES,
  source = 'tarkov.dev'
) {
  const contentLength = response.headers?.get('content-length');
  if (contentLength !== null && contentLength !== undefined) {
    const length = Number(contentLength);
    if (Number.isSafeInteger(length) && length > maxBytes) {
      const error = new Error(`${source} response for ${path} exceeds the ${maxBytes}-byte limit`);
      error.fatal = true;
      throw error;
    }
  }

  if (!response.body) {
    const error = new Error(`Invalid ${source} response body for ${path}`);
    error.fatal = true;
    throw error;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) {
        const error = new Error(`Invalid ${source} response body for ${path}`);
        error.fatal = true;
        throw error;
      }
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        const error = new Error(
          `${source} response for ${path} exceeds the ${maxBytes}-byte limit`
        );
        error.fatal = true;
        throw error;
      }
      chunks.push(value);
    }
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
      // Preserve the original read or validation error if cancellation fails.
    }
    throw error;
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    const error = new Error(`Invalid JSON response from ${source} for ${path}`);
    error.fatal = true;
    throw error;
  }
}

/** Verify the build-time digest while preserving the exact JSON serialization. */
function verifyOverlaySha256(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const metadata = value.$meta;
  if (
    !metadata ||
    typeof metadata !== 'object' ||
    Array.isArray(metadata) ||
    typeof metadata.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(metadata.sha256)
  ) {
    return false;
  }

  const { sha256, ...metadataWithoutHash } = metadata;
  const unsigned = { ...value, $meta: metadataWithoutHash };
  const actual = createHash('sha256')
    .update(JSON.stringify(unsigned, null, 2))
    .digest('hex');
  return actual === sha256;
}

function adaptReward(raw, context, helpers) {
  const { isRecord, compact, resolveItemRef, resolveTraderRef, resolveMapRef } = helpers;
  const resolveNamedReference = (value, resolveReference, fallbackName) => {
    const resolved = resolveReference(value, context);
    if (!isRecord(resolved) || typeof resolved.id !== 'string' || resolved.id.length === 0) {
      return undefined;
    }
    return {
      id: resolved.id,
      name:
        typeof resolved.name === 'string' && resolved.name.length > 0
          ? resolved.name
          : fallbackName,
    };
  };
  const adaptTraderUnlocks = (value) => {
    if (value === undefined || value === null) return undefined;
    const entries = Array.isArray(value) ? value : [value];
    return entries
      .map((entry) => resolveNamedReference(entry, resolveTraderRef, 'Unknown trader'))
      .filter(Boolean);
  };
  const adaptLocationUnlocks = (value) => {
    if (value === undefined || value === null) return undefined;
    if (typeof resolveMapRef !== 'function') return value;
    const entries = Array.isArray(value) ? value : [value];
    return entries
      .map((entry) => resolveNamedReference(entry, resolveMapRef, 'Unknown map'))
      .filter(Boolean);
  };
  if (!isRecord(raw)) return undefined;
  return compact({
    ...raw,
    items: Array.isArray(raw.items)
      ? raw.items
          .filter(isRecord)
          .map((entry) => compact({ ...entry, item: resolveItemRef(entry.item, context) }))
      : undefined,
    traderStanding: Array.isArray(raw.traderStanding)
      ? raw.traderStanding
          .filter(isRecord)
          .map((entry) => compact({ ...entry, trader: resolveTraderRef(entry.trader, context) }))
      : undefined,
    offerUnlock: Array.isArray(raw.offerUnlock)
      ? raw.offerUnlock.filter(isRecord).map((entry) =>
          compact({
            ...entry,
            trader: resolveTraderRef(entry.trader, context),
            item: resolveItemRef(entry.item, context),
          })
        )
      : undefined,
    traderUnlock: adaptTraderUnlocks(raw.traderUnlock),
    traderDialogueUnlock: adaptTraderUnlocks(raw.traderDialogueUnlock),
    locationUnlock: adaptLocationUnlocks(raw.locationUnlock),
  });
}

async function buildTaskContext(cache, mode, tasksData, helpers) {
  const { fetchEnvelope, fetchTranslations, isRecord, toLookup } = helpers;
  const [itemsEnvelope, mapsEnvelope, tradersEnvelope, itemsEn, tasksEn, mapsEn, tradersEn] =
    await Promise.all([
      fetchEnvelope(cache, `${mode}/items`),
      fetchEnvelope(cache, `${mode}/maps`),
      fetchEnvelope(cache, `${mode}/traders`),
      fetchTranslations(cache, mode, 'items'),
      fetchTranslations(cache, mode, 'tasks'),
      fetchTranslations(cache, mode, 'maps'),
      fetchTranslations(cache, mode, 'traders'),
    ]);

  const itemsData = isRecord(itemsEnvelope.data) ? itemsEnvelope.data : undefined;
  const mapsData = isRecord(mapsEnvelope.data) ? mapsEnvelope.data : undefined;
  const tradersData = tradersEnvelope.data;
  if (!itemsData || !mapsData || (!isRecord(tradersData) && !Array.isArray(tradersData))) {
    throw new Error(`Invalid json.tarkov.dev response while loading ${mode} task context`);
  }

  return {
    itemsById: toLookup(requireCollection(itemsData.items, `${mode}/items data.items`, isRecord)),
    questItemsById: toLookup(tasksData.questItems),
    tasksById: toLookup(requireCollection(tasksData.tasks, `${mode}/tasks data.tasks`, isRecord)),
    mapsById: toLookup(requireCollection(mapsData.maps, `${mode}/maps data.maps`, isRecord)),
    tradersById: toLookup(requireCollection(tradersData, `${mode}/traders data`, isRecord)),
    prestigeById: toLookup(tasksData.prestige),
    itemsEn,
    tasksEn,
    mapsEn,
    tradersEn,
  };
}

module.exports = {
  MAX_RESPONSE_BYTES: DEFAULT_MAX_RESPONSE_BYTES,
  adaptReward,
  buildTaskContext,
  fetchCached,
  getLatestTagVersion,
  getNextTagVersion,
  indexTaskAdditions,
  mapOptionalArray,
  mergeTaskOverride,
  normalizeRequiredPrestige,
  readResponseJson,
  resolveDialogueTraderRefs,
  resolveReferenceMatrix,
  selectTaskAdditions,
  verifyOverlaySha256,
};
