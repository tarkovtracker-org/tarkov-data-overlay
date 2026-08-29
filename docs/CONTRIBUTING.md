# Contributing to tarkov-data-overlay

Thank you for helping improve Tarkov data accuracy for the community!

## Types of Contributions

### Data Corrections

Fix incorrect data in tarkov.dev (e.g., wrong task levels, incorrect maps).
Corrections live in `src/overrides/` and should only include the fields you are
changing.

### Faction-locked Tasks

Upstream models faction exclusivity with the task-level `factionName` field
(`"Any"`, `"BEAR"`, or `"USEC"`). Faction variants of the same quest are
separate task IDs (e.g. Textile - Part 1 BEAR/USEC, The Huntsman Path -
Administrator Reserve/Lighthouse), so the correct fix for a wrong or missing
faction is a `factionName` override on the existing task ID in
`src/overrides/tasks.json5` — not a `modes/<mode>/` file, because a faction
lock applies identically in every game mode, and not a parallel
faction-split structure, so consumers can keep reading the upstream field.
Proof is the wiki Requirements line ("This quest is only obtainable by
BEAR/USEC PMCs") or the wiki's faction-exclusive objective lists.

### Data Additions

Add new data that is missing from tarkov.dev (e.g., game editions, event tasks).
Additions live in `src/additions/` and should include the full object.

## Project Data Layout

- `src/overrides/`: Corrections to existing tarkov.dev entities (tasks, items, traders, hideout).
- `src/additions/`: New entities not present in tarkov.dev (`tasksAdd`, `editions`, `itemsAdd`, `storyChapters`, `seasonalPerks`, `craftsAdd`).
- `src/schemas/`: JSON Schemas used by `npm run validate`.
- `dist/overlay.json`: Generated output from `npm run build` (committed to the repo; regenerate it whenever you change source data).
  Overrides are keyed by tarkov.dev IDs; additions are keyed by local IDs and
  appear under their source filenames in the output (`tasksAdd`, `editions`, `itemsAdd`, `storyChapters`, `seasonalPerks`, `craftsAdd`).

---

## How to Submit a Correction

### 1. Find the Entity ID

Get the tarkov.dev ID for the entity you're correcting:

- **Tasks**: Visit `https://tarkov.dev/task/[task-name]` and find the ID in the URL or page
- **Items**: Visit `https://tarkov.dev/item/[item-name]`
- Or look it up in the json.tarkov.dev data (e.g. `https://json.tarkov.dev/regular/tasks`)

### 2. Gather Proof

You **must** provide proof for every correction:

- Wiki link (preferred): `https://escapefromtarkov.fandom.com/wiki/[Page]`
- In-game screenshot
- Official patch notes

### 3. Edit the Source File

Edit the appropriate file in `src/overrides/`:

```json5
{
  // [Entity Name] - Brief description of what's wrong
  // Proof: [your proof link]
  "<entity-id>": {
    "fieldName": correctValue  // Was: incorrectValue
  }
}
```

### 4. Submit a Pull Request

1. Fork the repository
2. Create a branch: `fix/task-grenadier-level`
3. Make your changes
4. Run `npm run validate` (and `npm run typecheck` / `npm test` when you touch
   `src/lib/`, `scripts/`, or tests)
5. For any data change, run `npm run build` and commit the regenerated
   `dist/overlay.json`
6. Record the commands you ran — and call out any regenerated output — in the PR
7. Submit a PR using the template

---

## How to Submit an Addition

### 1. Pick the Right File

- New tasks not in the API → `src/additions/tasksAdd.json5` (schema `task-additions.schema.json`)
- New editions → `src/additions/editions.json5` (schema `edition.schema.json`)
- New story chapters → `src/additions/storyChapters.json5` (schema `story-chapter.schema.json`)
- New items → `src/additions/itemsAdd.json5` (schema `item-additions.schema.json`)
- New seasonal (`pvp-season`) perks → `src/additions/seasonalPerks.json5` (schema `seasonal-perk.schema.json`)
- New hideout crafts missing from the API → `src/additions/craftsAdd.json5` (schema `craft-additions.schema.json`)

`seasonalPerks` and `craftsAdd` cover `pvp-season` (Seasonal Character) data
tarkov.dev does not serve. Keep every new data type in `src/additions/` with its
schema in `src/schemas/`, and register the schema in `SCHEMA_CONFIGS`
(`src/lib/types.ts`). Prove additions the same way as any other: patch notes
and/or an in-game screenshot. Reference entities by tarkov.dev id where available
(items, traders, stations, most skills) so names resolve upstream.

> **Upstream-id exception:** a few referenced ids are not in tarkov.dev yet —
> notably some Seasonal Character faction skills (e.g. the `Usec*` skills, whose
> `Bear*` equivalents already exist upstream). Use the correct upstream id
> anyway; it is not invented, and the name resolves once tarkov.dev adds the
> entity. Do not drop or rename these ids to force an immediate match.

### 2. Create a Stable ID

Always set `id` to the same value as the top-level key. The key format depends
on the file — match the existing entries:

- `tasksAdd`, `editions`: local `snake_case` keys (e.g. `my_event_task`)
- `storyChapters`: local kebab-case keys
- `seasonalPerks`, `craftsAdd`: the source tarkov.dev/BSG id (a 24-char hex id),
  because these mirror upstream entities by id

```json5
{
  // local key (tasksAdd / editions); seasonalPerks & craftsAdd instead key by
  // their source id, e.g. '655b650ab71eeb7c4168c627'
  my_event_task: {
    id: 'my_event_task',
    name: 'My Event Task',
    // ...
  },
}
```

### 3. Provide Proof

Add the same proof comments as overrides. Additions are full objects, so there
is no `Was:` comment.

Prefer tarkov.dev IDs for referenced items/traders/maps when available, and
include `name`/`shortName` for readability.

---

## Disabled Tasks

If a task is removed from gameplay but still present in the API, you can set
`disabled: true` in `src/overrides/tasks.json5`. The `check-overrides` script
will flag these as still present in the API so we can keep them under review.

---

## File Format Rules

### Required Comments

Every correction (overrides) **must** include:

1. **Entity name** as a comment above the ID
2. **Proof link** in the header comment
3. **Original value** as an inline comment

Additions should also include entity name + proof comments, but do not need
`Was:` comments since they are not correcting existing API values.

### Example

```json5
{
  // Grenadier - Level requirement incorrect
  // Proof: https://escapefromtarkov.fandom.com/wiki/Grenadier
  // tarkov.dev shows 20, wiki confirms 10
  '5936d90786f7742b1420ba5b': {
    minPlayerLevel: 10, // Was: 20
  },
}
```

### Field Names

- Use **camelCase** exactly as tarkov.dev does
- `minPlayerLevel` ✅
- `min_player_level` ❌

---

## Patching Nested Data (Objectives)

To patch a specific objective within a task, use the objective's ID as a key:

```json5
{
  // Task Name - Objective count incorrect
  // Proof: [link]
  'task-id-here': {
    objectives: {
      'objective-id-here': {
        count: 4, // Was: 3
      },
    },
  },
}
```

You can also patch objective item lists (for TaskObjectiveItem objectives) by
providing an `items` array:

```json5
{
  // Task Name - Missing objective items
  // Proof: [link]
  'task-id-here': {
    objectives: {
      'objective-id-here': {
        items: [
          { id: 'item-id-1', name: 'Item Name 1' },
          { id: 'item-id-2', name: 'Item Name 2' },
        ],
      },
    },
  },
}
```

If tarkov.dev is missing the objective entirely, add it using `objectivesAdd`:

```json5
{
  // Task Name - Missing objective in API
  // Proof: [link]
  'task-id-here': {
    objectivesAdd: [
      {
        id: 'objective-id-here',
        description: 'Find in raid',
        items: [{ name: 'Item Name 1' }, { name: 'Item Name 2', id: 'item-id-2' }],
      },
    ],
  },
}
```

---

## Local Development

```bash
# Install dependencies
npm install

# Validate your changes
npm run validate

# Type-check scripts and tests
npm run typecheck

# Build the overlay locally (commit the regenerated dist/overlay.json for data changes)
npm run build

# Run the test suite (required when changing src/lib/, scripts/, or tests)
npm test
```

---

## Master Samples

See `docs/MASTER_SAMPLES.md` for the comprehensive, copy-paste JSON5 master reference.

---

## Questions?

Open an issue or reach out on [Discord](https://discord.gg/PpdDwd2M6V).
