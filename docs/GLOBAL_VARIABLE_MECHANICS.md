# `GlobalVariableValue` task gates

Reference notes for the patch 1.1.0.0 condition that tarkov.dev serves as an
`otherRequirements` entry of `type: "globalVariable"`. It answers three
questions that repeatedly cause confusion:

- why the required `value` is a small number like 1–5,
- why the referenced ID resolves to a _group_ holding N child variable IDs
  rather than to a single value,
- and what a consumer actually needs in order to decide whether the gate is
  satisfied.

This is the mechanism-and-evidence side. For what the overlay actually ships —
the `progressionCounters` registry contract, its evidence bar, and the
evaluation rules `evaluateTaskProgression` follows — see
[global variables and progression counters](GLOBAL_VARIABLES.md).

## Short answer

A `GlobalVariableValue` condition is a **counter comparison**, not a flag check.

For the 27 IDs that tarkov.dev currently publishes, the counter is
**"how many tasks you have completed for one trader at one loyalty tier"**, and
the condition means **"complete N tasks from that trader's tier-M pool"**.

The group's child variables are the individual per-task completion markers for
that pool. There are 8 children when the pool contains 8 tasks; pool sizes
observed across the 42 groups in the client's `variable_group` response are
2, 3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 18 and 36 — 8 and 9 are simply the most
common. So the count is not a fixed structural "8"; it is the size of the task
pool being counted.

## The three pieces of data

The client combines three separate payloads. Only the first is public.

| Piece                | Source                                                                                           | Shape                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| The condition        | `/client/quest/list` → `conditions.AvailableForStart[]`; tarkov.dev → `task.otherRequirements[]` | `{ conditionType: "GlobalVariableValue", target, value, compareMethod }`        |
| The group definition | `/client/variable_group`                                                                         | `{ id, variables: string[] }` — parent ID plus child variable IDs, nothing else |
| The player's values  | profile → `Variables`                                                                            | flat `Record<variableId, number>`                                               |

Notable details:

- `variable_group` carries **no** names, scopes, or metadata — only `id` and
  `variables`. There is no locale entry for either a group ID or a child ID.
- The payload is byte-identical across `pve`, `pvp` and `pvp-season` (same
  SHA-256), so groups are global definitions rather than per-mode ones.
- Group IDs never appear in `profile.Variables`. Only children do.

## Resolution rule

The condition's `target` is **not always a group**. Resolve it in this order:

1. If `target` matches a `variable_group` `id`, the compared value is the **sum
   of that group's children** as read from `profile.Variables` (absent child = 0).
2. Otherwise `target` is a plain variable ID and the compared value is
   `profile.Variables[target]` directly (absent = 0).

In the 1.1 PVE reference, 109 distinct targets appear across 300
`GlobalVariableValue` conditions: **36 are group IDs and 73 are plain
variables**. Treating every target as a group — or every target as a scalar —
silently misreads roughly a third of the gates either way.

Also worth noting, because it changes evaluation semantics:

- Condition placement: 179 `AvailableForStart`, 92 `AvailableForFinish`,
  29 `Fail`. Only the first is an unlock gate; `Fail` conditions _fail_ a task
  when the counter reaches a value.
- `compareMethod` is not always `>=`: 236 `>=`, 60 `==`, 4 `>`. An `== 0`
  condition means "this must not have happened yet", which an unconditional
  `>=` reading inverts.

## Why the counter exists: trader tier pools

Every one of the 27 IDs tarkov.dev publishes corresponds to exactly one
(trader, loyalty tier) pair. Within a tier, the trader's tasks split into two
sets: some are open as soon as the tier is reached, and the rest are staggered
behind counter thresholds.

Mechanic tier 2 is representative — 12 tasks in the pool, 3 open on arrival,
then 3 more at each of `>=1`, `>=3`, `>=5`:

```text
group 6a3c0fefbea2d2ad581c090b  (Mechanic, trader level 2, 12 children)
  free                     3 tasks
  GlobalVariableValue >=1  3 tasks   (Gunsmith - P226R, Corporate Secrets, ...)
  GlobalVariableValue >=3  3 tasks   (Gunsmith - AK-105, Energy Crisis, ...)
  GlobalVariableValue >=5  3 tasks   (Semiconductor Crisis, Import, ...)
```

Tier access itself is a separate, ordinary condition. In the reference the
per-task `tierAccessory` field and the `TraderLoyalty` condition never
disagree: `tierAccessory` 2/3/4 pairs only with `TraderLoyalty` value 2/3/4,
and `tierAccessory` 1 carries no loyalty condition. So the full unlock is:

```text
trader loyalty level M  AND  (completed tasks in that trader's tier-M pool) >= N
```

### Evidence

Four independent checks support the reading above.

1. **Counter equals completed count.** Using a level-55 PVE profile, the
   group's summed children equal the number of completed tasks in that
   (trader, tier) pool for **23 of 27 groups**.
2. **Child count equals pool size** for **20 of 27** groups, exactly.
3. **Explicit writes.** Two Prapor tier-2 tasks (`Capturing Outposts`,
   `Glory to CPSU`) declare a `Success` reward of `type: "GlobalVariable"`
   whose `target` is a child of the Prapor tier-2 group. Most tasks do not
   declare this — the server sets the marker implicitly — but where it is
   declared, it lands in the tier group the model predicts.
4. **Independent tier derivation.** Assigning each group a tier from the
   _published_ trader-level requirements of its gated tasks (tarkov.dev plus
   this repo's overlay) reproduces the reference's `tierAccessory` for every
   group, unanimously — each group's gated tasks all sit at one trader level.

## The 27 published trader-tier groups

Trader, tier, group ID and thresholds are derived from public data
(`json.tarkov.dev/pve/tasks` + `dist/overlay.json`). "Children" and "Pool" are
aggregate counts observed in the 1.1 PVE client capture, included because they
are the point of the question; no child variable IDs are reproduced here.

| Trader      | Tier | Group (`variableId`)       | Children | Pool | Thresholds (tasks gated) |
| ----------- | ---- | -------------------------- | -------- | ---- | ------------------------ |
| Jaeger      | 1    | `6a43a01ccc83aceedd35f09c` | 10       | 10   | ≥1 (3), ≥3 (5)           |
| Jaeger      | 2    | `6a43a095bfef0cd74c298963` | 11       | 11   | ≥2 (2), ≥5 (2)           |
| Jaeger      | 3    | `6a43a13633c97d216dfc85de` | 12       | 12   | ≥2 (3), ≥4 (4)           |
| Jaeger      | 4    | `6a43a16dde81644a7951f31b` | 6        | 6    | ≥1 (3)                   |
| Mechanic    | 1    | `6a3171c927ca9591bf4db1c4` | 9        | 9    | ≥1 (3), ≥3 (3)           |
| Mechanic    | 2    | `6a3c0fefbea2d2ad581c090b` | 12       | 12   | ≥1 (5), ≥3 (3), ≥5 (3)   |
| Mechanic    | 3    | `6a3cf95c6b35530c4a4f532e` | 12       | 16   | ≥1 (4), ≥3 (4), ≥5 (4)   |
| Mechanic    | 4    | `6a3d1c0990e9ffe15463e961` | 6        | 5    | ≥1 (2)                   |
| Peacekeeper | 1    | `6a5ba40fe5c4eaef5610f232` | 9        | 9    | ≥1 (3), ≥3 (3)           |
| Peacekeeper | 2    | `6a5ba450a7851e16ce0bde44` | 12       | 12   | ≥1 (3), ≥3 (3), ≥5 (3)   |
| Peacekeeper | 3    | `6a5ba48b8cfd0bddb3d4d2e1` | 8        | 8    | ≥2 (2), ≥4 (2)           |
| Peacekeeper | 4    | `6a5ba4c57cbb93b629051591` | 9        | 9    | ≥1 (3), ≥3 (4)           |
| Prapor      | 1    | `6a20540cf1b67a977cc5a088` | 11       | 11   | ≥1 (2), ≥3 (3), ≥5 (3)   |
| Prapor      | 2    | `6a2688488bba18e0b0187a04` | 18       | 13   | ≥3 (3), ≥5 (3)           |
| Prapor      | 3    | `6a32651a811905ed0cac0973` | 13       | 9    | ≥1 (3), ≥3 (4)           |
| Prapor      | 4    | `6a326525789ae12ecb0b2807` | 8        | 8    | ≥1 (3), ≥2 (2)           |
| Ragman      | 1    | `6a4b339f18db62e03b4f7ded` | 8        | 9    | ≥1 (3), ≥2 (3)           |
| Ragman      | 2    | `6a4b4e6a30dac4b01af220aa` | 10       | 10   | ≥1 (1), ≥2 (3), ≥4 (3)   |
| Ragman      | 3    | `6a4b9c9a60b56d421cceea18` | 10       | 7    | ≥1 (1), ≥2 (2)           |
| Skier       | 1    | `6a59f3ba06c8949abad30871` | 9        | 9    | ≥1 (2), ≥2 (2), ≥3 (4)   |
| Skier       | 2    | `6a5a111de1f417ac80a163e5` | 12       | 12   | ≥1 (4), ≥3 (3), ≥4 (2)   |
| Skier       | 3    | `6a5a115181116e807b55f258` | 8        | 8    | ≥1 (3), ≥3 (3)           |
| Skier       | 4    | `6a5a1192efde11cc7105b18f` | 5        | 4    | ≥1 (2)                   |
| Therapist   | 1    | `6a4e4ab3ecd1145894d00990` | 9        | 9    | ≥1 (2), ≥2 (2), ≥4 (2)   |
| Therapist   | 2    | `6a4e4aed3ded7a18126603f6` | 9        | 9    | ≥1 (2), ≥2 (2), ≥4 (2)   |
| Therapist   | 3    | `6a4e4b28629dc64c4001967c` | 8        | 8    | ≥1 (3), ≥3 (2)           |
| Therapist   | 4    | `6a56925b1c30ba5a77c7c518` | 3        | 3    | ≥1 (1)                   |

Only these seven traders use tier counters. Fence, Lightkeeper, BTR, Ref and
the 1.1 story traders gate through plain variables instead (next section).
Ragman has no tier-4 group because that tier holds a single task.

Rows where Children ≠ Pool are unresolved; see Caveats.

## The second family: plain variables

The other 73 targets are ordinary scalars used as script state, not task
counters. They come from a general-purpose variable system that the dialogue
tree also drives:

- Dialogue nodes contain 4,038 `Actions` of `type: "SetVariable"`
  (`{ variableId, value, saveScope }`) over 308 distinct variable IDs, and
  4,394 `Trigger.Conditions` of `type: "VariableValue"`
  (`{ variableId, value, operator }`).
- `saveScope` is `Dialogue` (3,507), `Profile` (367) or `Session` (164). **Only
  `Profile` scope persists into `profile.Variables`**, which is why most
  dialogue writes never surface as a task-visible value.
- Quest rewards can also write them: `rewards.{Started,Success,Fail}[]` entries
  of `type: "GlobalVariable"` (19 in the PVE reference), where `target` is the
  variable ID.

These scalars behave like story-stage counters, typically holding 0–4. Some are
world state rather than player state: two of them read the same non-zero value
(`3` and `1`) in **both** a level-55 PVE profile and a level-5 seasonal profile,
which per-player progress could not do. Their IDs are capture-only — they are
not among the 27 that tarkov.dev publishes — so they are described rather than
listed here.

Practical consequence: a plain-variable gate cannot be resolved from static
data. It is genuinely account/world state, and the honest evaluation result for
an unknown value is `unknown`, never `available`. This is what
`TaskUnlockState.globalVariables` in `src/lib/task-unlocks.ts` exists to
receive.

## What is missing to evaluate these gates

`src/lib/task-unlocks.ts` already models the condition
(`type: 'globalVariable'`, `variableId`, `compareMethod`, `value`) and accepts
`globalVariables: Record<string, number>`. The gap is that **nothing published
tells a consumer which tasks belong to which pool**, so the counter cannot be
computed from a task list plus completion history.

Attempting it from public data alone does not work. Defining the pool as
"tasks whose published trader-level requirement equals the tier" reproduces the
reference counter for only **7 of 27** groups, because tasks that are free
within their tier carry no trader-level requirement upstream and are therefore
missed, while some gated tasks carry a level that differs from their pool.

The missing input is small and fully covered upstream: **249 tasks** across the
27 pools (66 at tier 1, 79 at tier 2, 68 at tier 3, 36 at tier 4; 169 gated,
80 free), and **all 249 already exist in `json.tarkov.dev/pve/tasks`** — they
just lack the pool annotation. Supplying `(trader, tier)` membership per task
makes each of the 27 counters computable as:

```text
globalVariables[groupId] = count(completed tasks in pool(trader, tier))
```

The overlay already has the vehicle for that annotation: the
`progressionCounters` registry in `src/additions/progressionCounters.json5`,
published as `overlay.progressionCounters` and consumed by
`evaluateTaskProgression`. A `distinctTaskCompletions` derivation over a pool's
task IDs is exactly the shape above.

What is _not_ settled is whether the mapping in this document clears that
registry's evidence bar. The registry requires `verification: 'verified'` and
`coverage: 'complete'` with public proof, and the caveats below leave four
counters where the observed value does not equal the completed count and seven
where the child count does not equal the pool size. Until those are explained,
these pools belong in the registry as `unresolved` candidates at most, which
never produce an inferred value. See
[the registry contract](GLOBAL_VARIABLES.md#registry-contract) for the fields
and the bar.

## Building a progression model

The forward direction is exact; the reverse direction is not an edge list and
cannot be made into one. This is a property of the design, not a data gap.

### Forward: fully determined

Across all 249 tier-pool tasks, `AvailableForStart` contains only two condition
types — `TraderLoyalty` (63) and `GlobalVariableValue` (169) — and **zero
`Quest` conditions**. There is no "task X, Y, Z" prerequisite list to recover,
because these tasks have no task prerequisites at all. The complete predicate
is:

```text
available(task) =
      traderLoyalty(task.trader) >= task.tier
  AND count(completed ∩ pool(task.trader, task.tier)) >= task.threshold
```

Eleven tier-1 tasks add a gate on a plain variable rather than the tier counter
(Mechanic 3, Ragman 3, Therapist 3, Skier 2); those are the trader-intro/world
scalars and stay `unknown` without account state.

Each pool has 1–7 seed tasks carrying no counter gate, and the staggered waves
are reachable from those seeds in all 27 pools, so no pool can deadlock.

For corroboration, upstream asserts `taskRequirements` for only 1 of the 249,
and this overlay already corrects that entry.

### Reverse: a cardinality constraint, not a dependency

Knowing a player has a task at threshold `N` over pool `P` tells you
`|completed ∩ P| >= N` and nothing more. Because there are **zero intra-pool
task edges**, no individual member is ever forced, so no specific task can be
inferred as required. The number of minimal explanations is `C(|P|, N)` —
median 45 across the 169 gated tasks, up to `C(16,5) = 4368` for Mechanic
tier 3.

Choosing an arbitrary `N`-subset is nevertheless safe, because pools contain no
branches to diverge down: no member fails another member, and the only
`Fail` conditions on pool tasks are 5 `CounterCreator` and 3 `Quest` entries,
none of which target a pool task.

### Practical guidance

- Store the counter, not synthesized edges. Rendering these gates as
  prerequisite arrows invents structure the game does not have.
- Backfilling an unknown history: record the constraint `>= N of P` rather than
  marking specific tasks complete, and surface the shortfall (`N - have`).
- Planning a route to a task: any `N` available members work, so pick by cost.
  Greedy selection is sufficient given the seed/wave structure.
- A missing account value must evaluate to `unknown`, never `available`.

## Caveats

- **Four groups where the counter ≠ completed count** in the level-55 profile:
  Mechanic tier 3 (12 vs 16), Mechanic tier 4 (3 vs 4), Prapor tier 4 (6 vs 7),
  Ragman tier 1 (8 vs 9). In each case the group has fewer children than the
  pool has tasks, so some tasks do not contribute to the counter. Which tasks
  are excluded, and why, is not determined.
- **Seven groups where children ≠ pool size**, including Prapor tier 2
  (18 children vs 13 tasks) and Prapor tier 3 (13 vs 9). Extra children are
  never set in the observed profile, so they are plausibly retired or
  mode-specific markers, but that is unverified.
- **351 of 374 child variables have no writer anywhere in the client payloads.**
  They are set server-side on task completion. The child → task mapping is
  therefore not statically derivable; only the aggregate count is usable.
- `TradersInfo` entries no longer carry `loyaltyLevel` (keys are `unlocked`,
  `disabled`, `salesSum`, `standing`, `dialogueAvailable`). Trader tier is not
  readable from the profile directly.
- Everything here is from 1.1 captures (client `1.1.0.1.46699` / `.46911`) plus
  a live tarkov.dev read. Group membership and thresholds are BSG data and can
  change between patches; re-verify after a task rework.

## Reproducing

All reference-side figures come from the gitignored local capture under
`eft/data/combined/<mode>/`, using `variable_group.json`, `quests.json`,
`dialogue.json` and `profile_list.json`. Public-side figures come from
`json.tarkov.dev/pve/tasks`, `json.tarkov.dev/pve/traders` and
`dist/overlay.json`.

The published condition can be listed without any local capture:

```bash
curl -s https://json.tarkov.dev/pve/tasks \
  | jq '[.data.tasks[].otherRequirements[]? | select(.type=="globalVariable")] | length'
# 164 conditions over 27 distinct variableIds
```

Per repository policy the capture and anything derived from it stay out of Git;
this document deliberately records the data model and aggregate counts only.
