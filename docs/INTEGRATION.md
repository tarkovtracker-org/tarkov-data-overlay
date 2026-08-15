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
const OVERLAY_URL =
  'https://cdn.jsdelivr.net/gh/tarkovtracker-org/tarkov-data-overlay@main/dist/overlay.json';

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
      "prestige": {
        "<prestige-id>": {
          "prestigeLevel": 5,
          "conditions": {
            "<condition-id>": {
              "type": "taskStatus",
              "task": "new_beginning_prestige_5",
              "status": ["complete"]
            }
          },
          "storyRequirements": [
            {
              "type": "storyChapterStatus",
              "storyChapter": "tour",
              "name": "Tour",
              "status": ["complete"]
            }
          ]
        }
      },
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
    },
    "pvp-season": {
      "tasks": {
        "<task-id>": { "minPlayerLevel": 5 }
      }
    }
  },
  "seasonalPerks": {
    "<perk-id>": {
      "id": "<perk-id>",
      "type": "personal",
      "name": "Hemophilia",
      "description": "• Bleeding chance is increased by 25%",
      "points": 2,
      "mutuallyExclusiveSeasonalPerkIds": ["<other-perk-id>"],
      "effects": [
        { "effectId": "bleeding_chance_multiplicator", "multiplicator": 1.25 }
      ]
    }
  },
  "craftsAdd": {
    "<craft-id>": {
      "id": "<craft-id>",
      "station": "<station-id>",
      "level": 1,
      "taskUnlock": null,
      "duration": 600,
      "requiredItems": [{ "item": "<item-id>", "count": 1, "attributes": {} }],
      "requiredQuestItems": [],
      "gameEditions": [],
      "productItem": { "item": "<item-id>", "count": 1, "attributes": {} }
    }
  },
  "locales": {
    "en": {
      "tasks": {
        "<task-id>": {
          "name": "New Beginning",
          "wikiLink": "https://escapefromtarkov.fandom.com/wiki/New_Beginning_(Prestige_1)",
          "objectives": {
            "<objective-id>": { "description": "Eliminate 50 Scavs" }
          }
        }
      },
      "items": {
        "<item-id>": { "name": "Corrected English Item Name" }
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
  .map((task) => applyOverlay(task, overlay))
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
    result.objectives = baseTask.objectives.map((obj) => {
      const patch = (taskOverride.objectives as Record<string, any>)[obj.id];
      return patch ? { ...obj, ...patch } : obj;
    });
  }

  // Append missing objectives
  if (taskOverride.objectivesAdd && Array.isArray(taskOverride.objectivesAdd)) {
    result.objectives = [...(result.objectives || []), ...taskOverride.objectivesAdd] as any;
  }

  return result;
}
```

### With Added Objectives

If tarkov.dev is missing objectives (like new Collector items), you can append
them using `objectivesAdd` in the overlay. The merge example above already
handles this by appending `objectivesAdd` to the objective list.

---

## Applying Trader Requirements

Trader requirements use json.tarkov.dev's **discriminated** shape. Every entry
identifies whether it is a Loyalty Level (`level`, LL1-LL4) or a trader
reputation threshold (`reputation`, incl. scav karma), because the value range
alone is ambiguous — reputation entries serve positive, zero, and negative
values, with `>=`, `<=`, and `<` comparators.

```typescript
interface TraderRequirement {
  id: string; // upstream requirement id, or a stable 'overlay.'-prefixed synthetic id
  requirementType: 'level' | 'reputation';
  compareMethod: '>=' | '<=' | '>' | '<' | '='; // level requires '>='
  value: number; // level requires an integer from 1 through 4
  trader: { id: string; name: string };
}
```

### Merge semantics (patch-by-id)

Merge requirements by `id`, not by array position, so an overlay cannot
accidentally strip the `level`/`reputation` discriminator that was present
upstream:

```typescript
// Call only when `override.traderRequirements !== undefined`: an absent field
// means "no change", an empty array means "clear".
function applyTraderRequirements(
  baseReqs: TraderRequirement[],
  overrideReqs: TraderRequirement[]
): TraderRequirement[] {
  if (overrideReqs.length === 0) return []; // clears the upstream requirements
  const byId = new Map(baseReqs.map((r) => [r.id, r]));
  for (const req of overrideReqs) {
    byId.set(req.id, { ...byId.get(req.id), ...req }); // patch existing, else append
  }
  return [...byId.values()];
}
```

- **Synthetic requirement IDs** use the `overlay.` prefix (for example,
  `overlay.<taskId>.<traderId>.<type>.<method>.<value>`). The prefix identifies
  the ID as synthetic; it does not imply that the requirement itself was
  authored by the overlay. Overlay-only requirements use this form, and the
  API adapter also assigns it when an upstream requirement is missing an ID.
  Semantically identical repeated id-less upstream entries keep the base ID for
  the first occurrence and add `.occurrence.<n>` from the second occurrence so
  they remain distinct and deterministic. Synthetic IDs never collide with an
  upstream ID (`<24-hex>`, or the composite `<24-hex taskId>-<24-hex traderId>`
  tarkov.dev emits for some reputation gates). Both ID shapes are enforced by
  the task schemas, and `npm run validate` additionally checks that each
  synthetic ID is derived from the entry it labels (and that no two
  requirements in one task share an ID), so a malformed or drifted ID fails
  validation.
- **Upstream-preserved requirements** keep their upstream `id`, so a correction
  patches the existing requirement in place.
- **Clearing requirements** is expressed by an empty array
  (`traderRequirements: []`), which replaces the upstream array. An absent
  `traderRequirements` field means "no change".
- **Do not** re-derive the semantic from `trader` + `value`: Fence LL1 and Fence
  `reputation >= 1` are distinct requirements. Switch evaluation on
  `requirementType`, not on value range or trader identity.

### Migration / compatibility

The new fields (`id`, `requirementType`, `compareMethod`) are additive: existing
consumers that only read `trader` + `value` keep working, and a wholesale
`{ ...baseTask, ...override }` replace-array merge is still correct for the
current data. To benefit from the discriminated schema, migrate the
`traderRequirements` merge to patch-by-id as shown above. Requirements that were
mislabeled as Loyalty Level but are actually reputation gates were removed from
the overlay (upstream already serves the correct discriminated entries), so a
consumer that switches on `requirementType` will not see them regress.

---

## Applying Mode-Specific Data (PVP vs PVE vs Seasonal)

Some corrections differ by game mode. The overlay stores these under
`modes.regular`, `modes.pve`, and `modes["pvp-season"]`. The compiled overlay
always includes all three keys, matching `json.tarkov.dev/endpoints`; a mode with
no current corrections is represented by an empty object.

- Apply shared data first (`tasks`, `tasksAdd`)
- Then apply mode-specific data (`modes[gameMode].tasks`, `modes[gameMode].tasksAdd`)
- Use the same `gameMode` value for both the tarkov.dev data fetch and overlay merge

```typescript
type GameMode = 'regular' | 'pve' | 'pvp-season';

function getTaskOverrideForMode(taskId: string, overlay: Overlay, gameMode: GameMode) {
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

> **Seasonal mode = `pvp-season`.** BSG's Seasonal Character (EFT patch 1.1.0.0)
> is served by tarkov.dev like any other mode — `json.tarkov.dev/pvp-season/*`,
> listed under `gameModes` at `json.tarkov.dev/endpoints`. Fetch and merge it
> exactly as you would `regular` or `pve`. Note the hyphenated key requires
> bracket access (`overlay.modes["pvp-season"]`). One thing tarkov.dev does
> _not_ serve for this mode is seasonal perks — those are a separate top-level
> addition (`seasonalPerks`, see below), not part of the `modes` section.

---

## Applying Seasonal Perks

`seasonalPerks` is a top-level addition (not a `modes` section) because
tarkov.dev has no seasonal-perks endpoint for the `pvp-season` mode. It is an
object keyed by the perk id:

```typescript
interface SeasonalPerkEffect {
  effectId: string; // e.g. "pmc_experience_multiplicator"
  multiplicator?: number; // present for multiplicative effects
  intValue?: number; // present for e.g. skill_level_preset
  skillIds?: string[]; // tarkov.dev skill ids (resolve names via tarkov.dev)
  itemFilter?: {
    // tarkov.dev ItemFilters shape - arrays of tarkov.dev ids (names resolve via locale)
    allowedCategories?: string[];
    allowedItems?: string[];
    excludedCategories?: string[];
    excludedItems?: string[];
  };
  [key: string]: unknown; // other BSG effect-specific fields
}

interface SeasonalPerk {
  id: string;
  type: string; // tier: "common" | "personal"
  name: string;
  description?: string;
  points?: number | null; // perk-point value; null = none
  mutuallyExclusiveSeasonalPerkIds?: string[];
  effects?: SeasonalPerkEffect[];
}

// Only meaningful when the player is on a Seasonal Character.
const perks = Object.values(overlay.seasonalPerks ?? {});
const commonPerks = perks.filter((p) => p.type === 'common');
```

Perks with a non-empty `mutuallyExclusiveSeasonalPerkIds` cannot be selected
together; enforce that when presenting a perk picker. All references
(`skillIds`, `itemFilter`, trader ids, etc.) are tarkov.dev ids — resolve their
display names through tarkov.dev's own data/locale, do not expect names here.
The perk `name`/`description` are the only inline strings (English), because the
perks do not exist upstream to resolve against. One perk's `itemFilter`
references an item tarkov.dev does not serve yet; resolve `itemFilter` ids
against `itemsAdd` as a fallback (see [Resolving Added Items](#resolving-added-items)).

---

## Applying Added Crafts

`craftsAdd` supplies hideout crafts missing from tarkov.dev, keyed by craft id,
in tarkov.dev's **static-JSON** craft shape (all tarkov.dev ids):

```typescript
interface Craft {
  id: string;
  station: string; // tarkov.dev HideoutStation id
  level: number;
  duration: number; // production time in seconds
  requiredItems: Array<{
    item: string; // tarkov.dev item id
    count: number;
    attributes?: { tool?: boolean };
  }>;
  productItem: { item: string; count: number; attributes?: Record<string, unknown> };
  requiredQuestItems?: string[];
  gameEditions?: string[];
  // Present (as null) on quest-gated crafts whose unlocking task id is unknown;
  // omitted on crafts with no task unlock, matching tarkov.dev.
  taskUnlock?: string | null;
}
```

Merge by id:

```typescript
const byId = new Map(tarkovDevCrafts.map((c) => [c.id, c]));
const crafts = [
  ...tarkovDevCrafts,
  ...Object.values(overlay.craftsAdd ?? {}).filter((c) => !byId.has(c.id)),
];
```

Notes and caveats:

- Shape matches `json.tarkov.dev/{mode}/crafts` (uses `productItem`, `station`
  is an id). If you consume the **GraphQL** API instead, map `productItem` →
  `rewardItems` and the `station` id → the `HideoutStation` object.
- These are patch 1.1.0.0 crafts absent upstream (e.g. the Black Division
  decryption chain in the Intelligence Center). Merge-by-id makes them drop out
  automatically once tarkov.dev serves them.
- **Unlock caveat:** the quest-gated crafts carry `taskUnlock: null` — they are
  unlocked by a quest in-game, but the source does not expose which one, so the
  id is left null as a fillable placeholder (tarkov.dev serves a task-id string
  here). Until it is filled, treat those crafts as _available once their
  (unstated) quest is done_, not as unconditionally available — relevant for
  progression tools, not for recipe/ingredient lookups (inputs, output, station,
  level and duration are correct). Crafts with no task unlock omit the field,
  matching tarkov.dev.

---

## Resolving Added Items

`itemsAdd` carries items that overlay additions reference but that tarkov.dev
does not serve yet in **any** mode (`regular`, `pve`, `pvp-season`). Without it,
those ids have no name anywhere and surface as raw 24-hex strings.

```typescript
interface ItemAddition {
  id: string; // tarkov.dev/BSG item template id (matches the key)
  name: string; // English display name
  shortName?: string; // English short name (inventory label)
  description?: string; // English description
}
```

Resolve item ids upstream first, then fall back to `itemsAdd`:

```typescript
// The guide does not define an upstream `Item` type, so the map value uses an
// inline structural shape: at minimum an id + display name, plus whatever other
// fields tarkov.dev serves.
function resolveItem(
  id: string,
  apiItemsById: Map<string, { id: string; name: string; [key: string]: unknown }>,
  overlay: Overlay
) {
  return apiItemsById.get(id) ?? overlay.itemsAdd?.[id];
}
```

Notes and caveats:

- **English only.** tarkov.dev's locale system stays the source of truth for
  every other language; these ids resolve normally there once upstream ingests
  them. Do not translate from these strings — treat them as a display fallback.
- **Upstream-first ordering matters.** Once tarkov.dev serves an item, its data
  is richer (icons, prices, categories) and authoritative. Checking the API
  before the overlay makes each entry become dead weight rather than a stale
  override that shadows good upstream data.
- These entries are deleted as upstream catches up; `npm run check-overrides`
  flags any that tarkov.dev now serves (`NOW IN API - remove the addition`).
- **Item-resolution caveat:** 7 of these crafts reference patch 1.1.0.0 items
  that tarkov.dev does not serve yet in any mode (all 7 products, plus some
  inputs — the Black Division chain, Moreman's tapes, the topographic intel
  maps). Resolving those ids against tarkov.dev alone yields nothing, so a naive
  lookup renders a raw 24-hex id. **Resolve item ids against `itemsAdd` as a
  fallback** (see [Resolving Added Items](#resolving-added-items)) — it carries
  the English name/shortName/description for exactly these ids.

---

## Applying Locale Overrides

Sometimes a specific tarkov.dev locale bundle is broken — for example, the
English bundle currently returns the German string "Neuanfang" for the New
Beginning prestige quest names. The overlay's `locales` section carries
fixes for exactly these cases, keyed by locale code
(`locales[localeCode][entityType][entityId][fieldName]`).

Locale overrides are different from data overrides:

- A regular override (e.g. `tasks[id].name`) says "the canonical value is X
  regardless of locale".
- A locale override (e.g. `locales.en.tasks[id].name`) says "the `en` bundle
  specifically should show X" — other locale bundles may already be correct.

Rules for applying them:

- Apply locale overrides **after** data overrides; they take precedence for
  locale-sensitive fields (`name`, `shortName`, `description`, `wikiLink`,
  objective `description`) when rendering that locale.
- Only apply the section matching your active locale. If you render `de`,
  ignore `locales.en` entirely.
- Locale overrides are **not** mode-specific — locale bundles are shared
  across `regular` and `pve`, so apply them in both modes.
- Entries are sparse: only fields broken in that locale bundle are present.

```typescript
function applyLocaleOverlay(
  task: Task, // task with data overrides already applied
  overlay: Overlay,
  locale: string // active rendering locale, e.g. 'en'
): Task {
  const patch = overlay.locales?.[locale]?.tasks?.[task.id];
  if (!patch) return task;

  const result = { ...task };

  // Apply top-level locale-sensitive fields (name, wikiLink)
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'objectives') continue; // Handle separately
    (result as any)[key] = value;
  }

  // Apply ID-keyed objective description patches
  if (patch.objectives) {
    result.objectives = (task.objectives ?? []).map((obj) => {
      const objPatch = patch.objectives?.[obj.id];
      return objPatch ? { ...obj, ...objPatch } : obj;
    });
  }

  return result;
}

// Merge order: base -> data overrides -> mode overrides -> locale overrides
const task = applyLocaleOverlay(
  applyTaskOverlayForMode(baseTask, overlay, gameMode),
  overlay,
  activeLocale
);
```

The same pattern applies to the other entity types under `locales`
(`items`, `traders`, `maps`, `prestige`, `storyChapters`): shallow-merge the
patch over the entity, handling ID-keyed `objectives` patches separately
where present.

---

## Applying Prestige Corrections

tarkov.dev exposes prestige levels as a `prestige` array, each item shaped like
`{ id, prestigeLevel, conditions: [{ id, type, ... }] }`. It currently misses two
kinds of in-game requirements:

- the story-chapter requirements shown on the in-game prestige screen (`Tour`,
  `Falling Skies`, `The Ticket`, etc.)
- the New Beginning (Prestige 5/6) quests; its Prestige 5/6 `taskStatus`
  condition points at Collector (`5c51aac186f77432ea65c552`) only, but the game
  requires both Collector and the matching New Beginning quest

The missing quests are provided in `tasksAdd` (`new_beginning_prestige_5` /
`new_beginning_prestige_6`). The story requirements are provided as an
authoritative `storyRequirements` array; an empty array means there are no
story requirements for that prestige level.

The overlay's `prestige` section is keyed by prestige ID. Each entry patches the
matching prestige item; `conditions` is keyed by condition ID. Keys matching
upstream condition IDs patch existing conditions, while overlay-only keys are
synthetic conditions to append. Apply it by merging top-level fields, then
patching/appending conditions by ID:

```typescript
type PrestigeCondition = {
  id: string;
  type: string;
  task?: string;
  status?: string[];
  [k: string]: unknown;
};
type Prestige = {
  id: string;
  prestigeLevel: number;
  conditions: PrestigeCondition[];
  [k: string]: unknown;
};

function applyPrestigeOverlay(base: Prestige, overlay: Overlay): Prestige {
  const override = overlay.modes.regular.prestige?.[base.id];
  if (!override) return base;

  const { conditions: condPatches, ...topLevel } = override;
  const result: Prestige = { ...base, ...topLevel };

  if (condPatches) {
    const remaining = new Map(Object.entries(condPatches));
    result.conditions = base.conditions.map((cond) => {
      const patch = remaining.get(cond.id);
      remaining.delete(cond.id);
      return patch ? { ...cond, ...patch } : cond;
    });
    result.conditions.push(...Array.from(remaining, ([id, patch]) => ({ id, ...patch })));
  }
  return result;
}
```

The corrected or appended `task` may be an overlay `tasksAdd` id (e.g.
`new_beginning_prestige_5`) rather than a tarkov.dev task id, so resolve prestige
task references against the merged task list (`tasksFromApi` + `tasksAdd`). Use
`storyRequirements` as the source of truth for story-chapter requirements instead
of inferring them from chapter ordering.

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

// The legacy api.tarkov.dev/graphql endpoint has been superseded by static
// per-mode JSON files at json.tarkov.dev. Each endpoint returns
// `{ data, translations }`; entity references are plain id strings and english
// strings resolve through a sibling `_en` endpoint. This example resolves only
// the task name + map; a full consumer resolves items/traders/prestige/rewards
// the same way (see src/lib/tarkov-api.ts for the complete adapter).
const TARKOV_JSON_BASE = 'https://json.tarkov.dev';
const OVERLAY_URL =
  'https://cdn.jsdelivr.net/gh/tarkovtracker-org/tarkov-data-overlay@main/dist/overlay.json';
type GameMode = 'regular' | 'pve' | 'pvp-season';

async function fetchTasks(gameMode: GameMode): Promise<Task[]> {
  const get = async (path: string): Promise<Record<string, unknown>> => {
    const response = await fetch(`${TARKOV_JSON_BASE}/${gameMode}/${path}`, {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`tarkov.dev request failed: ${response.status} (${path})`);
    const payload = await response.json();
    const isRecord = (value: unknown): value is Record<string, unknown> =>
      typeof value === 'object' && value !== null && !Array.isArray(value);
    // Translation endpoints (*_en) may be empty; core endpoints must carry data.
    const data = isRecord(payload) ? payload.data : undefined;
    if (!isRecord(data)) {
      if (path.endsWith('_en')) return {};
      throw new Error(`tarkov.dev response for "${path}" had no "data" object`);
    }
    return data;
  };

  const [tasksData, mapsData, tasksEn, mapsEn] = await Promise.all([
    get('tasks'),
    get('maps'),
    get('tasks_en'),
    get('maps_en'),
  ]);

  const maps = (mapsData.maps ?? {}) as Record<string, { name?: string }>;
  const tasks = (tasksData.tasks ?? {}) as Record<string, Record<string, unknown>>;
  const translate = (map: Record<string, string>, key: unknown): string =>
    typeof key === 'string' ? (map[key] ?? key) : '';

  return Object.values(tasks).map((raw) => ({
    ...raw,
    name: translate(tasksEn as Record<string, string>, raw.name),
    map:
      typeof raw.map === 'string'
        ? { id: raw.map, name: translate(mapsEn as Record<string, string>, maps[raw.map]?.name) }
        : raw.map,
  })) as unknown as Task[];
}

async function fetchOverlay(): Promise<Overlay> {
  const response = await fetch(OVERLAY_URL);
  return response.json();
}

function applyTaskOverlayForMode(task: Task, overlay: Overlay, gameMode: GameMode): Task {
  const taskOverride = getTaskOverrideForMode(task.id, overlay, gameMode);
  if (!taskOverride) return task;

  // Reuse applyTaskOverlay from earlier example with a mode-merged override.
  return applyTaskOverlay(task, { ...overlay, tasks: { [task.id]: taskOverride } });
}

async function getTasksWithOverlay(gameMode: GameMode): Promise<Task[]> {
  const [tasks, overlay] = await Promise.all([fetchTasks(gameMode), fetchOverlay()]);

  const patchedTasks = tasks.map((task) => applyTaskOverlayForMode(task, overlay, gameMode));

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
  modes: Record<GameMode, ModeOverlay>; // all upstream modes are always present
  items?: Record<string, ItemOverride>;
  itemsAdd?: Record<string, ItemAddition>;
  traders?: Record<string, TraderOverride>;
  hideout?: Record<string, HideoutOverride>;
  editions?: Record<string, Edition>;
  storyChapters?: Record<string, StoryChapter>;
  // Seasonal (pvp-season) data tarkov.dev does not serve; see the sections above.
  seasonalPerks?: Record<string, SeasonalPerk>;
  craftsAdd?: Record<string, Craft>;
  // Per-locale corrections keyed by tarkov.dev locale code (en, de, fr, ...)
  locales?: Record<string, LocaleOverlay>;
  $meta: {
    version: string;
    generated: string;
    sha256?: string;
  };
}

type GameMode = 'regular' | 'pve' | 'pvp-season';

interface ModeOverlay {
  tasks?: Record<string, TaskOverride>;
  tasksAdd?: Record<string, TaskAddition>;
  prestige?: Record<string, PrestigeOverride>; // currently regular-only upstream
}

// Sparse fixes for one broken locale bundle; apply after data overrides,
// only when rendering the matching locale.
interface LocaleOverlay {
  tasks?: Record<
    string,
    {
      name?: string;
      wikiLink?: string;
      objectives?: Record<string, { description?: string }>;
    }
  >;
  items?: Record<
    string,
    {
      name?: string;
      shortName?: string;
      description?: string;
      wikiLink?: string;
    }
  >;
  traders?: Record<string, { name?: string; description?: string }>;
  maps?: Record<string, { name?: string; description?: string }>;
  prestige?: Record<string, { name?: string }>;
  storyChapters?: Record<
    string,
    {
      name?: string;
      description?: string;
      objectives?: Record<string, { description?: string }>;
    }
  >;
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

interface ItemOverride {
  // Corrected fields keyed by tarkov.dev item properties
  [fieldName: string]: any;
}

interface TraderOverride {
  // Corrected fields keyed by tarkov.dev trader properties
  [fieldName: string]: any;
}

interface HideoutOverride {
  // Corrected fields keyed by tarkov.dev hideout properties
  [fieldName: string]: any;
}

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
  description?: string;
}

interface StoryChapter {
  id: string;
  name: string;
  normalizedName: string;
}

interface PrestigeOverride {
  prestigeLevel?: number;
  name?: string;
  // Per-condition patches keyed by condition id; overlay-only ids are appended
  conditions?: Record<
    string,
    {
      type?: string;
      task?: string; // corrected/appended taskStatus target (tarkov.dev or tasksAdd id)
      status?: string[];
      playerLevel?: number;
      skill?: string;
      level?: number;
    }
  >;
  // Authoritative in-game story requirements; [] means none
  storyRequirements?: Array<
    | {
        type: 'storyChapterStatus';
        storyChapter: string; // storyChapters id
        name: string;
        status: string[];
      }
    | {
        type: 'storyObjectiveStatus';
        storyChapter: string; // storyChapters id
        objective: string; // objective id for storyObjectiveStatus
        name: string;
        status: string[];
      }
  >;
}
```
