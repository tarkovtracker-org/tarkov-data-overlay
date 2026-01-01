# overlay-monitor

Web monitor that watches each override file and renders the same correction
tables as the README, but live. Each file has its own page.

## Run

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
