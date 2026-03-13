# Integration Guide

How to use tarkov-data-overlay in your application.

---

## Fetching the Overlay

The overlay is distributed via jsDelivr CDN:

```bash
https://cdn.jsdelivr.net/gh/tarkovtracker-org/tarkov-data-overlay@main/dist/overlay.json
```

### Example (JavaScript/TypeScript)

```typescript
const OVERLAY_URL = 'https://cdn.jsdelivr.net/gh/tarkovtracker-org/tarkov-data-overlay@main/dist/overlay.json';

async function fetchOverlay() {
  const response = await fetch(OVERLAY_URL);
  return response.json();
}
```

---

## Overlay Structure

```json
{
  "tasks": {
    "<task-id>": {
      "minPlayerLevel": 10,
      "map": { "id": "...", "name": "Customs" }
    }
  },
  "tasksAdd": {
    "<added-task-id>": {
      "id": "<added-task-id>",
      "name": "Missing in Action",
      "wikiLink": "https://escapefromtarkov.fandom.com/wiki/Missing_in_Action",
      "trader": { "id": "...", "name": "Prapor" },
      "map": { "id": "...", "name": "Woods" },
      "objectives": [{ "id": "...", "description": "Stash ..." }]
    }
  },
  "itemsAdd": {
    "<added-item-id>": {
      "id": "<added-item-id>",
      "name": "Event Item"
    }
  },
  "storyChapters": {
    "<chapter-id>": {
      "id": "<chapter-id>",
      "name": "Tour"
    }
  },
  "modes": {
    "regular": {
      "tasks": {
        "<task-id>": {
          "objectives": {
            "<objective-id>": { "count": 24 }
          }
        }
      }
    },
    "pve": {
      "tasks": {
        "<task-id>": {
          "objectives": {
            "<objective-id>": { "count": 36 }
          }
        }
      },
      "tasksAdd": {
        "<mode-added-task-id>": { "id": "<mode-added-task-id>", "name": "..." }
      }
    }
  },
  "editions": {
    "standard": { "id": "standard", "title": "Standard Edition", ... },
    "unheard": { "id": "unheard", "title": "The Unheard Edition", ... }
  },
  "$meta": {
    "version": "1.0.0",
    "generated": "2025-12-19T00:00:00.000Z",
    "sha256": "..."
  }
}
```

---

## Applying the Overlay

### Basic Merge (Top-Level Fields)

For simple field corrections, use shallow merge:

```typescript
function applyOverlay(baseTask: Task, overlay: Overlay): Task {
  const taskOverride = overlay.tasks?.[baseTask.id];
  if (!taskOverride) return baseTask;

  return { ...baseTask, ...taskOverride };
}
```

### Filtering Disabled Tasks

Some tasks are marked as `disabled: true` when they've been removed from standard gameplay (event-only quests, removed content, etc.). Filter them out:

```typescript
function applyOverlay(baseTask: Task, overlay: Overlay): Task | null {
  const taskOverride = overlay.tasks?.[baseTask.id];
  if (!taskOverride) return baseTask;

  // Filter out disabled tasks
  if (taskOverride.disabled === true) return null;

  return { ...baseTask, ...taskOverride };
}

// Usage with filtering
const activeTasks = tasks
  .map(task => applyOverlay(task, overlay))
  .filter((task): task is Task => task !== null);
```

### With Objective Patches

For tasks with objective-level corrections:

```typescript
function applyTaskOverlay(baseTask: Task, overlay: Overlay): Task {
  const taskOverride = overlay.tasks?.[baseTask.id];
  if (!taskOverride) return baseTask;

  const result = { ...baseTask };

  // Apply top-level fields
  for (const [key, value] of Object.entries(taskOverride)) {
    if (key === 'objectives' || key === 'objectivesAdd') continue; // Handle separately
    (result as any)[key] = value;
  }

  // Apply objective patches (ID-keyed object)
  if (taskOverride.objectives && typeof taskOverride.objectives === 'object') {
    result.objectives = baseTask.objectives.map(obj => {
      const patch = (taskOverride.objectives as Record<string, any>)[obj.id];
      return patch ? { ...obj, ...patch } : obj;
    });
  }

  // Append missing objectives
  if (taskOverride.objectivesAdd && Array.isArray(taskOverride.objectivesAdd)) {
    result.objectives = [
      ...(result.objectives || []),
      ...taskOverride.objectivesAdd,
    ] as any;
  }

  return result;
}
```

### With Added Objectives

If tarkov.dev is missing objectives (like new Collector items), you can append
them using `objectivesAdd` in the overlay. The merge example above already
handles this by appending `objectivesAdd` to the objective list.

---

## Applying Mode-Specific Data (PVP vs PVE)

Some corrections differ by game mode. The overlay stores these under
`modes.regular` and `modes.pve`.

- Apply shared data first (`tasks`, `tasksAdd`)
- Then apply mode-specific data (`modes[gameMode].tasks`, `modes[gameMode].tasksAdd`)
- Use the same `gameMode` value for both tarkov.dev API query and overlay merge

```typescript
type GameMode = 'regular' | 'pve';

function getTaskOverrideForMode(
  taskId: string,
  overlay: Overlay,
  gameMode: GameMode
) {
  const shared = overlay.tasks?.[taskId] ?? {};
  const modeSpecific = overlay.modes?.[gameMode]?.tasks?.[taskId] ?? {};
  const merged = { ...shared, ...modeSpecific };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function getTaskAdditionsForMode(overlay: Overlay, gameMode: GameMode): TaskAddition[] {
  return [
    ...Object.values(overlay.tasksAdd ?? {}),
    ...Object.values(overlay.modes?.[gameMode]?.tasksAdd ?? {}),
  ];
}
```

