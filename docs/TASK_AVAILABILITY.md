# Task availability and unlock tracking

This repository now exposes the task-start model that TarkovTracker needs. The
model is intentionally separate from objectives, rewards, dialogue text, and
loot. Those fields describe what to do after a task is visible; they do not
prove that the task is unlocked.

## The important boundary

`json.tarkov.dev` provides a mode-specific static definition. It does not know
the player's current quest statuses, trader unlock flags, map access, dialogue
flags, global-variable values, or Lightkeeper state. A complete availability
decision is therefore:

```text
static task definition + account snapshot -> available | blocked | unknown
```

`unknown` is deliberate. A missing account field must not be treated as
`true`, because that is what makes every task look available to a new or
partially synchronized user.

## Evaluate user progress

Use one operation for a task after merging the selected mode's API data and overlay:

```ts
import { evaluateTaskProgression } from '../src/lib/index.js';

const result = evaluateTaskProgression(task, accountState, {
  mode: selectedMode,
  revision: selectedGameRulesRevision,
  counters: overlay.progressionCounters,
  storyChapters: overlay.storyChapters,
});

if (result.recordedStatus === 'complete') {
  // Keep the task in completed history.
} else if (result.recordedStatus === 'active') {
  // Keep the accepted task active, independently of its current start gates.
} else if (result.status === 'available') {
  // Eligible to start, subject to its separately recorded lifecycle state.
} else if (result.status === 'blocked') {
  // Explain result.blockers.
} else {
  // Explain result.unknown; do not silently present this as available.
}
```

Handle other recorded states (such as availableForFinish, failed, and availableAfter)
in their own lifecycle views. `result.status` evaluates start conditions only; it does
not restart, fail, or complete an existing task. Never replace recorded history with
that result. The helper does not fetch account data or apply an overlay for you.

`accountState` uses the fields in the account adapter below. Supply one account,
game mode, and wipe/prestige/season run consistently. Recompute after progress changes;
no counters or history are mutated. Missing task entries mean unknown, so a tracker
with a known complete history should explicitly record its non-complete tasks too.

A required false condition produces `blocked`; otherwise missing state produces
`unknown`. An OR group is satisfied if one supported alternative is satisfied.
Existing player-level, trader, dialogue, map, story, and timing gates still apply.
Task completion alone cannot resolve all of them.

For verified mappings, `result.counters` explains each value and its contributor
progress. The registry starts empty: this release supplies the model, not speculative
game mappings. See [global variables and progression counters](GLOBAL_VARIABLES.md)
for the data contract, evidence requirements, and safe backward-inference boundary.

The helpers are source-level exports, not a published npm runtime package. Consumers
must update their vendored/workspace source to use this entry point. Existing callers
of `deriveTaskUnlockDefinition` and `evaluateTaskUnlock` can continue using them.

## Definition semantics

`deriveTaskUnlockDefinition(task, { storyChapters })` produces this compact shape.
The optional `storyChapters` value is the built overlay's `storyChapters` object;
matching `questUnlocks` become exclusive story alternatives automatically.

| Field                   | Meaning                                                                                                                                                                                                                                                    |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `all`                   | Every condition is required: player level, faction, prestige, trader reputation/loyalty, and hidden requirements.                                                                                                                                          |
| `taskRequirements`      | Every referenced task must be in one of its listed statuses. A missing `status` means `complete`.                                                                                                                                                          |
| `anyOf`                 | Each group is required, but one task in that group is enough. This is the explicit format for an OR slot.                                                                                                                                                  |
| `alternatives`          | Complete alternative task/story paths. When present, `alternativesExclusive: true` uses only these paths, while `false` ORs them with the ordinary `taskRequirements`/`anyOf` path. With no alternatives, the ordinary path is used. `all` remains common. |
| `context`               | The task giver, assigned map, and `lightkeeperRequired` flag. These need account-state checks. A missing or malformed task giver is retained as an unknown condition rather than treated as no gate.                                                       |
| `timing`                | A minimum/maximum delay after the other start conditions become true.                                                                                                                                                                                      |
| `completion.neededKeys` | Keys needed to enter a raid/objective; this is not a task-start prerequisite.                                                                                                                                                                              |

