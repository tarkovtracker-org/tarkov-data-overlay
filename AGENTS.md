# Repository Guidelines

## Project Overview

Community-maintained data overlay for tarkov.dev API corrections and additions. Provides a JSON overlay file that consumers merge with tarkov.dev API responses to fix incorrect data or add missing data types (like game editions).

## Project Structure & Module Organization

`src/overrides/` holds JSON5 corrections keyed by tarkov.dev IDs, while `src/additions/` contains new data types (for example game editions). `src/schemas/` stores JSON Schemas, and `src/lib/` houses shared TypeScript utilities used by scripts in `scripts/`. Built output lands in `dist/overlay.json`. Tests live in `tests/`, with docs in `docs/`. The `data/` directory is used for local cache/results from validation tooling.

## Architecture

### Shared Library (src/lib/)

Scripts share utilities via `src/lib/index.ts`:

- `file-loader.ts` - JSON5/JSON loading, project paths, directory scanning
- `script-utils.ts` - CLI entry-point detection (`isDirectExecution`) and `sleep`
- `tarkov-api.ts` - json.tarkov.dev adapter that fetches the static per-mode JSON endpoints (tasks/items/maps/traders plus `_en` translations) and adapts them into the `TaskData[]` shape
- `task-validator.ts` - Override validation logic against API data
- `terminal.ts` - Console output formatting (colors, icons, progress, summary sections)
- `types.ts` - Shared TypeScript interfaces and schema configs

The wiki comparison tool is modular: `scripts/wiki-compare.ts` is a thin entry point re-exporting the public/test API, with the implementation in `scripts/wiki-compare/` (`types`, `cache`, `overlay`, `normalize`, `api`, `wiki`, `compare`, `cli`). Shared reference-file parsing (`findReferenceFile`, `parseEftTasks`, `detectReferenceMode`, `parseModeArgs`, `requireMatchingReferenceMode`) lives in `scripts/eft-compare.ts` and is imported by the other `eft:*` scripts.

### Build Pipeline

1. `scripts/validate.ts` - Validates JSON5 source files against schemas using AJV
2. `scripts/build.ts` - Compiles JSON5 sources into single `dist/overlay.json` with metadata

### Output Structure

The built `dist/overlay.json` contains entity sections keyed by tarkov.dev IDs (tasks, items, etc.) plus a `$meta` object with version, generated timestamp, and SHA256 hash.

### Game Modes

Two mode lists live in `src/lib/types.ts`:

- `SUPPORTED_GAME_MODES` (`regular`, `pve`, `pvp-season`) — the modes tarkov.dev
  serves upstream, as reported by `json.tarkov.dev/endpoints` (`gameModes`).
  `pvp-season` is BSG's Seasonal Character (patch 1.1.0.0) and is served like any
  other mode (`/{mode}/tasks`, `items`, `maps`, `traders`, `hideout`, ...).
  Everything that fetches/compares against tarkov.dev iterates this list, and
  `build.ts`/`validate.ts` iterate it for `src/overrides/modes/<mode>/` sections.
- `DIVERGENCE_MODES` aliases `SUPPORTED_GAME_MODES`, so divergence validation
  can adjudicate `regular`, `pve`, and `pvp-season`. Registry fields may omit a
  mode until its true value is independently verified; omission must not be
  interpreted as equality with another mode.

Seasonal-only data types tarkov.dev does not model at all live in dedicated
additions, e.g. `src/additions/seasonalPerks.json5` (schema
`seasonal-perk.schema.json`): tarkov.dev serves the `pvp-season` mode but has no
seasonal-perks endpoint, so the perks ship as an addition, following the same
pattern as `editions.json5`.

## Build, Test, and Development Commands

