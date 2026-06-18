/**
 * Example: Applying tarkov-data-overlay to tarkov.dev API responses
 *
 * This demonstrates how consumers can fetch and apply the overlay
 * to get corrected task data.
 */

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
  map?: TarkovMap;
  objectives: TaskObjective[];
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
  map?: TarkovMap;
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
  items?: Record<string, unknown>;
  editions?: Record<string, Edition>;
  $meta: {
    version: string;
    generated: string;
    sha256?: string;
  };
}

// Configuration
const TARKOV_JSON_BASE = 'https://json.tarkov.dev';
const OVERLAY_URL =
  'https://cdn.jsdelivr.net/gh/tarkovtracker-org/tarkov-data-overlay@main/dist/overlay.json';
type GameMode = 'regular' | 'pve';

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
    const response = await fetch(`${TARKOV_JSON_BASE}/${gameMode}/${path}`, {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`tarkov.dev request failed: ${response.status} (${path})`);
    }
    const payload = (await response.json()) as { data?: Record<string, unknown> };
    if (payload.data === undefined) {
      // Translation endpoints (*_en) may legitimately be empty; the core
      // tasks/items/maps endpoints carry the data this example depends on, so
      // a missing `data` there is a contract failure rather than empty content.
      if (path.endsWith('_en')) return {};
      throw new Error(`tarkov.dev response for "${path}" had no "data" field`);
    }
    return payload.data;
  };

  const [tasksData, itemsData, mapsData, tasksEn, itemsEn, mapsEn] = await Promise.all([
    get('tasks'),
    get('items'),
    get('maps'),
    get('tasks_en'),
    get('items_en'),
    get('maps_en'),
  ]);

  const items = (itemsData.items ?? {}) as Record<string, { name?: string }>;
  const maps = (mapsData.maps ?? {}) as Record<string, { name?: string }>;
  const tasks = (tasksData.tasks ?? {}) as Record<string, Record<string, unknown>>;

  const translate = (map: Record<string, string>, key: unknown): string =>
    typeof key === 'string' ? (map[key] ?? key) : '';

  // Return undefined for unresolved references so dangling ids are dropped by
  // the `.filter(Boolean)` paths below instead of surfacing blank names.
  const resolveMap = (id: unknown): TarkovMap | undefined => {
    if (typeof id !== 'string') return undefined;
    const nameKey = maps[id]?.name;
    if (typeof nameKey !== 'string') return undefined;
    return { id, name: translate(mapsEn as Record<string, string>, nameKey) };
  };

  const resolveItem = (id: unknown): { id: string; name: string } | undefined => {
    if (typeof id !== 'string') return undefined;
    const nameKey = items[id]?.name;
    if (typeof nameKey !== 'string') return undefined;
    return { id, name: translate(itemsEn as Record<string, string>, nameKey) };
  };

  return Object.values(tasks).map((raw) => ({
    id: String(raw.id ?? ''),
    name: translate(tasksEn as Record<string, string>, raw.name),
    minPlayerLevel: typeof raw.minPlayerLevel === 'number' ? raw.minPlayerLevel : 0,
    map: resolveMap(raw.map),
    objectives: Array.isArray(raw.objectives)
      ? raw.objectives
          .filter((o): o is Record<string, unknown> => typeof o === 'object' && o !== null)
          .map((o) => ({
            id: String(o.id ?? ''),
            description: translate(tasksEn as Record<string, string>, o.description),
            count: typeof o.count === 'number' ? o.count : undefined,
            maps: Array.isArray(o.maps)
              ? o.maps.map(resolveMap).filter((m): m is TarkovMap => Boolean(m))
              : undefined,
            items: Array.isArray(o.items)
              ? o.items
                  .map(resolveItem)
                  .filter((i): i is { id: string; name: string } => Boolean(i))
              : undefined,
          }))
      : [],
  }));
}

/**
 * Fetch the overlay from jsDelivr CDN
 */
async function fetchOverlay(): Promise<Overlay> {
  const response = await fetch(OVERLAY_URL);
  return response.json();
}

/**
 * Apply overlay corrections to a single task
 *
 * Handles both top-level field corrections and nested objective patches.
 */
function applyTaskOverlay(task: Task, overlay: Overlay): Task | null {
  const taskOverride = overlay.tasks?.[task.id];

  // No override for this task
  if (!taskOverride) return task;

  // Filter out disabled tasks (documented in INTEGRATION.md)
  if ((taskOverride as Record<string, unknown>).disabled === true) return null;

  // Start with a copy of the original task
  const result: Task = { ...task };

  // Apply top-level field overrides (shallow merge)
  for (const [key, value] of Object.entries(taskOverride)) {
    if (key === 'objectives' || key === 'objectivesAdd') continue; // Handle separately

    // Type-safe property assignment
    if (key === 'minPlayerLevel' && typeof value === 'number') {
      result.minPlayerLevel = value;
    } else if (key === 'map' && value) {
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
    result.objectives = [
      ...(result.objectives || []),
      ...taskOverride.objectivesAdd,
    ];
  }

  return result;
}

/**
 * Apply overlay to all tasks
 */
function applyOverlayToTasks(tasks: Task[], overlay: Overlay): Task[] {
  return tasks
    .map((task) => applyTaskOverlay(task, overlay))
    .filter((task): task is Task => task !== null);
}

/**
 * Main example: Fetch tasks with overlay applied
 */
async function main() {
  console.log('Fetching tasks from tarkov.dev...');
  const tasks = await fetchTasksFromTarkovDev();
  console.log(`Fetched ${tasks.length} tasks\n`);

  console.log('Fetching overlay...');
  const overlay = await fetchOverlay();
  console.log(`Overlay version: ${overlay.$meta.version}`);
  console.log(`Generated: ${overlay.$meta.generated}\n`);

  // Apply overlay
  const correctedTasks = applyOverlayToTasks(tasks, overlay);

  // Show corrections applied
  console.log('Corrections applied:');
  for (const task of correctedTasks) {
    const original = tasks.find((t) => t.id === task.id)!;
    if (original.minPlayerLevel !== task.minPlayerLevel) {
      console.log(
        `  ${task.name}: level ${original.minPlayerLevel} → ${task.minPlayerLevel}`
      );
    }
  }

  // Show editions (additions)
  if (overlay.editions) {
    console.log('\nEditions available:');
    for (const edition of Object.values(overlay.editions)) {
      console.log(`  ${edition.title} (Stash Level ${edition.defaultStashLevel})`);
    }
  }
}

// Run if executed directly
main().catch(console.error);
