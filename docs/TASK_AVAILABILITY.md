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

## Definition semantics

`deriveTaskUnlockDefinition(task)` produces this compact shape:

| Field                   | Meaning                                                                                                                                                         |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `all`                   | Every condition is required: player level, faction, prestige, trader reputation/loyalty, and hidden requirements.                                               |
| `taskRequirements`      | Every referenced task must be in one of its listed statuses. A missing `status` means `complete`.                                                               |
| `anyOf`                 | Each group is required, but one task in that group is enough. This is the explicit format for an OR slot.                                                       |
| `alternatives`          | Complete alternative task/story paths. With `alternativesExclusive: true`, these replace the normal `taskRequirements`/`anyOf` path while `all` remains common. |
| `context`               | The task giver, assigned map, and `lightkeeperRequired` flag. These need account-state checks.                                                                  |
| `timing`                | A minimum/maximum delay after the other start conditions become true.                                                                                           |
| `completion.neededKeys` | Keys needed to enter a raid/objective; this is not a task-start prerequisite.                                                                                   |

The boolean algebra is:

```text
all AND context AND (
  taskRequirements AND every(anyOf group)
  OR one(alternatives)                 # only when alternatives exist
)
```

Status values inside one task requirement are ORed. For example, `['complete',
'failed']` means either terminal state satisfies that one edge. A task edge with
`active` is meaningful: it allows a predecessor that is currently started,
not only one that has been completed. Do not discard active edges.

The evaluator accepts both the string statuses used by tarkov.dev and BSG's
numeric profile status codes. The numeric mapping is based on the
[SPT quest structure reference](https://github.com/sp-tarkov/wiki/blob/main/modding/references/quest-values.md):
success (`4`) becomes `complete`, failure states (`5`–`8`) become `failed`, and
the in-progress/available states become `active`.

## Hidden IDs are useful state keys

The `otherRequirements` field currently contains two important types:

- `globalVariable`: `requirementId` is the BSG condition identity; `variableId`
  is the persistent variable whose numeric value is compared. The IDs may look
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

## Account adapter

The consumer should convert its synchronized profile into the small state
contract used by `evaluateTaskUnlock`:

```ts
import { deriveTaskUnlockDefinition, evaluateTaskUnlock } from 'tarkov-data-overlay';

const definition = deriveTaskUnlockDefinition(task);
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
IDs. `globalVariables` should be keyed by the variable-group entry's `id`
(the `variableId` in the task definition), not by the task's condition ID.

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