- `npm install` installs dependencies.
- `npm run validate` validates JSON5 sources against schemas (run before opening a PR).
- `npm run build` generates `dist/overlay.json` from sources.
- `npm run check-overrides` compares overrides to the live tarkov.dev API.
- `npm run typecheck` runs `tsc --noEmit` (also run in CI).
- `npm test` runs the Vitest suite (also run in CI); `npm run test:watch` keeps it running.
- `npm run format` / `npm run format:check` run Prettier over the TypeScript sources.
- Example single test: `npx vitest run tests/file-loader.test.ts`.

### Reference cross-check tooling (local-only)

The `eft:*` scripts cross-check the overlay against a local quest reference -
values verified in-game and kept out of the repo - which is the authority for
numeric quest fields (experience, minPlayerLevel, objective counts). The
reference lives in `eft/` and all derived output in `data/` — both gitignored.
Versioned captures go in subdirectories (`eft/eft-1.1-pve/`); `findReferenceFile`
scans recursively and auto-detects the most recently captured `quest_list`
reference, so a fresh dump supersedes an older one without touching the tooling
call sites (pass an explicit `eftDir` to pin a specific capture).
Never commit the reference or anything derived from it; PRs carry only the
resulting JSON5 corrections plus proof links. That prohibition covers the raw
capture and the field-by-field diffs these tools emit — not every artifact
informed by the reference. Deliberate, documented exceptions exist and are called
out where they apply: `src/additions/storyChapters.json5` and its provenance lock
`scripts/story-reference.lock.json` (both below) and
`docs/GLOBAL_VARIABLE_MECHANICS.md`, which records aggregates plus a few per-task
observations, using only publicly published identifiers and no reference field
values. Anything new in that category needs the same explicit rationale and must
name what it does and does not reproduce.

- `npm run eft:normalize` distills the local reference into a clean
  tarkov.dev-shaped `data/eft/quests.<mode>.json`.
- `npm run eft:compare` lists where the reference disagrees with the live API.
- `npm run eft:wiki` cross-references those reference-vs-API discrepancies
  against the EFT wiki, showing whether the wiki backs the reference, the API,
  or neither (minPlayerLevel and experience only).
- `npm run eft:audit` is the three-way `reference -> API -> overrides` check.
  Per field it reports GAP (API wrong, no override — add one), STALE (API fixed
  upstream, override redundant — remove it), CONFLICT (override disagrees with
  the reference — fix it), or OK (override correct and still needed). It covers
  `experience`, `minPlayerLevel`, objective counts, and `taskRequirements`. The
  reference is mode-specific; the audit auto-detects its mode and refuses a
  mismatched `--mode` to avoid false positives.

  Field authority differs, and getting this wrong has shipped regressions.
  Patch 1.1.0.0 expresses most trader-loyalty gates as `GlobalVariableValue`
  start conditions against opaque per-tier variables rather than as
  `TraderLoyalty` conditions, and tarkov.dev serves those as
  `otherRequirements` `globalVariable` entries. A `GlobalVariableValue` is a
  numeric state gate, though — not automatically a loyalty condition or a task
  prerequisite list. See `docs/GLOBAL_VARIABLES.md` for counter evidence
  requirements. That distinction drives all three rules below:
  - `taskRequirements` — preserve explicit `Quest` start conditions and their
    accepted statuses. The wiki's infobox `previous` field is narrative order,
    **not** proof of an unlock edge. Distinguish a present template carrying no
    `Quest` condition from a task missing from the capture entirely; only the
    former licenses `taskRequirements: []`.
  - `minPlayerLevel` — absence of an explicit `Level` condition does **not**
    authorize `0`. Template status values alone do not prove capture
    completeness, so treat the explicit-gate list as a floor on what exists
    rather than a closed set. Upstream also _derives_ `minPlayerLevel` from the
    loyalty tier's `requiredPlayerLevel` when a task is loyalty-gated, so a
    missing `Level` condition means "no explicit gate", not "no gate", and
    zeroing those would discard a correct derived floor. Check trader and
    predecessor-derived floors plus the wiki Requirements section, and only
    correct the field when upstream's value matches none of them.
  - `traderRequirements` — **not** auditable against the reference, which is why
    `eft:audit` deliberately does not cover it. Because the gate lives in a
    global variable, the client shows no `TraderLoyalty` condition even for tasks
    that do have a loyalty gate; treating absence as "no gate" would falsely
    condemn 150+ correct overrides. Use explicit loyalty conditions and the
    corroborated wiki Requirements section. A candidate cohort tier must not
    automatically become an extra runtime gate.