The boolean algebra is:

```text
ordinary = taskRequirements AND every(anyOf group)

no alternatives:
  all AND context AND ordinary
alternativesExclusive = false:
  all AND context AND (ordinary OR one(alternatives))
alternativesExclusive = true:
  all AND context AND one(alternatives)
```

When alternatives are present, `alternativesExclusive: false` keeps the
ordinary path as an OR candidate, while `true` evaluates only the explicit
alternatives. Without alternatives, `taskRequirements` and `anyOf` always form
the ordinary path.

Status values inside one task requirement are ORed. For example, `['complete',
'failed']` means either terminal state satisfies that one edge. A task edge with
`active` is meaningful: it allows a predecessor that is currently started,
not only one that has been completed. Do not discard active edges.

The evaluator accepts string statuses and BSG numeric profile status codes, keeping
their meanings distinct:

| Code | Status             |
| ---- | ------------------ |
| 0    | locked             |
| 1    | availableForStart  |
| 2    | active             |
| 3    | availableForFinish |
| 4    | complete           |
| 5    | failed             |
| 6    | failedRestartable  |
| 7    | markedFailed       |
| 8    | expired            |
| 9    | availableAfter     |

`started` and `accepted` alias `active`; `completed` and `success` alias `complete`.
Available/delayed states do not satisfy an active edge. Failure states are also
distinct. This corrects the previous evaluator's broad status collapsing; consumers
that intentionally accept several states must list those states explicitly. The
exported `normalizeTaskStatus` uses the same normalization as the evaluator.

## Hidden IDs are useful state keys

The `otherRequirements` field currently contains two important types:

- `globalVariable`: `requirementId` is the BSG condition identity; `variableId`
  identifies the scalar or group whose effective numeric value is compared. The IDs may look
  random because they are generated identifiers, but they are deterministic
  references, not a task-order heuristic. Track the value by `variableId` and
  retain `requirementId` for provenance/debugging.
- `dialogue`: `requirementId` is the condition identity and `traders` identifies
  the trader interaction. Track the condition ID in `completedConditionIds` or
  provide it in `dialogues`. Do not infer dialogue completion from the task
  name or from merely having the trader unlocked.

Unknown future `otherRequirements` types are retained by the adapter and
evaluate as `unknown` until TarkovTracker adds a state adapter. This is safer
than silently dropping a new BSG start condition.

## Specific story-objective gates

`otherRequirements` also supports the overlay-defined `storyObjective` type:

```json
{
  "id": "overlay.task-id.boreas.hard-drives",
  "type": "storyObjective",
  "storyChapter": { "id": "boreas", "name": "Boreas" },
  "objective": {
    "id": "69bc0b6069651f9af0993d2c",
    "name": "Ask Mechanic for help decoding the hard drives from the icebreaker"
  }
}
```

Supply explicit completion through
`accountState.storyObjectives[chapterId][objectiveId]`: `true` satisfies the
condition, `false` blocks it, and missing/non-boolean values remain `unknown`.
Chapter completion or an unrelated objective does not substitute for this state.
The Boreas guide identifies this objective as handing all three C-1 hard drives
to Mechanic; collecting the drives or merely starting Boreas is insufficient.
These gates are ANDed with the task's other requirements and do not invent
normal quest prerequisites. They do not require finishing the whole chapter.

Consumers must update their vendored evaluator and account adapter. Older
versions safely retain this new requirement type as unknown; they must not
silently drop it or display unknown eligibility as available.

## Account adapter

The consumer should convert its synchronized profile into the small state
contract used by `evaluateTaskUnlock`. The helpers are source-level exports in
this repository rather than a published npm runtime package, so import them
from the vendored or workspace source path used by your application:

```ts
import { deriveTaskUnlockDefinition, evaluateTaskUnlock } from '../src/lib/index.js';

const definition = deriveTaskUnlockDefinition(task, {
  storyChapters: overlay?.storyChapters,
});
const result = evaluateTaskUnlock(task, definition, {
  playerLevel: profile.level,
  faction: profile.faction,
  taskStatuses: questStatusesById,
  traderLevels: traderLoyaltyById,
  traderReputation: traderStandingById,
  traderUnlocked: traderUnlocksById,
  mapAccess: mapAccessById,
  lightkeeperUnlocked: profile.lightkeeperUnlocked,
  globalVariables: variablesByVariableId,
  completedConditionIds: profile.completedConditionIds,
  storyChapters: storyChapterProgressById,
});

if (result.status === 'available') {
  // Show the task.
} else if (result.status === 'blocked') {
  // Show result.blockers as actionable prerequisites.
} else {
  // Keep it out of the available list until the missing state is synced.
  // result.unknown explains which account feed is incomplete.
}
```

For BSG profile data, `taskStatuses` may use the quest's numeric `status`, and
`completedConditionIds` may be populated from the quest's completed condition
IDs. `globalVariables` is keyed by the condition's `variableId`, whether that is
a scalar ID or a group ID. Group values must already be resolved by a trusted
adapter; raw profile child values are not sufficient. Both `=` and BSG `==`
are supported numeric equality operators.

## Traders and maps

`fetchModeAccessData('regular' | 'pve' | 'pvp-season')` exposes static entry
metadata:

- map `minPlayerLevel`, `maxPlayerLevel`, `accessKeys`, and
  `accessKeysMinPlayerLevel`;
- trader loyalty levels with `requiredPlayerLevel`, `requiredReputation`, and
  `requiredCommerce`.

This data explains the rules, but it is not the player's unlock state. The
static endpoint does not provide a reliable per-account `unlockedByDefault`
flag, so the consumer must derive `traderUnlocked` and `mapAccess` from its
account/game-state feed. A task's `trader` is its giver; a task's `map` is its
assigned map when the upstream definition has one. A `null` map generally
means the task spans multiple locations and should not be turned into a
single map gate. `neededKeys` remains an entry/completion requirement.

Task rewards are normalized so `traderUnlock`, `traderDialogueUnlock`, and
`locationUnlock` are arrays of `{ id, name }` references. These are unlock
events caused by completing/starting a task, not prerequisites for that same
task. Story chapter `mapUnlocks` and `traderUnlocks` follow the same rule.

## Modes and generated reports

All three upstream modes are independent inputs and must be fetched and
evaluated separately:

- `regular`
- `pve`
- `pvp-season`

Run:

```bash
npm run tasks:availability
```

This fetches current task/map/trader data for every mode, applies the built
overlay, joins explicit story alternatives, and writes compact reports to
`data/task-availability/{regular,pve,pvp-season}.json`. Use `--stdout` for a
pipeable report, `--mode pve` for one mode, and `--no-overlay` to inspect only
the upstream definition. The report intentionally omits objectives, rewards,
dialogue text, and other payload noise.

When the built overlay is present, its `$meta.sha256` digest is verified before
any corrections or additions are applied. Use `--no-overlay` to generate a
report from upstream data without an overlay. This detects stale or corrupted
JSON but is not a cryptographic signature; loaders reject legacy or custom
overlays that do not contain a valid build digest.

## Network Provider - Part 1

The old 13-task override was removed. It was a plausible
[wiki](https://escapefromtarkov.fandom.com/wiki/Network_Provider_-_Part_1)
transcription,
but the current static task data does not publish those prerequisites, the
current BSG capture only proves the Fence reputation gate, and the current wiki
page leaves the third quest path unresolved. Keeping that list made a false
AND graph and could hide valid paths. The overlay now retains the explicit
Batya and The Ticket story alternatives, the API's Fence reputation gate, and
the Lightkeeper/trader account gates. Until the unresolved third path is
independently verified, it remains `unknown` rather than being guessed. This
addresses the false-positive report tracked in
[issue #254](https://github.com/tarkovtracker-org/tarkov-data-overlay/issues/254).

For the general upstream data contract, see the
[tarkov.dev task data](https://tarkov.dev/) and the repository's
[integration guide](INTEGRATION.md).
