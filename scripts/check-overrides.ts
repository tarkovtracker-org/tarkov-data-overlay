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
const loadDivergences = () =>
  loadOptional<TaskDivergence>('divergences', 'tasks.json5');

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
    label: 'prestige',
    segments: ['overrides', 'prestige.json5'],
    endpoint: 'tasks',
    collectionKey: 'prestige',
    config: {
      // prestigeLevel identifies which prestige tier the entry patches.
      identityFields: ['prestigeLevel'],
      // tarkov.dev does not expose in-game story-chapter requirements at all.
      additiveFields: ['storyRequirements'],
      // conditions are keyed by condition ID; overlay_* keys are synthetic.
      keyedFields: ['conditions'],
    },
  },
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
    collectionKey: 'hideoutStations',
  },
];

const ENTITY_ADDITION_SPECS: EntityCheckSpec[] = [
  {
    label: 'itemsAdd',
    segments: ['additions', 'itemsAdd.json5'],
    endpoint: 'items',
    collectionKey: 'items',
  },
];

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
  const line = (r: ValidationResult) => `${r.name} (${r.id})`;

  printCountSection(`${icons.success} Still need overrides`, 'green', stillNeeded.map(line));
  printCountSection(`${icons.sync} Fixed in API, can remove`, 'yellow', fixed.map(line));
  printCountSection(
    `${icons.trash} Removed from API, delete from overlay`,
    'red',
    removedFromApi.map(line)
  );

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

  const byStatus = (status: AdditionStatus) =>
    results.filter((r) => r.status === status).map((r) => `${r.name} (${r.key})`);

  printHeader(summaryTitle);

  printCountSection(
    `${icons.success} Resolved in API (remove from tasksAdd)`,
    'green',
    byStatus('RESOLVED')
  );
  printCountSection(`${icons.warning} Still missing from API`, 'yellow', byStatus('MISSING'));
  printCountSection(
    `${icons.sync} Needs review (name-only matches)`,
    'yellow',
    byStatus('CHECK')
  );
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
    console.log(formatCountLabel(`${meta.icon} ${meta.label}`, subset.length, meta.color));
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

  const obsolete = results.filter(
    (r) => r.verdict === 'STALE' || r.verdict === 'REMOVED'
  ).length;
  if (obsolete > 0) {
    console.log(`${icons.lightbulb} ${bold('RECOMMENDATION:')}`);
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
async function checkLocaleOverrides(): Promise<void> {
  const localesDir = join(srcDir, 'overrides', 'locales');
  const localeOverrides = loadAllJson5FromDir(localesDir);
  const locales = Object.keys(localeOverrides).sort();
  if (locales.length === 0) return;

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
  }
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
 * Report base-override verdicts across every game mode.
 *
 * Base overrides are mode-agnostic: `docs/INTEGRATION.md` applies them to both
 * modes before mode-specific ones. Validating them against regular alone can
 * therefore hide two failure shapes - an override that is stale in regular but
 * load-bearing in PvE, and one that is quietly wrong in the mode we never
 * checked. Only overrides stale in EVERY mode are safe to retire.
 */
function printBaseCrossModeSummary(
  resultsByMode: Partial<Record<GameMode, ValidationResult[]>>
): { staleEverywhere: string[]; verdictDiffers: string[] } {
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
    const comparable = present.filter(
      (mode) => perMode[mode]!.status !== 'REMOVED_FROM_API'
    );
    if (comparable.length === 0) continue;

    const name = perMode[comparable[0]]!.name;
    const needed = comparable.filter((mode) => perMode[mode]!.stillNeeded);

    if (needed.length === 0) {
      staleEverywhere.push(
        `${name} (${taskId}) - redundant in ${comparable.join(' + ')}`
      );
    } else if (needed.length < comparable.length) {
      const idle = comparable.filter((mode) => !perMode[mode]!.stillNeeded);
      verdictDiffers.push(
        `${name} (${taskId}) - needed in ${needed.join(' + ')}, redundant in ${idle.join(' + ')}`
      );
    }
  }

  printCountSection(
    `${icons.warning} Base overrides redundant in EVERY mode (safe to retire)`,
    'yellow',
    staleEverywhere
  );
  printCountSection(
    `${icons.info} Base overrides whose verdict DIFFERS by mode (keep; consider moving to a mode file)`,
    'cyan',
    verdictDiffers
  );

  return { staleEverywhere, verdictDiffers };
}

