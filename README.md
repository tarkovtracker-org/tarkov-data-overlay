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

### Task Experience Corrections

| Task | tarkov.dev | Correct |
|------|------------|---------|
| Grenadier | 18,000 | 12,500 |
| A Shooter Born in Heaven | 12,500 | 55,000 |
| Test Drive - Part 1 | 18,200 | 9,100 |
| Hell on Earth - Part 1 | 15,600 | 2,300 |
| Hell on Earth - Part 2 | 98,000 | 16,000 |
| Pyramid Scheme | 25,500 | 12,400 |
| Athlete | 21,900 | 3,500 |
| Dandies | 33,000 | 11,000 |
| Decontamination Service | 30,500 | 12,500 |

### Task Objective Count Corrections

| Task | tarkov.dev | Correct |
|------|------------|---------|
| Grenadier | 8 | 5 |
| Test Drive - Part 1 | 5 | 10 |
| Easy Job - Part 2 | 20 | 10 |
| Long Road | 8 | 4 |

### Task Reward Corrections

| Task | Field | tarkov.dev | Correct |
|------|-------|------------|---------|
| To Great Heights! - Part 4 [PVP ZONE] | money | 1,000,002 | 2,500,000 |

### Task Prerequisite Corrections

| Task | Change |
|------|--------|
| Grenadier | taskRequirements changed from [] (empty) to Shooting Cans |
| The Tarkov Shooter - Part 2 | taskRequirements changed from [] (empty) to The Tarkov Shooter - Part 1 |
| Hell on Earth - Part 1 | taskRequirements changed from [] (empty) to The Good Times - Part 1 |
| Revision - Lighthouse | taskRequirements changed from [] (empty) to Revision - Reserve |
| Energy Crisis | taskRequirements changed from [] (empty) to Farming - Part 4 |
| Drip-Out - Part 2 | taskRequirements changed from [] (empty) to Dandies |

### Task Name/Link Corrections

| Task | Field | tarkov.dev | Correct |
|------|-------|------------|---------|
| Half Empty | name | "Half-Empty" | "Half Empty" |
| Half Empty | wikiLink | Half-Empty | Half_Empty |

### Task Level Requirements Corrections

| Task | Field | tarkov.dev | Correct |
|------|-------|------------|---------|
| Task ID 60e71e8ed54b755a3b53eb67 | minPlayerLevel | 65 | 55 |

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
