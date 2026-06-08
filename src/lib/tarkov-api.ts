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
 * which is large. Results are memoized per endpoint path for the life of the
 * process so a single run that fetches `regular` then `pve` only downloads each
 * file once.
 */

import type {
  TaskData,
  TaskItemRef,
  TaskObjective,
  TaskRewards,
  TaskRequirement,
} from './types.js';

const TARKOV_JSON_BASE = 'https://json.tarkov.dev';
const DEFAULT_MAX_RETRIES = 3;
const MAX_BACKOFF_MS = 5000;

type GameMode = 'regular' | 'pve';

type JsonRecord = Record<string, unknown>;

type Envelope = {
  data: unknown;
  translations?: string[];
};

/** Flat translation map: key -> english string. */
type TranslationMap = Record<string, string>;

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function getValueType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

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
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  ) as T;
}

/**
 * Build an id -> record lookup from either an id-keyed object or an array of
 * records.
 */
function toLookup(value: unknown): Map<string, JsonRecord> {
  const entries: Array<readonly [string, JsonRecord]> = [];
  const records = Array.isArray(value)
    ? value
    : isRecord(value)
      ? Object.values(value)
      : [];
  for (const entry of records) {
    if (!isRecord(entry)) continue;
    const id = typeof entry.id === 'string' ? entry.id : undefined;
    if (id) entries.push([id, entry] as const);
  }
  return new Map(entries);
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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const inFlight = new Map<string, Promise<Envelope>>();

/** Thrown for malformed payloads; not worth retrying since a retry won't fix shape. */
class EnvelopeValidationError extends Error {}

function validateEnvelope(payload: unknown, path: string): Envelope {
  if (!isRecord(payload) || !('data' in payload) || payload.data == null) {
    throw new EnvelopeValidationError(
      `Invalid json.tarkov.dev response for ${path}: missing data`
    );
  }
  if (payload.translations !== undefined && !Array.isArray(payload.translations)) {
    throw new EnvelopeValidationError(
      `Invalid json.tarkov.dev response for ${path}: translations is not an array`
    );
  }
  return payload as Envelope;
}

async function fetchEnvelopeOnce(path: string): Promise<Envelope> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= DEFAULT_MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetch(`${TARKOV_JSON_BASE}/${path}`, {
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        throw new Error(
          `tarkov.dev request failed: ${response.status} ${response.statusText} (${path})`
        );
      }
      const payload = await response.json();
      return validateEnvelope(payload, path);
    } catch (error) {
      // Malformed payloads will not change on retry; fail fast.
      if (error instanceof EnvelopeValidationError) throw error;
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt === DEFAULT_MAX_RETRIES) break;
      await sleep(Math.min(1000 * 2 ** (attempt - 1), MAX_BACKOFF_MS));
    }
  }
  throw lastError ?? new Error(`Failed to fetch ${path}`);
}

/** Fetch an endpoint envelope, memoized per path for the life of the process. */
function fetchEnvelope(path: string): Promise<Envelope> {
  const existing = inFlight.get(path);
  if (existing) return existing;
  const promise = fetchEnvelopeOnce(path).catch((error) => {
    inFlight.delete(path);
    throw error;
  });
  inFlight.set(path, promise);
  return promise;
}

/** Fetch an `_en` endpoint and return its flat translation map. */
async function fetchTranslations(mode: GameMode, endpoint: string): Promise<TranslationMap> {
  const envelope = await fetchEnvelope(`${mode}/${endpoint}_en`);
  return isRecord(envelope.data) ? (envelope.data as TranslationMap) : {};
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

/**
 * Resolve an item reference (string id or inline `{id,...}`) into the
 * `{id,name,shortName}` shape the validator compares against.
 */
function resolveItemRef(value: unknown, ctx: Context): TaskItemRef | undefined {
  const id = stringId(value);
  const inline = isRecord(value) ? value : undefined;
  const raw = (id ? ctx.itemsById.get(id) ?? ctx.questItemsById.get(id) : undefined) ?? inline;
  if (!id && !raw) return undefined;
  const name =
    translate(ctx.itemsEn, raw?.name) ??
    (typeof inline?.name === 'string' ? inline.name : undefined);
  const shortName =
    translate(ctx.itemsEn, raw?.shortName) ??
    (typeof inline?.shortName === 'string' ? inline.shortName : undefined);
  return compact({ id: id ?? '', name, shortName }) as TaskItemRef;
}

function resolveItemRefs(value: unknown, ctx: Context): TaskItemRef[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .map((entry) => resolveItemRef(entry, ctx))
    .filter((entry): entry is TaskItemRef => Boolean(entry));
}

function resolveItemRefMatrix(value: unknown, ctx: Context): TaskItemRef[][] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .map((group) => {
      const list = Array.isArray(group) ? group : [group];
      return list
        .map((entry) => resolveItemRef(entry, ctx))
        .filter((entry): entry is TaskItemRef => Boolean(entry));
    })
    .filter((group) => group.length > 0);
}

function resolveMapRef(
  value: unknown,
  ctx: Context
): { id: string; name: string } | undefined {
  const id = stringId(value);
  if (!id) return undefined;
  const raw = ctx.mapsById.get(id);
  const name = translate(ctx.mapsEn, raw?.name);
  return compact({ id, name }) as { id: string; name: string };
}

