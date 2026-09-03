/**
 * Tarkov.dev data client (json.tarkov.dev)
 *
 * Fetches task data from the json.tarkov.dev static JSON endpoints and adapts
 * it into the `TaskData[]` shape consumed by the override validator.
 *
 * Why JSON instead of GraphQL:
 * The legacy `api.tarkov.dev/graphql` endpoint has been replaced by static
 * per-mode JSON files. The JSON payloads use id-keyed objects, string-id
 * references between entities, and translation placeholders that resolve via a
 * sibling `_en` endpoint. This module fetches the relevant endpoints, resolves
 * references and english translations, and produces the same `TaskData` objects
 * the validator already understands, so `fetchTasks()` keeps its signature.
 *
 * The previous GraphQL `usingWeapon` broken-item fallback is obsolete: the JSON
 * endpoint returns plain id strings, so there is no upstream item-resolution
 * error to recover from.
 *
 * Note: resolving objective/reward item names requires the `items` payload,
 * which is large. Endpoint reads are deduped within a single `fetchTasks` or
 * `fetchTaskModeData` call so concurrent reads only download each file once.
 * Across calls the cache is not shared.
 */

import { SYNTHETIC_REQUIREMENT_ID_PREFIX } from './types.js';
import type {
  TaskData,
  TaskItemRef,
  TaskObjective,
  TaskRewards,
  TaskRequirement,
  TaskKeyRequirement,
  TaskOtherRequirement,
  TaskUnknownOtherRequirement,
  TraderRequirement,
  GameMode,
  MapAccessData,
  ModeAccessData,
  TraderAccessData,
} from './types.js';
import {
  adaptReward as adaptSharedReward,
  buildTaskContext as buildSharedTaskContext,
  fetchCached,
  mapOptionalArray,
  normalizeRequiredPrestige,
  readResponseJson,
  resolveDialogueTraderRefs as resolveSharedDialogueTraderRefs,
  resolveReferenceMatrix,
} from './tarkov-api-shared.cjs';

const TARKOV_JSON_BASE = 'https://json.tarkov.dev';
const DEFAULT_MAX_RETRIES = 3;
const MAX_BACKOFF_MS = 5000;
/** Bound one upstream exchange so maintenance commands cannot wait forever. */
export const FETCH_TIMEOUT_MS = 30_000;
/** Keep malformed or unexpectedly large upstream payloads from exhausting memory. */
export const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
/**
 * Identify the overlay to json.tarkov.dev. A descriptive UA is required in
 * practice: Cloudflare challenges browser-mimicking UAs (e.g. "Mozilla/5.0")
 * from non-browser clients with HTTP 403, while a named client UA passes.
 */
export const USER_AGENT =
  'tarkov-data-overlay (+https://github.com/tarkovtracker-org/tarkov-data-overlay)';

type JsonRecord = Record<string, unknown>;

export interface TarkovEnvelope {
  data: unknown;
  translations?: string[];
}

/** Flat translation map: key -> translated string for one locale. */
export type TranslationMap = Record<string, string>;

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Return a stable type label for malformed endpoint payload diagnostics. */
function getValueType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** Check whether a value is a non-array object record. */
function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Extract an entity ID from a string reference or inline record. */
function stringId(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (isRecord(value) && typeof value.id === 'string') return value.id;
  return undefined;
}

/**
 * Remove undefined values so adapted objects compare cleanly against overrides.
 */
function compact<T extends JsonRecord>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([key, entry]) => !UNSAFE_KEYS.has(key) && entry !== undefined)
  ) as T;
}

/**
 * Build an id -> record lookup from either an id-keyed object or an array of
 * records.
 */
function toLookup(value: unknown, label = 'collection'): Map<string, JsonRecord> {
  const lookup = new Map<string, JsonRecord>();
  const records = Array.isArray(value) ? value : isRecord(value) ? Object.values(value) : [];
  for (const entry of records) {
    if (!isRecord(entry)) continue;
    const id = typeof entry.id === 'string' ? entry.id : undefined;
    if (!id) continue;
    if (lookup.has(id)) {
      throw new EnvelopeValidationError(`Duplicate ${label} id '${id}'`);
    }
    lookup.set(id, entry);
  }
  return lookup;
}

/**
 * Resolve a translation key against the english map. Falls back to the raw key
 * when no translation exists, which matches how the api previously surfaced
 * untranslated strings.
 */