/**
 * Report the mode-divergence registry against both modes.
 *
 * This is the check that catches a mirror-direction flip. `OVERRIDE_MISSING`
 * means consumers of that mode are being served a value we know is wrong.
 * `OVERRIDE_REDUNDANT` entries are deliberate guards and are reported for
 * visibility only - retiring them is what let the last regression through.
 */
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
      r.override === undefined
        ? ''
        : `, override ${formatDivergenceValue(r.override)}`
    }${r.confidence === 'high' ? '' : ` [${r.confidence} confidence]`}`;

  printCountSection(
    `${icons.error} Wrong data being served - no override corrects upstream (ADD an override)`,
    'red',
    grouped.missing.map((r) => `${describe(r)}\n      proof: ${r.proof}`)
  );
  printCountSection(
    `${icons.error} Override present but disagrees with the recorded truth (FIX the override)`,
    'red',
    grouped.wrong.map((r) => `${describe(r)}\n      proof: ${r.proof}`)
  );

  // Mirroring is the upstream root cause: identical values in both modes for a
  // field we know differs. Surface it so it can be reported upstream.
  const mirroredFields = new Map<string, DivergenceResult>();
  for (const r of grouped.mirrored) mirroredFields.set(`${r.taskId}:${r.field}`, r);
  printCountSection(
    `${icons.warning} Upstream is MIRRORING one mode into the other (report to tarkov.dev)`,
    'yellow',
    Array.from(mirroredFields.values()).map(
      (r) =>
        `${r.taskName} (${r.taskId}) ${r.field}: tarkov.dev serves the same value in both modes`
    )
  );

  printCountSection(
    `${icons.success} Overrides doing necessary work`,
    'green',
    grouped.active.map(describe)
  );
  printCountSection(
    `${icons.info} Redundant guards - upstream currently correct, KEEP for flip protection`,
    'cyan',
    grouped.redundant.map(describe)
  );
  printCountSection(
    `${icons.success} Upstream already correct, no override needed`,
    'green',
    grouped.upstreamCorrect.map(
      (r) => `${r.taskName} (${r.taskId}) ${r.mode}.${r.field} = ${formatDivergenceValue(r.upstream)}`
    )
  );

  if (grouped.notInMode.length > 0) {
    printCountSection(
      `${icons.info} Registered field not applicable (task absent from that mode)`,
      'cyan',
      grouped.notInMode.map((r) => `${r.taskName} (${r.taskId}) ${r.mode}.${r.field}`)
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
): { errors: number } {
  printHeader(`${label.toUpperCase()} OVERLAY CHECK`);
  console.log(dim(`  (${filePath})`));
  console.log();

  if (results.length === 0) {
    console.log(dim('  Nothing to verify (file empty or comment-only).'));
    console.log();
    return { errors: 0 };
  }

  const grouped = categorizeEntityResults(results);
  const lines = (list: EntityValidationResult[]) =>
    list.flatMap((r) => [r.id, ...r.details.map((d) => `   ${d.message}`)]);

  printCountSection(
    `${icons.error} Entries whose ID is missing upstream (verify the ID)`,
    'red',
    grouped.removedFromApi.map((r) => r.id)
  );
  printCountSection(
    `${icons.warning} Still needed`,
    'yellow',
    lines(grouped.stillNeeded)
  );
  printCountSection(
    `${icons.success} Fixed upstream - safe to retire`,
    'green',
    lines(grouped.fixed)
  );

  const identityErrors = results.flatMap((r) =>
    r.details.filter((d) => d.status === 'error').map((d) => `${r.id}: ${d.message}`)
  );
  if (identityErrors.length > 0) {
    printCountSection(
      `${icons.error} Identity/consistency problems`,
      'red',
      identityErrors
    );
  }

  return { errors: grouped.removedFromApi.length + identityErrors.length };
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
      dim(
        '  (no eft/ reference available: quest-ID resolution skipped, internal consistency only)'
      )
    );
  }
  console.log();

  printCountSection(
    `${icons.error} Referential integrity problems`,
    'red',
    issues.map((i) => `${i.chapterId} [${i.kind}]: ${i.message}`)
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
        const bare = rawId.replace(/[^0-9a-f]/gi, '');
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
    `${icons.warning} Stale suppressions - upstream quirk is gone, remove these`,
    'yellow',
    stale.map((r) =>
      `${r.taskId}${r.objectiveId ? ` / ${r.objectiveId}` : ''}: ${r.message}`
    )
  );
  printCountSection(
    `${icons.success} Suppressions still relevant`,
    'green',
    live.map((r) =>
      `${r.taskId}${r.objectiveId ? ` / ${r.objectiveId}` : ''}: ${r.message}`
    )
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
  const getTasksForMode = createTaskFetcher();
  /** Problems that mean data is being served wrong or the overlay is inconsistent. */
  let actionable = 0;

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
    const apiTasks = await getTasksForMode();
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
    });
    actionable += printDivergenceReport(divergenceResults).actionable;

    // Entity types that previously had no validator at all.
    for (const spec of ENTITY_OVERRIDE_SPECS) {
      const entityOverrides = loadOptional(...spec.segments);
      const relPath = `src/${spec.segments.join('/')}`;
      if (Object.keys(entityOverrides).length === 0) {
        actionable += printEntityResults(spec.label, relPath, []).errors;
        continue;
      }
      printProgress(`Fetching ${spec.label} data from tarkov.dev API...`);
      const apiEntities = await fetchRawEntities('regular', spec.endpoint, spec.collectionKey);
      printSuccess(`Fetched ${apiEntities.size} ${spec.label} record(s)\n`);
      const entityResults = validateEntityOverrides(entityOverrides, apiEntities, spec.config);
      actionable += printEntityResults(spec.label, relPath, entityResults).errors;
    }

    for (const spec of ENTITY_ADDITION_SPECS) {
      const entityAdditions = loadOptional(...spec.segments);
      const relPath = `src/${spec.segments.join('/')}`;
      if (Object.keys(entityAdditions).length === 0) {
        printEntityResults(spec.label, relPath, []);
        continue;
      }
      printProgress(`Fetching ${spec.label} data from tarkov.dev API...`);
      const apiEntities = await fetchRawEntities('regular', spec.endpoint, spec.collectionKey);
      printSuccess(`Fetched ${apiEntities.size} record(s)\n`);
      printEntityResults(spec.label, relPath, validateEntityAdditions(entityAdditions, apiEntities));
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
      printSuppressionResults(checkTaskSuppressionStaleness(suppressions, apiTasks));
    }

    printReferenceCrossCheck(crossCheckGroups);

    printProgress('Checking locale overrides against tarkov.dev bundles...\n');
    await checkLocaleOverrides();

    if (strict && actionable > 0) {
      printError(
        `\n${icons.error} ${actionable} actionable problem(s) found (--strict). ` +
          'Data is being served incorrectly or the overlay is inconsistent.'
      );
      process.exit(2);
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
