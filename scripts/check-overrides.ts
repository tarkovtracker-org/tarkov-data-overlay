#!/usr/bin/env tsx
/**
 * Validation script to check if overlay corrections are still needed
 *
 * This script queries the tarkov.dev API and compares current API data
 * with our overlay corrections to determine which overrides are still
 * necessary and which have been fixed upstream.
 *
 * Usage:
 *   npm run check-overrides
 *
 * Exit codes:
 *   0 - All overrides validated successfully
 *   1 - Error occurred during validation
 */

import { join } from 'path';
import { existsSync } from 'fs';
import { pathToFileURL } from 'url';
import {
  getProjectPaths,
  loadJson5File,
  colors,
  icons,
  bold,
  dim,
  printHeader,
  printProgress,
  printSuccess,
  printError,
  formatCountLabel,
  fetchTasks,
  SUPPORTED_GAME_MODES,
  validateAllOverrides,
  categorizeResults,
  type TaskOverride,
  type TaskAddition,
  type TaskData,
  type GameMode,
  type ValidationResult,
  type ValidationDetail,
} from '../src/lib/index.js';
import {
  loadEftTasks,
  detectReferenceMode,
  crossCheckOverrides,
  type CrossCheckEntry,
} from './eft-compare.js';

const { srcDir, rootDir } = getProjectPaths();

/**
 * Load task overrides from source file
 */
function loadTaskOverrides(): Record<string, TaskOverride> {
  const filePath = join(srcDir, 'overrides', 'tasks.json5');
  return loadJson5File<Record<string, TaskOverride>>(filePath);
}

/**
 * Load task additions from source file
 */
function loadTaskAdditions(): Record<string, TaskAddition> {
  const filePath = join(srcDir, 'additions', 'tasksAdd.json5');
  return loadJson5File<Record<string, TaskAddition>>(filePath);
}

type EditionData = {
  id: string;
  title?: string;
  exclusiveTaskIds?: string[];
  excludedTaskIds?: string[];
};

/**
 * Load mode-specific JSON5 file from src/, returning {} when missing.
 */
function loadModeFile<T>(relPath: string): Record<string, T> {
  const filePath = join(srcDir, relPath);
  if (!existsSync(filePath)) return {};
  return loadJson5File<Record<string, T>>(filePath);
}

const loadModeTaskOverrides = (mode: GameMode) =>
  loadModeFile<TaskOverride>(join('overrides', 'modes', mode, 'tasks.json5'));

const loadModeTaskAdditions = (mode: GameMode) =>
  loadModeFile<TaskAddition>(join('additions', 'modes', mode, 'tasksAdd.json5'));

/**
 * Load edition additions from source file
 */
function loadEditions(): Record<string, EditionData> {
  const filePath = join(srcDir, 'additions', 'editions.json5');
  return loadJson5File<Record<string, EditionData>>(filePath);
}

const STATUS_ICONS: Record<ValidationResult['status'], string> = {
  NEEDED: icons.warning,
  FIXED: icons.success,
  REMOVED_FROM_API: icons.trash,
  NOT_FOUND: icons.error,
};

const DETAIL_ICONS: Record<ValidationDetail['status'], string> = {
  needed: icons.warning,
  check: icons.warning,
  fixed: icons.success,
  info: icons.info,
};

const DETAIL_COLORS: Record<ValidationDetail['status'], string> = {
  needed: colors.yellow,
  check: colors.yellow,
  fixed: colors.green,
  info: colors.cyan,
};

export type AdditionStatus = 'RESOLVED' | 'MISSING' | 'CHECK';

export type AdditionResult = {
  key: string;
  name: string;
  status: AdditionStatus;
  message: string;
};

export type EditionTaskReference = {
  editionId: string;
  editionTitle?: string;
  taskId: string;
  kind: 'exclusive' | 'excluded';
};

