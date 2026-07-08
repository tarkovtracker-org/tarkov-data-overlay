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
  sleep,
} from '../../src/lib/index.js';
import {
  CliOptions,
  DEFAULT_TASK_NAME,
  Discrepancy,
  ExtendedTaskData,
  Priority,
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
  loadTaskRequirementOverrides,
  loadTaskSuppressions,
} from './overlay.js';
import {
  buildMapAliasMap,
  collectMapNames,
} from './normalize.js';
import {
  fetchExtendedTasks,
  resolveTask,
  resolveWikiTitle,
} from './api.js';
import {
  WikiFetchResult,
  fetchWikiWikitext,
  parseWikiTask,
  printWikiData,
} from './wiki.js';
import {
  compareTasks,
} from './compare.js';

export function parseArgs(argv: string[]): CliOptions & { help?: boolean } {
  const options: CliOptions & { help?: boolean } = {};

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (!arg) continue;
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }

    if (arg === '--all' || arg === '-a') {
      options.all = true;
      continue;
    }

    if (arg.startsWith('--id=')) {
      options.id = arg.slice('--id='.length);
      continue;
    }
    if (arg === '--id') {
      options.id = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg.startsWith('--name=')) {
      options.name = arg.slice('--name='.length);
      continue;
    }
    if (arg === '--name') {
      options.name = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg.startsWith('--wiki=')) {
      options.wiki = arg.slice('--wiki='.length);
      continue;
    }
    if (arg === '--wiki') {
      options.wiki = argv[i + 1];
      i += 1;
      continue;
    }

    if (arg === '--cache' || arg === '-c') {
      options.useCache = true;
      continue;
    }

    if (arg === '--refresh' || arg === '-r') {
      options.refresh = true;
      continue;
    }

    if (arg.startsWith('--gameMode=')) {
      const mode = arg.slice('--gameMode='.length);
      if (mode === 'regular' || mode === 'pve' || mode === 'both') {
        options.gameMode = mode;
      }
      continue;
    }
    if (arg === '--gameMode' || arg === '-g') {
      const mode = argv[i + 1];
      if (mode === 'regular' || mode === 'pve' || mode === 'both') {
        options.gameMode = mode;
        i += 1;
      }
      continue;
    }

    if (arg.startsWith('--output=')) {
      options.output = arg.slice('--output='.length);
      continue;
    }
    if (arg === '--output' || arg === '-o') {
      // Check if next arg exists and isn't a flag
      const nextArg = argv[i + 1];
      if (nextArg && !nextArg.startsWith('-')) {
        options.output = nextArg;
        i += 1;
      } else {
        options.output = ''; // Empty string means auto-generate filename
      }
      continue;
    }

    if (arg.startsWith('--group-by=')) {
      const groupBy = arg.slice('--group-by='.length);
      if (groupBy === 'priority' || groupBy === 'category') {
        options.groupBy = groupBy;
      }
      continue;
    }
    if (arg === '--group-by') {
      const groupBy = argv[i + 1];
      if (groupBy === 'priority' || groupBy === 'category') {
        options.groupBy = groupBy;
        i += 1;
      }
      continue;
    }

    if (!options.name) {
      options.name = arg;
    }
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
  console.log(
    '  --group-by <type>  Group output by: priority or category (default: category)'
  );
  console.log(
    '  --gameMode, -g     Game mode: regular (PVP), pve, or both (default: both)'
  );
  console.log('  --id <taskId>      Find task by ID');
  console.log('  --name <taskName>  Find task by name');
  console.log('  --wiki <pageTitle> Override wiki page title');
  console.log('  --help, -h         Show this help');
  console.log();
  console.log('Examples:');
  console.log('  tsx scripts/wiki-compare.ts Grenadier');
  console.log('  tsx scripts/wiki-compare.ts --all --cache');
  console.log(
    '  tsx scripts/wiki-compare.ts --all --cache --group-by=priority'
  );
  console.log('  tsx scripts/wiki-compare.ts --all --refresh --output');
  console.log(
    '  tsx scripts/wiki-compare.ts --all --output data/results/pve-comparison.json'
  );
  console.log('  tsx scripts/wiki-compare.ts --all --gameMode=pve --cache');
  console.log();
}