function translate(map: TranslationMap, key: unknown): string | undefined {
  if (typeof key !== 'string') return undefined;
  if (UNSAFE_KEYS.has(key)) return undefined;
  const value = map[key];
  return typeof value === 'string' ? value : key;
}

/** Wait for the bounded retry backoff interval. */
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Per-call endpoint cache. Dedupes concurrent reads within one fetchTasks call. */
type EndpointCache = Map<string, Promise<TarkovEnvelope>>;

/** Thrown for malformed payloads; not worth retrying since a retry won't fix shape. */
class EnvelopeValidationError extends Error {}

/** Validate the common envelope shape returned by json.tarkov.dev. */
function validateEnvelope(payload: unknown, path: string): TarkovEnvelope {
  if (!isRecord(payload) || !('data' in payload) || payload.data == null) {
    throw new EnvelopeValidationError(`Invalid json.tarkov.dev response for ${path}: missing data`);
  }
  if (payload.translations !== undefined && !Array.isArray(payload.translations)) {
    throw new EnvelopeValidationError(
      `Invalid json.tarkov.dev response for ${path}: translations is not an array`
    );
  }
  return payload as unknown as TarkovEnvelope;
}

/** Identify the expected HTTP 404 error used by optional translation endpoints. */
function isNotFoundError(error: unknown): error is Error {
  return error instanceof Error && /request failed: 404\b/.test(error.message);
}

/** Return true only for the translation endpoint known to be absent upstream. */
function isOptionalTranslationEndpoint(mode: GameMode, endpoint: string, locale: string): boolean {
  return mode === 'pvp-season' && endpoint === 'items' && locale === 'en';
}

/** Normalize retryable failures, rethrowing errors that should fail fast. */
function normalizeFetchError(error: unknown, retryNotFound: boolean): Error {
  if (error instanceof EnvelopeValidationError) throw error;
  if (isFatalResponseError(error)) throw new EnvelopeValidationError(error.message);
  if (!retryNotFound && isNotFoundError(error)) throw error;
  return error instanceof Error ? error : new Error(String(error));
}

/** Identify a fatal response-reader error that cannot be fixed by retrying. */
function isFatalResponseError(error: unknown): error is Error & { fatal: true } {
  return error instanceof Error && isRecord(error) && error.fatal === true;
}

