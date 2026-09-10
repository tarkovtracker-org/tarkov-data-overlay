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
resulting JSON5 corrections plus proof links.

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

  Field authority differs. `GlobalVariableValue` is a numeric state gate, not
  automatically a loyalty condition or a task prerequisite list. See
  `docs/GLOBAL_VARIABLES.md` for counter evidence requirements.
  - `taskRequirements`: preserve explicit `Quest` start conditions and their
    accepted statuses. Wiki narrative `previous` is not proof of an unlock edge.
    Distinguish a present template with no Quest condition from a missing task.
  - `minPlayerLevel`: absence of an explicit `Level` condition does not authorize
    zero. Check trader and predecessor-derived floors and wiki Requirements.
    Template status values alone do not prove capture completeness.
  - `traderRequirements`: use explicit loyalty conditions and corroborated wiki
    requirements. `eft:audit` does not adjudicate these. A candidate cohort tier
    must not automatically become an extra runtime gate.

- `npm run eft:story` regenerates `src/additions/storyChapters.json5` from the
  reference. Story quests are entirely absent from tarkov.dev, so unlike the
  numeric `eft:*` tools this one produces committed additions, not a gitignored
  diff. It takes objective text/order/ids from the local reference for structure
  and the optional/required flags plus proof from the EFT wiki, merges curated
  chapter metadata from `scripts/story-chapter-meta.json`, and preserves The
  Ticket's branching. The reference itself stays gitignored; only the generated
  JSON5 is committed. The pipeline is pure TypeScript
  (`eft-story-wiki.ts` -> `eft-story-generate.ts` -> `eft-story-write.ts`);
  fuzzy optional-matching uses a faithful difflib `SequenceMatcher.ratio()`
  port in `scripts/lib/sequence-matcher.ts`.

## Coding Style & Naming Conventions

TypeScript uses 2-space indentation, semicolons, and ESM imports (see `"type": "module"`). Data files are JSON5 and may include comments. Use tarkov.dev entity IDs as keys and field names that match the tarkov.dev API exactly (camelCase). Every correction must include: entity name comment, proof link, and inline “Was:” value. For nested patches (like task objectives), use ID-keyed objects rather than arrays. Empty override files are valid and skipped during build. When adding a new entity type, add its schema to `SCHEMA_CONFIGS` in `src/lib/types.ts`.

## Testing Guidelines

Vitest is the only test framework. Tests should be named `*.test.ts` under `tests/`. There is no explicit coverage gate, but add or update tests when you change shared library behavior or validation logic.

## Static Analysis Findings

Fix fallow findings at their root whenever the code can be safely consolidated, simplified, removed, or covered by tests. Do not add `fallow-ignore` suppressions for resolvable findings; suppressions must be reserved for genuinely unavoidable tool false positives or external/runtime constraints, include a specific reason, and receive explicit reviewer approval.

`npm run fallow:security` reports candidates rather than confirmed vulnerabilities and
exits 0; CI gates only on newly introduced ones (`--gate new --changed-since <base>`). The
30 candidates standing on `main` were triaged and are all tool false positives. Re-check a
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