export function normalizeWikiLink(link?: string): string | undefined {
  if (!link) return undefined;
  const trimmed = link.trim();
  if (!trimmed) return undefined;

  try {
    const parsed = new URL(trimmed);
    const protocol =
      parsed.protocol === 'http:' || parsed.protocol === 'https:'
        ? 'https:'
        : parsed.protocol;
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    const pathname =
      parsed.pathname.replace(/\/+$/, '') === ''
        ? '/'
        : parsed.pathname.replace(/\/+$/, '');
    return `${protocol}//${host}${pathname}`.toLowerCase();
  } catch {
    return trimmed.toLowerCase().replace(/\/+$/, '');
  }
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

function getPrestigeLevel(task: { requiredPrestige?: { prestigeLevel: number } | null }): number {
  return task.requiredPrestige?.prestigeLevel ?? 0;
}

function buildApiIndexes(apiTasks: TaskData[]) {
  const byWikiLink = new Map<string, TaskData>();
  const byName = new Map<string, TaskData[]>();

  for (const task of apiTasks) {
    const wikiKey = normalizeWikiLink(task.wikiLink);
    if (wikiKey) {
      byWikiLink.set(wikiKey, task);
    }

    const nameKey = normalizeName(task.name);
    const matches = byName.get(nameKey) ?? [];
    matches.push(task);
    byName.set(nameKey, matches);
  }

  return { byWikiLink, byName };
}

export function checkTaskAdditions(
  additions: Record<string, TaskAddition>,
  apiTasks: TaskData[]
): AdditionResult[] {
  const { byWikiLink, byName } = buildApiIndexes(apiTasks);

  return Object.entries(additions).map(([key, addition]) => {
    const wikiKey = normalizeWikiLink(addition.wikiLink);
    const wikiMatch = wikiKey ? byWikiLink.get(wikiKey) : undefined;
    if (wikiMatch) {
      return {
        key,
        name: addition.name,
        status: 'RESOLVED',
        message: `Matched API task '${wikiMatch.name}' (${wikiMatch.id}) by wikiLink - RESOLVED`,
      };
    }

    const nameKey = normalizeName(addition.name);
    const nameMatches = byName.get(nameKey) ?? [];
    const additionPrestigeLevel = addition.requiredPrestige?.prestigeLevel;

    if (additionPrestigeLevel !== undefined && nameMatches.length > 0) {
      const prestigeMatches = nameMatches.filter(
        (task) => getPrestigeLevel(task) === additionPrestigeLevel
      );

      if (prestigeMatches.length === 1) {
        return {
          key,
          name: addition.name,
          status: 'CHECK',
          message: `Matched API task '${prestigeMatches[0].name}' (${prestigeMatches[0].id}) by name and requiredPrestige=${additionPrestigeLevel} - NEEDS REVIEW`,
        };
      }

      if (prestigeMatches.length > 1) {
        const ids = prestigeMatches.map((task) => task.id).join(', ');
        return {
          key,
          name: addition.name,
          status: 'CHECK',
          message: `Multiple API tasks share this name and requiredPrestige=${additionPrestigeLevel} (${ids}) - NEEDS REVIEW`,
        };
      }

      const availablePrestigeLevels = [...new Set(nameMatches.map((task) => getPrestigeLevel(task)))]
        .sort((a, b) => a - b)
        .join(', ');
      return {
        key,
        name: addition.name,
        status: 'MISSING',
        message: `API tasks share this name, but none match requiredPrestige=${additionPrestigeLevel} (available: ${availablePrestigeLevels}) - STILL NEEDED`,
      };
    }

    if (nameMatches.length === 1) {
      return {
        key,
        name: addition.name,
        status: 'CHECK',
        message: `Matched API task '${nameMatches[0].name}' (${nameMatches[0].id}) by name only - NEEDS REVIEW`,
      };
    }

    if (nameMatches.length > 1) {
      const ids = nameMatches.map((task) => task.id).join(', ');
      return {
        key,
        name: addition.name,
        status: 'CHECK',
        message: `Multiple API tasks share this name (${ids}) - NEEDS REVIEW`,
      };
    }

    return {
      key,
      name: addition.name,
      status: 'MISSING',
      message: 'Still missing from API - STILL NEEDED',
    };
  });
}

export function checkEditionTaskReferences(
  editions: Record<string, EditionData>,
  apiTasks: TaskData[]
): EditionTaskReference[] {
  const apiTaskIds = new Set(apiTasks.map((task) => task.id));
  const missing: EditionTaskReference[] = [];

  for (const edition of Object.values(editions)) {
    for (const taskId of edition.exclusiveTaskIds ?? []) {
      if (!apiTaskIds.has(taskId)) {
        missing.push({
          editionId: edition.id,
          editionTitle: edition.title,
          taskId,
          kind: 'exclusive',
        });
      }
    }

    for (const taskId of edition.excludedTaskIds ?? []) {
      if (!apiTaskIds.has(taskId)) {
        missing.push({
          editionId: edition.id,
          editionTitle: edition.title,
          taskId,
          kind: 'excluded',
        });
      }
    }
  }

  return missing;
}

/**
 * Print validation results for all tasks
 */
type ResultPrintOptions = {
  titlePrefix?: string;
  overridePath?: string;
};

function printResults(results: ValidationResult[], options: ResultPrintOptions = {}): void {
  const title = options.titlePrefix
    ? `${options.titlePrefix} OVERLAY VALIDATION REPORT`
    : 'OVERLAY VALIDATION REPORT';
  const overridePath = options.overridePath ?? 'src/overrides/tasks.json5';

  printHeader(title);

  // Print details for each task
  for (const result of results) {
    const icon = STATUS_ICONS[result.status];
    console.log(`${icon} ${bold(result.name)} ${dim(`(${result.id})`)}`);

    for (const detail of result.details) {
      const detailIcon = DETAIL_ICONS[detail.status];
      const color = DETAIL_COLORS[detail.status];
      console.log(`   ${detailIcon} ${color}${detail.message}${colors.reset}`);
    }
    console.log();
  }

  // Print summary
  printHeader(options.titlePrefix ? `${options.titlePrefix} SUMMARY` : 'SUMMARY');

  const { stillNeeded, fixed, removedFromApi } = categorizeResults(results);

  // Still needed
  console.log(
    formatCountLabel(
      `${icons.success} Still need overrides`,
      stillNeeded.length,
      'green'
    )
  );
  if (stillNeeded.length > 0) {
    for (const r of stillNeeded) {
      console.log(`  - ${r.name} (${r.id})`);
    }
  } else {
    console.log(`  ${dim('None')}`);
  }
  console.log();

  // Fixed in API
  console.log(
    formatCountLabel(
      `${icons.sync} Fixed in API, can remove`,
      fixed.length,
      'yellow'
    )
  );
  if (fixed.length > 0) {
    for (const r of fixed) {
      console.log(`  - ${r.name} (${r.id})`);
    }
  } else {
    console.log(`  ${dim('None')}`);
  }
  console.log();

  // Removed from API
  console.log(
    formatCountLabel(
      `${icons.trash} Removed from API, delete from overlay`,
      removedFromApi.length,
      'red'
    )
  );
  if (removedFromApi.length > 0) {
    for (const r of removedFromApi) {
      console.log(`  - ${r.name} (${r.id})`);
    }
  } else {
    console.log(`  ${dim('None')}`);
  }
  console.log();

  // Print recommendation
  const obsoleteCount = fixed.length + removedFromApi.length;
  if (obsoleteCount > 0) {
    console.log(`${icons.lightbulb} ${bold('RECOMMENDATION:')}`);
    console.log(
      `   Update ${overridePath} to remove ${obsoleteCount} obsolete override(s)`
    );
    console.log();
  }
}

const ADDITION_ICONS: Record<AdditionStatus, string> = {
  RESOLVED: icons.success,
  CHECK: icons.warning,
  MISSING: icons.warning,
};

const ADDITION_COLORS: Record<AdditionStatus, string> = {
  RESOLVED: colors.green,
  CHECK: colors.yellow,
  MISSING: colors.yellow,
};

function printAdditionResults(results: AdditionResult[], titlePrefix?: string): void {
  const checkTitle = titlePrefix ? `${titlePrefix} ADDITIONS CHECK` : 'ADDITIONS CHECK';
  const summaryTitle = titlePrefix
    ? `${titlePrefix} ADDITIONS SUMMARY`
    : 'ADDITIONS SUMMARY';

  printHeader(checkTitle);

  for (const result of results) {
    const icon = ADDITION_ICONS[result.status];
    const color = ADDITION_COLORS[result.status];
    console.log(`${icon} ${bold(result.name)} ${dim(`(${result.key})`)}`);
    console.log(`   ${color}${result.message}${colors.reset}`);
    console.log();
  }

  const resolved = results.filter((r) => r.status === 'RESOLVED');
  const missing = results.filter((r) => r.status === 'MISSING');
  const review = results.filter((r) => r.status === 'CHECK');

  printHeader(summaryTitle);

  console.log(
    formatCountLabel(
      `${icons.success} Resolved in API (remove from tasksAdd)`,
      resolved.length,
      'green'
    )
  );
  if (resolved.length > 0) {
    for (const r of resolved) {
      console.log(`  - ${r.name} (${r.key})`);
    }
  } else {
    console.log(`  ${dim('None')}`);
  }
  console.log();

  console.log(
    formatCountLabel(
      `${icons.warning} Still missing from API`,
      missing.length,
      'yellow'
    )
  );
  if (missing.length > 0) {
    for (const r of missing) {
      console.log(`  - ${r.name} (${r.key})`);
    }
  } else {
    console.log(`  ${dim('None')}`);
  }
  console.log();

  console.log(
    formatCountLabel(
      `${icons.sync} Needs review (name-only matches)`,
      review.length,
      'yellow'
    )
  );
  if (review.length > 0) {
    for (const r of review) {
      console.log(`  - ${r.name} (${r.key})`);
    }
  } else {
    console.log(`  ${dim('None')}`);
  }
  console.log();
}

function printEditionReferenceResults(missing: EditionTaskReference[]): void {
  printHeader('EDITION EXCLUSIONS CHECK');

  if (missing.length === 0) {
    console.log(`${icons.success} All edition task references exist in API\n`);
    return;
  }

  console.log(
    formatCountLabel(
      `${icons.warning} Missing edition task references (review)`,
      missing.length,
      'yellow'
    )
  );
  for (const entry of missing) {
    const title = entry.editionTitle ?? entry.editionId;
    console.log(
      `  - ${title} (${entry.editionId}) ${entry.kind} task ID ${entry.taskId}`
    );
  }
  console.log();
}

/**
 * Cross-check objective overrides against the local quest reference file
 * (authoritative source). The API-only validator can only say "override differs
 * from API", which it treats as "still needed" - it cannot tell when the
 * override itself is wrong. The reference file adjudicates that. No-ops cleanly
 * when no reference file is present in `eft/`.
 */
function printReferenceCrossCheck(
  groups: Array<{ label: string; overrides: Record<string, TaskOverride> }>
): void {
  const eftDir = join(rootDir, 'eft');
  const eftTasks = loadEftTasks(eftDir);
  if (!eftTasks) return; // no reference file available; skip silently

  printHeader('REFERENCE CROSS-CHECK');

  // The reference file is mode-specific. 'base' overrides are mode-agnostic and
  // always comparable; a mode-specific group is only valid to cross-check when
  // it matches the reference's mode, otherwise it produces false conflicts.
  const refMode = detectReferenceMode(eftDir);
  const applicable = groups.filter((g) => g.label === 'base' || g.label === refMode);
  const skipped = groups.filter((g) => !applicable.includes(g));
  if (refMode) {
    console.log(dim(`  (reference mode: ${refMode})`));
    for (const g of skipped) {
      console.log(dim(`  (skipping ${g.label} overrides: reference is ${refMode})`));
    }
  } else {
    console.log(dim('  (reference mode unknown; checking base overrides only)'));
  }
  console.log();

  const countConflicts: CrossCheckEntry[] = [];
  const descConflicts: CrossCheckEntry[] = [];
  const unverifiable: CrossCheckEntry[] = [];
  let confirmed = 0;

  for (const { overrides } of applicable) {
    for (const entry of crossCheckOverrides(overrides, eftTasks)) {
      if (entry.verdict === 'CONFLICTS_REFERENCE') {
        (entry.field === 'count' ? countConflicts : descConflicts).push(entry);
      } else if (entry.verdict === 'NO_REFERENCE_DATA') unverifiable.push(entry);
      else confirmed += 1;
    }
  }

  const printConflict = (c: CrossCheckEntry): void => {
    console.log(`  - ${c.taskId} / ${c.objectiveId} (${c.field})`);
    console.log(`      override: ${colors.red}${c.override}${colors.reset}`);
    console.log(`      reference: ${colors.green}${c.reference}${colors.reset}`);
  };

  // Numeric (count) overrides are an exact signal: disagreeing with the
  // reference almost always means the override is wrong.
  console.log(
    formatCountLabel(
      `${icons.error} Count overrides that CONFLICT with the reference (likely wrong)`,
      countConflicts.length,
      'red'
    )
  );
  countConflicts.forEach(printConflict);
  if (countConflicts.length === 0) console.log(`  ${dim('None')}`);
  console.log();

  // Description wording is intentionally rephrased by tarkov.dev and by some
  // overrides (e.g. fixing a localization bug), so a text mismatch is not by
  // itself proof the override is wrong - flag it for review, don't condemn it.
  console.log(
    formatCountLabel(
      `${icons.warning} Description overrides that differ from the reference (review - wording may intentionally differ)`,
      descConflicts.length,
      'yellow'
    )
  );
  descConflicts.forEach(printConflict);
  if (descConflicts.length === 0) console.log(`  ${dim('None')}`);
  console.log();

  console.log(
    formatCountLabel(
      `${icons.success} Overrides confirmed by the reference`,
      confirmed,
      'green'
    )
  );
  console.log();

  console.log(
    formatCountLabel(
      `${icons.info} Objective overrides the reference can't adjudicate`,
      unverifiable.length,
      'cyan'
    )
  );
  console.log();
}

/**
 * Main validation function
 */
async function main(): Promise<void> {
  try {
    printProgress('Loading task overrides...');
    const overrides = loadTaskOverrides();
    const taskCount = Object.keys(overrides).length;
    printSuccess(`Found ${taskCount} task override(s)\n`);

    printProgress('Loading task additions and editions...');
    const additions = loadTaskAdditions();
    const editions = loadEditions();
    const additionsCount = Object.keys(additions).length;
    const editionsCount = Object.keys(editions).length;
    printSuccess(
      `Found ${additionsCount} task addition(s) and ${editionsCount} edition(s)\n`
    );

    printProgress('Fetching current data from tarkov.dev API...');
    const apiTasks = await fetchTasks();
    printSuccess(`Fetched ${apiTasks.length} tasks from API\n`);

    printProgress('Validating overrides...\n');
    const results = validateAllOverrides(overrides, apiTasks);

    printResults(results);

    // Collect every override group for the reference cross-check below.
    const crossCheckGroups: Array<{ label: string; overrides: Record<string, TaskOverride> }> = [
      { label: 'base', overrides },
    ];

    printProgress('Checking additions against API...\n');
    const additionResults = checkTaskAdditions(additions, apiTasks);
    printAdditionResults(additionResults);

    // Validate mode-specific overrides and additions
    for (const mode of SUPPORTED_GAME_MODES) {
      const modeOverrides = loadModeTaskOverrides(mode);
      const modeAdditions = loadModeTaskAdditions(mode);
      const modeOverrideCount = Object.keys(modeOverrides).length;
      const modeAdditionCount = Object.keys(modeAdditions).length;
      if (modeOverrideCount === 0 && modeAdditionCount === 0) continue;

      if (modeOverrideCount > 0) {
        crossCheckGroups.push({ label: mode, overrides: modeOverrides });
      }

      printProgress(`Fetching ${mode} tasks from tarkov.dev API...`);
      const modeApiTasks = await fetchTasks(mode);
      printSuccess(`Fetched ${modeApiTasks.length} ${mode} tasks from API\n`);

      if (modeOverrideCount > 0) {
        printProgress(`Validating ${mode} mode overrides...\n`);
        const modeResults = validateAllOverrides(modeOverrides, modeApiTasks);
        printResults(modeResults, {
          titlePrefix: mode.toUpperCase(),
          overridePath: `src/overrides/modes/${mode}/tasks.json5`,
        });
      }

      if (modeAdditionCount > 0) {
        printProgress(`Checking ${mode} mode additions against API...\n`);
        const modeAdditionResults = checkTaskAdditions(modeAdditions, modeApiTasks);
        printAdditionResults(modeAdditionResults, mode.toUpperCase());
      }
    }

    printProgress('Checking edition exclusions against API...\n');
    const missingEditionRefs = checkEditionTaskReferences(editions, apiTasks);
    printEditionReferenceResults(missingEditionRefs);

    printReferenceCrossCheck(crossCheckGroups);

    process.exit(0);
  } catch (error) {
    printError('Error during validation:', error as Error);
    process.exit(1);
  }
}

function isDirectExecution(): boolean {
  const entryFile = process.argv[1];
  if (!entryFile) return false;
  return import.meta.url === pathToFileURL(entryFile).href;
}

if (isDirectExecution()) {
  main();
}