export async function runSingleTask(
  tasks: ExtendedTaskData[],
  mapAliasMap: Map<string, string>,
  options: CliOptions
): Promise<void> {
  const requirementOverrides = loadTaskRequirementOverrides();
  const nextTaskMap = buildNextTaskMap(tasks, requirementOverrides);
  const taskSuppressions = loadTaskSuppressions();
  const task = resolveTask(tasks, options);
  if (!task) {
    printError(
      `Task not found (id=${options.id ?? 'n/a'}, name=${
        options.name ?? DEFAULT_TASK_NAME
      })`
    );
    printUsage();
    process.exit(1);
  }

  const wikiTitle = resolveWikiTitle(task, options.wiki);
  const wikiCache = options.useCache && !options.refresh ? loadWikiCache(task.id) : null;
  let wikiResponse: WikiFetchResult;

  if (wikiCache) {
    wikiResponse = {
      title: wikiCache.title,
      wikitext: wikiCache.wikitext,
      lastRevision: wikiCache.lastRevision,
    };
    printSuccess(
      `Loaded wiki page "${wikiResponse.title}" from cache (${wikiCache.fetchedAt})`
    );
  } else {
    printProgress(`Fetching wiki wikitext for "${wikiTitle}"...`);
    wikiResponse = await fetchWikiWikitext(wikiTitle);
    saveWikiCache(
      task.id,
      wikiResponse.title,
      wikiResponse.wikitext,
      wikiResponse.lastRevision
    );
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
  printProgress(
    `Found ${tasksWithWiki.length}/${tasks.length} tasks with wiki links`
  );

  // Load suppressed fields (overlay corrections + wiki-incorrect suppressions)
  const { suppressed, overlayCount, wikiIncorrectCount, wikiIncorrectKeys } =
    loadSuppressedFields();
  const taskSuppressions = loadTaskSuppressions();
  if (overlayCount > 0 || wikiIncorrectCount > 0) {
    printProgress(
      `Loaded ${overlayCount} overlay correction(s), ${wikiIncorrectCount} wiki-incorrect suppression(s)`
    );
  }
  if (taskSuppressions.size > 0) {
    printProgress(`Loaded ${taskSuppressions.size} task suppression entries`);
  }
  const requirementOverrides = loadTaskRequirementOverrides();
  const nextTaskMap = buildNextTaskMap(tasks, requirementOverrides);

  const allDiscrepancies: Discrepancy[] = [];
  let checked = 0;
  let errors = 0;
  let cacheHits = 0;
  const failedTasks: Array<{ id: string; name: string; reason: string }> = [];

  for (const task of tasksWithWiki) {
    checked += 1;
    const wikiTitle = resolveWikiTitle(task);
    process.stdout.write(
      `\r[${checked}/${tasksWithWiki.length}] ${task.name.padEnd(40)}`
    );

    try {
      let wikiResponse: WikiFetchResult;
      const wikiCache =
        options.useCache && !options.refresh ? loadWikiCache(task.id) : null;

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
      process.stderr.write(
        `\n${icons.error} ${task.name} (${task.id}) failed: ${reason}\n`
      );
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
    return (
      !suppressed.has(key) &&
      !isTaskFieldSuppressed(taskSuppressions, d.taskId, d.field)
    );
  });
  const filteredCount = allDiscrepancies.length - newDiscrepancies.length;

  if (filteredCount > 0) {
    console.log(
      `${dim(
        `Suppressed (overlay + wiki-incorrect + task suppressions): ${filteredCount}`
      )}`
    );
  }
  console.log(
    `${bold(`New discrepancies to review: ${newDiscrepancies.length}`)}`
  );

  // Post-1.0 wiki edit summary
  const post1_0Count = newDiscrepancies.filter(
    (d) => d.wikiEditedPost1_0 === true
  ).length;
  const pre1_0Count = newDiscrepancies.filter(
    (d) => d.wikiEditedPost1_0 === false
  ).length;
  const unknownCount = newDiscrepancies.filter(
    (d) => d.wikiEditedPost1_0 === undefined
  ).length;

  if (post1_0Count > 0 || pre1_0Count > 0) {
    console.log();
    printHeader('WIKI DATA FRESHNESS (1.0 = Nov 15, 2025)');
    console.log(
      `  🟢 Post-1.0 wiki edits: ${post1_0Count} ${dim('(high confidence)')}`
    );
    console.log(
      `  🔴 Pre-1.0 wiki edits: ${pre1_0Count} ${dim('(may be outdated)')}`
    );
    if (unknownCount > 0) {
      console.log(`  ⚪ Unknown: ${unknownCount} ${dim('(no revision data)')}`);
    }
  }

  // Check for stale wiki-incorrect suppressions (wiki now matches API)
  const allDiscrepancyKeys = new Set(
    allDiscrepancies.map((d) => `${d.taskId}:${d.field}`)
  );
  const staleSuppresions: string[] = [];
  for (const key of wikiIncorrectKeys) {
    if (!allDiscrepancyKeys.has(key)) {
      staleSuppresions.push(key);
    }
  }

  if (staleSuppresions.length > 0) {
    console.log();
    printHeader('STALE WIKI-INCORRECT SUPPRESSIONS');
    console.log(
      `  ${bold('These suppressions can be removed')} - wiki now matches API:`
    );
    console.log();
    for (const key of staleSuppresions) {
      const [taskId, field] = key.split(':');
      const task = tasksWithWiki.find((t) => t.id === taskId);
      const taskName = task?.name ?? 'Unknown Task';
      console.log(`  🗑️  ${taskName} ${dim(`[${field}]`)}`);
      console.log(`     ${dim(`ID: ${taskId}`)}`);
    }
    console.log();
    console.log(
      `  ${dim(`Remove from: src/suppressions/wiki-incorrect.json5`)}`
    );
  }
  console.log();

  if (newDiscrepancies.length > 0) {
    const groupBy = options.groupBy ?? 'category';

    // Priority order and labels
    const priorityOrder: Priority[] = ['high', 'medium', 'low'];
    const priorityLabels: Record<Priority, string> = {
      high: '🔴 HIGH',
      medium: '🟡 MEDIUM',
      low: '🟢 LOW',
    };

    const priorityIcons: Record<Priority, string> = {
      high: '🔴',
      medium: '🟡',
      low: '🟢',
    };

    const categoryLabels: Record<string, string> = {
      minPlayerLevel: 'Level Requirements',
      taskRequirements: 'Task Prerequisites',
      nextTasks: 'Task Next / Unlocks',
      map: 'Task Map / Location',
      'objectives.description': 'Objective Descriptions',
      experience: 'Reward: Experience (XP)',
      money: 'Reward: Money (Roubles)',
      'objectives.count': 'Objective Counts',
      'objectives.maps': 'Objective Maps / Locations',
      'objectives.items': 'Objective Required Items',
    };

    // Define category display order (most important first)
    const categoryOrder = [
      'minPlayerLevel',
      'taskRequirements',
      'nextTasks',
      'map',
      'objectives.description',
      'objectives.count',
      'objectives.maps',
      'objectives.items',
      'experience',
      'money',
      // Reputation fields will be sorted alphabetically after these
    ];

    // Helper to get category label (handles dynamic reputation.TraderName fields)
    const getCategoryLabel = (field: string): string => {
      if (field.startsWith('reputation.')) {
        const trader = field.replace('reputation.', '');
        return `Reward: Reputation (${trader})`;
      }
      return categoryLabels[field] ?? field;
    };

    // Helper to print a single discrepancy
    const printDiscrepancy = (
      d: Discrepancy,
      showPriority: boolean,
      showCategory: boolean
    ): void => {
      const freshness =
        d.wikiEditedPost1_0 === true
          ? '🟢'
          : d.wikiEditedPost1_0 === false
          ? '🔴'
          : '⚪';
      const editInfo =
        d.wikiEditDaysAgo !== undefined ? `${d.wikiEditDaysAgo}d ago` : '';
      const priorityPrefix = showPriority
        ? `${priorityIcons[d.priority]} `
        : '  ';
      const categoryInfo = showCategory
        ? ` ${dim(`[${getCategoryLabel(d.field)}]`)}`
        : '';

      console.log(`\n${priorityPrefix}${d.taskName}${categoryInfo}`);
      console.log(`    ${dim(`ID: ${d.taskId}`)}`);
      console.log(`    API:  ${d.apiValue}`);
      console.log(
        `    Wiki: ${d.wikiValue} ${
          d.trustsWiki ? dim('← likely correct') : ''
        }`
      );
      if (editInfo) {
        console.log(`    ${dim(`Wiki edit: ${freshness} ${editInfo}`)}`);
      }
    };

    // Group by priority
    const byPriority = new Map<Priority, Discrepancy[]>();
    for (const p of priorityOrder) {
      byPriority.set(p, []);
    }
    for (const d of newDiscrepancies) {
      byPriority.get(d.priority)!.push(d);
    }

    // Group by category
    const byCategory = new Map<string, Discrepancy[]>();
    for (const d of newDiscrepancies) {
      const field = d.field;
      if (!byCategory.has(field)) byCategory.set(field, []);
      byCategory.get(field)!.push(d);
    }

    const sortedCategories = Array.from(byCategory.keys()).sort((a, b) => {
      const aIdx = categoryOrder.indexOf(a);
      const bIdx = categoryOrder.indexOf(b);
      if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
      if (aIdx !== -1) return -1;
      if (bIdx !== -1) return 1;
      return a.localeCompare(b);
    });

    // Print summary
    printHeader('SUMMARY');
    console.log(`  Grouping by: ${bold(groupBy.toUpperCase())}`);
    console.log();
    console.log('  By Priority:');
    for (const p of priorityOrder) {
      const count = byPriority.get(p)!.length;
      if (count > 0) {
        console.log(`    ${priorityLabels[p]}: ${count}`);
      }
    }
    console.log();
    console.log('  By Category:');
    for (const field of sortedCategories) {
      const discs = byCategory.get(field)!;
      const label = getCategoryLabel(field);
      console.log(`    ${label}: ${discs.length}`);
    }
    console.log();

    // Print details based on groupBy mode
    if (groupBy === 'category') {
      printHeader('DISCREPANCIES BY CATEGORY');

      for (const field of sortedCategories) {
        const discs = byCategory.get(field)!;
        const label = getCategoryLabel(field);

        // Sort by priority within category (high first)
        discs.sort((a, b) => {
          const order = { high: 0, medium: 1, low: 2 };
          return order[a.priority] - order[b.priority];
        });

        console.log(`\n${'─'.repeat(60)}`);
        console.log(`${bold(label)} (${discs.length})`);
        console.log(`${'─'.repeat(60)}`);

        for (const d of discs) {
          printDiscrepancy(d, true, false);
        }
      }
    } else {
      // groupBy === 'priority'
      printHeader('DISCREPANCIES BY PRIORITY');

      for (const p of priorityOrder) {
        const discs = byPriority.get(p)!;
        if (discs.length === 0) continue;

        // Sort by category within priority
        discs.sort((a, b) => {
          const aIdx = categoryOrder.indexOf(a.field);
          const bIdx = categoryOrder.indexOf(b.field);
          if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
          if (aIdx !== -1) return -1;
          if (bIdx !== -1) return 1;
          return a.field.localeCompare(b.field);
        });

        console.log(`\n${'─'.repeat(60)}`);
        console.log(`${bold(priorityLabels[p])} (${discs.length})`);
        console.log(`${'─'.repeat(60)}`);

        for (const d of discs) {
          printDiscrepancy(d, false, true);
        }
      }
    }
    console.log();
  }

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
        byCategory: Object.fromEntries(
          Object.entries(byCategory).map(([k, v]) => [k, v.length])
        ),
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
