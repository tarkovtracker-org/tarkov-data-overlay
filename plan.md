# Refactor plan — tarkov-data-overlay

Goal: keep the core purpose (JSON5 overlay sources -> validated -> built
`dist/overlay.json`, plus maintenance tooling) while improving correctness,
efficiency, consistency, and maintainability. Mark items `[x]` as completed.

## Phase A — Infrastructure & correctness

- [x] A1. CI never runs the test suite or typecheck (15 test files, 202 tests
      exist but only `validate` + `build` run). Add `typecheck` + `test` steps
      to `.github/workflows/ci.yml`.
- [x] A2. Release-notes generator in CI deletes `current._meta` /
      `previous._meta` but the build writes `$meta` — fix to `$meta` so the
      meta block can never leak into release notes as a phantom section.
- [x] A3. `@types/node` is ^20 while engines require Node >=22 and CI runs 24.
      Bump `@types/node` to ^24.
- [x] A4. `tsconfig.json` declares `outDir: dist` + `declaration: true` but the
      repo never emits JS (tsx runtime, `tsc --noEmit`); `dist/` holds only
      `overlay.json`. Set `noEmit: true`, drop emit-only options.
- [x] A5. Add `prettier` devDependency + `format` / `format:check` scripts
      (config `.prettierrc` already exists but nothing can use it).

## Phase B — Shared-library dedup

- [x] B1. `isDirectExecution()` is copy-pasted in 7 scripts. Add
      `isDirectExecution(importMetaUrl)` + shared `sleep()` to a new
      `src/lib/script-utils.ts`, export from lib index, use everywhere.
- [x] B2. `check-overrides.ts` repeats an identical "count label + list or
      None" print block 8 times. Add `printCountSection()` to
      `src/lib/terminal.ts` and collapse the repetition.
- [x] B3. `findReferenceFile` and the envelope/mode-detection logic are
      duplicated between `eft-compare.ts` and `eft-normalize.ts`. Export from
      `eft-compare.ts` (already the shared reference-parsing module) and import
      in `eft-normalize.ts`.
- [x] B4. The `--mode/--json/eftDir` arg parsing and the reference/mode
      mismatch guard are triplicated (eft-compare, eft-audit,
      eft-wiki-crosscheck). Extract shared helpers into `eft-compare.ts`.

## Phase C — Efficiency

- [x] C1. `check-overrides.ts` downloads the full regular-mode dataset twice
      (`fetchTasks()` for the base pass, then `fetchTasks('regular')` in the
      mode loop — tens of MB re-downloaded). Memoize tasks per mode.

## Phase D — Story pipeline: single toolchain

The `eft:story` pipeline is Python (x2) + CommonJS (x1) + shell chaining inside
an npm script, in an otherwise all-TypeScript/ESM repo. Port to TypeScript so
it is typechecked, testable with Vitest, and drops the python3 dependency.

- [x] D1. Port `scripts/eft-story-wiki.py` -> `scripts/eft-story-wiki.ts`
      (MediaWiki fetch + objective parsing). Verify live against the wiki and
      diff output vs the Python script if python3 available.
- [x] D2. Port `scripts/eft-story-generate.py` -> `scripts/eft-story-generate.ts`,
      including a faithful difflib `SequenceMatcher.ratio()` port (with
      autojunk) so fuzzy optional-matching behaves identically. Unit-test the
      matcher and normalizers. (End-to-end run needs the local-only `eft/`
      reference, absent here — noted as verification limit.)
- [x] D3. Port `scripts/eft-story-write.cjs` -> `scripts/eft-story-write.ts`.
      Verify by round-trip: parse committed `storyChapters.json5`, regenerate,
      byte-compare.
- [x] D4. Update `package.json` `eft:story` to a single tsx chain; delete the
      Python/CJS files; update AGENTS.md/CLAUDE.md if they reference them.

## Phase E — Split the wiki-compare monolith

- [x] E1. `scripts/wiki-compare.ts` is 3,577 lines. Split into
      `scripts/wiki-compare/` modules: `types.ts`, `cache.ts`,
      `suppressions.ts`, `normalize.ts` (text/alias/item/map matching),
      `wiki.ts` (fetch/parse), `compare.ts`, `cli.ts` (args/runners/main),
      with `scripts/wiki-compare.ts` kept as a thin entry that re-exports the
      existing public/test API unchanged.
- [x] E2. Full suite green after split (typecheck + 202 tests), no behavior
      change.

## Explicit non-goals (decided, not forgotten)

- monitor/ rewrite: it is plain Node by design (pm2 runs it directly on the
  deploy host without a build step), has 569 lines of real tests, and is
  self-contained. Rewriting it risks the deployment for no functional gain.
- Bulk prettier reformat of every file: would bury the real refactor in noise.
  Format scripts are added; a repo-wide reformat can be its own commit later.
- Data file (JSON5) changes: data correctness is proof-driven, out of scope.

## Verification gates (after every phase)

- `npm run typecheck` clean
- `npm test` — all 202+ tests pass
- `npm run validate` + `npm run build` — overlay builds, only `$meta` diff