---

## Using Additions (New Data)

For data not in tarkov.dev (like game editions):

```typescript
// Editions are additions, not corrections
const editions = overlay.editions;

// Use directly - no merging needed
const unheardEdition = editions?.unheard;
console.log(unheardEdition?.defaultStashLevel); // 5
```

### Task Additions (Event-Only / Missing from API)

Tasks that are not present in tarkov.dev are provided under `tasksAdd`. Consumers
should treat these as new tasks and append them to the API task list.

```typescript
const addedTasks = Object.values(overlay.tasksAdd ?? {});
const allTasks = [...tasksFromApi, ...addedTasks];
```

---

## Full Integration Example

```typescript
import type { Task, Overlay } from './types';

const TARKOV_DEV_API = 'https://api.tarkov.dev/graphql';
const OVERLAY_URL = 'https://cdn.jsdelivr.net/gh/tarkovtracker-org/tarkov-data-overlay@main/dist/overlay.json';
type GameMode = 'regular' | 'pve';

async function fetchTasks(gameMode: GameMode): Promise<Task[]> {
  // Fetch from tarkov.dev
  const response = await fetch(TARKOV_DEV_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: `query($gameMode: GameMode) {
        tasks(lang: en, gameMode: $gameMode) {
          id
          name
          minPlayerLevel
          map { id name }
          objectives { id count ... on TaskObjectiveItem { items { id name } } }
        }
      }`,
      variables: { gameMode },
    })
  });
  const { data } = await response.json();
  return data.tasks;
}

async function fetchOverlay(): Promise<Overlay> {
  const response = await fetch(OVERLAY_URL);
  return response.json();
}

function applyTaskOverlayForMode(
  task: Task,
  overlay: Overlay,
  gameMode: GameMode
): Task {
  const taskOverride = getTaskOverrideForMode(task.id, overlay, gameMode);
  if (!taskOverride) return task;

  // Reuse applyTaskOverlay from earlier example with a mode-merged override.
  return applyTaskOverlay(task, { ...overlay, tasks: { [task.id]: taskOverride } });
}

async function getTasksWithOverlay(gameMode: GameMode): Promise<Task[]> {
  const [tasks, overlay] = await Promise.all([
    fetchTasks(gameMode),
    fetchOverlay()
  ]);

  const patchedTasks = tasks.map(task => applyTaskOverlayForMode(task, overlay, gameMode));

  const addedTasks = getTaskAdditionsForMode(overlay, gameMode);
  return [...patchedTasks, ...addedTasks];
}
```

---

## Caching Recommendations

- Cache the overlay for **1-12 hours** (data changes infrequently)
- Use `$meta.sha256` to detect changes
- Consider caching at the edge (Cloudflare, Vercel, etc.)

---

## TypeScript Types

```typescript
interface Overlay {
  tasks?: Record<string, TaskOverride>;
  tasksAdd?: Record<string, TaskAddition>;
  modes?: Partial<Record<GameMode, ModeOverlay>>;
  items?: Record<string, ItemOverride>;
  itemsAdd?: Record<string, ItemAddition>;
  editions?: Record<string, Edition>;
  storyChapters?: Record<string, StoryChapter>;
  $meta: {
    version: string;
    generated: string;
    sha256?: string;
  };
}

type GameMode = 'regular' | 'pve';

interface ModeOverlay {
  tasks?: Record<string, TaskOverride>;
  tasksAdd?: Record<string, TaskAddition>;
}

interface TaskOverride {
  minPlayerLevel?: number;
  name?: string;
  wikiLink?: string;
  disabled?: boolean;
  map?: { id: string; name: string } | null;
  objectives?: Record<string, ObjectiveOverride>;
  objectivesAdd?: ObjectiveAdd[];
  // ... other fields
}

interface TaskAddition {
  id: string;
  name: string;
  wikiLink: string;
  trader: { id?: string; name: string };
  map?: { id: string; name: string } | null;
  objectives: TaskObjectiveAdd[];
  // ... other fields
}

interface TaskObjectiveAdd {
  id: string;
  description: string;
  count?: number;
  maps?: Array<{ id: string; name: string }>;
  item?: { id: string; name: string; shortName?: string };
  markerItem?: { id: string; name: string; shortName?: string };
}

interface ObjectiveOverride {
  count?: number;
  maps?: Array<{ id: string; name: string }>;
  items?: Array<{ id?: string; name: string }>;
  // ... other fields
}

interface ObjectiveAdd {
  id: string;
  count?: number;
  description: string;
  maps?: Array<{ id: string; name: string }>;
  items?: Array<{ id?: string; name: string }>;
}

// Note: objectivesAdd allows name-only items; objective patches should include IDs.

interface Edition {
  id: string;
  value: number;
  title: string;
  defaultStashLevel: number;
  defaultCultistCircleLevel: number;
  traderRepBonus: Record<string, number>;
  exclusiveTaskIds?: string[];
  excludedTaskIds?: string[];
}

interface ItemAddition {
  id: string;
  name: string;
  shortName?: string;
}

interface StoryChapter {
  id: string;
  name: string;
  normalizedName: string;
}
```
