# Issue triage

This guide defines how maintainers and AI agents review GitHub issues for
`tarkov-data-overlay`. The goal is to make every issue useful for the next
person: identify the exact data claim, verify it against current sources, link
related history, and leave a clear next action.

Triage is evidence-driven and fail-closed. If a claim cannot be verified, do
not mark it confirmed, fixed, duplicate, or resolved merely because it sounds
plausible.

## Labels

Apply one type label, one lifecycle label, and an action label only when there
is a concrete implementation step.

| Label                        | Meaning                                                                                                    |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `type:correction`            | The report concerns data already served by tarkov.dev.                                                     |
| `type:addition`              | The report concerns data missing from tarkov.dev.                                                          |
| `status:needs-triage`        | The issue has not yet received a complete evidence-based review.                                           |
| `status:needs-info`          | The report is actionable in principle, but required details or proof are missing.                          |
| `status:needs-investigation` | Available sources conflict, are unavailable, or need deeper investigation.                                 |
| `status:confirmed`           | The current problem is reproducible and supported by evidence.                                             |
| `status:fixed`               | The consumer-visible problem is absent from latest `main`, with the repository or upstream fix identified. |
| `status:duplicate`           | The report repeats another issue; the canonical issue must be linked.                                      |
| `status:wontfix`             | The report is invalid, out of scope, unsupported, or intentionally will not be changed.                    |
| `action:ready-to-fix`        | A confirmed report has enough detail for a focused implementation.                                         |

Only one lifecycle label should remain after triage. When changing a status,
remove the previous lifecycle label. Keep the original issue type when it is
clear; if the type is unclear, use `status:needs-info` instead of guessing.

The prefixed labels are the long-term contract. The existing unprefixed
`correction` and `addition` labels may remain during migration, but new issues
should use the prefixed labels. A maintainer must create or rename labels in
GitHub repository settings; this repository does not grant a bot permission to
change external issue metadata.

## Triage procedure

### 1. Read and normalize the report

Capture the entity ID, entity type, field or proposed data shape, affected
mode, current value, expected value, version/date, and evidence. Update the
title only when it is misleading or too vague. Use one of these forms:

```text
[CORRECTION] <entity> — <field> — <mode> mismatch
[NEW DATA] <data type> — <entity or scope> missing
```

Do not silently invent values while rewriting an issue. If the title or body
cannot be made specific from the report, request the missing information.

For a legacy or incomplete issue, preserve the reporter's original description
and append a `## Triage summary` when a normalized record is needed. It should
contain:

```markdown
## Triage summary

- **Entity:** `<type> — <name> — <ID>`
- **Mode/scope:** `<regular, pve, pvp-season, or mode-independent>`
- **Field/data:** `<exact field path or missing data type>`
- **Observed:** `<current upstream value or confirmed absence>`
- **Expected:** `<correct value or requested structure>`
- **Impact/reproduction:** `<what is wrong and how to see it>`
- **Evidence:** `<links and retrieval/version dates>`
```

Only fill a line from the issue or verified evidence. If a required line
cannot be completed, use `status:needs-info` rather than guessing.

### 2. Check for duplicates first

Search both open and closed issues using the entity name, entity ID, field
name, data type, and distinctive wording. A duplicate must link the canonical
issue and state its current state:

- Duplicate of an open issue: keep the canonical issue as the implementation
  queue and link the report to it.
- Duplicate of a closed issue: link the closing PR, commit, or resolution. Do
  not reopen it unless the new report demonstrates a distinct regression or a
  different mode/version.
- Similar wording without the same entity, field, mode, or root cause is not
  enough to call it a duplicate; use `status:needs-investigation`.

### 3. Verify the current repository state

Review the latest `main`, not only the branch or commit that happened to be
checked out. A local verification can start with:

```bash
git fetch origin main --no-tags
git rev-parse origin/main
npm ci
npm run validate
npm run build:check
npm test
```

Use the smallest relevant checks while investigating, but run the full checks
before calling a data report fixed by a repository change. Inspect the source
files and generated `dist/overlay.json` on the verified `main` commit.

For corrections, compare the reported field with the current
`json.tarkov.dev` endpoint for every mode the report claims is affected. The
supported modes are `regular`, `pve`, and `pvp-season`; do not infer that one
mode matches another without evidence. `npm run check-overrides` is useful for
finding stale or still-needed overlay corrections, but an issue verdict must
still identify the relevant entity and field.

For a correction, distinguish these outcomes explicitly:

- Upstream is still wrong and latest `main` does not correct the consumer
  result: the issue is confirmed.
- Latest `main` corrects the consumer result while upstream remains wrong: the
  issue is fixed in the repository.
- Upstream now serves the expected value and latest `main` has no conflicting
  override: the issue is fixed upstream.
- Upstream now serves the expected value but latest `main` still applies an
  obsolete or conflicting override: the issue is still actionable; keep it
  confirmed and identify the stale overlay entry as the next fix.

