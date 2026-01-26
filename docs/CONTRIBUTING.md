# Contributing to tarkov-data-overlay

Thank you for helping improve Tarkov data accuracy for the community!

## Types of Contributions

### Data Corrections

Fix incorrect data in tarkov.dev (e.g., wrong task levels, incorrect maps).
Corrections live in `src/overrides/` and should only include the fields you are
changing.

### Data Additions

Add new data that is missing from tarkov.dev (e.g., game editions, event tasks).
Additions live in `src/additions/` and should include the full object.

## Project Data Layout

- `src/overrides/`: Corrections to existing tarkov.dev entities (tasks, items, traders, hideout).
- `src/additions/`: New entities not present in tarkov.dev (tasksAdd, editions).
- `src/schemas/`: JSON Schemas used by `npm run validate`.
- `dist/overlay.json`: Generated output from `npm run build`.
  Overrides are keyed by tarkov.dev IDs; additions are keyed by local IDs and
  appear under `tasksAdd`/`editions` in the output.

---

## How to Submit a Correction

### 1. Find the Entity ID

Get the tarkov.dev ID for the entity you're correcting:

- **Tasks**: Visit `https://tarkov.dev/task/[task-name]` and find the ID in the URL or page
- **Items**: Visit `https://tarkov.dev/item/[item-name]`
- Or query the API directly

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
4. Run `npm run validate` to check your changes
5. Submit a PR using the template

---

## How to Submit an Addition

### 1. Pick the Right File

- New tasks not in the API → `src/additions/tasksAdd.json5`
- New editions → `src/additions/editions.json5`

### 2. Create a Stable ID

Use a stable, snake_case key and set `id` to the same value:

```json5
{
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
        items: [
          { name: 'Item Name 1' },
          { name: 'Item Name 2', id: 'item-id-2' },
        ],
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

# Build the overlay locally
npm run build
```

---

## Master Samples

See `docs/MASTER_SAMPLES.md` for the comprehensive, copy-paste JSON5 master reference.

---

## Questions?

Open an issue or reach out on Discord.
