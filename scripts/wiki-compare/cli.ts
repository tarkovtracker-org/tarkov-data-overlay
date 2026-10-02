/**
 * CLI argument parsing and the single-task / bulk runners.
 *
 * Extracted from the former single-file scripts/wiki-compare.ts.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  printHeader,
  printProgress,
  printSuccess,
  printError,
  bold,
  dim,
  icons,
  colorize,
  sleep,
} from '../../src/lib/index.js';
import {
  CliOptions,
  DEFAULT_TASK_NAME,
  Discrepancy,
  ExtendedTaskData,
  RATE_LIMIT_MS,
} from './types.js';
import {
  ensureDir,
  loadApiCache,
  loadWikiCache,
  resolveOutputFilePath,
  saveApiCache,
  saveWikiCache,
} from './cache.js';
import {
  buildNextTaskMap,
  isTaskFieldSuppressed,
  loadSuppressedFields,
  loadDivergentFieldKeys,
  loadTaskRequirementOverrides,
  loadTaskSuppressions,
} from './overlay.js';
import { buildMapAliasMap, collectMapNames } from './normalize.js';
import { fetchExtendedTasks, resolveTask, resolveWikiTitle } from './api.js';
import { WikiFetchResult, fetchWikiWikitext, parseWikiTask, printWikiData } from './wiki.js';
import { compareTasks } from './compare.js';
import { renderDiscrepancies } from './render.js';

type ParsedOptions = CliOptions & { help?: boolean };
type FlagDescriptor = {
  names: string[];
  kind: 'flag' | 'value' | 'optional';
  apply: (options: ParsedOptions, value: string | undefined) => boolean;
};

const FLAGS: FlagDescriptor[] = [
  { names: ['--help', '-h'], kind: 'flag', apply: (o) => (o.help = true) },
  { names: ['--all', '-a'], kind: 'flag', apply: (o) => (o.all = true) },
  { names: ['--cache', '-c'], kind: 'flag', apply: (o) => (o.useCache = true) },
  { names: ['--refresh', '-r'], kind: 'flag', apply: (o) => (o.refresh = true) },
  {
    names: ['--id'],
    kind: 'value',
    apply: (o, v) => {
      o.id = v;
      return true;
    },
  },
  {
    names: ['--name'],
    kind: 'value',
    apply: (o, v) => {
      o.name = v;
      return true;
    },
  },
  {
    names: ['--wiki'],
    kind: 'value',
    apply: (o, v) => {
      o.wiki = v;
      return true;
    },
  },
  {
    names: ['--output', '-o'],
    kind: 'optional',
    apply: (o, v) => {
      o.output = v ?? '';
      return true;
    },
  },
  {
    names: ['--gameMode', '-g'],
    kind: 'value',
    apply: (o, v) => {
      if (v !== 'regular' && v !== 'pve' && v !== 'both') return false;
      o.gameMode = v;
      return true;
    },
  },
  {
    names: ['--group-by'],
    kind: 'value',
    apply: (o, v) => {
      if (v !== 'priority' && v !== 'category') return false;
      o.groupBy = v;
      return true;
    },
  },
];

function findFlag(arg: string): FlagDescriptor | undefined {
  return FLAGS.find(
    (flag) =>
      flag.names.includes(arg) || (flag.kind !== 'flag' && arg.startsWith(`${flag.names[0]}=`))
  );
}

function applyFlag(
  descriptor: FlagDescriptor,
  arg: string,
  next: string | undefined,
  options: ParsedOptions
): boolean {
  const inline = arg.startsWith(`${descriptor.names[0]}=`);
  const consume = descriptor.kind !== 'optional' || Boolean(next && !next.startsWith('-'));
  const value = inline ? arg.slice(descriptor.names[0].length + 1) : consume ? next : undefined;
  const accepted = descriptor.apply(options, value);
  // Invalid enum values remain available as positional names, matching the CLI contract.
  return accepted && !inline && descriptor.kind !== 'flag' && consume;
}

export function parseArgs(argv: string[]): ParsedOptions {
  const options: ParsedOptions = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg) continue;
    const descriptor = findFlag(arg);
    if (!descriptor) {
      if (!options.name) options.name = arg;
      continue;
    }
    if (applyFlag(descriptor, arg, argv[i + 1], options)) i += 1;
  }
  return options;
}

export function printUsage(): void {
  console.log('Usage:');
  console.log('  tsx scripts/wiki-compare.ts [options] [taskName]');
  console.log();
  console.log('Options:');
  console.log('  --all, -a          Compare all tasks (bulk mode)');
  console.log('  --cache, -c        Use cached data if available');
  console.log('  --refresh, -r      Force refresh cache (fetch new data)');
  console.log(
    '  --output, -o [path] Save results to file (default: data/results/comparison-<timestamp>.json)'
  );
  console.log('  --group-by <type>  Group output by: priority or category (default: category)');
  console.log('  --gameMode, -g     Game mode: regular (PVP), pve, or both (default: both)');
  console.log('  --id <taskId>      Find task by ID');
  console.log('  --name <taskName>  Find task by name');
  console.log('  --wiki <pageTitle> Override wiki page title');
  console.log('  --help, -h         Show this help');
  console.log();
  console.log('Examples:');
  console.log('  tsx scripts/wiki-compare.ts Grenadier');
  console.log('  tsx scripts/wiki-compare.ts --all --cache');
  console.log('  tsx scripts/wiki-compare.ts --all --cache --group-by=priority');
  console.log('  tsx scripts/wiki-compare.ts --all --refresh --output');
  console.log('  tsx scripts/wiki-compare.ts --all --output data/results/pve-comparison.json');
  console.log('  tsx scripts/wiki-compare.ts --all --gameMode=pve --cache');
  console.log();
}

export async function runSingleTask(
  tasks: ExtendedTaskData[],
  mapAliasMap: Map<string, string>,
  options: CliOptions
): Promise<void> {
  const requirementOverrides = loadTaskRequirementOverrides(options.gameMode ?? 'both');
  const nextTaskMap = buildNextTaskMap(tasks, requirementOverrides);
  const taskSuppressions = loadTaskSuppressions();
  const task = resolveTask(tasks, options);
  if (!task) {
    printError(
      `Task not found (id=${options.id ?? 'n/a'}, name=${options.name ?? DEFAULT_TASK_NAME})`
    );
    printUsage();
    process.exit(1);
  }

  const wikiTitle = resolveWikiTitle(task, options.wiki);
  const wikiCache =
    !options.wiki && options.useCache && !options.refresh ? loadWikiCache(task.id) : null;
  let wikiResponse: WikiFetchResult;

  if (wikiCache) {
    wikiResponse = {
      title: wikiCache.title,
      wikitext: wikiCache.wikitext,
      lastRevision: wikiCache.lastRevision,
    };
    printSuccess(`Loaded wiki page "${wikiResponse.title}" from cache (${wikiCache.fetchedAt})`);
  } else {
    printProgress(`Fetching wiki wikitext for "${wikiTitle}"...`);
    wikiResponse = await fetchWikiWikitext(wikiTitle);
    // An explicit --wiki override resolves to a different article than the
    // task's regular wiki page; caching it under the task id would poison the
    // cache for later plain runs (they would compare against the wrong page).
    if (!options.wiki) {
      saveWikiCache(task.id, wikiResponse.title, wikiResponse.wikitext, wikiResponse.lastRevision);
    }
    printSuccess(`Fetched wiki page "${wikiResponse.title}"`);
  }

  const wikiData = parseWikiTask(
    wikiResponse.title,
    wikiResponse.wikitext,
    mapAliasMap,
    wikiResponse.lastRevision
  );
  printWikiData(wikiData);
  compareTasks(task, wikiData, mapAliasMap, true, nextTaskMap, taskSuppressions);
}

export async function runBulkMode(
  tasks: ExtendedTaskData[],
  mapAliasMap: Map<string, string>,
  options: CliOptions
): Promise<void> {
  const tasksWithWiki = tasks.filter((t) => t.wikiLink);
  printProgress(`Found ${tasksWithWiki.length}/${tasks.length} tasks with wiki links`);

  // Load suppressed fields (overlay corrections + wiki-incorrect suppressions).
  // Scope to the active game mode so a PvE-only correction does not mask a
  // genuine regular-mode divergence (and vice versa).
  const { suppressed, overlayCount, wikiIncorrectCount, wikiIncorrectKeys } = loadSuppressedFields(
    options.gameMode ?? 'both'
  );
  const taskSuppressions = loadTaskSuppressions();
  if (overlayCount > 0 || wikiIncorrectCount > 0) {
    printProgress(
      `Loaded ${overlayCount} overlay correction(s), ${wikiIncorrectCount} wiki-incorrect suppression(s)`
    );
  }
  if (taskSuppressions.size > 0) {
    printProgress(`Loaded ${taskSuppressions.size} task suppression entries`);
  }
  const requirementOverrides = loadTaskRequirementOverrides(options.gameMode ?? 'both');
  const nextTaskMap = buildNextTaskMap(tasks, requirementOverrides);

  const allDiscrepancies: Discrepancy[] = [];
  let checked = 0;
  let errors = 0;
  let cacheHits = 0;
  const failedTasks: Array<{ id: string; name: string; reason: string }> = [];

  for (const task of tasksWithWiki) {
    checked += 1;
    const wikiTitle = resolveWikiTitle(task);
    process.stdout.write(`\r[${checked}/${tasksWithWiki.length}] ${task.name.padEnd(40)}`);

    try {
      let wikiResponse: WikiFetchResult;
      const wikiCache = options.useCache && !options.refresh ? loadWikiCache(task.id) : null;

      if (wikiCache) {
        wikiResponse = {
          title: wikiCache.title,
          wikitext: wikiCache.wikitext,
          lastRevision: wikiCache.lastRevision,
        };
        cacheHits += 1;
      } else {
        wikiResponse = await fetchWikiWikitext(wikiTitle);
        saveWikiCache(
          task.id,
          wikiResponse.title,
          wikiResponse.wikitext,
          wikiResponse.lastRevision
        );
        await sleep(RATE_LIMIT_MS);
      }

      const wikiData = parseWikiTask(
        wikiResponse.title,
        wikiResponse.wikitext,
        mapAliasMap,
        wikiResponse.lastRevision
      );
      const discrepancies = compareTasks(
        task,
        wikiData,
        mapAliasMap,
        false,
        nextTaskMap,
        taskSuppressions
      );
      allDiscrepancies.push(...discrepancies);
    } catch (error) {
      errors += 1;
      const reason = error instanceof Error ? error.message : String(error);
      failedTasks.push({ id: task.id, name: task.name, reason });
      process.stderr.write(`\n${task.name} (${task.id}) failed: ${reason} : ${icons.error}\n`);
    }
  }

  console.log('\n');
  printHeader('BULK RESULTS');
  console.log(`Tasks checked: ${checked}`);
  console.log(`Wiki cache hits: ${cacheHits}`);
  console.log(`Wiki errors: ${errors}`);
  console.log(`Total discrepancies found: ${allDiscrepancies.length}`);
  if (failedTasks.length > 0) {
    console.log('Failed tasks:');
    for (const failed of failedTasks.slice(0, 10)) {
      console.log(`  - ${failed.name} (${failed.id}): ${failed.reason}`);
    }
    if (failedTasks.length > 10) {
      console.log(`  ...and ${failedTasks.length - 10} more`);
    }
  }

  // Filter out suppressed discrepancies (overlay corrections + wiki-incorrect)
  const newDiscrepancies = allDiscrepancies.filter((d) => {
    const key = `${d.taskId}:${d.field}`;
    return !suppressed.has(key) && !isTaskFieldSuppressed(taskSuppressions, d.taskId, d.field);
  });
  const filteredCount = allDiscrepancies.length - newDiscrepancies.length;

  // A discrepancy on a registered mode-divergent field indicates upstream mode
  // mirroring, so it outranks its normal field-based priority.
  const divergentKeys = loadDivergentFieldKeys();
  let elevatedCount = 0;
  for (const discrepancy of newDiscrepancies) {
    if (
      discrepancy.priority !== 'high' &&
      divergentKeys.has(`${discrepancy.taskId}:${discrepancy.field}`)
    ) {
      discrepancy.priority = 'high';
      elevatedCount += 1;
    }
  }
  if (elevatedCount > 0) {
    console.log(dim(`Elevated to high priority (registered mode divergence): ${elevatedCount}`));
  }

  if (filteredCount > 0) {
    console.log(
      `${dim(`Suppressed (overlay + wiki-incorrect + task suppressions): ${filteredCount}`)}`
    );
  }
  console.log(`${bold(`New discrepancies to review: ${newDiscrepancies.length}`)}`);

  // Post-1.0 wiki edit summary
  const post1_0Count = newDiscrepancies.filter((d) => d.wikiEditedPost1_0 === true).length;
  const pre1_0Count = newDiscrepancies.filter((d) => d.wikiEditedPost1_0 === false).length;
  const unknownCount = newDiscrepancies.filter((d) => d.wikiEditedPost1_0 === undefined).length;

  if (post1_0Count > 0 || pre1_0Count > 0) {
    console.log();
    printHeader('WIKI DATA FRESHNESS (1.0 = Nov 15, 2025)');
    console.log(
      `  ${colorize('[POST-1.0]', 'green')} wiki edits: ${post1_0Count} ${dim('(high confidence)')}`
    );
    console.log(
      `  ${colorize('[PRE-1.0]', 'red')} wiki edits: ${pre1_0Count} ${dim('(may be outdated)')}`
    );
    if (unknownCount > 0) {
      console.log(`  ${dim('[UNKNOWN]')} Unknown: ${unknownCount} ${dim('(no revision data)')}`);
    }
  }

  // Check for stale wiki-incorrect suppressions (wiki now matches API)
  const allDiscrepancyKeys = new Set(allDiscrepancies.map((d) => `${d.taskId}:${d.field}`));
  const staleSuppresions: string[] = [];
  for (const key of wikiIncorrectKeys) {
    if (!allDiscrepancyKeys.has(key)) {
      staleSuppresions.push(key);
    }
  }

  if (staleSuppresions.length > 0) {
    console.log();
    printHeader('STALE WIKI-INCORRECT SUPPRESSIONS');
    console.log(`  ${bold('These suppressions can be removed')} - wiki now matches API:`);
    console.log();
    for (const key of staleSuppresions) {
      const [taskId, field] = key.split(':');
      const task = tasksWithWiki.find((t) => t.id === taskId);
      const taskName = task?.name ?? 'Unknown Task';
      console.log(`  ${taskName} [${field}] : ${icons.trash}`);
      console.log(`     ${dim(`ID: ${taskId}`)}`);
    }
    console.log();
    console.log(`  ${dim(`Remove from: src/suppressions/wiki-incorrect.json5`)}`);
  }
  console.log();

  renderDiscrepancies(newDiscrepancies, options.groupBy ?? 'category');

  // Save results to file if requested
  const outputFile = resolveOutputFilePath(options.output);
  if (outputFile) {
    ensureDir(path.dirname(outputFile));
    const groupBy = options.groupBy ?? 'category';

    // Group by priority
    const byPriority: Record<string, Discrepancy[]> = {
      high: [],
      medium: [],
      low: [],
    };
    for (const d of newDiscrepancies) {
      byPriority[d.priority].push(d);
    }

    // Group by category
    const byCategory: Record<string, Discrepancy[]> = {};
    for (const d of newDiscrepancies) {
      if (!byCategory[d.field]) byCategory[d.field] = [];
      byCategory[d.field].push(d);
    }

    const results = {
      meta: {
        generatedAt: new Date().toISOString(),
        tasksChecked: checked,
        cacheHits,
        errors,
        totalDiscrepancies: allDiscrepancies.length,
        alreadyAddressed: filteredCount,
        newDiscrepancies: newDiscrepancies.length,
        groupBy,
      },
      wikiDataFreshness: {
        post1_0: post1_0Count,
        pre1_0: pre1_0Count,
        unknown: unknownCount,
        note: 'Tarkov 1.0 launched Nov 15, 2025. Post-1.0 wiki edits are high confidence.',
      },
      summary: {
        byPriority: {
          high: byPriority.high.length,
          medium: byPriority.medium.length,
          low: byPriority.low.length,
        },
        byCategory: Object.fromEntries(Object.entries(byCategory).map(([k, v]) => [k, v.length])),
      },
      // Primary grouping based on --group-by flag
      discrepancies: groupBy === 'category' ? byCategory : byPriority,
    };
    fs.writeFileSync(outputFile, JSON.stringify(results, null, 2));
    printSuccess(`Results saved to ${outputFile}`);
  }
}

export async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printUsage();
    return;
  }

  printHeader('WIKI TASK COMPARE');

  const gameMode = options.gameMode ?? 'both';
  const modeLabel =
    gameMode === 'both'
      ? 'PVP + PVE (mode-specific)'
      : gameMode === 'regular'
        ? 'PVP only'
        : 'PVE only';

  // Load or fetch API data
  let tasks: ExtendedTaskData[];
  const apiCache = options.useCache && !options.refresh ? loadApiCache() : null;

  // Only use cache if it matches the requested game mode
  const cacheMatchesMode = apiCache?.meta.gameMode === gameMode;

  if (apiCache && cacheMatchesMode) {
    tasks = apiCache.tasks;
    printSuccess(
      `Loaded ${tasks.length} tasks from cache [${modeLabel}] (${apiCache.meta.fetchedAt})`
    );
  } else {
    printProgress(`Fetching tasks from tarkov.dev API [${modeLabel}]...`);
    tasks = await fetchExtendedTasks(gameMode);
    saveApiCache(tasks, gameMode);
    printSuccess(`Fetched ${tasks.length} unique tasks [${modeLabel}]`);
  }

  const mapNames = collectMapNames(tasks);
  const mapAliasMap = buildMapAliasMap(mapNames);

  if (options.all) {
    await runBulkMode(tasks, mapAliasMap, options);
  } else {
    await runSingleTask(tasks, mapAliasMap, options);
  }
}
