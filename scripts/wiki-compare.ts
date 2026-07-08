#!/usr/bin/env tsx
/**
 * Compare tasks between tarkov.dev and the EFT wiki.
 *
 * Research/comparison tool: surfaces discrepancies (level, objectives,
 * rewards, prerequisites, maps) for a single task or in bulk, filtered
 * against existing overlay corrections and suppressions.
 *
 * Implementation lives in scripts/wiki-compare/ (types, cache, overlay,
 * normalize, api, wiki, compare, cli). This entry point re-exports the
 * public/test-facing API and runs the CLI when executed directly.
 */

import { isDirectExecution, printError } from '../src/lib/index.js';
import { main } from './wiki-compare/cli.js';

export { getPriority } from './wiki-compare/types.js';
export {
  buildMapAliasMap,
  itemsMatch,
  normalizeItemName,
  normalizeMapName,
  normalizeObjectiveText,
} from './wiki-compare/normalize.js';
export { parseWikiTask } from './wiki-compare/wiki.js';
export { compareTasks } from './wiki-compare/compare.js';
export type {
  Discrepancy,
  ExtendedTaskData,
  Priority,
  WikiObjective,
  WikiTaskData,
} from './wiki-compare/types.js';

if (isDirectExecution(import.meta.url)) {
  main().catch((error) => {
    printError('Wiki compare failed:', error as Error);
    process.exit(1);
  });
}