/** Fetch one endpoint with bounded retries, timeout, and optional 404 handling. */
async function fetchEnvelopeOnce(path: string, retryNotFound = true): Promise<TarkovEnvelope> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= DEFAULT_MAX_RETRIES; attempt += 1) {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(`${TARKOV_JSON_BASE}/${path}`, {
        headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(
          `tarkov.dev request failed: ${response.status} ${response.statusText} (${path})`
        );
      }
      return validateEnvelope(await readResponseJson(response, path, MAX_RESPONSE_BYTES), path);
    } catch (error) {
      // Malformed payloads and expected missing optional translations fail fast.
      lastError = timedOut
        ? new Error(`tarkov.dev request timed out after ${FETCH_TIMEOUT_MS}ms (${path})`)
        : normalizeFetchError(error, retryNotFound);
      if (attempt === DEFAULT_MAX_RETRIES) break;
      await sleep(Math.min(1000 * 2 ** (attempt - 1), MAX_BACKOFF_MS));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError ?? new Error(`Failed to fetch ${path}`);
}

/** Fetch an endpoint envelope, deduping concurrent reads within one call. */
function fetchEnvelope(
  cache: EndpointCache,
  path: string,
  retryNotFound = true
): Promise<TarkovEnvelope> {
  return fetchCached(cache, path, (requestedPath) =>
    fetchEnvelopeOnce(requestedPath, retryNotFound)
  );
}

/** Fetch one validated json.tarkov.dev envelope without sharing cache state. */
export async function fetchTarkovEnvelope(
  path: string,
  retryNotFound = true
): Promise<TarkovEnvelope> {
  return fetchEnvelope(new Map(), path, retryNotFound);
}

/** Fetch an `_<locale>` endpoint and return its flat translation map. */
async function fetchTranslations(
  cache: EndpointCache,
  mode: GameMode,
  endpoint: string,
  locale = 'en'
): Promise<TranslationMap> {
  const optional = isOptionalTranslationEndpoint(mode, endpoint, locale);
  try {
    const envelope = await fetchEnvelope(cache, `${mode}/${endpoint}_${locale}`, !optional);
    if (!isRecord(envelope.data)) {
      throw new EnvelopeValidationError(
        `Invalid json.tarkov.dev response for ${mode}/${endpoint}_${locale}: expected data object`
      );
    }
    return envelope.data as TranslationMap;
  } catch (error) {
    // The endpoint registry currently advertises translations for every mode,
    // but pvp-season/items_en is absent in production. A missing translation
    // map is recoverable because adapters already fall back to the raw key.
    // Other translation endpoints are required so an upstream contract change
    // cannot silently turn all names into raw keys.
    if (optional && isNotFoundError(error)) return {};
    throw error;
  }
}

/** Shared lookups + translation maps used by the adapters. */
type Context = {
  itemsById: Map<string, JsonRecord>;
  questItemsById: Map<string, JsonRecord>;
  tasksById: Map<string, JsonRecord>;
  mapsById: Map<string, JsonRecord>;
  tradersById: Map<string, JsonRecord>;
  prestigeById: Map<string, JsonRecord>;
  itemsEn: TranslationMap;
  tasksEn: TranslationMap;
  mapsEn: TranslationMap;
  tradersEn: TranslationMap;
};

/** Select the upstream item record, falling back to an inline reference. */
function resolveItemRecord(
  id: string | undefined,
  inline: JsonRecord | undefined,
  ctx: Context
): JsonRecord | undefined {
  return (id ? (ctx.itemsById.get(id) ?? ctx.questItemsById.get(id)) : undefined) ?? inline;
}

/** Translate one item display field and preserve an inline fallback value. */
function resolveItemField(
  field: 'name' | 'shortName',
  raw: JsonRecord | undefined,
  inline: JsonRecord | undefined,
  ctx: Context
): string | undefined {
  return (
    translate(ctx.itemsEn, raw?.[field]) ??
    (typeof inline?.[field] === 'string' ? inline[field] : undefined)
  );
}

/**
 * Resolve an item reference (string id or inline `{id,...}`) into the
 * `{id,name,shortName}` shape the validator compares against.
 */
function resolveItemRef(value: unknown, ctx: Context): TaskItemRef | undefined {
  const id = stringId(value);
  const inline = isRecord(value) ? value : undefined;
  const raw = resolveItemRecord(id, inline, ctx);
  if (!id && !raw) return undefined;
  const name = resolveItemField('name', raw, inline, ctx);
  const shortName = resolveItemField('shortName', raw, inline, ctx);
  return compact({ id: id ?? '', name, shortName }) as TaskItemRef;
}

/** Resolve a list of item references and drop entries that cannot be resolved. */
function resolveItemRefs(value: unknown, ctx: Context): TaskItemRef[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .map((entry) => resolveItemRef(entry, ctx))
    .filter((entry): entry is TaskItemRef => Boolean(entry));
}

/** Resolve a nested item-reference matrix while preserving its groups. */
function resolveItemRefMatrix(value: unknown, ctx: Context): TaskItemRef[][] | undefined {
  return resolveReferenceMatrix(value, (entry) => resolveItemRef(entry, ctx));
}

/** Resolve one map reference and its translated display name. */
function resolveMapRef(value: unknown, ctx: Context): { id: string; name: string } | undefined {
  const id = stringId(value);
  if (!id) return undefined;
  const raw = ctx.mapsById.get(id);
  const name = translate(ctx.mapsEn, raw?.name);
  return compact({ id, name }) as { id: string; name: string };
}

/** Resolve a list of map references and drop malformed entries. */
function resolveMapRefs(
  value: unknown,
  ctx: Context
): Array<{ id: string; name: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .map((entry) => resolveMapRef(entry, ctx))
    .filter((entry): entry is { id: string; name: string } => Boolean(entry));
}

/** Resolve one trader reference and its translated display name. */
function resolveTraderRef(value: unknown, ctx: Context): { id: string; name: string } | undefined {
  const id = stringId(value);
  if (!id) return undefined;
  const raw = ctx.tradersById.get(id);
  const name = translate(ctx.tradersEn, raw?.name);
  return compact({ id, name }) as { id: string; name: string };
}

/** Resolve one task reference and its translated display name. */
function resolveTaskRef(value: unknown, ctx: Context): { id: string; name: string } | undefined {
  const id = stringId(value);
  if (!id) return undefined;
  const raw = ctx.tasksById.get(id);
  const name = translate(ctx.tasksEn, raw?.name);
  return compact({ id, name }) as { id: string; name: string };
}

/**
 * Resolve a task `requiredPrestige` reference (a prestige-id string) into the
 * `{id,name,prestigeLevel}` object the validator expects. The prestige level
 * lives in the separate `prestige` array of the tasks payload.
 */
function resolveRequiredPrestige(
  value: unknown,
  ctx: Context
): { id?: string; name: string; prestigeLevel: number } | undefined {
  if (value === undefined) return undefined;
  const id = stringId(value);
  const inline = isRecord(value) ? value : undefined;
  const raw = (id ? ctx.prestigeById.get(id) : undefined) ?? inline;
  // Preserve a declared but unresolved requirement so the availability model
  // reports unknown instead of silently treating it as no requirement.
  return normalizeRequiredPrestige(id, translate(ctx.tasksEn, raw?.name), raw);
}

/** Preserve a declared but unresolved task-giver reference as malformed data. */
function adaptTaskTrader(value: unknown, ctx: Context): TaskData['trader'] {
  if (value === undefined) return undefined;
  return resolveTraderRef(value, ctx) ?? { id: '', name: 'Unknown trader' };
}

/** Resolve map data nested inside an objective zone or location. */
function resolveZone(value: unknown, ctx: Context): unknown {
  if (!isRecord(value)) return value;
  return compact({ ...value, map: resolveMapRef(value.map, ctx) });
}

/** Adapt one objective and resolve its nested entity references. */
function adaptObjective(raw: JsonRecord, ctx: Context): TaskObjective {
  return compact({
    ...raw,
    id: stringId(raw) ?? '',
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
  }) as unknown as TaskObjective;
}

/** Adapt one reward object using the shared reward normalizer. */
function adaptReward(raw: unknown, ctx: Context): TaskRewards | undefined {
  return adaptSharedReward<TaskRewards, Context>(raw, ctx, {
    isRecord,
    compact,
    resolveItemRef,
    resolveTraderRef,
    resolveMapRef,
  });
}

/** Adapt one task prerequisite and resolve its referenced task. */
function adaptTaskRequirement(raw: unknown, ctx: Context): TaskRequirement {
  if (!isRecord(raw)) return raw as TaskRequirement;
  return compact({ ...raw, task: resolveTaskRef(raw.task, ctx) }) as unknown as TaskRequirement;
}

/** Adapt one hidden requirement and resolve any trader references. */
function adaptOtherRequirement(raw: unknown, ctx: Context): TaskOtherRequirement {
  if (!isRecord(raw)) {
    return { id: 'malformed-requirement', type: 'malformed' } as TaskUnknownOtherRequirement;
  }
  return compact({
    ...raw,
    id: typeof raw.id === 'string' ? raw.id : 'malformed-requirement',
    type: typeof raw.type === 'string' ? raw.type : 'malformed',
    traders: resolveSharedDialogueTraderRefs(raw.traders, ctx, resolveTraderRef),
  }) as TaskOtherRequirement;
}

/** Adapt one map/key requirement and resolve its references. */
function adaptKeyRequirement(raw: unknown, ctx: Context): TaskKeyRequirement {
  if (!isRecord(raw)) return raw as TaskKeyRequirement;
  return compact({
    ...raw,
    map: resolveMapRef(raw.map, ctx),
    keys: resolveItemRefs(raw.keys, ctx),
  }) as unknown as TaskKeyRequirement;
}

/** Adapt one trader requirement and assign a stable merge identity if needed. */
function adaptTraderRequirement(
  raw: unknown,
  taskId: string,
  ctx: Context,
  syntheticIdOccurrences: Map<string, number>
): TraderRequirement {
  if (!isRecord(raw)) return raw as TraderRequirement;

  const trader = resolveTraderRef(raw.trader, ctx);
  const upstreamId = stringId(raw);
  const syntheticIdBase = [
    SYNTHETIC_REQUIREMENT_ID_PREFIX.slice(0, -1),
    taskId,
    trader?.id,
    raw.requirementType,
    raw.compareMethod,
    raw.value,
  ].join('.');
  const occurrence = upstreamId ? 0 : (syntheticIdOccurrences.get(syntheticIdBase) ?? 0) + 1;
  if (!upstreamId) syntheticIdOccurrences.set(syntheticIdBase, occurrence);
  const generatedId =
    occurrence <= 1 ? syntheticIdBase : `${syntheticIdBase}.occurrence.${occurrence}`;

  // Preserve an upstream merge identity when present. If upstream regresses and
  // omits it, derive a deterministic identity from its fields. Repeated id-less
  // entries retain the original identity for the first occurrence and receive
  // stable occurrence suffixes thereafter instead of collapsing during merge.
  return compact({
    ...raw,
    id: upstreamId ?? generatedId,
    trader,
  }) as unknown as TraderRequirement;
}

/** Preserve malformed gate numbers as NaN so unlock evaluation fails closed. */
function optionalNumber(value: unknown, preserveInvalid = false): number | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'number' ? value : preserveInvalid ? Number.NaN : undefined;
}

