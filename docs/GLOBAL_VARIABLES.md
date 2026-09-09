# Global variables and progression counters

A global-variable requirement compares a number with a threshold. `variableId`
identifies the value; `id` identifies the condition. Neither ID describes task
order. Preserve the comparison operator, including equality: `== 0` means the
current value equals zero, not that an event could never have occurred.

Some targets refer to groups of child variables. Others represent individual
flags or stage values. Group membership alone does not establish how tasks
contribute, how values aggregate, or whether they reset. Trader loyalty is a
separate condition. Do not infer an additional loyalty gate from cohort metadata.

## What ships today

The overlay exposes an optional `progressionCounters` registry, initially empty.
No real task-to-counter mapping is asserted by this feature. Existing
`otherRequirements` and `taskRequirements` remain unchanged, so consumers that do
not use the new registry can continue their current integration.

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
- `verification`: `verified` requires evidence of the derivation, not merely a
  similar task count. `unresolved` entries are informational candidates.
- `coverage`: `complete` means the entire contributor set is established.
  `partial` mappings never produce an inferred value, even if marked verified.
- `distinctTaskCompletions`: each listed task contributes exactly one when
  complete in the current progression run. Duplicate events do not add points.
  This derivation is unsuitable for counters with repeat contributions, resets
  independent of task progress, shared markers, or non-task producers.
- `proof`: public evidence links for the complete rule and its scope. These are
  review evidence, not a cryptographic guarantee that a supplied mapping is true.

Before marking an entry verified, establish the contributor identities, contribution
amount, relevant completion state, alternate producers, initial value, and reset
behavior for that mode/revision. A matching sum in one profile does not prove these
properties. Re-verify after a progression rework. Keep captures and derived research
in gitignored local directories; publish only permitted corrections with public proof.

## Evaluation rules

An explicit finite `state.globalVariables[variableId]` takes precedence over a
computed value. It must already be the effective value for the condition target.
Raw child values are not automatically summed. An invalid explicit value yields
unknown rather than falling back to a potentially contradictory inferred value.

Without an explicit value, the evaluator requires a complete verified mapping and
known statuses for every contributor. Missing, invalid, or mixed complete/non-complete
status lists make the result unknown. Known non-complete statuses contribute zero;
complete statuses contribute one. Incomplete history is not silently treated as zero.

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
