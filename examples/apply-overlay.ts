/**
 * Example: Applying tarkov-data-overlay to tarkov.dev API responses
 *
 * This demonstrates how consumers can fetch and apply the overlay
 * to get corrected task data.
 */

import {
  FETCH_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  fetchTarkovEnvelope,
  mergeTaskOverride,
  readResponseJson,
  runDirectly,
  selectTaskAdditions,
  verifyOverlaySha256,
} from '../src/lib/index.js';

// Types
interface TarkovMap {
  id: string;
  name: string;
}

interface TaskObjective {
  id: string;
  description: string;
  count?: number;
  maps?: TarkovMap[];
  items?: Array<{ id?: string; name: string }>;
}

interface Task {
  id: string;
  name: string;
  minPlayerLevel: number;
  map?: TarkovMap | null;
  objectives: TaskObjective[];
}

interface TaskAddition {
  id: string;
  name: string;
  trader: { id?: string; name: string };
  minPlayerLevel?: number;
  map?: TarkovMap | null;
  objectives: TaskObjective[];
  disabled?: boolean;
}

interface ObjectiveOverride {
  count?: number;
  description?: string;
  maps?: TarkovMap[];
  items?: Array<{ id?: string; name: string }>;
}

interface ObjectiveAdd {
  id: string;
  count?: number;
  description: string;
  maps?: TarkovMap[];
  items?: Array<{ id?: string; name: string }>;
}

interface TaskOverride {
  minPlayerLevel?: number;
  map?: TarkovMap | null;
  disabled?: boolean;
  objectives?: Record<string, ObjectiveOverride>;
  objectivesAdd?: ObjectiveAdd[];
}

interface Edition {
  id: string;
  title: string;
  value: number;
  defaultStashLevel: number;
  defaultCultistCircleLevel: number;
  traderRepBonus: Record<string, number>;
}

interface Overlay {
  tasks?: Record<string, TaskOverride>;
  tasksAdd?: Record<string, TaskAddition>;
  modes?: Partial<
    Record<
      GameMode,
      { tasks?: Record<string, TaskOverride>; tasksAdd?: Record<string, TaskAddition> }
    >
  >;
  items?: Record<string, unknown>;
  editions?: Record<string, Edition>;
  $meta: {
    version: string;
    generated: string;
    sha256: string;
  };
}

// Configuration
// Pin this URL to a reviewed release tag or commit for production use.
const OVERLAY_URL =
  'https://cdn.jsdelivr.net/gh/tarkovtracker-org/tarkov-data-overlay@main/dist/overlay.json';
type GameMode = 'regular' | 'pve' | 'pvp-season';

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Fetch tasks from the json.tarkov.dev static endpoints.
 *
 * The legacy api.tarkov.dev/graphql endpoint has been superseded by static
 * per-mode JSON files. Each endpoint returns `{ data, translations }` where
 * entity references are plain id strings and english strings resolve through a
 * sibling `_en` endpoint. This example resolves only the fields it displays
 * (task name, map name, objective item names); a full consumer would resolve
 * traders, prestige, rewards, etc. the same way (see src/lib/tarkov-api.ts).
 */
