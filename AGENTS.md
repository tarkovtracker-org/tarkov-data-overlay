# Repository Guidelines

## Project Structure & Module Organization
`src/overrides/` holds JSON5 corrections keyed by tarkov.dev IDs, while `src/additions/` contains new data types (for example game editions). `src/schemas/` stores JSON Schemas, and `src/lib/` houses shared TypeScript utilities used by scripts in `scripts/`. Built output lands in `dist/overlay.json`. Tests live in `tests/`, with docs in `docs/`. The `data/` directory is used for local cache/results from validation tooling.

## Build, Test, and Development Commands
- `npm install` installs dependencies.
- `npm run validate` validates JSON5 sources against schemas (run before opening a PR).
- `npm run build` generates `dist/overlay.json` from sources.
- `npm run check-overrides` compares overrides to the live tarkov.dev API.
- `npm test` runs the Vitest suite; `npm run test:watch` keeps it running.
- Example single test: `npx vitest run tests/file-loader.test.ts`.

## Coding Style & Naming Conventions
TypeScript uses 2-space indentation, semicolons, and ESM imports (see `"type": "module"`). Data files are JSON5 and may include comments. Use tarkov.dev entity IDs as keys and camelCase field names. Every correction must include: entity name comment, proof link, and inline “Was:” value. For nested patches (like task objectives), use ID-keyed objects rather than arrays.

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

`scripts/wiki-task-spike.ts` already uses `api.php` (`WIKI_API`); follow that pattern for any new wiki access. The `{{Historical content}}` / `{{Event content}}` templates at the top of a page's wikitext indicate expired/event content (verify before adding or for removing stale event additions).
