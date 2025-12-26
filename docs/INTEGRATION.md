# Integration Guide

How to use tarkov-data-overlay in your application.

---

## Fetching the Overlay

The overlay is distributed via jsDelivr CDN:

```
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

## Using Additions (New Data)

For data not in tarkov.dev (like game editions):

```typescript
// Editions are additions, not corrections
const editions = overlay.editions;

// Use directly - no merging needed
const unheardEdition = editions?.unheard;
console.log(unheardEdition?.stashLevel); // 5
```

---

## Full Integration Example

```typescript
import type { Task, Overlay } from './types';

const TARKOV_DEV_API = 'https://api.tarkov.dev/graphql';
const OVERLAY_URL = 'https://cdn.jsdelivr.net/gh/tarkovtracker-org/tarkov-data-overlay@main/dist/overlay.json';

async function fetchTasks(): Promise<Task[]> {
  // Fetch from tarkov.dev
  const response = await fetch(TARKOV_DEV_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: `{ tasks { id name minPlayerLevel map { id name } objectives { id count ... on TaskObjectiveItem { items { id name } } } } }`
    })
  });
  const { data } = await response.json();
  return data.tasks;
}

async function fetchOverlay(): Promise<Overlay> {
  const response = await fetch(OVERLAY_URL);
  return response.json();
}

async function getTasksWithOverlay(): Promise<Task[]> {
  const [tasks, overlay] = await Promise.all([
    fetchTasks(),
    fetchOverlay()
  ]);

  return tasks.map(task => applyTaskOverlay(task, overlay));
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
  items?: Record<string, ItemOverride>;
  editions?: Record<string, Edition>;
  $meta: {
    version: string;
    generated: string;
    sha256?: string;
  };
}

interface TaskOverride {
  minPlayerLevel?: number;
  name?: string;
  wikiLink?: string;
  disabled?: boolean;
  map?: { id: string; name: string };
  objectives?: Record<string, ObjectiveOverride>;
  objectivesAdd?: ObjectiveAdd[];
  // ... other fields
}

interface ObjectiveOverride {
  count?: number;
  maps?: Array<{ id: string; name: string }>;
  items?: Array<{ id?: string; name: string }>;
  // ... other fields
}

interface ObjectiveAdd {
  id?: string;
  count?: number;
  description?: string;
  maps?: Array<{ id: string; name: string }>;
  items?: Array<{ id?: string; name: string }>;
}

interface Edition {
  id: string;
  title: string;
  stashLevel: number;
  cultistCircleLevel: number;
  traderRepBonus: Record<string, number>;
}
```
