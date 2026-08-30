# tarkov-data-overlay

Community-maintained data overlay for [tarkov.dev](https://tarkov.dev) API corrections and additions.

## Why?

The tarkov.dev API is an excellent resource, but game updates sometimes outpace data updates. This overlay provides:

- **Corrections**: Fix incorrect data (task levels, map requirements, etc.)
- **Additions**: New data types not in tarkov.dev (game editions, etc.)

## Usage

Fetch the overlay from jsDelivr CDN:

```text
https://cdn.jsdelivr.net/gh/tarkovtracker-org/tarkov-data-overlay@main/dist/overlay.json
```

Then merge it with tarkov.dev responses. See [Integration Guide](docs/INTEGRATION.md) for details.
For accurate task visibility and unlock-state tracking, see
[Task availability and unlock tracking](docs/TASK_AVAILABILITY.md).

## Monitor

Browse the hosted monitor at [monitor.nivmizz7.fr](https://monitor.nivmizz7.fr), or run it locally with:

```bash
npm run monitor
```

The monitor is read-only by default. To enable its local “Update overlay” action,
explicitly opt in when starting it:

```bash
ALLOW_REBUILD=true npm run monitor
```

Set `REBUILD_TOKEN` as well when exposing the rebuild API to another trusted
service. Authenticated callers should pass it in an `Authorization: Bearer …`
header. For backwards compatibility, `?token=` is also accepted; use that only
for trusted local clients because query strings can appear in logs and browser
history. Rebuilds target the default `dist/overlay.json` output; custom local
and HTTP(S) overlay targets remain read-only.

## Maintenance

The overlay is regularly validated against the tarkov.dev API to ensure corrections are still needed:

```bash
npm run check-overrides
```

This command compares all overrides against current API data and reports:

- ✅ Overrides that are still needed
- 🔄 Corrections that have been fixed upstream (can be removed)
- 🗑️ Tasks that have been removed from the API (can be deleted)

Run this periodically to keep the overlay lean and accurate.

For local checks:

```bash
npm run validate
npm run typecheck
npm test
```

## Contributing

Found incorrect data? See [Contributing Guide](docs/CONTRIBUTING.md).

## Data Governance

- This is **community-maintained, best-effort** data
- All corrections require proof (wiki links, screenshots)
- Not a replacement for tarkov.dev - a bridge during data gaps
- Transparent history via Git

## License

See [LICENSE](LICENSE).
