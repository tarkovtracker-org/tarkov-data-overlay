# Global variables and progression counters

A global-variable requirement compares a number with a threshold. `variableId`
identifies the value; `id` identifies the condition. Neither ID describes task
order. Preserve the comparison operator, including equality: `== 0` means the
current value equals zero, not that an event could never have occurred.

Some targets refer to groups of child variables. Others represent individual
flags or stage values. Group membership alone does not establish how tasks
contribute, how values aggregate, or whether they reset. Trader loyalty is a
separate condition. Do not infer an additional loyalty gate from cohort metadata.

For the underlying mechanism — how a target resolves to a group or a scalar, what
the counters were observed to represent, and the open questions that keep those
observations the registry's pools are based on — see
[`GlobalVariableValue` task gates](GLOBAL_VARIABLE_MECHANICS.md).

## What ships today

The `progressionCounters` registry maps each of the 27 published trader-tier groups
to its pool (248 tasks). It is best effort, under the standard in
[registry contract](#registry-contract):

- **23 groups are `verified`/`complete`.** In every retained 1.1 PMC profile (one
  PVE, two PvP, two seasonal) the group's counter equals the number of completed
  pool tasks, and no capture contradicts the pool.
- **4 groups are `unresolved`/`partial`:** Mechanic tier 3 and 4, Prapor tier 4 and
  Ragman tier 1. Their counter reads below the completed pool count in at least one
  profile, so counting the pool would unlock tasks too early. See
  [Caveats](GLOBAL_VARIABLE_MECHANICS.md#caveats).

The `regular`, `pve` and `pvp-season` blocks are identical because the modes share
one variable-group catalogue: the `variable_group` payload is identical in the
PVE, PvP and seasonal captures, and tarkov.dev serves the same 164 gates over the
same 27 variables in each mode, with every pool task present in each mode's task
list. Pool membership itself was observed only as far as each capture reaches:
the PVE capture contains all 248 pool tasks, the PvP capture 226 and the seasonal
capture 12, and every observed task sits in the same trader tier as in PVE. The
rest of the PvP and seasonal membership rests on the shared catalogue.

Existing `otherRequirements` and `taskRequirements` remain unchanged, so consumers that do
not use the registry can continue their current integration.

`evaluateTaskProgression` computes a value only when a mapping is verified,
complete, and matches the selected mode and revision. Otherwise a global-variable
requirement needs an explicit resolved account value or evaluates to `unknown`.
See the [integration example](TASK_AVAILABILITY.md#evaluate-user-progress).

## Registry contract

Entries are indexed by mode, then by the requirement's `variableId`. This example
uses fictional IDs and illustrates a verified rule; it is not game data:

```json
{
  "pve": {
    "example-variable": {
      "revision": "example-rules-v1",
      "verification": "verified",
      "coverage": "complete",
      "derivation": {
        "type": "distinctTaskCompletions",
        "taskIds": ["example-task-a", "example-task-b", "example-task-c"]
      },
      "proof": ["https://example.com/verified-progression-rule"]
    }
  }
}
```

The registry belongs in `src/additions/progressionCounters.json5`; build output
publishes it as `overlay.progressionCounters`. The JSON schema rejects unsupported
modes, derivations, duplicate contributor IDs, and missing proof links. Runtime
validation also fails closed when a consumer bypasses source validation.

- `revision`: a maintainer-assigned identifier for the applicable game rules.
  It is not automatically the overlay version. Consumers must deliberately select
  the same identifier; omitted or mismatched revisions cannot derive a value.
- `verification`: `verified` means the mapping meets the best-effort standard
  below. `unresolved` entries are informational candidates.
- `coverage`: `complete` means the listed tasks are the whole pool as far as the
  evidence shows. `partial` mappings never produce an inferred value, even if
  marked verified.
- `distinctTaskCompletions`: each listed task contributes exactly one when
  complete in the current progression run. Duplicate events do not add points.
  This derivation is unsuitable for counters with repeat contributions, resets
  independent of task progress, shared markers, or non-task producers.
- `proof`: public evidence links for the rule and its scope. These are review
  evidence, not a guarantee that a supplied mapping is true.

### Evidence standard

The registry is best effort, like the rest of the overlay. It does not need
proof of the server-side mechanism. Mark an entry `verified`/`complete` when:

- the counter equals the completed-pool count in every retained profile for which
  the comparison is informative (a counter of 0 with no completed pool tasks
  counts as consistent, not as support), and
- no capture, public data or user report contradicts the pool.

Keep an entry `unresolved`/`partial` while any observation contradicts it, for
example a counter reading below its completed pool count. When new evidence
contradicts a `verified` entry, flip it back rather than waiting for a full
explanation. Re-check after a progression rework. Keep raw captures and derived
research in gitignored local directories and follow the capture-evidence rules
in `AGENTS.md`.

## Evaluation rules

An explicit finite `state.globalVariables[variableId]` takes precedence over a
computed value. It must already be the effective value for the condition target.
Raw child values are not automatically summed. An invalid explicit value yields
unknown rather than falling back to a potentially contradictory inferred value.

Without an explicit value, the evaluator requires a complete verified mapping and
known statuses for every contributor. A contributor is unknown when its own status is
missing, empty, or invalid, or when its status list mixes complete and non-complete
entries; a single unknown contributor makes the whole counter unknown. Otherwise each
contributor is scored: complete contributes one and known non-complete contributes zero,
so a contributor set mixing complete and incomplete tasks still resolves to a known
value. Incomplete history is not silently treated as zero.

`result.counters[variableId]` explains the source and includes the computed value
when known. For verified derivations it also lists completed, incomplete, and unknown
contributor IDs. The original condition in `result.all` retains the operator and
threshold, so consumers can explain a known shortfall. Do not label every incomplete
contributor available: evaluate that task's own gates before suggesting it.

## Backward progress inference

Explicit predecessor requirements retain their accepted statuses and alternatives.
An `active OR complete` edge cannot justify marking a predecessor complete. Likewise,
a verified requirement of three distinct completions does not identify which three
occurred. Candidate sets must themselves have reachable histories; arbitrary subsets
are not valid backfills.

The evaluator reads progress and does not mutate it or implement a historical solver.
Keep confirmed task history separate from inferred constraints. Past unlocks concern
past state under the applicable rules, not necessarily a variable's current value.
Unresolved variable producers remain a boundary in backward tracing. They must not be
converted into invented prerequisite edges.