- `npm run eft:story` regenerates `src/additions/storyChapters.json5` from the
  reference. Story quests are entirely absent from tarkov.dev, so unlike the
  numeric `eft:*` tools this one produces committed additions, not a gitignored
  diff. It takes objective text/order/ids from the local reference for structure
  and the optional/required flags plus proof from the EFT wiki, merges curated
  chapter metadata from `scripts/story-chapter-meta.json`, and derives The
  Ticket's branch model (chapter-level `endings` with the real
  `client/ending_list` ids, plus per-chapter `referenceCoverage`) from the
  capture rather than from curated slugs. The reference itself stays gitignored;
  only the generated JSON5 is committed. The pipeline is pure TypeScript
  (`eft-story-wiki.ts` -> `eft-story-generate.ts` -> `eft-story-write.ts`);
  fuzzy optional-matching uses a faithful difflib `SequenceMatcher.ratio()`
  port in `scripts/lib/sequence-matcher.ts`.

  Generation is local-only and cannot run in CI or for a contributor without the
  capture. What keeps the committed output auditable is
  `scripts/story-reference.lock.json`, a committed provenance lock — the second
  deliberate exception to "never commit anything derived from the reference".
  It records only which capture was used: path, SHA-256, byte size, client
  version, game mode, capture timestamp, and how much of the storyline that
  capture resolved (quest count, chapter quests, objective texts). It reproduces
  no field values — no experience, no level gates, no objective text, no ids.
  The generator refuses to guess: it uses the locked capture and fails if the
  hash no longer matches, and `STORY_REFERENCE_UPDATE_LOCK=1` is the only way to
  re-pin, so switching source captures always lands as a reviewable lock diff
  next to the regenerated data. `STORY_REFERENCE=<file>` only relaxes the _path_
  (a moved or renamed copy of the pinned capture); its hash must still match, so
  it cannot swap in a different capture. The generator stages a sidecar binding
  the capture to the exact payload it emits, and `eft-story-write.ts` refuses to
  replace the artifact without one - so an edited or unrelated
  `data/eft/story-final.json` cannot be published under the committed lock.
  Note the pinned capture is not
  necessarily the newest one: the client returns a story sub-quest template only
  once the player has reached it, so an older capture from an advanced character
  resolves more of the storyline than a fresh one from an early character, and
  the lock's `clientVersion` may therefore predate the current patch. Check it
  before assuming the storyline data reflects the latest build.

## Coding Style & Naming Conventions

TypeScript uses 2-space indentation, semicolons, and ESM imports (see `"type": "module"`). Data files are JSON5 and may include comments. Use tarkov.dev entity IDs as keys and field names that match the tarkov.dev API exactly (camelCase). Every correction must include: entity name comment, proof link, and inline “Was:” value. For nested patches (like task objectives), use ID-keyed objects rather than arrays. Empty override files are valid and skipped during build. When adding a new entity type, add its schema to `SCHEMA_CONFIGS` in `src/lib/types.ts`.

## Testing Guidelines

Vitest is the only test framework. Tests should be named `*.test.ts` under `tests/`. There is no explicit coverage gate, but add or update tests when you change shared library behavior or validation logic.

## Static Analysis Findings

Fix fallow findings at their root whenever the code can be safely consolidated, simplified, removed, or covered by tests. Do not add `fallow-ignore` suppressions for resolvable findings; suppressions must be reserved for genuinely unavoidable tool false positives or external/runtime constraints, include a specific reason, and receive explicit reviewer approval.