/** Preserve malformed gate strings as null so unlock evaluation fails closed. */
function optionalString(value: unknown, preserveInvalid = false): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'string'
    ? value
    : preserveInvalid
      ? (null as unknown as string)
      : undefined;
}

/** Preserve malformed gate booleans as null so unlock evaluation fails closed. */
function optionalBoolean(value: unknown, preserveInvalid = false): boolean | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'boolean'
    ? value
    : preserveInvalid
      ? (null as unknown as boolean)
      : undefined;
}

/** Adapt one nested task-requirement group, treating malformed groups as empty. */
function adaptTaskRequirementGroup(value: unknown, ctx: Context): TaskRequirement[] {
  return Array.isArray(value) ? value.map((req) => adaptTaskRequirement(req, ctx)) : [];
}

/** Resolve a task's nullable top-level map reference. */
function adaptTaskMap(value: unknown, ctx: Context): TaskData['map'] {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return resolveMapRef(value, ctx) ?? { id: '', name: 'Unknown map' };
}

/** Adapt task objectives while dropping malformed non-object entries. */
function adaptObjectives(value: unknown, ctx: Context): TaskObjective[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter(isRecord).map((objective) => adaptObjective(objective, ctx));
}

/** Adapt one raw task record into the validator's normalized task shape. */
function adaptTask(raw: JsonRecord, ctx: Context): TaskData {
  const id = stringId(raw) ?? '';
  const syntheticRequirementIdOccurrences = new Map<string, number>();
  return compact({
    id,
    name: translate(ctx.tasksEn, raw.name) ?? id,
    trader: adaptTaskTrader(raw.trader, ctx),
    minPlayerLevel: optionalNumber(raw.minPlayerLevel, true),
    wikiLink: optionalString(raw.wikiLink),
    map: adaptTaskMap(raw.map, ctx),
    kappaRequired: optionalBoolean(raw.kappaRequired),
    lightkeeperRequired: optionalBoolean(raw.lightkeeperRequired, true),
    factionName: optionalString(raw.factionName, true),
    requiredPrestige: resolveRequiredPrestige(raw.requiredPrestige, ctx),
    experience: optionalNumber(raw.experience),
    taskRequirements: mapOptionalArray(raw.taskRequirements, (req) =>
      adaptTaskRequirement(req, ctx)
    ),
    taskRequirementGroups: mapOptionalArray(raw.taskRequirementGroups, (group) =>
      adaptTaskRequirementGroup(group, ctx)
    ),
    traderRequirements: mapOptionalArray(raw.traderRequirements, (req) =>
      adaptTraderRequirement(req, id, ctx, syntheticRequirementIdOccurrences)
    ),
    otherRequirements: mapOptionalArray(raw.otherRequirements, (requirement) =>
      adaptOtherRequirement(requirement, ctx)
    ),
    neededKeys: mapOptionalArray(raw.neededKeys, (requirement) =>
      adaptKeyRequirement(requirement, ctx)
    ),
    availableDelaySecondsMin: optionalNumber(raw.availableDelaySecondsMin, true),
    availableDelaySecondsMax: optionalNumber(raw.availableDelaySecondsMax, true),
    objectives: adaptObjectives(raw.objectives, ctx),
    startRewards: adaptReward(raw.startRewards, ctx),
    finishRewards: adaptReward(raw.finishRewards, ctx),
  }) as unknown as TaskData;
}