async function fetchTasksFromTarkovDev(gameMode: GameMode = 'regular'): Promise<Task[]> {
  const get = async (path: string): Promise<Record<string, unknown>> => {
    const optionalItemsTranslation = gameMode === 'pvp-season' && path === 'items_en';
    let payload;
    try {
      payload = await fetchTarkovEnvelope(`${gameMode}/${path}`, !optionalItemsTranslation);
    } catch (error) {
      if (
        optionalItemsTranslation &&
        error instanceof Error &&
        /request failed: 404\b/.test(error.message)
      ) {
        return {};
      }
      throw error;
    }
    const data = payload.data;
    if (!isRecord(data)) {
      // Translation endpoints (*_en) may legitimately be empty; the core
      // tasks/items/maps endpoints carry the data this example depends on, so
      // missing or non-object `data` there is a contract failure, not content.
      if (path.endsWith('_en')) return {};
      throw new Error(`tarkov.dev response for "${path}" had no "data" object`);
    }
    return data;
  };

  const [tasksData, itemsData, mapsData, tasksEn, itemsEn, mapsEn] = await Promise.all([
    get('tasks'),
    get('items'),
    get('maps'),
    get('tasks_en'),
    get('items_en'),
    get('maps_en'),
  ]);

  const getCollection = (data: Record<string, unknown>, key: string): Record<string, unknown> => {
    if (!isRecord(data[key])) {
      throw new Error(`tarkov.dev response did not include a valid data.${key} object`);
    }
    return data[key];
  };
  const items = getCollection(itemsData, 'items') as Record<string, { name?: string }>;
  const maps = getCollection(mapsData, 'maps') as Record<string, { name?: string }>;
  const tasks = getCollection(tasksData, 'tasks');

  const translate = (map: Record<string, string>, key: unknown): string =>
    typeof key === 'string' && !UNSAFE_KEYS.has(key) && Object.hasOwn(map, key)
      ? typeof map[key] === 'string'
        ? map[key]
        : key
      : typeof key === 'string'
        ? key
        : '';

  // Return undefined for unresolved references so dangling ids are dropped by
  // the `.filter(Boolean)` paths below instead of surfacing blank names.
  const resolveMap = (id: unknown): TarkovMap | undefined => {
    if (typeof id !== 'string') return undefined;
    const map = Object.hasOwn(maps, id) && isRecord(maps[id]) ? maps[id] : undefined;
    const nameKey = map?.name;
    if (typeof nameKey !== 'string') return undefined;
    return { id, name: translate(mapsEn as Record<string, string>, nameKey) };
  };

  const resolveItem = (id: unknown): { id: string; name: string } | undefined => {
    if (typeof id !== 'string') return undefined;
    const item = Object.hasOwn(items, id) && isRecord(items[id]) ? items[id] : undefined;
    const nameKey = item?.name;
    if (typeof nameKey !== 'string') return undefined;
    return { id, name: translate(itemsEn as Record<string, string>, nameKey) };
  };

  const result: Task[] = [];
  const seenIds = new Set<string>();
  for (const [sourceKey, raw] of Object.entries(tasks)) {
    if (!isRecord(raw) || typeof raw.id !== 'string' || raw.id.length === 0) {
      throw new Error(`tarkov.dev response task '${sourceKey}' has no valid id`);
    }
    if (seenIds.has(raw.id)) {
      throw new Error(`tarkov.dev response contains duplicate task id '${raw.id}'`);
    }
    seenIds.add(raw.id);

    const objectives = Array.isArray(raw.objectives)
      ? raw.objectives.map((value, index) => {
          if (!isRecord(value) || typeof value.id !== 'string' || value.id.length === 0) {
            throw new Error(`tarkov.dev task '${raw.id}' objective ${index} has no valid id`);
          }
          return {
            id: value.id,
            description: translate(tasksEn as Record<string, string>, value.description),
            count: typeof value.count === 'number' ? value.count : undefined,
            maps: Array.isArray(value.maps)
              ? value.maps.map(resolveMap).filter((m): m is TarkovMap => Boolean(m))
              : undefined,
            items: Array.isArray(value.items)
              ? value.items
                  .map(resolveItem)
                  .filter((i): i is { id: string; name: string } => Boolean(i))
              : undefined,
          };
        })
      : [];

    result.push({
      id: raw.id,
      name: translate(tasksEn as Record<string, string>, raw.name),
      minPlayerLevel: typeof raw.minPlayerLevel === 'number' ? raw.minPlayerLevel : 0,
      map: resolveMap(raw.map),
      objectives,
    });
  }
  return result;
}

/**
 * Fetch the overlay from jsDelivr CDN
 */
