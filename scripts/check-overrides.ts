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
import { existsSync, readdirSync, readFileSync } from 'fs';
import {
  getProjectPaths,
  isDirectExecution,
  loadJson5File,
  loadAllJson5FromDir,
  colors,
  icons,
  bold,
  dim,
  printHeader,
  printProgress,
  printSuccess,
  printError,
  formatCountLabel,
  printCountSection,
  fetchTasks,
  fetchLocaleBundle,
  fetchRawEntities,
  SUPPORTED_GAME_MODES,
  validateAllOverrides,
  validateLocaleOverrides,
  validateDivergences,
  categorizeDivergenceResults,
  loadDivergenceRegistry,
  validateEntityOverrides,
  validateEntityAdditions,
  categorizeEntityResults,
  checkStoryChapterIntegrity,
  checkTaskSuppressionStaleness,
  categorizeResults,
  type TaskOverride,
  type TaskAddition,
  type TaskData,
  type GameMode,
  type ValidationResult,
  type ValidationDetail,
  type LocaleOverlay,
  type LocaleValidationResult,
  type LocaleVerdict,
  type TaskDivergence,
  type DivergenceResult,
  type EntityValidationResult,
  type EntityValidatorConfig,
  type StoryChapterIssue,
  type SuppressionStaleness,
} from '../src/lib/index.js';
import {
  loadEftTasks,
  detectReferenceMode,
  crossCheckOverrides,
  findReferenceFile,
  readQuestArray,
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

/**
 * Load an optional src/ JSON5 file, returning {} when it does not exist.
 *
 * Several override files ship as comment-only templates, so a missing or empty
 * file is normal and must not be treated as an error.
 */
function loadOptional<T = unknown>(...segments: string[]): Record<string, T> {
  const filePath = join(srcDir, ...segments);
  if (!existsSync(filePath)) return {};
  return loadJson5File<Record<string, T>>(filePath);
}

/** Load the mode-divergence registry (tooling-only; never built into dist). */
const loadDivergences = () => loadDivergenceRegistry(join(srcDir, 'divergences', 'tasks.json5'));

/** Entity types checked generically, with their API endpoint and field semantics. */
type EntityCheckSpec = {
  label: string;
  /** Path under src/ */
  segments: string[];
  /** Endpoint path segment on json.tarkov.dev */
  endpoint: string;
  /** Key inside the response `data` holding the collection, if nested */
  collectionKey?: string;
  config?: EntityValidatorConfig;
};

const ENTITY_OVERRIDE_SPECS: EntityCheckSpec[] = [
  {
    label: 'items',
    segments: ['overrides', 'items.json5'],
    endpoint: 'items',
    collectionKey: 'items',
  },
  {
    label: 'traders',
    segments: ['overrides', 'traders.json5'],
    endpoint: 'traders',
  },
  {
    label: 'hideout',
    segments: ['overrides', 'hideout.json5'],
    endpoint: 'hideout',
    // The hideout endpoint keys stations directly under `data`, with no
    // wrapping collection key.
  },
];

const ENTITY_ADDITION_SPECS: EntityCheckSpec[] = [
  {
    label: 'itemsAdd',
    segments: ['additions', 'itemsAdd.json5'],
    endpoint: 'items',
    collectionKey: 'items',
  },
  {
    label: 'craftsAdd',
    segments: ['additions', 'craftsAdd.json5'],
    endpoint: 'crafts',
    // The crafts endpoint returns the collection directly under `data` as a
    // top-level array (no wrapping collection key).
  },
];

const STATUS_ICONS: Record<ValidationResult['status'], string> = {
  NEEDED: icons.warning,
  FIXED: icons.success,
  REMOVED_FROM_API: icons.trash,
  NOT_FOUND: icons.error,
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
      parsed.protocol === 'http:' || parsed.protocol === 'https:' ? 'https:' : parsed.protocol;
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
    const pathname =
      parsed.pathname.replace(/\/+$/, '') === '' ? '/' : parsed.pathname.replace(/\/+$/, '');
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

/** Count of trader requirements by semantic type. */
export type RequirementTypeCounts = { level: number; reputation: number };

/**
 * Count trader requirements by semantic type for a task list.
 *
 * Exported for tests; `check-overrides` prints this per game mode so the
 * level/reputation split is visible (issue #274 acceptance: "CI reports
 * requirement counts by semantic type and mode").
 */
export function countRequirementTypes(tasks: TaskData[]): RequirementTypeCounts {
  const counts: RequirementTypeCounts = { level: 0, reputation: 0 };
  for (const task of tasks) {
    for (const req of task.traderRequirements ?? []) {
      if (req.requirementType === 'level') counts.level += 1;
      else if (req.requirementType === 'reputation') counts.reputation += 1;
    }
  }
  return counts;
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

      const availablePrestigeLevels = [
        ...new Set(nameMatches.map((task) => getPrestigeLevel(task))),
      ]
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

function printResults(
  results: ValidationResult[],
  options: ResultPrintOptions = {}
): { obsoleteEntries: number; staleFields: number } {
  const title = options.titlePrefix
    ? `${options.titlePrefix} OVERLAY VALIDATION REPORT`
    : 'OVERLAY VALIDATION REPORT';
  const overridePath = options.overridePath ?? 'src/overrides/tasks.json5';

  printHeader(title);

  // Print details for each task
  for (const result of results) {
    const icon = STATUS_ICONS[result.status];
    console.log(`${bold(result.name)} ${dim(`(${result.id})`)} : ${icon}`);

    for (const detail of result.details) {
      const color = DETAIL_COLORS[detail.status];
      console.log(`   ${color}${detail.message}${colors.reset}`);
    }
    console.log();
  }

  // Print summary
  printHeader(options.titlePrefix ? `${options.titlePrefix} SUMMARY` : 'SUMMARY');

  const { stillNeeded, fixed, removedFromApi } = categorizeResults(results);
  const line = (r: ValidationResult) => `${r.name} (${r.id})`;

  printCountSection('Still need overrides', 'green', stillNeeded.map(line), icons.success);
  printCountSection('Fixed in API, can remove', 'yellow', fixed.map(line), icons.sync);

  // Fully fixed and removed entries are already counted as obsolete below.
  // Count field-level staleness only inside entries that still need at least
  // one override, so each removable unit contributes exactly once.
  const staleFields = stillNeeded.flatMap((result) =>
    result.details
      .filter((detail) => detail.status === 'fixed')
      .map((detail) => `${result.name} (${result.id}) ${detail.field}: ${detail.message}`)
  );
  printCountSection(
    'Individual fields fixed upstream (remove from otherwise-needed entries)',
    'yellow',
    staleFields,
    icons.sync
  );
  printCountSection(
    'Removed from API, delete from overlay',
    'red',
    removedFromApi.map(line),
    icons.trash
  );

  // Print recommendation
  const obsoleteCount = fixed.length + removedFromApi.length;
  if (obsoleteCount > 0) {
    console.log(`${bold('RECOMMENDATION')} : ${icons.lightbulb}`);
    console.log(`   Update ${overridePath} to remove ${obsoleteCount} obsolete override(s)`);
    console.log();
  }

  return { obsoleteEntries: obsoleteCount, staleFields: staleFields.length };
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

function printAdditionResults(
  results: AdditionResult[],
  titlePrefix?: string
): { resolved: number } {
  const checkTitle = titlePrefix ? `${titlePrefix} ADDITIONS CHECK` : 'ADDITIONS CHECK';
  const summaryTitle = titlePrefix ? `${titlePrefix} ADDITIONS SUMMARY` : 'ADDITIONS SUMMARY';

  printHeader(checkTitle);

  for (const result of results) {
    const icon = ADDITION_ICONS[result.status];
    const color = ADDITION_COLORS[result.status];
    console.log(`${bold(result.name)} ${dim(`(${result.key})`)} : ${icon}`);
    console.log(`   ${color}${result.message}${colors.reset}`);
    console.log();
  }

  const byStatus = (status: AdditionStatus) =>
    results.filter((r) => r.status === status).map((r) => `${r.name} (${r.key})`);

  printHeader(summaryTitle);

  printCountSection(
    'Resolved in API (remove from tasksAdd)',
    'green',
    byStatus('RESOLVED'),
    icons.success
  );
  printCountSection('Still missing from API', 'yellow', byStatus('MISSING'), icons.warning);
  printCountSection('Needs review (name-only matches)', 'yellow', byStatus('CHECK'), icons.sync);

  return { resolved: results.filter((result) => result.status === 'RESOLVED').length };
}

function printEditionReferenceResults(missing: EditionTaskReference[]): void {
  printHeader('EDITION EXCLUSIONS CHECK');

  if (missing.length === 0) {
    console.log(`All edition task references exist in API : ${icons.success}\n`);
    return;
  }

  console.log(
    `${formatCountLabel('Missing edition task references (review)', missing.length, 'yellow')} : ${icons.warning}`
  );
  for (const entry of missing) {
    const title = entry.editionTitle ?? entry.editionId;
    console.log(`  - ${title} (${entry.editionId}) ${entry.kind} task ID ${entry.taskId}`);
  }
  console.log();
}

const LOCALE_VERDICT_ORDER: LocaleVerdict[] = ['STALE', 'REMOVED', 'NEEDED', 'UNVERIFIABLE'];

const LOCALE_VERDICT_META: Record<
  LocaleVerdict,
  { icon: string; color: keyof typeof colors; label: string }
> = {
  STALE: {
    icon: icons.sync,
    color: 'yellow',
    label: 'Bundle fixed upstream, can remove',
  },
  REMOVED: {
    icon: icons.trash,
    color: 'red',
    label: 'Entity removed from API, delete from overlay',
  },
  NEEDED: {
    icon: icons.success,
    color: 'green',
    label: 'Bundle still broken, override required',
  },
  UNVERIFIABLE: {
    icon: icons.info,
    color: 'cyan',
    label: 'Overlay-authored (storyChapters), cannot verify',
  },
};

export function printLocaleResults(locale: string, results: LocaleValidationResult[]): void {
  printHeader(`LOCALE OVERRIDES CHECK (${locale})`);

  for (const verdict of LOCALE_VERDICT_ORDER) {
    const subset = results.filter((r) => r.verdict === verdict);
    const meta = LOCALE_VERDICT_META[verdict];
    console.log(`${formatCountLabel(meta.label, subset.length, meta.color)} : ${meta.icon}`);
    for (const r of subset) {
      console.log(`  - ${r.entityType}/${r.entityId} ${bold(r.field)}`);
      if (r.overrideValue !== undefined) {
        console.log(`      override: ${r.overrideValue}`);
        console.log(`      bundle:   ${r.bundleValue ?? dim('(not found)')}`);
      }
      console.log(`      ${dim(r.message)}`);
    }
    if (subset.length === 0) console.log(`  ${dim('None')}`);
    console.log();
  }

  const obsolete = results.filter((r) => r.verdict === 'STALE' || r.verdict === 'REMOVED').length;
  if (obsolete > 0) {
    console.log(`${bold('RECOMMENDATION')} : ${icons.lightbulb}`);
    console.log(
      `   Update src/overrides/locales/${locale}.json5 to remove ${obsolete} obsolete patch(es)`
    );
    console.log();
  }
}

/**
 * Check every locale override file against the live tarkov.dev bundle for the
 * same locale. Locale bundles are shared across game modes, so 'regular' is
 * fetched once per locale.
 */
async function checkLocaleOverrides(): Promise<number> {
  const localesDir = join(srcDir, 'overrides', 'locales');
  const localeOverrides = loadAllJson5FromDir(localesDir);
  const locales = Object.keys(localeOverrides).sort();
  if (locales.length === 0) return 0;

  let stale = 0;
  for (const locale of locales) {
    printProgress(`Fetching ${locale} locale bundle from tarkov.dev...`);
    const bundle = await fetchLocaleBundle('regular', locale);
    printSuccess(`Fetched ${locale} bundle\n`);

    const results = validateLocaleOverrides(
      locale,
      localeOverrides[locale] as LocaleOverlay,
      bundle
    );
    printLocaleResults(locale, results);
    stale += results.filter(
      (result) => result.verdict === 'STALE' || result.verdict === 'REMOVED'
    ).length;
  }
  return stale;
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
    `${formatCountLabel(
      'Count overrides that CONFLICT with the reference (likely wrong)',
      countConflicts.length,
      'red'
    )} : ${icons.error}`
  );
  countConflicts.forEach(printConflict);
  if (countConflicts.length === 0) console.log(`  ${dim('None')}`);
  console.log();

  // Description wording is intentionally rephrased by tarkov.dev and by some
  // overrides (e.g. fixing a localization bug), so a text mismatch is not by
  // itself proof the override is wrong - flag it for review, don't condemn it.
  console.log(
    `${formatCountLabel(
      'Description overrides that differ from the reference (review - wording may intentionally differ)',
      descConflicts.length,
      'yellow'
    )} : ${icons.warning}`
  );
  descConflicts.forEach(printConflict);
  if (descConflicts.length === 0) console.log(`  ${dim('None')}`);
  console.log();

  console.log(
    `${formatCountLabel('Overrides confirmed by the reference', confirmed, 'green')} : ${icons.success}`
  );
  console.log();

  console.log(
    `${formatCountLabel(
      "Objective overrides the reference can't adjudicate",
      unverifiable.length,
      'cyan'
    )} : ${icons.info}`
  );
  console.log();
}

/**
 * Report upstream trader-requirement counts by semantic type and mode.
 *
 * Surfaces the level/reputation split so a consumer's requirement evaluation
 * can be kept in sync with the discriminated upstream schema.
 */
function printRequirementTypeCounts(apiTasksByMode: Partial<Record<GameMode, TaskData[]>>): void {
  printHeader('TRADER REQUIREMENT TYPE COUNTS (UPSTREAM)');
  for (const mode of SUPPORTED_GAME_MODES) {
    const tasks = apiTasksByMode[mode];
    if (!tasks) continue;
    const counts = countRequirementTypes(tasks);
    console.log(`  ${mode}: ${counts.level} level, ${counts.reputation} reputation`);
  }
  console.log();
}

/**
 * Report base-override verdicts across every game mode.
 *
 * Base overrides are mode-agnostic: `docs/INTEGRATION.md` applies them to both
 * modes before mode-specific ones. Validating them against regular alone can
 * therefore hide two failure shapes - an override that is stale in regular but
 * load-bearing in PvE, and one that is quietly wrong in the mode we never
 * checked. Only overrides stale in EVERY mode are safe to retire.
 */
function printBaseCrossModeSummary(resultsByMode: Partial<Record<GameMode, ValidationResult[]>>): {
  staleEverywhere: string[];
  verdictDiffers: string[];
} {
  const modes = Object.keys(resultsByMode) as GameMode[];
  printHeader('BASE OVERRIDES ACROSS ALL MODES');
  console.log(dim(`  (base overrides apply to every mode: ${modes.join(', ')})`));
  console.log();

  const byTask = new Map<string, Partial<Record<GameMode, ValidationResult>>>();
  for (const mode of modes) {
    for (const result of resultsByMode[mode] ?? []) {
      const entry = byTask.get(result.id) ?? {};
      entry[mode] = result;
      byTask.set(result.id, entry);
    }
  }

  const staleEverywhere: string[] = [];
  const verdictDiffers: string[] = [];

  for (const [taskId, perMode] of byTask) {
    const present = modes.filter((mode) => perMode[mode]);
    // A task missing from one mode's data is mode-exclusive, not a disagreement.
    const comparable = present.filter((mode) => perMode[mode]!.status !== 'REMOVED_FROM_API');
    if (comparable.length === 0) continue;

    const name = perMode[comparable[0]]!.name;
    const needed = comparable.filter((mode) => perMode[mode]!.stillNeeded);

    if (needed.length === 0) {
      staleEverywhere.push(`${name} (${taskId}) - redundant in ${comparable.join(' + ')}`);
    } else if (needed.length < comparable.length) {
      const idle = comparable.filter((mode) => !perMode[mode]!.stillNeeded);
      verdictDiffers.push(
        `${name} (${taskId}) - needed in ${needed.join(' + ')}, redundant in ${idle.join(' + ')}`
      );
    }
  }

  printCountSection(
    'Base overrides redundant in EVERY mode (safe to retire)',
    'yellow',
    staleEverywhere,
    icons.warning
  );
  printCountSection(
    'Base overrides whose verdict DIFFERS by mode (keep; consider moving to a mode file)',
    'cyan',
    verdictDiffers,
    icons.info
  );

  return { staleEverywhere, verdictDiffers };
}

/**
 * Report the mode-divergence registry against every recorded upstream mode.
 *
 * This is the check that catches a mirror-direction flip. `OVERRIDE_MISSING`
 * means consumers of that mode are being served a value we know is wrong.
 * `OVERRIDE_REDUNDANT` entries are deliberate guards and are reported for
 * visibility only - retiring them is what let the last regression through.
 */
function printDivergenceCoverage(registry: Record<string, TaskDivergence>): void {
  printHeader('MODE-DIVERGENCE COVERAGE');

  const missing: string[] = [];
  for (const [taskId, entry] of Object.entries(registry)) {
    if (entry.status === 'mode-exclusive') continue;
    for (const [field, definition] of Object.entries(entry.fields)) {
      for (const mode of SUPPORTED_GAME_MODES) {
        if (!(mode in definition)) {
          missing.push(
            `${entry.name} (${taskId}) ${field}: ${mode} truth not independently verified`
          );
        }
      }
    }
  }

  printCountSection(
    'Unverified mode values (capture/proof needed; not assumed from upstream)',
    'yellow',
    missing,
    icons.warning
  );
}

function printDivergenceReport(results: DivergenceResult[]): { actionable: number } {
  printHeader('MODE-DIVERGENCE REGISTRY');

  if (results.length === 0) {
    console.log(dim('  No divergences registered.'));
    console.log();
    return { actionable: 0 };
  }

  const grouped = categorizeDivergenceResults(results);
  const describe = (r: DivergenceResult): string =>
    `${r.taskName} (${r.taskId}) ${r.mode}.${r.field}: expected ${formatDivergenceValue(
      r.expected
    )}, upstream ${formatDivergenceValue(r.upstream)}${
      r.override === undefined ? '' : `, override ${formatDivergenceValue(r.override)}`
    }${r.confidence === 'high' ? '' : ` [${r.confidence} confidence]`}`;

  printCountSection(
    'Wrong data being served - no override corrects upstream (ADD an override)',
    'red',
    grouped.missing.map((r) => `${describe(r)}\n      proof: ${r.proof}`),
    icons.error
  );
  printCountSection(
    'Override present but disagrees with the recorded truth (FIX the override)',
    'red',
    grouped.wrong.map((r) => `${describe(r)}\n      proof: ${r.proof}`),
    icons.error
  );

  // Mirroring is the upstream root cause: identical values in both modes for a
  // field we know differs. Surface it so it can be reported upstream.
  const mirroredFields = new Map<string, DivergenceResult>();
  for (const r of grouped.mirrored) mirroredFields.set(`${r.taskId}:${r.field}`, r);
  printCountSection(
    'Upstream is MIRRORING one mode into the other (report to tarkov.dev)',
    'yellow',
    Array.from(mirroredFields.values()).map(
      (r) =>
        `${r.taskName} (${r.taskId}) ${r.field}: tarkov.dev serves the same value in both modes`
    ),
    icons.warning
  );

  printCountSection(
    'Overrides doing necessary work',
    'green',
    grouped.active.map(describe),
    icons.success
  );
  printCountSection(
    'Redundant guards - upstream currently correct, KEEP for flip protection',
    'cyan',
    grouped.redundant.map(describe),
    icons.info
  );
  printCountSection(
    'Upstream already correct, no override needed',
    'green',
    grouped.upstreamCorrect.map(
      (r) =>
        `${r.taskName} (${r.taskId}) ${r.mode}.${r.field} = ${formatDivergenceValue(r.upstream)}`
    ),
    icons.success
  );

  if (grouped.notInMode.length > 0) {
    printCountSection(
      'Registered field not applicable (task absent from that mode)',
      'cyan',
      grouped.notInMode.map((r) => `${r.taskName} (${r.taskId}) ${r.mode}.${r.field}`),
      icons.info
    );
  }

  return { actionable: grouped.missing.length + grouped.wrong.length };
}

function formatDivergenceValue(value: unknown): string {
  if (value === undefined) return 'absent';
  if (value === null) return 'null';
  return typeof value === 'string' ? `'${value}'` : String(value);
}

/**
 * Report generic entity override/addition results (prestige, items, traders,
 * hideout, itemsAdd).
 */
function printEntityResults(
  label: string,
  filePath: string,
  results: EntityValidationResult[]
): { errors: number; stale: number } {
  printHeader(`${label.toUpperCase()} OVERLAY CHECK`);
  console.log(dim(`  (${filePath})`));
  console.log();

  if (results.length === 0) {
    console.log(dim('  Nothing to verify (file empty or comment-only).'));
    console.log();
    return { errors: 0, stale: 0 };
  }

  const grouped = categorizeEntityResults(results);
  const lines = (list: EntityValidationResult[]) =>
    list.flatMap((r) => [r.id, ...r.details.map((d) => `   ${d.message}`)]);

  printCountSection(
    'Entries whose ID is missing upstream (verify the ID)',
    'red',
    grouped.removedFromApi.map((r) => r.id),
    icons.error
  );
  printCountSection(
    'Still needed',
    'yellow',
    lines(grouped.stillNeeded),
    icons.warning,
    grouped.stillNeeded.length
  );
  printCountSection(
    'Fixed upstream - safe to retire',
    'green',
    lines(grouped.fixed),
    icons.success,
    grouped.fixed.length
  );

  // REMOVED_FROM_API results carry their own 'error' detail and are already
  // printed and counted via grouped.removedFromApi above, so exclude them here
  // to avoid double-reporting (and inflating the --strict actionable count).
  const identityErrors = results
    .filter((r) => r.status !== 'REMOVED_FROM_API')
    .flatMap((r) =>
      r.details.filter((d) => d.status === 'error').map((d) => `${r.id}: ${d.message}`)
    );
  if (identityErrors.length > 0) {
    printCountSection('Identity/consistency problems', 'red', identityErrors, icons.error);
  }

  const staleFieldsInNeededEntries = grouped.stillNeeded
    .flatMap((result) => result.details)
    .filter((detail) => detail.status === 'fixed').length;

  return {
    errors: grouped.removedFromApi.length + identityErrors.length,
    stale: grouped.fixed.length + staleFieldsInNeededEntries,
  };
}

/** Report story-chapter referential integrity problems. */
function printStoryChapterIssues(
  issues: StoryChapterIssue[],
  questRefsChecked: boolean
): { errors: number } {
  printHeader('STORY CHAPTER INTEGRITY');
  console.log(
    dim('  (overlay-authored; cannot be verified upstream, so references are checked instead)')
  );
  if (!questRefsChecked) {
    console.log(
      dim('  (no eft/ reference available: quest-ID resolution skipped, internal consistency only)')
    );
  }
  console.log();

  printCountSection(
    'Referential integrity problems',
    'red',
    issues.map((i) => `${i.chapterId} [${i.kind}]: ${i.message}`),
    icons.error
  );

  return { errors: issues.length };
}

/**
 * Quest IDs from the local EFT reference, or null when no reference is present.
 *
 * Story-chapter quests are absent from tarkov.dev, so this is the only source
 * that can resolve them. Two reference payloads are needed:
 *
 * - `quest_list` carries ordinary trader quests, which is what story-chapter
 *   objectives point at via `sourceQuestId`.
 * - `quest_getMainQuestsList` carries the story chapters themselves, which is
 *   what `chapterQuestId` points at. Chapter IDs are NOT in `quest_list`, so
 *   without this file every chapter would look unresolvable.
 */
function loadReferenceQuestIds(): Set<string> | null {
  const eftDir = join(rootDir, 'eft');
  if (!existsSync(eftDir)) return null;

  const ids = new Set<string>();

  try {
    for (const quest of readQuestArray(findReferenceFile(eftDir))) {
      const rawId = (quest as { _id?: unknown })._id;
      if (typeof rawId === 'string') {
        // EFT reference _id values are wrapped, e.g. "[60e71dc0...] Long Line".
        // Extract the first 24-hex token so hex letters in the quest name
        // (the 'e' in "Line") don't corrupt the id. Mirrors eft-compare bareId.
        const bare = rawId.match(/[0-9a-f]{24}/i)?.[0]?.toLowerCase();
        if (bare) ids.add(bare);
      }
    }
  } catch {
    // No quest_list reference, or an unexpected shape.
  }

  for (const chapterId of loadReferenceChapterIds(eftDir)) ids.add(chapterId);

  return ids.size > 0 ? ids : null;
}

/** Story chapter IDs from a `quest_getMainQuestsList` capture, if present. */
function loadReferenceChapterIds(eftDir: string): string[] {
  let files: string[];
  try {
    files = readdirSync(eftDir);
  } catch {
    return [];
  }

  const mainQuestFile = files.find(
    (file) => /getmainquestslist/i.test(file) && file.endsWith('.json')
  );
  if (!mainQuestFile) return [];

  try {
    const raw = JSON.parse(readFileSync(join(eftDir, mainQuestFile), 'utf-8')) as unknown;
    const envelope = raw as {
      response?: { decoded_response?: unknown };
      data?: unknown;
    };
    const decoded = (envelope.response?.decoded_response ?? raw) as { data?: unknown };
    const data = (decoded.data ?? decoded) as { chapters?: unknown };
    if (!Array.isArray(data.chapters)) return [];

    return data.chapters
      .map((chapter) =>
        chapter && typeof chapter === 'object'
          ? (chapter as Record<string, unknown>).ChapterId
          : undefined
      )
      .filter((id): id is string => typeof id === 'string');
  } catch {
    return [];
  }
}

/** Report suppressions that no longer suppress anything. */
function printSuppressionResults(results: SuppressionStaleness[]): { stale: number } {
  printHeader('SUPPRESSION STALENESS');

  const stale = results.filter((r) => r.stale);
  const live = results.filter((r) => !r.stale);

  printCountSection(
    'Stale suppressions - upstream quirk is gone, remove these',
    'yellow',
    stale.map((r) => `${r.taskId}${r.objectiveId ? ` / ${r.objectiveId}` : ''}: ${r.message}`),
    icons.warning
  );
  printCountSection(
    'Suppressions still relevant',
    'green',
    live.map((r) => `${r.taskId}${r.objectiveId ? ` / ${r.objectiveId}` : ''}: ${r.message}`),
    icons.success
  );

  return { stale: stale.length };
}

/**
 * Fetch tasks once per game mode. The base pass and the mode loop both need
 * regular-mode data; without memoization the (large) regular-mode payloads
 * would be downloaded twice in a single run.
 */
function createTaskFetcher(): (mode?: GameMode) => Promise<TaskData[]> {
  const cache = new Map<GameMode, Promise<TaskData[]>>();
  return (mode: GameMode = 'regular') => {
    let tasks = cache.get(mode);
    if (!tasks) {
      tasks = fetchTasks(mode).catch((error) => {
        cache.delete(mode);
        throw error;
      });
      cache.set(mode, tasks);
    }
    return tasks;
  };
}

/**
 * Main validation function
 */
async function main(): Promise<void> {
  const strict = process.argv.includes('--strict');
  const failOnStale = process.argv.includes('--fail-on-stale');
  const getTasksForMode = createTaskFetcher();
  /** Problems that mean data is being served wrong or the overlay is inconsistent. */
  let actionable = 0;
  /** Overlay entries or fields now supplied upstream and safe to remove. */
  let staleProblems = 0;

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
    printSuccess(`Found ${additionsCount} task addition(s) and ${editionsCount} edition(s)\n`);

    printProgress('Fetching current data from tarkov.dev API...');
    const apiTasks = await getTasksForMode();
    printSuccess(`Fetched ${apiTasks.length} tasks from API\n`);

    printProgress('Validating overrides...\n');
    const results = validateAllOverrides(overrides, apiTasks);

    const baseTaskReport = printResults(results);
    staleProblems += baseTaskReport.obsoleteEntries + baseTaskReport.staleFields;

    // Collect every override group for the reference cross-check below.
    const crossCheckGroups: Array<{ label: string; overrides: Record<string, TaskOverride> }> = [
      { label: 'base', overrides },
    ];

    printProgress('Checking additions against API...\n');
    const staleSharedAdditionKeys = new Set<string>();
    const regularAdditionResults = checkTaskAdditions(additions, apiTasks);
    for (const result of regularAdditionResults) {
      if (result.status === 'RESOLVED') staleSharedAdditionKeys.add(result.key);
    }
    printAdditionResults(regularAdditionResults);

    // Per-mode API data and overrides, reused by the divergence and
    // cross-mode passes so nothing is fetched twice.
    const modeOverridesByMode: Partial<Record<GameMode, Record<string, TaskOverride>>> = {};
    const apiTasksByMode: Partial<Record<GameMode, TaskData[]>> = {};

    // Validate mode-specific overrides and additions
    for (const mode of SUPPORTED_GAME_MODES) {
      const modeOverrides = loadModeTaskOverrides(mode);
      const modeAdditions = loadModeTaskAdditions(mode);
      modeOverridesByMode[mode] = modeOverrides;

      printProgress(`Fetching ${mode} tasks from tarkov.dev API...`);
      const modeApiTasks = await getTasksForMode(mode);
      apiTasksByMode[mode] = modeApiTasks;
      printSuccess(`Fetched ${modeApiTasks.length} ${mode} tasks from API\n`);

      const modeOverrideCount = Object.keys(modeOverrides).length;
      const modeAdditionCount = Object.keys(modeAdditions).length;

      if (modeOverrideCount > 0) {
        crossCheckGroups.push({ label: mode, overrides: modeOverrides });

        printProgress(`Validating ${mode} mode overrides...\n`);
        const modeResults = validateAllOverrides(modeOverrides, modeApiTasks);
        const modeTaskReport = printResults(modeResults, {
          titlePrefix: mode.toUpperCase(),
          overridePath: `src/overrides/modes/${mode}/tasks.json5`,
        });
        staleProblems += modeTaskReport.obsoleteEntries + modeTaskReport.staleFields;
      }

      if (modeAdditionCount > 0) {
        printProgress(`Checking ${mode} mode additions against API...\n`);
        const modeAdditionResults = checkTaskAdditions(modeAdditions, modeApiTasks);
        staleProblems += printAdditionResults(modeAdditionResults, mode.toUpperCase()).resolved;
      }

      // Shared additions apply to every mode, so an entry appearing upstream in
      // any one mode is stale as a shared addition and must be mode-scoped or removed.
      if (mode !== 'regular') {
        const sharedAdditionResults = checkTaskAdditions(additions, modeApiTasks);
        for (const result of sharedAdditionResults) {
          if (result.status === 'RESOLVED') staleSharedAdditionKeys.add(result.key);
        }
        printAdditionResults(sharedAdditionResults, `SHARED ADDITIONS VS ${mode.toUpperCase()}`);
      }
    }
    staleProblems += staleSharedAdditionKeys.size;

    printRequirementTypeCounts(apiTasksByMode);

    // Base overrides apply to every mode, so validate them against every mode.
    const baseResultsByMode: Partial<Record<GameMode, ValidationResult[]>> = {};
    for (const mode of SUPPORTED_GAME_MODES) {
      const modeApiTasks = apiTasksByMode[mode];
      if (!modeApiTasks) continue;
      baseResultsByMode[mode] = validateAllOverrides(overrides, modeApiTasks);
    }
    printBaseCrossModeSummary(baseResultsByMode);

    printProgress('Checking edition exclusions against API...\n');
    const missingEditionRefs = checkEditionTaskReferences(editions, apiTasks);
    printEditionReferenceResults(missingEditionRefs);

    // Mode-divergence registry: the check that detects a mirror-direction flip.
    const divergences = loadDivergences();
    printDivergenceCoverage(divergences);
    const divergenceResults = validateDivergences(divergences, overrides, {
      regular: apiTasksByMode.regular
        ? {
            apiTasks: apiTasksByMode.regular,
            modeOverrides: modeOverridesByMode.regular ?? {},
          }
        : undefined,
      pve: apiTasksByMode.pve
        ? { apiTasks: apiTasksByMode.pve, modeOverrides: modeOverridesByMode.pve ?? {} }
        : undefined,
      'pvp-season': apiTasksByMode['pvp-season']
        ? {
            apiTasks: apiTasksByMode['pvp-season'],
            modeOverrides: modeOverridesByMode['pvp-season'] ?? {},
          }
        : undefined,
    });
    actionable += printDivergenceReport(divergenceResults).actionable;

    // Prestige only exists in upstream regular mode, so its overlay is scoped
    // to modes.regular rather than being applied to pve/pvp-season.
    const prestigeSpec: EntityCheckSpec = {
      label: 'regular prestige',
      segments: ['overrides', 'modes', 'regular', 'prestige.json5'],
      endpoint: 'tasks',
      collectionKey: 'prestige',
      config: {
        identityFields: ['prestigeLevel'],
        additiveFields: ['storyRequirements'],
        keyedFields: ['conditions'],
      },
    };

    // Entity types that previously had no validator at all. Memoize by
    // endpoint and collection so specs that share one endpoint but select
    // different collections cannot reuse an incompatible response.
    const entityCache = new Map<string, Promise<Map<string, Record<string, unknown>>>>();
    const getEntities = (mode: GameMode, spec: EntityCheckSpec) => {
      const key = `${mode}/${spec.endpoint}/${spec.collectionKey ?? ''}`;
      let pending = entityCache.get(key);
      if (!pending) {
        pending = fetchRawEntities(mode, spec.endpoint, spec.collectionKey);
        entityCache.set(key, pending);
      }
      return pending;
    };

    const prestigeOverrides = loadOptional(...prestigeSpec.segments);
    if (Object.keys(prestigeOverrides).length > 0) {
      printProgress('Fetching regular prestige data from tarkov.dev API...');
      const apiEntities = await getEntities('regular', prestigeSpec);
      printSuccess(`Fetched ${apiEntities.size} regular prestige record(s)\n`);
      const report = printEntityResults(
        prestigeSpec.label,
        'src/overrides/modes/regular/prestige.json5',
        validateEntityOverrides(prestigeOverrides, apiEntities, prestigeSpec.config)
      );
      actionable += report.errors;
      staleProblems += report.stale;
    }

    for (const spec of ENTITY_OVERRIDE_SPECS) {
      const entityOverrides = loadOptional(...spec.segments);
      const relPath = `src/${spec.segments.join('/')}`;
      if (Object.keys(entityOverrides).length === 0) {
        const report = printEntityResults(spec.label, relPath, []);
        actionable += report.errors;
        staleProblems += report.stale;
        continue;
      }
      for (const mode of SUPPORTED_GAME_MODES) {
        printProgress(`Fetching ${mode} ${spec.label} data from tarkov.dev API...`);
        const apiEntities = await getEntities(mode, spec);
        printSuccess(`Fetched ${apiEntities.size} ${mode} ${spec.label} record(s)\n`);
        const entityResults = validateEntityOverrides(entityOverrides, apiEntities, spec.config);
        const report = printEntityResults(`${mode} ${spec.label}`, relPath, entityResults);
        actionable += report.errors;
        staleProblems += report.stale;
      }
    }

    for (const spec of ENTITY_ADDITION_SPECS) {
      const entityAdditions = loadOptional(...spec.segments);
      const relPath = `src/${spec.segments.join('/')}`;
      if (Object.keys(entityAdditions).length === 0) {
        printEntityResults(spec.label, relPath, []);
        continue;
      }
      for (const mode of SUPPORTED_GAME_MODES) {
        printProgress(`Fetching ${mode} ${spec.label} data from tarkov.dev API...`);
        const apiEntities = await getEntities(mode, spec);
        printSuccess(`Fetched ${apiEntities.size} ${mode} record(s)\n`);
        const report = printEntityResults(
          `${mode} ${spec.label}`,
          relPath,
          validateEntityAdditions(entityAdditions, apiEntities)
        );
        actionable += report.errors;
        staleProblems += report.stale;
      }
    }

    // Story chapters: overlay-authored, so check references rather than values.
    const storyChapters = loadOptional('additions', 'storyChapters.json5');
    if (Object.keys(storyChapters).length > 0) {
      // Story quests are NOT in the tarkov.dev task list, so their IDs can only
      // be resolved against the local EFT reference. Without it, only internal
      // consistency is checkable.
      const referenceQuestIds = loadReferenceQuestIds();
      let knownQuestIds: Set<string> | undefined;

      if (referenceQuestIds) {
        knownQuestIds = new Set(referenceQuestIds);
        for (const mode of SUPPORTED_GAME_MODES) {
          for (const task of apiTasksByMode[mode] ?? []) knownQuestIds.add(task.id);
        }
        for (const [key, addition] of Object.entries(additions)) {
          knownQuestIds.add(key);
          const id = (addition as { id?: unknown }).id;
          if (typeof id === 'string') knownQuestIds.add(id);
        }
        for (const mode of SUPPORTED_GAME_MODES) {
          for (const [key, addition] of Object.entries(loadModeTaskAdditions(mode))) {
            knownQuestIds.add(key);
            const id = (addition as { id?: unknown }).id;
            if (typeof id === 'string') knownQuestIds.add(id);
          }
        }
      }

      actionable += printStoryChapterIssues(
        checkStoryChapterIntegrity(storyChapters, knownQuestIds),
        knownQuestIds !== undefined
      ).errors;
    }

    // Suppressions hide real upstream quirks; a dead one hides future problems.
    const suppressions = loadOptional('suppressions', 'tasks.json5');
    if (Object.keys(suppressions).length > 0) {
      // A suppression may target a mode-exclusive task (e.g. a PvE-only quest),
      // so resolve IDs against every mode rather than regular alone - otherwise
      // a live suppression would be reported as stale.
      const allModeTasks = new Map<string, TaskData>();
      for (const task of apiTasks) allModeTasks.set(task.id, task);
      for (const mode of SUPPORTED_GAME_MODES) {
        for (const task of apiTasksByMode[mode] ?? []) allModeTasks.set(task.id, task);
      }
      // A stale suppression is a dead overlay entry (overlay inconsistency), so
      // it counts toward the --strict gate alongside the other checks.
      actionable += printSuppressionResults(
        checkTaskSuppressionStaleness(suppressions, [...allModeTasks.values()])
      ).stale;
    }

    printReferenceCrossCheck(crossCheckGroups);

    printProgress('Checking locale overrides against tarkov.dev bundles...\n');
    staleProblems += await checkLocaleOverrides();

    if (strict && actionable > 0) {
      printError(
        `\n${actionable} actionable problem(s) found (--strict) : ${icons.error}. ` +
          'Data is being served incorrectly or the overlay is inconsistent.'
      );
      process.exit(2);
    }

    if (failOnStale && staleProblems > 0) {
      printError(
        `\n${staleProblems} stale overlay field/entry problem(s) found (--fail-on-stale) : ${icons.error}. ` +
          'Remove data now supplied upstream or scope it to the modes where it is still missing.'
      );
      process.exit(3);
    }

    process.exit(0);
  } catch (error) {
    printError('Error during validation:', error as Error);
    process.exit(1);
  }
}

if (isDirectExecution(import.meta.url)) {
  main();
}