/** Build the shared entity and translation context for task adaptation. */
async function buildContext(
  cache: EndpointCache,
  mode: GameMode,
  tasksData: JsonRecord
): Promise<Context> {
  return buildSharedTaskContext<TarkovEnvelope, GameMode>(cache, mode, tasksData, {
    fetchEnvelope,
    fetchTranslations,
    isRecord,
    toLookup,
  });
}

/**
 * Fetch a raw entity collection for a game mode, keyed by id.
 *
 * Unlike `fetchTasks` this performs no adaptation or translation: it is used by
 * the override checkers for entity types that only need presence/field
 * comparison (prestige, items, traders, hideout). Text fields in the result are
 * still translation KEYS, not resolved strings.
 *
 * @param mode - game mode to fetch
 * @param endpoint - endpoint path segment, e.g. 'items' or 'hideout'
 * @param collectionKey - key inside `data` holding the collection. Some
 *   endpoints (traders) put the collection directly in `data`; omit for those.
 */
export async function fetchRawEntities(
  mode: GameMode,
  endpoint: string,
  collectionKey?: string
): Promise<Map<string, Record<string, unknown>>> {
  const cache: EndpointCache = new Map();
  const envelope = await fetchEnvelope(cache, `${mode}/${endpoint}`);
  // Some endpoints (e.g. crafts) return the collection directly under `data`
  // as a top-level array rather than an id-keyed object. A top-level array
  // cannot be keyed by name, so combining it with a `collectionKey` is a
  // misconfiguration and fails loudly rather than silently indexing the
  // wrong collection.
  if (Array.isArray(envelope.data)) {
    if (collectionKey) {
      throw new Error(
        `fetchRawEntities: ${mode}/${endpoint} returned a top-level array but collectionKey '${collectionKey}' was provided`
      );
    }
    return toLookup(envelope.data, `${mode}/${endpoint}`);
  }
  if (!isRecord(envelope.data)) {
    throw new Error(
      `Invalid json.tarkov.dev response for ${mode}/${endpoint}: expected data collection`
    );
  }
  const data = envelope.data;
  const collection = collectionKey ? data[collectionKey] : data;
  if (!isRecord(collection) && !Array.isArray(collection)) {
    throw new Error(
      `Invalid json.tarkov.dev response for ${mode}/${endpoint}: expected ${
        collectionKey ? `data.${collectionKey}` : 'data'
      } collection`
    );
  }
  return toLookup(
    collection,
    `${mode}/${endpoint}${collectionKey ? ` data.${collectionKey}` : ''}`
  );
}

