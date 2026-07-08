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

The wiki comparison tool is modular: `scripts/wiki-compare.ts` is a thin entry point re-exporting the public/test API, with the implementation in `scripts/wiki-compare/` (`types`, `cache`, `overlay`, `normalize`, `api`, `wiki`, `compare`, `cli`). Shared eft-reference parsing (`findReferenceFile`, `parseEftTasks`, `detectReferenceMode`, `parseModeArgs`, `requireMatchingReferenceMode`) lives in `scripts/eft-compare.ts` and is imported by the other `eft:*` scripts.

### Build Pipeline

1. `scripts/validate.ts` - Validates JSON5 source files against schemas using AJV
2. `scripts/build.ts` - Compiles JSON5 sources into single `dist/overlay.json` with metadata

### Output Structure

The built `dist/overlay.json` contains entity sections keyed by tarkov.dev IDs (tasks, items, etc.) plus a `$meta` object with version, generated timestamp, and SHA256 hash.

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

The `eft:*` scripts cross-check the overlay against a local quest reference file,
the authority for numeric quest fields (experience, minPlayerLevel, objective
counts). The reference file lives in `eft/` and all derived output in `data/` —
both gitignored. Never commit reference files or anything derived from them; PRs
carry only the resulting JSON5 corrections plus proof links.

- `npm run eft:normalize` distills a raw reference file into a clean
  tarkov.dev-shaped `data/eft/quests.<mode>.json`.
- `npm run eft:compare` lists where the reference disagrees with the live API.
- `npm run eft:wiki` cross-references those reference-vs-API discrepancies
  against the EFT wiki, showing whether the wiki backs the reference, the API,
  or neither (minPlayerLevel and experience only).
- `npm run eft:audit` is the three-way `reference -> API -> overrides` check.
  Per field it reports GAP (API wrong, no override — add one), STALE (API fixed
  upstream, override redundant — remove it), CONFLICT (override disagrees with
  the reference — fix it), or OK (override correct and still needed). The
  reference is mode-specific; the audit auto-detects its mode and refuses a
  mismatched `--mode` to avoid false positives.
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

## Commit & Pull Request Guidelines

Recent history favors Conventional Commit prefixes like `feat:`, `chore:`, and `refactor:`; build commits use `chore: build overlay [skip ci]`. Keep commits focused. PRs should include a clear summary, proof links for data changes, and the commands you ran (at least `npm run validate`). If you updated generated output, call that out explicitly.

## Data Contribution Quick Checklist

- Edit the correct JSON5 file in `src/overrides/` or `src/additions/`.
- Provide proof (wiki link, screenshot, or patch notes).
- Run `npm run validate` and `npm run build` before submitting.

## Fetching Wiki Data

The EFT Fandom wiki serves rendered HTML page paths (`https://escapefromtarkov.fandom.com/wiki/...`) behind a Cloudflare managed challenge. Non-browser clients (curl, agent fetch tools, scripts) get `HTTP 403` with a `cf-mitigated: challenge` header instead of content, regardless of User-Agent. Do not scrape `/wiki/` HTML.

Use the MediaWiki API instead — it is not challenged and returns full content (no User-Agent required):

- Wikitext: `https://escapefromtarkov.fandom.com/api.php?action=parse&page=<Title>&prop=wikitext&format=json`
- Rendered HTML fragment: `...&prop=text`
- Plain-text extract: `action=query&prop=extracts&...`

The wiki-compare tool (run via `npm run wiki:compare`) already uses `api.php` (`WIKI_API` in `scripts/wiki-compare/types.ts`); follow that pattern for any new wiki access. The `{{Historical content}}` / `{{Event content}}` templates at the top of a page's wikitext indicate expired/event content (verify before adding or for removing stale event additions).
