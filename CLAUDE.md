# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Community-maintained data overlay for tarkov.dev API corrections and additions. Provides a JSON overlay file that consumers merge with tarkov.dev API responses to fix incorrect data or add missing data types (like game editions).

## Commands

```bash
npm run validate        # Validate source files against JSON schemas
npm run build           # Build dist/overlay.json from source files
npm run check-overrides # Check if overrides are still needed (queries tarkov.dev API)
npm test                # Run tests (vitest)
npm run test:watch      # Run tests in watch mode
```

### Checking Override Validity

The `check-overrides` script validates whether existing overrides are still needed by comparing them against current tarkov.dev API data:

```bash
npm run check-overrides
```

This will:
- Load all task overrides from `src/overrides/tasks.json5`
- Query the tarkov.dev API for current data
- Compare each override field-by-field
- Report which overrides are:
  - ✅ Still needed (API data still incorrect)
  - 🔄 Fixed in API (can be removed)
  - 🗑️  Task removed from API (can be deleted)

Run this periodically (weekly/monthly) to keep the overlay lean and up-to-date.

## Architecture

### Source Data (src/)
- `src/overrides/` - JSON5 files for correcting tarkov.dev data (tasks.json5, items.json5, traders.json5, hideout.json5)
- `src/additions/` - JSON5 files for new data not in tarkov.dev (editions.json5)
- `src/schemas/` - JSON Schema files for validation

### Build Pipeline
1. `scripts/validate.ts` - Validates JSON5 source files against schemas using AJV
2. `scripts/build.ts` - Compiles JSON5 sources into single `dist/overlay.json` with metadata

### Output Structure
The built overlay.json contains:
- Entity sections keyed by tarkov.dev IDs (tasks, items, etc.)
- `$meta` object with version, generated timestamp, and SHA256 hash

## Data Contribution Format

Every correction in JSON5 files must include:
1. Entity name as a comment
2. Proof link (wiki, screenshot, patch notes)
3. Original incorrect value as inline comment

Example:
```json5
{
  // Grenadier - Level requirement incorrect
  // Proof: https://escapefromtarkov.fandom.com/wiki/Grenadier
  "5936d90786f7742b1420ba5b": {
    "minPlayerLevel": 10  // Was: 20
  }
}
```

## Key Conventions

- Use tarkov.dev entity IDs as keys
- Field names must match tarkov.dev API exactly (camelCase)
- Nested patches (like objectives) use ID-keyed objects, not arrays
- Empty override files are valid and skipped during build