`npm run fallow:security` reports candidates rather than confirmed vulnerabilities and
exits 0; CI checks only newly introduced ones (`--gate new --changed-since <base>`), and
because `main` is not branch-protected a red result reports rather than blocks. The 30
candidates standing on `main` were triaged and are all tool false positives. Re-check a
category only if the guard named below stops holding, and prefer fixing a guard over
suppressing an item:

- **Path traversal, 16 items** (`scripts/wiki-compare/overlay.ts`, `cache.ts`). Every path
  is `path.join(process.cwd(), …)` over literal segments except the mode segment in
  `taskOverlayFiles`, which is either a member of the module-local `WIKI_COMPARE_MODES`
  constant or a `SuppressionScope` argument threaded down from a caller. That type is a
  compile-time bound only, so the guard that matters is at the input boundary: the sole
  external source is the `--gameMode`/`-g` flag, and `cli.ts` accepts it only when it equals
  `regular`, `pve`, or `both`, discarding anything else so the `'both'` default applies. A new
  entry point that reaches these helpers without passing through that check needs its own
  validation. User-derived cache stems go through `assertSafeCacheFileStem`
  (`/^[A-Za-z0-9_-]{1,128}$/`). `resolveOutputFilePath` returns the operator's own `--output`
  argument, which is intended CLI behaviour.
- **Dynamic regular expression, 11 items** (`normalize.ts`, `wiki.ts`). Every
  interpolation is wrapped in `escapeRegExp`, so wiki text cannot inject metacharacters.
  The two that are not (`normalize.ts` around the count-word replacements) interpolate
  module-local word lists, not input.
- **SSRF, 3 items** (`monitor/server.js`, `src/lib/tarkov-api.ts`,
  `monitor/public/app.js`). Both server-side calls append to a hardcoded
  `https://json.tarkov.dev` base, so the host cannot be redirected, and the request-derived
  mode segment passes `normalizeMode` (allowlist with fallback) plus `isSafeModeName`
  (`/^[a-z0-9]+(?:-[a-z0-9]+)*$/`, no separators). The third is a same-origin `fetch` in
  browser code.

CodeQL alerts dismissed as false positives should state the reason that actually holds. For
wiki-derived text the operative reason is that `eft-story-generate.ts` consumes the scraped
file only through `sequenceRatio()` as a fuzzy-match key and never copies the text itself.
Two nearby claims are _not_ supportable: `eft-story-wiki.ts` does persist that text, to the
gitignored `data/eft/story-wiki-objectives.json`, and the wiki does influence committed
output — `matchOptional` returns a coerced `boolean` that becomes an objective's
optional/required marker in `src/additions/storyChapters.json5`. A boolean cannot carry
markup, which is why the sanitization argument survives; free-form wiki text reaching the
overlay would not.

## Commit & Pull Request Guidelines

Recent history favors Conventional Commit prefixes like `feat:`, `chore:`, and `refactor:`; build commits use `chore: build overlay [skip ci]`. Keep commits focused. PRs should include a clear summary, proof links for data changes, and the commands you ran (at least `npm run validate`). If you updated generated output, call that out explicitly.

### PR review bots

Three bots review pull requests here. cubic re-reviews automatically on every
push. Codex reviews on open, on ready-for-review, and on a `@codex review`
comment, but only because the Codex GitHub integration is enabled for this
repository; that comment does nothing where it is not. CodeRabbit reviews on push
and on `@coderabbitai review`, subject to the allowance below.

Never idle waiting for CodeRabbit's GitHub review allowance to reopen. That
allowance is metered from recent usage (CodeRabbit has reported it as one review
per hour here), and when it is exhausted the bot answers a review request with
`Review rate limited` while still reporting its own check as **passing**. It also
"does not re-review already reviewed commits", so a green CodeRabbit check is not
evidence that the head commit was reviewed. Get the coverage another way:

- Run a supplemental local CodeRabbit review. It is not the same artifact as a PR
  review — different context, and no PR threads come out of it — but it surfaces
  findings while the PR allowance is closed: `coderabbit review --base main --agent`
  for structured findings, with `--committed` / `--uncommitted` to scope which
  changes are considered, `coderabbit review findings` to re-read the last local
  run, and `coderabbit pullrequest <number> --agent` to pull findings CodeRabbit
  already posted on a PR. Subcommands and their flags vary by CLI version, so
  confirm against `coderabbit review --help` and `coderabbit pullrequest --help`
  before relying on one; the top-level `coderabbit --help` lists subcommands and
  global options only. A local run has completed a full
  review while the GitHub PR allowance was exhausted, so the two are metered
  separately in practice — but CLI runs are still review events counted against the
  account's limits and can draw on usage-based billing, so treat them as costed
  rather than free. The CLI has its own small included pool and reports
  `errorType: rate_limit` with a wait time when it is spent; when that happens fall
  through to the bots below rather than waiting for it either.
- Comment `@codex review` for a fresh pass on the current head commit.

Reply to each review thread naming the commit that fixed it and what changed, then
resolve the thread; the reply is what makes the trail auditable later.

A `CHANGES_REQUESTED` review stays attached to the commit it was written against,
so it survives the push that fixes it and leaves `reviewDecision` misleading. It
does not block merging here: `main` is not branch-protected, and GitHub has
reported `mergeStateStatus: CLEAN` alongside a stale `CHANGES_REQUESTED`. Dismiss
such a review only after confirming its findings are genuinely fixed, its threads
are resolved, and you hold permission to dismiss; cite the fixing commit and the
replacement review evidence in the dismissal message. If branch protection is ever
enabled and requires approval of the most recent push, dismissal alone will not
satisfy that rule and a fresh approving review will be needed.

## Data Contribution Quick Checklist

- Edit the correct JSON5 file in `src/overrides/` or `src/additions/`.
- Provide proof (wiki link, screenshot, or patch notes).
- For map and trader references, look the ID up in `TARKOV_MAP_NAMES_BY_ID` /
  `TARKOV_TRADER_NAMES_BY_ID` (`src/lib/types.ts`) rather than copying a nearby
  entry. Consumers resolve these by `id`, so a correct `name` beside the wrong
  `id` silently points at another map or trader;
  `tests/entity-references.test.ts` enforces the pairing.
- Run `npm run validate` and `npm run build` before submitting.

## Issue Triage

Use [docs/TRIAGE.md](docs/TRIAGE.md) when reviewing GitHub issues. Verify
reports against the latest `main`, the applicable live tarkov.dev mode(s), and
the field-appropriate proof before marking them confirmed, fixed, duplicate,
or won't fix. Fail closed: missing or conflicting evidence gets
`status:needs-info` or `status:needs-investigation`, not a guessed verdict.
Record the checked commit, modes, evidence, and next action in the triage
comment. Keep only one lifecycle label and use the `type:*` / `status:*`
taxonomy defined in the guide.

## Fetching Wiki Data

The EFT Fandom wiki serves rendered HTML page paths (`https://escapefromtarkov.fandom.com/wiki/...`) behind a Cloudflare managed challenge. Non-browser clients (curl, agent fetch tools, scripts) get `HTTP 403` with a `cf-mitigated: challenge` header instead of content, regardless of User-Agent. Do not scrape `/wiki/` HTML.

Use the MediaWiki API instead — it is not challenged and returns full content (no User-Agent required):

- Wikitext: `https://escapefromtarkov.fandom.com/api.php?action=parse&page=<Title>&prop=wikitext&format=json`
- Rendered HTML fragment: `...&prop=text`
- Plain-text extract: `action=query&prop=extracts&...`

The wiki-compare tool (run via `npm run wiki:compare`) already uses `api.php` (`WIKI_API` in `scripts/wiki-compare/types.ts`); follow that pattern for any new wiki access. The `{{Historical content}}` / `{{Event content}}` templates at the top of a page's wikitext indicate expired/event content (verify before adding or for removing stale event additions).