/** Read an optional finite numeric field from an endpoint record. */
function numberField(record: JsonRecord, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Keep only string entries from an optional endpoint array field. */
function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * Fetch the static map-entry and trader-level metadata needed to explain why a
 * task cannot currently be played. Account-specific map locks and trader
 * unlock flags are deliberately not synthesized here: json.tarkov.dev does
 * not serve those values in these static endpoints.
 */
async function fetchModeAccessDataWithCache(
  mode: GameMode,
  cache: EndpointCache
): Promise<ModeAccessData> {
  const [mapsEnvelope, tradersEnvelope, mapsEn, tradersEn] = await Promise.all([
    fetchEnvelope(cache, `${mode}/maps`),
    fetchEnvelope(cache, `${mode}/traders`),
    fetchTranslations(cache, mode, 'maps'),
    fetchTranslations(cache, mode, 'traders'),
  ]);

  const mapsData = isRecord(mapsEnvelope.data) ? mapsEnvelope.data : undefined;
  if (!mapsData || (!isRecord(tradersEnvelope.data) && !Array.isArray(tradersEnvelope.data))) {
    throw new Error(`Invalid json.tarkov.dev response while loading ${mode} access data`);
  }
  if (!isRecord(mapsData.maps) && !Array.isArray(mapsData.maps)) {
    throw new Error(`Invalid json.tarkov.dev response for ${mode}/maps data.maps`);
  }
  const maps = Object.fromEntries(
    [...toLookup(mapsData.maps, `${mode}/maps`)].map(([id, raw]) => [
      id,
      compact({
        id,
        name: translate(mapsEn, raw.name) ?? id,
        minPlayerLevel: numberField(raw, 'minPlayerLevel'),
        maxPlayerLevel: numberField(raw, 'maxPlayerLevel'),
        accessKeys: stringArray(raw.accessKeys),
        accessKeysMinPlayerLevel: numberField(raw, 'accessKeysMinPlayerLevel'),
      }) as MapAccessData,
    ])
  );

  const traders = Object.fromEntries(
    [...toLookup(tradersEnvelope.data, `${mode}/traders`)].map(([id, raw]) => [
      id,
      compact({
        id,
        name: translate(tradersEn, raw.name) ?? id,
        levels: Array.isArray(raw.levels)
          ? raw.levels.filter(isRecord).map((level) =>
              compact({
                level: numberField(level, 'level'),
                requiredPlayerLevel: numberField(level, 'requiredPlayerLevel'),
                requiredReputation: numberField(level, 'requiredReputation'),
                requiredCommerce: numberField(level, 'requiredCommerce'),
              })
            )
          : [],
      }) as TraderAccessData,
    ])
  );

  return { maps, traders };
}

/** Fetch map-entry and trader metadata for one mode. */
export async function fetchModeAccessData(gameMode?: GameMode): Promise<ModeAccessData> {
  return fetchModeAccessDataWithCache(gameMode ?? 'regular', new Map());
}

/** Task data and static access metadata fetched with one shared endpoint cache. */
export interface TaskModeData {
  tasks: TaskData[];
  access: ModeAccessData;
}

/** Fetch the task report inputs without downloading shared endpoints twice. */
export async function fetchTaskModeData(gameMode?: GameMode): Promise<TaskModeData> {
  const mode: GameMode = gameMode ?? 'regular';
  const cache: EndpointCache = new Map();
  const [tasks, access] = await Promise.all([
    fetchTasksWithCache(mode, cache),
    fetchModeAccessDataWithCache(mode, cache),
  ]);
  return { tasks, access };
}

/** Extract and validate the task collection from a mode endpoint envelope. */
function getTaskData(mode: GameMode, tasksEnvelope: TarkovEnvelope): JsonRecord {
  const tasksData = isRecord(tasksEnvelope.data) ? tasksEnvelope.data : undefined;
  if (!tasksData || !isRecord(tasksData.tasks)) {
    throw new Error(
      `Invalid json.tarkov.dev response for ${mode}/tasks: expected data.tasks object, got ${getValueType(
        tasksData?.tasks
      )}`
    );
  }
  return tasksData;
}

/**
 * Fetch all tasks for a game mode from json.tarkov.dev and adapt them into
 * the `TaskData[]` shape used by the override validator.
 */
async function fetchTasksWithCache(mode: GameMode, cache: EndpointCache): Promise<TaskData[]> {
  const tasksData = getTaskData(mode, await fetchEnvelope(cache, `${mode}/tasks`));
  const taskCollection = tasksData.tasks as JsonRecord;

  const taskEntries: Array<[string, JsonRecord]> = [];
  const seenIds = new Set<string>();
  for (const [sourceKey, rawTask] of Object.entries(taskCollection)) {
    if (!isRecord(rawTask)) {
      throw new EnvelopeValidationError(
        `Invalid json.tarkov.dev response for ${mode}/tasks: task '${sourceKey}' is not an object`
      );
    }
    const id = stringId(rawTask);
    if (!id) {
      throw new EnvelopeValidationError(
        `Invalid json.tarkov.dev response for ${mode}/tasks: task '${sourceKey}' has no id`
      );
    }
    if (seenIds.has(id)) {
      throw new EnvelopeValidationError(
        `Invalid json.tarkov.dev response for ${mode}/tasks: duplicate task id '${id}'`
      );
    }
    seenIds.add(id);
    taskEntries.push([sourceKey, rawTask]);
  }

  const ctx = await buildContext(cache, mode, tasksData);
  return taskEntries.map(([, rawTask]) => adaptTask(rawTask, ctx));
}

/** Counts the merge identities present in raw upstream trader requirements. */
export interface TraderRequirementIdCounts {
  total: number;
  missing: number;
}

/**
 * Count missing trader-requirement IDs in the raw task payload.
 *
 * This intentionally runs on the endpoint payload before `adaptTask()` adds
 * deterministic synthetic IDs. The synthetic IDs keep consumers safe, but
 * must not hide an upstream data-quality regression from maintenance checks.
 */
export function countTraderRequirementIds(tasksData: unknown): TraderRequirementIdCounts {
  if (!isRecord(tasksData) || !isRecord(tasksData.tasks)) {
    return { total: 0, missing: 0 };
  }

  let total = 0;
  let missing = 0;
  for (const task of Object.values(tasksData.tasks)) {
    if (!isRecord(task) || !Array.isArray(task.traderRequirements)) continue;
    for (const requirement of task.traderRequirements) {
      total += 1;
      if (
        !isRecord(requirement) ||
        typeof requirement.id !== 'string' ||
        requirement.id.trim().length === 0
      ) {
        missing += 1;
      }
    }
  }
  return { total, missing };
}

/** Fetch adapted tasks and raw trader-requirement ID diagnostics together. */
export interface TaskDataWithRequirementCounts {
  tasks: TaskData[];
  traderRequirementIds: TraderRequirementIdCounts;
}

export async function fetchTasksWithRequirementCounts(
  gameMode?: GameMode
): Promise<TaskDataWithRequirementCounts> {
  const mode: GameMode = gameMode ?? 'regular';
  const cache: EndpointCache = new Map();
  const tasksData = getTaskData(mode, await fetchEnvelope(cache, `${mode}/tasks`));

  return {
    tasks: await fetchTasksWithCache(mode, cache),
    traderRequirementIds: countTraderRequirementIds(tasksData),
  };
}

/** Fetch all tasks for a game mode from json.tarkov.dev. */
export async function fetchTasks(gameMode?: GameMode): Promise<TaskData[]> {
  return fetchTasksWithCache(gameMode ?? 'regular', new Map());
}

/**
 * Raw per-locale bundle used by the locale-override validator.
 *
 * Unlike `fetchTasks`, this deliberately does NOT adapt or translate the core
 * records: the core endpoints store translation keys as field values (e.g.
 * `task.name === "<id> name"`), and the validator resolves those keys against
 * the `_<locale>` translation map itself so it can distinguish "bundle fixed
 * upstream" from "translation key missing".
 */
export interface LocaleBundle {
  /** Locale code the translation maps were fetched for (en, de, fr, ...) */
  locale: string;
  tasksById: Map<string, Record<string, unknown>>;
  itemsById: Map<string, Record<string, unknown>>;
  tradersById: Map<string, Record<string, unknown>>;
  mapsById: Map<string, Record<string, unknown>>;
  /** Prestige records live in the tasks payload's `prestige` array */
  prestigeById: Map<string, Record<string, unknown>>;
  tasksLocale: TranslationMap;
  itemsLocale: TranslationMap;
  tradersLocale: TranslationMap;
  mapsLocale: TranslationMap;
}

/**
 * Fetch the core entity endpoints plus the `_<locale>` translation maps for a
 * game mode, returning the raw lookups the locale-override validator needs.
 */
export async function fetchLocaleBundle(gameMode?: GameMode, locale = 'en'): Promise<LocaleBundle> {
  const mode: GameMode = gameMode ?? 'regular';
  const cache: EndpointCache = new Map();

  const [
    tasksEnvelope,
    itemsEnvelope,
    mapsEnvelope,
    tradersEnvelope,
    tasksLocale,
    itemsLocale,
    mapsLocale,
    tradersLocale,
  ] = await Promise.all([
    fetchEnvelope(cache, `${mode}/tasks`),
    fetchEnvelope(cache, `${mode}/items`),
    fetchEnvelope(cache, `${mode}/maps`),
    fetchEnvelope(cache, `${mode}/traders`),
    fetchTranslations(cache, mode, 'tasks', locale),
    fetchTranslations(cache, mode, 'items', locale),
    fetchTranslations(cache, mode, 'maps', locale),
    fetchTranslations(cache, mode, 'traders', locale),
  ]);

  const tasksData = isRecord(tasksEnvelope.data) ? tasksEnvelope.data : undefined;
  const itemsData = isRecord(itemsEnvelope.data) ? itemsEnvelope.data : undefined;
  const mapsData = isRecord(mapsEnvelope.data) ? mapsEnvelope.data : undefined;
  if (
    !tasksData ||
    !itemsData ||
    !mapsData ||
    (!isRecord(tradersEnvelope.data) && !Array.isArray(tradersEnvelope.data))
  ) {
    throw new Error(`Invalid json.tarkov.dev response while loading ${mode} locale data`);
  }
  if (
    (!isRecord(tasksData.tasks) && !Array.isArray(tasksData.tasks)) ||
    (!isRecord(itemsData.items) && !Array.isArray(itemsData.items)) ||
    (!isRecord(mapsData.maps) && !Array.isArray(mapsData.maps))
  ) {
    throw new Error(`Invalid json.tarkov.dev response while loading ${mode} locale collections`);
  }

  return {
    locale,
    tasksById: toLookup(tasksData.tasks, `${mode}/tasks`),
    itemsById: toLookup(itemsData.items, `${mode}/items`),
    mapsById: toLookup(mapsData.maps, `${mode}/maps`),
    tradersById: toLookup(tradersEnvelope.data, `${mode}/traders`),
    prestigeById: toLookup(tasksData.prestige, `${mode}/tasks prestige`),
    tasksLocale,
    itemsLocale,
    mapsLocale,
    tradersLocale,
  };
}

/**
 * Find a task by ID from a list of tasks
 */
export function findTaskById(tasks: TaskData[], taskId: string): TaskData | undefined {
  return tasks.find((t) => t.id === taskId);
}
