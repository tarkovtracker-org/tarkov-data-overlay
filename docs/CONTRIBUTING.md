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

To report a problem before preparing a change, open the GitHub [**Data
correction** issue form](https://github.com/tarkovtracker-org/tarkov-data-overlay/issues/new?template=data-correction.yml)
and include the entity ID, exact field, current and expected values, affected
mode, version/date, reproduction details, and proof. See the [Issue Triage
Guide](TRIAGE.md) for the evidence and verification rules maintainers use. Use
the [**New data request** issue form](https://github.com/tarkovtracker-org/tarkov-data-overlay/issues/new?template=new-data-request.yml)
when the data is absent from tarkov.dev rather than incorrect in it.

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

## What Counts as Proof for Which Field

Not every wiki field is evidence for every override. Patch 1.1.0.0 expresses most
trader-loyalty gates as `GlobalVariableValue` start conditions against opaque
per-tier variables instead of `TraderLoyalty` conditions, and tarkov.dev serves
those as `otherRequirements` `globalVariable` entries. That single change is why
the three rules below differ, and getting them mixed up has already shipped
regressions.

A `GlobalVariableValue` condition is a numeric state comparison, though; it is
not interchangeable with a `TraderLoyalty` condition or a list of prerequisite
tasks. See [global variables and progression counters](GLOBAL_VARIABLES.md)
before adding counter metadata, and keep incomplete or unverified mappings
informational.

### `taskRequirements` — the wiki `previous` field is not proof

The infobox `previous` field describes narrative progression. The game gates a
task with the `AvailableForStart` conditions in its quest template, so a task
whose only captured start condition is a variable has **no explicit Quest**
prerequisite, and `taskRequirements: []` is correct rather than missing an edge.

Before overriding `taskRequirements`, confirm the edge exists as a `Quest` start
condition. `npm run eft:audit` reports this per task (`CONFLICT` means the
override disagrees with the client). If you cannot check the client data, do not
override the field.

If the client names a prerequisite task that is absent from the selected
tarkov.dev task endpoint, the audit reports `UNRESOLVED`. Do not add that edge to
an override: it would create a dangling prerequisite for consumers. Track the
missing task separately as an upstream-ingestion or data-addition investigation
until the task can be represented safely.

### `minPlayerLevel` — absence of a `Level` condition does not mean `0`

A reference establishes the **explicit** conditions in the captured task
templates, and nothing more. An all-zero template status or a surviving satisfied
condition does not prove the capture is a complete, unfiltered catalog, so treat
the explicit-gate list as a floor on what exists rather than a closed set. Pin
its mode and version, and distinguish an absent task from an explicit empty
prerequisite list on a task that is present.

A missing `Level` condition therefore does not authorize setting `minPlayerLevel`
to zero. Upstream _derives_ a floor from the loyalty tier's
`requiredPlayerLevel` when a task is loyalty-gated, and from prerequisite tasks,
so "no `Level` condition" means "no explicit gate", not "no gate", and zeroing
those would throw away a correct derived floor.

Investigate those sources and corroborate with the wiki Requirements section
before correcting a value; exceeding the task's own trader floor is not alone
proof that it is stale. Use `0` to mean "no level gate" (see
`src/lib/task-unlocks.ts`).

### `traderRequirements` — distinguish explicit gates from inferred cohorts

An explicit `TraderLoyalty` condition is evidence of a loyalty gate in that
capture. Its absence does not by itself establish that no other mechanism
restricts access: because the gate often lives in a global variable, the client
shows no `TraderLoyalty` condition even for tasks that genuinely have a loyalty
gate, so reading absence as "no gate" would falsely condemn 150+ correct
overrides. `eft:audit` does not currently adjudicate trader requirements. Use the
wiki Requirements section and applicable condition evidence; do not turn a
cohort's inferred tier into an extra gate on every member.

### Entity `{ id, name }` pairs — look the ID up, never copy it

Consumers resolve maps and traders by `id`, and the schema only type-checks both
as strings, so a correct name beside the wrong ID silently points at another
entity. Look the ID up in `TARKOV_MAP_NAMES_BY_ID` /
`TARKOV_TRADER_NAMES_BY_ID` (`src/lib/types.ts`);
`tests/entity-references.test.ts` enforces the pairing, and
`tests/task-graph.test.ts` enforces that task references stay internally
consistent and acyclic.

---

## Corrections Deliberately Not Made

Each entry below is a correction that looks obviously missing, was tried, and was
found wrong. The reason it is recorded here rather than in the data file is that
absence leaves no trace: without this list the next contributor reads the wiki,
sees a discrepancy, and re-adds the same bad override. Re-add one only by
clearing the specific bar named for it.

**The Survivalist Path — Unprotected but Dangerous**
(`5d25aed386f77442734d25d2`, issue #328). A previous revision repointed this
task's prerequisite to Acquaintance and restricted its kill objective to Woods,
both taken from the wiki. The client disagrees on both counts: its only
`AvailableForStart` condition is a `Quest` condition on Zhivchik, which upstream
already serves, and the objective's kill counter carries only `Kills` and
`Equipment` conditions — no `Location` condition, so the objective is not
map-restricted and upstream's empty `maps` is correct. Issue #328 reports a
completed task not registering from a Seasonal profile; the unlock graph matches
the client here, so that symptom still needs a separate root cause.

**The Survivalist / Jaeger chain.** Patch 1.1.0.0 replaced most quest-chain
prerequisites with `TraderLoyalty` and `GlobalVariableValue` gates, which
tarkov.dev already serves as `traderRequirements` / `otherRequirements`. The
in-game order is Thrifty (Jaeger LL2, no quest prerequisite) → Zhivchik →
Unprotected but Dangerous → Wounded Beast. Acquaintance has no start conditions
at all, and The Tarkov Shooter - Part 1 is gated by a loyalty variable rather
than by Acquaintance. Upstream matches the client on every one of these, so
overriding `taskRequirements` here would introduce edges the client does not
have.

**Introduction** (`5d2495a886f77425cd51e403`). Its wiki Requirements section
still reads "Must be level 2 to start this quest". That is pre-1.1.0.0: the
client carries no `Level` condition for it, and upstream's `minPlayerLevel` is
already `0`. Its gate is a **dialogue** requirement — upstream serves a single
`otherRequirements` entry of `type: 'dialogue'`, not `globalVariable`, and the
two are mutually exclusive types. Track it by its condition ID through
`completedConditionIds` / `dialogues` rather than as numeric variable state, and
do not re-add a level gate from that wiki line.

**New Beginning (Prestige 1)** (`6761f28a022f60bb320f3e95`). An override here
targeting objective `6848100b00afffa81f09e36b` is a no-op: that objective belongs
to Prestige 3 (`6848100b00afffa81f09e365`), where upstream already reads the text
such an override would supply. Prestige 1's own equivalent objective
(`6761f9d718fa62aac3264ff2`) already reads correctly upstream. Do not retarget it
to Prestige 3 either — upstream shows a deliberate escalating chain: P1/P2 extract
from The Lab, P3 transits Lab → Streets then extracts from Streets, P4 adds
Streets → Interchange.

**The Tarkov Shooter - Part 5** (`5bc4836986f7740c0152911c`, issue #356). Two
different tasks carry this name, so check the ID first: `5bc4826c86f774106d22d88b`
is the obsolete duplicate that this overlay sets `disabled: true` on (issue #322),
while `5bc4836986f7740c0152911c` is the live task and correctly has no override.
For the live task the 1.1.0.0 client reference and the regular, pve and
pvp-season payloads all agree — 28000 experience, 275000 roubles, two copies of
the Mosin Rifle ProMag Archangel OPFOR PRS chassis, and a Jaeger LL3 offer — so a
reward override here would override matching upstream data. An earlier wiki-based
patch supplied a different reward block.

**Establish Contact, Collector, Is This a Reference?** (issue #274). These were
once authored as a "Fence LL1" `traderRequirements` entry, but the gate is Fence
_reputation_ (scav karma), not a loyalty level. Upstream now serves the correct
discriminated requirement — `requirementType: 'reputation'` on Fence with
`value` 4, 3 and 1 respectively, and Collector additionally carries seven
`level`-type LL4 requirements — and the wiki agrees.

Re-adding an LL1 entry breaks both documented merge strategies, in opposite ways.
Under the patch-by-id merge in [INTEGRATION.md](INTEGRATION.md), an overlay-authored
entry carries its own synthetic `overlay.` ID, so it does not patch the upstream
reputation requirement — it is **appended**, leaving the task with a correct
reputation gate plus a fabricated loyalty gate. Under the legacy wholesale
replace-array merge, it **replaces** the array and the upstream reputation gate is
lost entirely. Only an explicit empty array is meant to clear requirements.

**Objective description rewrites removed as fabricated or swapped.** Pathfinder's
"Sales Night" objective description was mis-attributed to a nonexistent quest and
rewrote a correct `type=visit` objective. Small Business - Part 3 had its two
Woods objective descriptions swapped, contradicting tarkov.dev, both game
captures, and the wiki guide. Setup's hat/vest combinations are served correctly
upstream; only their ordering differed. Re-add any of these only with a fresh
in-game marker screenshot, not a wiki reading.

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

# Confirm the committed generated output still matches source data
npm run build:check

# Run the test suite (required when changing src/lib/, scripts/, or tests)
npm test
```

---

## Master Samples

See `docs/MASTER_SAMPLES.md` for the comprehensive, copy-paste JSON5 master reference.

---

## Questions?

Open an issue or reach out on [Discord](https://discord.gg/PpdDwd2M6V).
