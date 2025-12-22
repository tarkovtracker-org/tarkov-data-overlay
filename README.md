# tarkov-data-overlay

Community-maintained data overlay for [tarkov.dev](https://tarkov.dev) API corrections and additions.

## Why?

The tarkov.dev API is an excellent resource, but game updates sometimes outpace data updates. This overlay provides:

- **Corrections**: Fix incorrect data (task levels, map requirements, etc.)
- **Additions**: New data types not in tarkov.dev (game editions, etc.)

## Usage

Fetch the overlay from jsDelivr CDN:

```
https://cdn.jsdelivr.net/gh/tarkovtracker-org/tarkov-data-overlay@main/dist/overlay.json
```

Then merge it with tarkov.dev responses. See [Integration Guide](docs/INTEGRATION.md) for details.

## Current Corrections

### Task Objective Corrections

| Task | Objective | Field | tarkov.dev | Correct |
|------|-----------|-------|------------|---------|
| Grenadier | Eliminate PMCs with grenades | count | 8 | 5 |

### Task Prerequisite Corrections

| Task | Change |
|------|--------|
| Grenadier | taskRequirements changed from [] (empty) to Shooting Cans |

### Task Name/Link Corrections

| Task | Field | tarkov.dev | Correct |
|------|-------|------------|---------|
| Half Empty | name | "Half-Empty" | "Half Empty" |
| Half Empty | wikiLink | Half-Empty | Half_Empty |

## Current Additions

- **Game Editions**: Standard, Left Behind, Prepare for Escape, Edge of Darkness, The Unheard, Edge of Darkness + Unheard

## Maintenance

The overlay is regularly validated against the tarkov.dev API to ensure corrections are still needed:

```bash
npm run check-overrides
```

This command compares all overrides against current API data and reports:
- ✅ Overrides that are still needed
- 🔄 Corrections that have been fixed upstream (can be removed)
- 🗑️  Tasks that have been removed from the API (can be deleted)

Run this periodically to keep the overlay lean and accurate.

## Contributing

Found incorrect data? See [Contributing Guide](docs/CONTRIBUTING.md).

## Data Governance

- This is **community-maintained, best-effort** data
- All corrections require proof (wiki links, screenshots)
- Not a replacement for tarkov.dev - a bridge during data gaps
- Transparent history via Git

## License

MIT
