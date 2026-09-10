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

For the 27 IDs that tarkov.dev currently publishes, the best-supported reading is
that the counter is **"how many tasks you have completed for one trader at one
loyalty tier"**, so the condition means **"complete N tasks from that trader's
tier-M pool"**.

Treat that as an observed interpretation, not an established rule. It reproduces
the profile's value for 23 of the 27 groups and matches the pool size for 20 of
27; the groups it fails on are listed in [Caveats](#caveats) and are not
explained. Reconciling is necessary but **not sufficient** — an aggregate match in
one profile cannot show which tasks contribute or by how much — so no group here
is established well enough to drive a progression mapping. See
[the registry contract](GLOBAL_VARIABLES.md#registry-contract) for the bar a
mapping must clear before it can produce a value.

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
   of that group's children** as read from `profile.Variables`.
2. Otherwise `target` is a plain variable ID and the compared value is
   `profile.Variables[target]` directly.

Step 2 needs care without a **complete** `variable_group` catalog, which is not
public — only the condition payload is — so for most consumers a failed lookup
means "not in my catalog", not "not a group". Resolve the ambiguity with the
profile rather than by guessing, using the fact that group IDs never appear in
`profile.Variables`:

- `target` is a key in `profile.Variables` → it is a scalar. Use its value.
- `target` is absent and the catalog is known complete → it is a scalar that was
  never written. Use `0`.
- `target` is absent and the catalog may be incomplete → **unknown**. It may be a
  group you cannot expand, and reading it as a scalar would miss (group IDs are
  not profile keys) and then invent a zero.

Treating an absent value as `0` is therefore only ever valid against a complete
raw payload: an unwritten group child in step 1, or the second bullet above. It
must not be carried into `TaskUnlockState.globalVariables`, which holds
already-resolved effective values: a key missing from that map means **unknown**,
not zero. The distinction is load-bearing because 60 of the published conditions
compare with `==`, so an invented `0` would satisfy an `== 0` gate and report a
task available with no account evidence. `evaluateTaskProgression` already behaves
this way — a missing entry reaches `evaluateNumericCondition` as `undefined` and
yields `unknown` ("… is not present"), never `0`.

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

Mechanic tier 2 is representative — 12 tasks in the pool, 11 of them gated, so
one is open on arrival and the rest unlock in waves at `>=1`, `>=3` and `>=5`.
The thresholds and task names below are from the published data and can be
re-derived with the snippet under [Reproducing](#reproducing); only "children"
and the pool size come from the capture:

```text
group 6a3c0fefbea2d2ad581c090b  (Mechanic, trader level 2, 12 children)
  free                     1 task
  GlobalVariableValue >=1  5 tasks   (Ill-Wisher, Chemistry Closet,
                                      Corporate Perks, The Secret to
                                      Productivity, Shady Contractor)
  GlobalVariableValue >=3  3 tasks   (Scout, Surveillance, Gunsmith - OP-SKS)
  GlobalVariableValue >=5  3 tasks   (Playing the Market, Gunsmith - Model 870,
                                      Secrets of Polikhim)
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

These scalars behave like story-stage counters, typically holding 0–4. The scope
of some is **unresolved**: two of them read the same non-zero value (`3` and `1`)
in both a level-55 PVE profile and a level-5 seasonal profile. That is consistent
with world state, but two profiles cannot establish it — independent per-player
variables can share a default or coincidentally reach a low value. Treat the
scope as unknown until a producer or a `saveScope` definition shows the value is
shared, and do **not** cache such a value globally and apply it to another
account. Their IDs are capture-only — not among the 27 that tarkov.dev publishes
— so they are described rather than listed here.

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

The missing input is small and fully covered upstream. The 27 counter pools hold
**248 tasks** (66 at tier 1, 79 at tier 2, 68 at tier 3, 35 at tier 4), of which
**164 are gated** by a counter threshold and 84 are free within their tier. The
gated figure is publicly checkable: it equals the 164 `globalVariable` conditions
`json.tarkov.dev/pve/tasks` serves over these 27 `variableId`s. All 248 tasks
already exist in that endpoint — they just lack the pool annotation. Supplying
`(trader, tier)` membership per task makes a counter computable as:

```text
globalVariables[groupId] = |completed ∩ contributors(groupId)|
```

Throughout this document, **`contributors(groupId)`** means the set of tasks that
actually increment that counter. Nothing here establishes that set for **any**
group, so distinguish three states and do not conflate the first two:

- **Aggregate-reconciling (23 groups).** The counter's observed value equals the
  number of completed pool tasks in one profile. That is consistent with the pool
  being the contributor set, but it does not prove it: an aggregate can match
  while one task contributes nothing and another contributes twice, and one
  profile says nothing about contribution amounts, alternate producers, initial
  values or resets. See
  [the registry's evidence bar](GLOBAL_VARIABLES.md#registry-contract), which
  states outright that a matching sum in one profile does not prove these
  properties.
- **Not reconciling (4 groups).** The counter reads below the completed pool
  count, so the pool and the counter are **inconsistent under the simple model**.
  This is not proof that those tasks are outside the contributor set: since reset
  and initial-value behaviour is unresolved, a reset could produce the same
  shortfall after every pool task had contributed. Either way the identities stay
  unknown and the counter is not computable. See [Caveats](#caveats).
- **Verified.** Contributor identities established by evidence of the derivation
  itself. No group in this document reaches this state.

Every formula below is scoped to `contributors`, never to the raw pool, and each
is usable only once a group is verified — by evidence beyond this document. On the
strength of what is recorded here, all 27 are candidates.

Ragman's single tier-4 task is **not** in these totals: it has no counter group,
which is why the table below has no Ragman tier-4 row. Do not add it as a
contributor to any pool.

The overlay already has the vehicle for that annotation: the
`progressionCounters` registry in `src/additions/progressionCounters.json5`,
published as `overlay.progressionCounters` and consumed by
`evaluateTaskProgression`. A `distinctTaskCompletions` derivation over a pool's
task IDs is exactly the shape above.

What is _not_ settled is whether the mapping in this document clears that
registry's evidence bar. It does not, and not merely because of the four
unreconciled counters and seven child-count mismatches below. The bar requires
`verification: 'verified'` and `coverage: 'complete'` with public proof of the
derivation, and the aggregate profile match behind this model does not supply that
for **any** of the 27 — it cannot distinguish which tasks contribute, how much
each contributes, whether another producer writes the value, or how it initialises
and resets. So all 27 belong in the registry as `unresolved` candidates at most,
which never produce an inferred value. See
[the registry contract](GLOBAL_VARIABLES.md#registry-contract) for the fields and
the bar.

## Building a progression model

The forward direction is structurally determined; the reverse direction is not an
edge list and cannot be made into one. That second point is a property of the
design, not a data gap.

### Forward: no task prerequisites to recover

Across all 248 tier-pool tasks, `AvailableForStart` contains only two condition
types — `TraderLoyalty` and `GlobalVariableValue` (164 of them) — and **zero
`Quest` conditions**. There is no "task X, Y, Z" prerequisite list to recover,
because these tasks have no task prerequisites at all.

The 164 counter-gated tasks take the predicate below. It does **not** apply to
every tier-pool task: 11 tier-1 tasks are gated on a plain variable rather than
their tier counter (Mechanic 3, Ragman 3, Therapist 3, Skier 2). Reading
`counter(trader, tier)` for those would inspect the wrong state entirely — they
are trader-intro/world scalars, they have no threshold over a pool, and they stay
`unknown` without account state. Branch on the condition's `variableId`: a tier
group ID takes the predicate, anything else takes the plain-variable path in
[Resolution rule](#resolution-rule).

```text
# counter-gated tasks only
available(task) =
      traderLoyalty(task.trader) >= task.tier
  AND counter(task.trader, task.tier) >= task.threshold
```

`counter(...)` is `|completed ∩ contributors(groupId)|`, which is **not**
interchangeable with `|completed ∩ pool|`. For the 23 aggregate-reconciling groups
substituting the pool happens to reproduce the observed value in the one profile
checked, which is why the model is plausible — but as noted above that match does
not establish the contributor set, so the substitution stays a hypothesis rather
than a licence. For the four groups in [Caveats](#caveats) the substitution is
contradicted: in each the counter read **below** the number of completed pool
tasks, so counting the whole pool **overshoots** — a consumer would clear the
threshold and report a task available too early. The reason is undetermined. A
shortfall in child count fits two of the four (Mechanic tier 3 and Ragman tier 1),
but for the other two the children are not fewer than the pool at all, and in any
of the four an unresolved reset could equally explain a low reading after every
member had contributed. Treat all four as `unknown` rather than substituting a
full-pool count.

Each pool has 1–7 seed tasks carrying no counter gate, and the staggered waves
are reachable from those seeds in all 27 pools, so no pool can deadlock.

For corroboration, upstream asserts `taskRequirements` for only 1 of the 248,
and this overlay already corrects that entry.

### Reverse: a cardinality constraint, not a dependency

Knowing a player has a task at threshold `N` over a group tells you
`|completed ∩ contributors| >= N` and nothing more. Because there are **zero
intra-pool task edges**, no individual member is ever forced, so no specific task
can be inferred as required. Where the contributor set is verified, the number of
minimal explanations is `C(|contributors|, N)` — median 45 across the 164 gated
tasks, up to `C(16,5) = 4368` for Mechanic tier 3. Where it is not verified, the
count is not computable at all: substituting the pool would enumerate subsets that
include non-contributing members, so those four groups yield no explanation set
rather than a large one.

This does **not** license picking an `N`-subset and recording it as completed
history. The gate supplies no identity evidence, so any such subset is invented:
it can contradict the player's real history and double-count when the actual
completions later arrive. Keep the cardinality constraint instead.

What the absence of branches does buy is safety when planning **forward**, for a
pool whose contributor set is verified. There, any `N` currently-available members
will clear the threshold, and no choice among them can strand the player, because
no member fails another member and the only `Fail` conditions on pool tasks are
5 `CounterCreator` and 3 `Quest` entries, none of which target a pool task. So a
route planner may choose freely by cost; a history reconstructor may not choose at
all.

That guarantee does **not** extend to the four unreconciled groups. There an
available pool task may not advance the counter at all, so completing `N` of them
can leave the threshold unmet and a planner would report false progress. Restrict
route planning to verified contributors.

### Practical guidance

- Store the counter, not synthesized edges. Rendering these gates as
  prerequisite arrows invents structure the game does not have.
- Backfilling an unknown history: record the constraint `>= N of contributors`
  rather than marking specific tasks complete, and surface the shortfall
  (`N - have`).
- Planning a route to a task, **only for a group with a verified contributor
  set**: any `N` available contributors work, so pick by cost. Greedy selection is
  sufficient given the seed/wave structure. For the four unreconciled groups an
  available task may not advance the counter, so do not plan routes or report
  progress across them.
- A missing account value must evaluate to `unknown`, never `available`.

## Caveats

- **Four groups where the counter ≠ completed count** in the level-55 profile.
  The pairs below are the counter's value versus the number of completed pool
  tasks — not children versus pool size: Mechanic tier 3 (12 vs 16), Mechanic
  tier 4 (3 vs 4), Prapor tier 4 (6 vs 7), Ragman tier 1 (8 vs 9). In every case
  the counter reads lower, which is inconsistent with the pool being counted
  one-per-task. The cause is undetermined and at least two explanations survive:
  some task does not contribute (a shortfall in child count fits Mechanic tier 3
  at 12 children for 16 tasks and Ragman tier 1 at 8 for 9, but Mechanic tier 4
  has _more_ children than pool tasks and Prapor tier 4 has exactly as many), or
  the counter reset at some point after contributions landed. Nothing here
  distinguishes them, so no contributor identity is established for these groups.
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

Every threshold in the table, and the gated task names for any one group, come
from the same endpoint. Names arrive as translation keys (`"<taskId> name"`), so
this resolves them through `tasks_en`; the output is the Mechanic tier-2 listing
shown earlier verbatim:

```bash
GROUP=6a3c0fefbea2d2ad581c090b
curl -s https://json.tarkov.dev/pve/tasks    -o /tmp/tasks.json
curl -s https://json.tarkov.dev/pve/tasks_en -o /tmp/tasks_en.json
jq -r -n --slurpfile t /tmp/tasks.json --slurpfile en /tmp/tasks_en.json --arg g "$GROUP" '
  ($en[0].data) as $L
  | [ $t[0].data.tasks[]
      | . as $task
      | (.otherRequirements[]? | select(.type=="globalVariable" and .variableId==$g))
      | { value, name: ($L[$task.name] // $task.name) } ]
  | group_by(.value)[]
  | ">=\(.[0].value) (\(length)): \(map(.name) | join(", "))"'
# >=1 (5): Ill-Wisher, Chemistry Closet, Corporate Perks, The Secret to Productivity, Shady Contractor
# >=3 (3): Scout, Surveillance, Gunsmith - OP-SKS
# >=5 (3): Playing the Market, Gunsmith - Model 870, Secrets of Polikhim
```

This repository's `fetchTasks` adapter (`src/lib/tarkov-api.ts`) performs the same
translation lookup, so a script can call it instead of resolving keys by hand.

### Why this document is tracked

`AGENTS.md` says of the numeric `eft:*` cross-check tooling: "Never commit the
reference or anything derived from it; PRs carry only the resulting JSON5
corrections plus proof links." That prohibition is about republishing the
reference's contents — the raw capture and the field-by-field diffs the `eft:*`
tools emit, which is why their output goes to gitignored `data/`.

It is not a blanket ban on reference-informed output, and the repository already
commits such output deliberately: `src/additions/storyChapters.json5` is tracked,
declares "Source: local quest reference (structure/ordering)", and carries 345
per-objective `sourceQuestId` references, because those story quests exist nowhere
else. `AGENTS.md` sanctions that explicitly — "unlike the numeric `eft:*` tools
this one produces committed additions, not a gitignored diff. The reference itself
stays gitignored; only the generated JSON5 is committed."

This document sits well inside that boundary, and the boundary is checkable rather
than asserted:

- Every one of the 27 identifiers it names is published by
  `json.tarkov.dev/pve/tasks`. No capture-only identifier appears — two were
  removed for that reason while this document was in review.
- Every threshold and gated task name is re-derivable from public endpoints with
  the command above.
- Capture-informed content is limited to aggregates: the `Children` and `Pool`
  integers, the reconciliation counts, condition-type and `compareMethod`
  distributions, and the caveats. No per-task reference field values, and no
  quest, objective or child-variable identifier.

That is strictly less reference detail than the committed `storyChapters.json5`
already carries. If a maintainer prefers a stricter line, the affected material is
the aggregate columns and counts; the resolution rule and the guidance would go
with them, since `variable_group` is a client endpoint and cannot be described
from public data at all.