async function fetchOverlay(): Promise<Overlay> {
  const response = await fetch(OVERLAY_URL, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Overlay request failed: ${response.status} ${response.statusText}`);
  }
  const overlay: unknown = await readResponseJson(response, OVERLAY_URL, MAX_RESPONSE_BYTES);
  if (!verifyOverlaySha256(overlay)) {
    throw new Error('Overlay is missing a valid build digest');
  }
  return overlay as Overlay;
}

/**
 * Apply overlay corrections to a single task
 *
 * Handles both top-level field corrections and nested objective patches.
 */
function applyTaskOverride(task: Task, taskOverride: TaskOverride | undefined): Task | null {
  // No override for this task
  if (!taskOverride) return task;

  // Filter out disabled tasks (documented in INTEGRATION.md)
  if ((taskOverride as Record<string, unknown>).disabled === true) return null;

  // Start with a copy of the original task
  const result: Task = { ...task };

  // Apply top-level field overrides (shallow merge)
  for (const [key, value] of Object.entries(taskOverride)) {
    if (
      key === 'objectives' ||
      key === 'objectivesAdd' ||
      key === 'disabled' ||
      UNSAFE_KEYS.has(key)
    )
      continue;

    // Type-safe property assignment
    if (key === 'minPlayerLevel' && typeof value === 'number') {
      result.minPlayerLevel = value;
    } else if (key === 'map') {
      result.map = value as Task['map'];
    } else {
      // For any other properties, use type assertion
      (result as unknown as Record<string, unknown>)[key] = value;
    }
  }

  // Apply objective-level patches (ID-keyed)
  if (taskOverride.objectives && task.objectives) {
    result.objectives = task.objectives.map((objective) => {
      const patch = taskOverride.objectives![objective.id];
      if (!patch) return objective;

      // Shallow merge the objective with its patch (supports count, description, maps, items)
      return { ...objective, ...patch };
    });
  }

  // Append missing objectives
  if (taskOverride.objectivesAdd) {
    result.objectives = [...(result.objectives || []), ...taskOverride.objectivesAdd];
  }

  return result;
}

function getTaskOverrideForMode(
  taskId: string,
  overlay: Overlay,
  gameMode: GameMode
): TaskOverride | undefined {
  const shared = overlay.tasks?.[taskId];
  const modeSpecific = overlay.modes?.[gameMode]?.tasks?.[taskId];
  if (!shared && !modeSpecific) return undefined;
  return mergeTaskOverride(shared, modeSpecific);
}

function applyTaskOverlay(task: Task, overlay: Overlay, gameMode: GameMode): Task | null {
  return applyTaskOverride(task, getTaskOverrideForMode(task.id, overlay, gameMode));
}

function getTaskAdditionsForMode(
  overlay: Overlay,
  gameMode: GameMode,
  apiTaskIds: ReadonlySet<string> = new Set()
): Task[] {
  const allAdditions = selectTaskAdditions(
    overlay.tasksAdd,
    overlay.modes?.[gameMode]?.tasksAdd,
    true
  );
  const collidingAddition = [...allAdditions.values()].find((addition) =>
    apiTaskIds.has(addition.id)
  );
  if (collidingAddition) {
    throw new Error(`Task addition '${collidingAddition.id}' collides with an API task`);
  }

  const byId = selectTaskAdditions(overlay.tasksAdd, overlay.modes?.[gameMode]?.tasksAdd, false);

  return [...byId.values()].map((addition) => {
    const { disabled: _disabled, ...task } = addition;
    return { ...task, minPlayerLevel: addition.minPlayerLevel ?? 0 };
  });
}

/**
 * Apply overlay to all tasks
 */
function applyOverlayToTasks(tasks: Task[], overlay: Overlay, gameMode: GameMode): Task[] {
  return tasks
    .map((task) => applyTaskOverlay(task, overlay, gameMode))
    .filter((task): task is Task => task !== null);
}

/**
 * Main example: Fetch tasks with overlay applied
 */
async function main() {
  const gameMode: GameMode = 'regular';
  console.log('Fetching tasks from tarkov.dev...');
  const tasks = await fetchTasksFromTarkovDev(gameMode);
  console.log(`Fetched ${tasks.length} tasks\n`);

  console.log('Fetching overlay...');
  const overlay = await fetchOverlay();
  console.log(`Overlay version: ${overlay.$meta.version}`);
  console.log(`Generated: ${overlay.$meta.generated}\n`);

  // Apply overlay
  const correctedTasks = applyOverlayToTasks(tasks, overlay, gameMode);
  const apiTaskIds = new Set(tasks.map((task) => task.id));
  const addedTasks = getTaskAdditionsForMode(overlay, gameMode, apiTaskIds);
  const allTasks = [...correctedTasks, ...addedTasks];

  // Show corrections applied
  console.log('Corrections applied:');
  for (const task of correctedTasks) {
    const original = tasks.find((t) => t.id === task.id)!;
    if (original.minPlayerLevel !== task.minPlayerLevel) {
      console.log(`  ${task.name}: level ${original.minPlayerLevel} → ${task.minPlayerLevel}`);
    }
  }
  console.log(`  Added tasks: ${addedTasks.length}`);
  console.log(`Active tasks after overlay: ${allTasks.length}`);

  // Show editions (additions)
  if (overlay.editions) {
    console.log('\nEditions available:');
    for (const edition of Object.values(overlay.editions)) {
      console.log(`  ${edition.title} (Stash Level ${edition.defaultStashLevel})`);
    }
  }
}

// Run if executed directly
runDirectly(import.meta.url, main);

export { applyTaskOverride, getTaskAdditionsForMode, getTaskOverrideForMode };
