## Overlay Monitor

Run a local web monitor that renders live correction tables from the override files:

```bash
npm run monitor
```

Optional environment variables:

- `PORT` (default: `3476`)
- `TARGET_TASKS` (default: `src/overrides/tasks.json5`)
- `TARGET_HIDEOUT` (default: `src/overrides/hideout.json5`)
- `TARGET_ITEMS` (default: `src/overrides/items.json5`)
- `TARGET_TRADERS` (default: `src/overrides/traders.json5`)
- `MAX_ROWS` (default: `200`)