For additions, confirm that the requested data is absent from the applicable
upstream endpoint and not already represented in `src/additions/` or the built
overlay. Seasonal-only data may be valid as an addition even though
`pvp-season` itself is served upstream.

### 4. Validate the evidence

Prefer evidence in this order:

1. In-game capture or a current official patch note.
2. EFT wiki Requirements or data page, checked through the MediaWiki API when
   possible.
3. A reproducible current API response or consumer report, with its mode and
   retrieval date.

Do not scrape challenged `/wiki/` HTML pages. Use the wiki MediaWiki API
pattern documented in `AGENTS.md`.

Apply field-specific caution from the contribution guide:

- A wiki `previous` field is narrative order, not proof of a
  `taskRequirements` unlock edge. Confirm the actual `Quest` start condition;
  `traderRequirements` and `otherRequirements` can represent the real gate.
- Absence of a local quest-reference value does not prove that
  `minPlayerLevel` is zero. Use the wiki Requirements section, and interpret
  an explicit `0` as no level gate.
- For map and trader references, verify the ID/name pair against the registries
  in `src/lib/types.ts`; matching names alone are insufficient.

If sources disagree, record the conflict and use
`status:needs-investigation`. Never choose the more convenient source without
explaining why it is authoritative for that field.

### 5. Choose exactly one verdict

| Verdict             | Use when                                                                                                                                                 | Required follow-up                                                                                               |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Confirmed           | The report is current, reproducible, and evidenced.                                                                                                      | Apply `status:confirmed`; add `action:ready-to-fix` only when implementation can start.                          |
| Fixed               | The consumer-visible problem is absent from latest `main`; either the repository correction is present, or upstream is correct and no overlay conflicts. | Apply `status:fixed`; link the commit/PR or current API evidence and say whether the fix is in-repo or upstream. |
| Duplicate           | The same root issue is tracked elsewhere.                                                                                                                | Apply `status:duplicate`; link the canonical issue and say whether it is open or closed.                         |
| Needs information   | A required ID, field, mode, value, version, reproduction, or proof is missing.                                                                           | Apply `status:needs-info`; ask only for the missing facts.                                                       |
| Needs investigation | Evidence conflicts, the API is unavailable, or the claim cannot yet be reproduced.                                                                       | Apply `status:needs-investigation`; state the exact unresolved question.                                         |
| Won't fix           | The report is invalid, outside the overlay's scope, or intentionally unsupported.                                                                        | Apply `status:wontfix`; explain the scope or technical reason and link guidance when useful.                     |

“Fixed” means the consumer-visible problem is fixed in the latest `main`, not
merely fixed in an unmerged branch or proposed pull request. An upstream value
matching the report is not enough if the committed overlay still overrides it.
If a PR is the fix but has not merged, keep the issue confirmed and link the PR
as the next action.

### 6. Leave an auditable comment

Every triaged issue should record the verification point, modes checked,
evidence used, verdict, and next action. Replace bracketed placeholders; do
not leave a generic “looks good” comment.

#### Confirmed

```markdown
### Triage: confirmed

- **Checked:** `main` at `<commit>`
- **Modes/data checked:** `<modes and endpoint or source>`
- **Finding:** `<current value differs from expected value>`
- **Evidence:** <links and what each proves>
- **Next action:** `<implementation needed>`
```

#### Fixed

```markdown
### Triage: fixed

- **Checked:** `main` at `<commit>` and/or upstream data retrieved `<date>`
- **Result:** `<explain the corrected source and field>`
- **Proof of fix:** <commit, PR, release, or API links>
- **Resolution:** `<in latest main | upstream fixed>`
```

#### Duplicate

```markdown
### Triage: duplicate

This report has the same root cause as [#<canonical issue>](link), which is
currently **<open/closed>**. See <closing PR, commit, or resolution link>.
```

#### Needs information

```markdown
### Triage: needs information

I cannot verify this report yet. Please provide:

- `<specific missing field or value>`
- `<specific mode/version/reproduction/proof>`

The issue will remain open while this information is collected.
```

#### Needs investigation

```markdown
### Triage: needs investigation

- **Checked:** `<commit, endpoint, or source>`
- **Conflict or gap:** `<exact unresolved question>`
- **Tried:** `<checks and evidence>`
- **Next step:** `<investigation needed>`
```

#### Won't fix

```markdown
### Triage: won't fix

This is outside the overlay's supported scope because `<specific reason>`.
The relevant guidance is <link>. No data change will be made for this report.
```

## Backlog rollout

Apply the process to existing open issues in bounded batches:

1. Create the prefixed labels and retain the old labels during migration.
2. Triage the oldest or highest-impact issues first.
3. Normalize only titles and bodies that are materially unclear; preserve the
   reporter's original facts.
4. Add one triage comment with the exact verification point and links.
5. Close only issues classified as fixed, duplicate, or won't fix when the
   comment contains the required proof.
6. Leave ambiguous issues open as `status:needs-info` or
   `status:needs-investigation`.

Do not batch-close based only on age, title similarity, or a changed upstream
version. Re-run the relevant checks after major game or API updates.
