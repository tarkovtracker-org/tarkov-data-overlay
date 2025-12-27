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
  stashLevel: number;
  cultistCircleLevel: number;
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
const TARKOV_DEV_API = 'https://api.tarkov.dev/graphql';
const OVERLAY_URL =
  'https://cdn.jsdelivr.net/gh/tarkovtracker-org/tarkov-data-overlay@main/dist/overlay.json';

/**
 * Fetch tasks from tarkov.dev GraphQL API
 */
async function fetchTasksFromTarkovDev(): Promise<Task[]> {
  const query = `
    query {
      tasks(lang: en) {
        id
        name
        minPlayerLevel
        map { id name }
        objectives {
          id
          description
          ... on TaskObjectiveItem { count items { id name } }
          ... on TaskObjectiveShoot { count }
          maps { id name }
        }
      }
    }
  `;

  const response = await fetch(TARKOV_DEV_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });

  const { data } = await response.json();
  return data.tasks;
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
      console.log(`  ${edition.title} (Stash Level ${edition.stashLevel})`);
    }
  }
}

// Run if executed directly
main().catch(console.error);