function resolveMapRefs(value: unknown, ctx: Context): Array<{ id: string; name: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .map((entry) => resolveMapRef(entry, ctx))
    .filter((entry): entry is { id: string; name: string } => Boolean(entry));
}

function resolveTraderRef(value: unknown, ctx: Context): { id: string; name: string } | undefined {
  const id = stringId(value);
  if (!id) return undefined;
  const raw = ctx.tradersById.get(id);
  const name = translate(ctx.tradersEn, raw?.name);
  return compact({ id, name }) as { id: string; name: string };
}

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
  const id = stringId(value);
  if (!id) return undefined;
  const raw = ctx.prestigeById.get(id);
  if (!raw) return undefined;
  const prestigeLevel = typeof raw.prestigeLevel === 'number' ? raw.prestigeLevel : 0;
  const name = translate(ctx.tasksEn, raw.name) ?? id;
  return { id, name, prestigeLevel };
}

function resolveZone(value: unknown, ctx: Context): unknown {
  if (!isRecord(value)) return value;
  return compact({ ...value, map: resolveMapRef(value.map, ctx) });
}

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

function adaptReward(raw: unknown, ctx: Context): TaskRewards | undefined {
  if (!isRecord(raw)) return undefined;
  return compact({
    ...raw,
    items: Array.isArray(raw.items)
      ? raw.items.filter(isRecord).map((entry) =>
          compact({ ...entry, item: resolveItemRef(entry.item, ctx) })
        )
      : undefined,
    traderStanding: Array.isArray(raw.traderStanding)
      ? raw.traderStanding.filter(isRecord).map((entry) =>
          compact({ ...entry, trader: resolveTraderRef(entry.trader, ctx) })
        )
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
  }) as unknown as TaskRewards;
}

function adaptTaskRequirement(raw: unknown, ctx: Context): TaskRequirement {
  if (!isRecord(raw)) return raw as TaskRequirement;
  return compact({ ...raw, task: resolveTaskRef(raw.task, ctx) }) as unknown as TaskRequirement;
}

function adaptTraderRequirement(raw: unknown, ctx: Context): unknown {
  if (!isRecord(raw)) return raw;
  return compact({ ...raw, trader: resolveTraderRef(raw.trader, ctx) });
}

function adaptTask(raw: JsonRecord, ctx: Context): TaskData {
  const id = stringId(raw) ?? '';
  return compact({
    id,
    name: translate(ctx.tasksEn, raw.name) ?? id,
    minPlayerLevel: typeof raw.minPlayerLevel === 'number' ? raw.minPlayerLevel : undefined,
    wikiLink: typeof raw.wikiLink === 'string' ? raw.wikiLink : undefined,
    map: raw.map === null ? null : resolveMapRef(raw.map, ctx),
    kappaRequired: typeof raw.kappaRequired === 'boolean' ? raw.kappaRequired : undefined,
    lightkeeperRequired:
      typeof raw.lightkeeperRequired === 'boolean' ? raw.lightkeeperRequired : undefined,
    factionName: typeof raw.factionName === 'string' ? raw.factionName : undefined,
    requiredPrestige: resolveRequiredPrestige(raw.requiredPrestige, ctx),
    experience: typeof raw.experience === 'number' ? raw.experience : undefined,
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
  }) as unknown as TaskData;
}

async function buildContext(mode: GameMode, tasksData: JsonRecord): Promise<Context> {
  const [itemsEnvelope, mapsEnvelope, tradersEnvelope, itemsEn, tasksEn, mapsEn, tradersEn] =
    await Promise.all([
      fetchEnvelope(`${mode}/items`),
      fetchEnvelope(`${mode}/maps`),
      fetchEnvelope(`${mode}/traders`),
      fetchTranslations(mode, 'items'),
      fetchTranslations(mode, 'tasks'),
      fetchTranslations(mode, 'maps'),
      fetchTranslations(mode, 'traders'),
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

/**
 * Fetch all tasks for a game mode from json.tarkov.dev and adapt them into
 * the `TaskData[]` shape used by the override validator.
 */
export async function fetchTasks(gameMode?: GameMode): Promise<TaskData[]> {
  const mode: GameMode = gameMode ?? 'regular';

  const tasksEnvelope = await fetchEnvelope(`${mode}/tasks`);
  const tasksData = isRecord(tasksEnvelope.data) ? tasksEnvelope.data : undefined;
  if (!tasksData || !isRecord(tasksData.tasks)) {
    throw new Error(
      `Invalid json.tarkov.dev response for ${mode}/tasks: expected data.tasks object, got ${getValueType(
        tasksData?.tasks
      )}`
    );
  }

  const ctx = await buildContext(mode, tasksData);

  return Object.values(tasksData.tasks)
    .filter(isRecord)
    .map((task) => adaptTask(task, ctx));
}

/**
 * Find a task by ID from a list of tasks
 */
export function findTaskById(tasks: TaskData[], taskId: string): TaskData | undefined {
  return tasks.find((t) => t.id === taskId);
}

/**
 * Clear the per-process endpoint memo cache. Intended for tests that stub
 * `fetch` and need each case to fetch fresh data.
 */
export function __clearTarkovApiCache(): void {
  inFlight.clear();
}
