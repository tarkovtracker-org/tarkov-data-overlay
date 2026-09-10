# Security Policy

## Reporting a vulnerability

Report privately through GitHub's
[private vulnerability reporting](https://github.com/tarkovtracker-org/tarkov-data-overlay/security/advisories/new),
which is enabled on this repository. Please do not open a public issue for anything
exploitable.

Include the affected file or script, the command or request that triggers it, and what an
attacker gains. A short reproduction is worth more than a scanner excerpt: this repository
is mostly local tooling, so whether input is operator-supplied or genuinely untrusted
usually decides whether a finding is exploitable at all.

Expect an acknowledgement within a week. This is a community-maintained, best-effort
project with no paid on-call, so please allow time before disclosing publicly.

## What this project ships

`dist/overlay.json` is static JSON served over a CDN. It contains no executable code and
runs nothing on a consumer's machine. Everything else in the repository is developer
tooling that maintainers run locally or in CI.

## In scope

- **Build and validation pipeline** (`scripts/build.ts`, `scripts/validate.ts`, `src/lib/`):
  anything that lets untrusted input corrupt the published overlay, bypass schema
  validation, or forge the `$meta.sha256` digest.
- **Local monitor** (`monitor/`): it binds `127.0.0.1` by default and its rebuild action
  requires an explicit `REBUILD_TOKEN` bearer token. Auth bypass, a rebuild triggered
  without a valid token, or a path that escapes the intended output file are in scope.
  See the Monitor section of [README.md](README.md) for the intended model, including the
  `TRUSTED_HTTPS_PROXY` requirement when `HOST` is not loopback.
- **Supply chain**: a dependency advisory that `npm run audit:dependencies` does not
  catch, or a way to influence what CI installs.
- **Overlay data integrity**: a route by which unreviewed third-party content reaches a
  committed file. Wiki-derived text is deliberately used only as a fuzzy-match key rather
  than stored, so a path that lands it in the overlay is a real finding.

## Out of scope

- The [tarkov.dev](https://tarkov.dev) API and the Escape from Tarkov wiki. Report issues
  to those projects; this overlay only reads them.
- Consumer applications that merge the overlay. Escape data before rendering it, as with
  any external source.
- Incorrect game data. That is a data-quality bug, not a vulnerability — open a normal
  issue and see [docs/TRIAGE.md](docs/TRIAGE.md).
- Findings that require an operator to run a local CLI against their own machine with
  arguments they chose. The `eft:*` and `wiki:compare` scripts write where the operator
  points them by design.
- Static-analysis output with no demonstrated data flow. See the Static Analysis Findings
  section of [AGENTS.md](AGENTS.md) for how existing candidates were triaged.

## Supported versions

Only `main` and the most recent `dist/overlay.json` release tag receive fixes. Older tags
are immutable snapshots and are not patched; pin a tag for reproducibility, but track the
latest for corrections.

## Hardening already in place

CI gates every pull request on `npm run audit:dependencies` (fails at high severity),
CodeQL for `javascript-typescript` and `actions`, and `fallow security --gate new` for
newly introduced findings. Dependabot security updates, secret scanning, and push
protection are enabled. GitHub Actions are pinned to commit SHAs and workflows declare
explicit `permissions` blocks.
