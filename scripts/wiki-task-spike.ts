#!/usr/bin/env tsx
/**
 * Spike: compare a single task between tarkov.dev and the wiki.
 *
 * Goal: validate wiki extraction feasibility for tasks.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import JSON5 from 'json5';

import {
  findTaskById,
  printHeader,
  printProgress,
  printSuccess,
  printError,
  bold,
  dim,
  icons,
} from '../src/lib/index.js';

import type { TaskData, TaskRequirement } from '../src/lib/types.js';

/** Extended task data with rewards for comparison */
type ExtendedTaskData = TaskData & {
  experience?: number;
  finishRewards?: {
    traderStanding?: Array<{ trader: { name: string }; standing: number }>;
    items?: Array<{ item: { name: string }; count: number }>;
  };
  gameModes?: ('regular' | 'pve')[];
};

type ApiObjective = NonNullable<TaskData['objectives']>[number];

type WikiObjective = {
  text: string;
  count?: number;
  pveCount?: number; // PvE-specific count when wiki shows different values
  maps?: string[];
  items?: string[];
  links?: string[];
};

type WikiLink = {
  target: string;
  display?: string;
};

type TraderReputation = {
  trader: string;
  value: number;
};

type WikiRewards = {
  xp?: number;
  reputations: TraderReputation[];
  money?: number;
  items: Array<{ name: string; count: number }>;
  raw: string[];
};

type WikiRelatedItem = {
  name: string;
  requirement?: string;
};

type WikiTaskData = {
  pageTitle: string;
  requirements: string[];
  objectives: WikiObjective[];
  rewards: WikiRewards;
  minPlayerLevel?: number;
  previousTasks: string[];
  nextTasks: string[];
  maps: string[];
  relatedItems: WikiRelatedItem[];
  relatedRequiredItems: string[];
  relatedHandoverItems: string[];
  lastRevision?: {
    timestamp: string;
    user: string;
    comment: string;
  };
};

type GroupBy = 'priority' | 'category';

type CliOptions = {
  id?: string;
  name?: string;
  wiki?: string;
  all?: boolean;
  useCache?: boolean;
  refresh?: boolean;
  output?: string;
  gameMode?: 'regular' | 'pve' | 'both';
  groupBy?: GroupBy;
};

type Priority = 'high' | 'medium' | 'low';

type Discrepancy = {
  taskId: string;
  taskName: string;
  field: string;
  apiValue: string | number | undefined;
  wikiValue: string | number | undefined;
  priority: Priority;
  trustsWiki: boolean;
  wikiLastEdit?: string;
  wikiEditDaysAgo?: number;
  wikiEditedPost1_0?: boolean;
};

/**
 * Get priority for a discrepancy based on field type
 * - Level/Task requirements: High (blocks progression)
 * - Reputation: Medium-High (affects loyalty levels)
 * - Objectives: Medium
 * - XP/Money: Low (not strictly required for tracking)
 */
function getPriority(field: string): Priority {
  // Handle trader-specific reputation fields like "reputation.Prapor"
  if (field.startsWith('reputation.')) {
    return 'medium';
  }

  switch (field) {
    case 'minPlayerLevel':
    case 'taskRequirements':
    case 'nextTasks':
    case 'objectives.description':
      return 'high';
    case 'reputation':
    case 'objectives.count':
    case 'objectives.maps':
    case 'objectives.items':
    case 'map':
      return 'medium';
    case 'experience':
    case 'money':
    default:
      return 'low';
  }
}

const DEFAULT_TASK_NAME = 'Grenadier';
const WIKI_API = 'https://escapefromtarkov.fandom.com/api.php';
const TARKOV_API = 'https://api.tarkov.dev/graphql';
const RATE_LIMIT_MS = 500;

// Tarkov 1.0 launch date - wiki edits after this are more trustworthy
const TARKOV_1_0_LAUNCH = new Date('2025-11-15T00:00:00Z');

// Cache directories
const CACHE_DIR = path.join(process.cwd(), 'data', 'cache');
const WIKI_CACHE_DIR = path.join(CACHE_DIR, 'wiki');
const RESULTS_DIR = path.join(process.cwd(), 'data', 'results');
const API_CACHE_FILE = path.join(CACHE_DIR, 'tarkov-api-tasks.json');
const SAFE_CACHE_FILE_STEM = /^[A-Za-z0-9_-]{1,128}$/;

// Overlay file for filtering already-addressed discrepancies
const TASKS_OVERLAY_FILE = path.join(
  process.cwd(),
  'src',
  'overrides',
  'tasks.json5'
);

const TASKS_SUPPRESSIONS_FILE = path.join(
  process.cwd(),
  'src',
  'suppressions',
  'tasks.json5'
);

// Suppressions file for discrepancies where wiki is wrong and API is correct
const WIKI_INCORRECT_FILE = path.join(
  process.cwd(),
  'src',
  'suppressions',
  'wiki-incorrect.json5'
);

const EXTENDED_TASKS_QUERY = `
  query($gameMode: GameMode) {
    tasks(lang: en, gameMode: $gameMode) {
      id
      name
      minPlayerLevel
      wikiLink
      map { id name }
      experience
      taskRequirements {
        task { id name }
        status
      }
      objectives {
        id
        type
        description
        maps { id name }
        ... on TaskObjectiveBasic {
          requiredKeys { id name shortName }
        }
        ... on TaskObjectiveMark {
          markerItem { id name shortName }
          requiredKeys { id name shortName }
        }
        ... on TaskObjectiveExtract {
          requiredKeys { id name shortName }
        }
        ... on TaskObjectiveShoot {
          count
          usingWeapon { id name shortName }
          usingWeaponMods { id name shortName }
          wearing { id name shortName }
          notWearing { id name shortName }
          requiredKeys { id name shortName }
        }
        ... on TaskObjectiveItem {
          count
          items { id name shortName }
          foundInRaid
          requiredKeys { id name shortName }
        }
        ... on TaskObjectiveQuestItem {
          count
          questItem { id name shortName }
          requiredKeys { id name shortName }
        }
        ... on TaskObjectiveUseItem {
          count
          useAny { id name shortName }
          requiredKeys { id name shortName }
        }
        ... on TaskObjectiveBuildItem {
          item { id name shortName }
          containsAll { id name shortName }
        }
      }
      finishRewards {
        traderStanding { trader { name } standing }
        items { item { name } count }
      }
    }
  }
`;

type GameMode = 'regular' | 'pve';

async function fetchTasksForMode(mode: GameMode): Promise<ExtendedTaskData[]> {
  const response = await fetch(TARKOV_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: EXTENDED_TASKS_QUERY,
      variables: { gameMode: mode },
    }),
  });

  if (!response.ok) {
    throw new Error(`API request failed: ${response.status}`);
  }

  const result = (await response.json()) as {
    data?: { tasks: ExtendedTaskData[] };
    errors?: Array<{ message: string }>;
  };

  if (result.errors) {
    throw new Error(
      `GraphQL errors: ${result.errors.map((e) => e.message).join(', ')}`
    );
  }

  const tasks = result.data?.tasks ?? [];
  // Tag each task with its game mode
  return tasks.map((t) => ({ ...t, gameModes: [mode] }));
}

/**
 * Fetch tasks from one or both game modes.
 * In `both` mode, retain mode-specific task entries so PvE-specific data is not lost.
 */
async function fetchExtendedTasks(
  gameMode: 'regular' | 'pve' | 'both' = 'both'
): Promise<ExtendedTaskData[]> {
  if (gameMode !== 'both') {
    return fetchTasksForMode(gameMode);
  }

  // Fetch both modes and retain separate entries per wikiLink + mode.
  const [regularTasks, pveTasks] = await Promise.all([
    fetchTasksForMode('regular'),
    fetchTasksForMode('pve'),
  ]);

  const byWikiLinkAndMode = new Map<string, ExtendedTaskData>();
  for (const task of [...regularTasks, ...pveTasks]) {
    const mode = task.gameModes?.[0] ?? 'regular';
    const key = `${task.wikiLink || `id:${task.id}`}|${mode}`;
    byWikiLinkAndMode.set(key, task);
  }

  return Array.from(byWikiLinkAndMode.values());
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function assertSafeCacheFileStem(value: string): string {
  if (!SAFE_CACHE_FILE_STEM.test(value)) {
    throw new Error(`Unsafe cache file name: ${value}`);
  }
  return value;
}

function getTimestamp(): string {
  const now = new Date();
  return now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

function resolveOutputFilePath(output?: string): string | undefined {
  if (output === undefined) return undefined;
  const trimmed = output.trim();
  if (trimmed.length === 0) {
    return path.join(RESULTS_DIR, `comparison-${getTimestamp()}.json`);
  }
  return trimmed;
}

type CacheMetadata = {
  fetchedAt: string;
  taskCount: number;
  gameMode: 'regular' | 'pve' | 'both';
};

type ApiCache = {
  meta: CacheMetadata;
  tasks: ExtendedTaskData[];
};

function loadApiCache(): ApiCache | null {
  if (!fs.existsSync(API_CACHE_FILE)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(API_CACHE_FILE, 'utf-8'));
    return data as ApiCache;
  } catch {
    return null;
  }
}

function saveApiCache(
  tasks: ExtendedTaskData[],
  gameMode: 'regular' | 'pve' | 'both'
): void {
  ensureDir(CACHE_DIR);
  const cache: ApiCache = {
    meta: {
      fetchedAt: new Date().toISOString(),
      taskCount: tasks.length,
      gameMode,
    },
    tasks,
  };
  // codeql[js/http-to-file-access]: The API response is intentionally cached as JSON to a fixed file under data/cache.
  fs.writeFileSync(API_CACHE_FILE, JSON.stringify(cache, null, 2));
}

type WikiCache = {
  fetchedAt: string;
  title: string;
  wikitext: string;
  lastRevision?: {
    timestamp: string;
    user: string;
    comment: string;
  };
};

function getWikiCachePath(taskId: string): string {
  return path.join(WIKI_CACHE_DIR, `${assertSafeCacheFileStem(taskId)}.json`);
}

function loadWikiCache(taskId: string): WikiCache | null {
  const cachePath = getWikiCachePath(taskId);
  if (!fs.existsSync(cachePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as WikiCache;
  } catch {
    return null;
  }
}

function saveWikiCache(
  taskId: string,
  title: string,
  wikitext: string,
  lastRevision?: WikiCache['lastRevision']
): void {
  ensureDir(WIKI_CACHE_DIR);
  const cache: WikiCache = {
    fetchedAt: new Date().toISOString(),
    title,
    wikitext,
    lastRevision,
  };
  // codeql[js/http-to-file-access]: Wiki pages are cached as JSON under data/cache/wiki with a validated task-id filename.
  fs.writeFileSync(getWikiCachePath(taskId), JSON.stringify(cache, null, 2));
}

type SuppressedFieldsResult = {
  suppressed: Set<string>;
  overlayCount: number;
  wikiIncorrectCount: number;
  wikiIncorrectKeys: Set<string>; // Track wiki-incorrect separately to check for stale entries
};

type TaskSuppressionEntry = {
  objectives?: Record<string, true | { fields?: Record<string, boolean> }>;
  [field: string]: unknown;
};

function loadTaskSuppressions(): Map<string, TaskSuppressionEntry> {
  const suppressions = new Map<string, TaskSuppressionEntry>();

  if (!fs.existsSync(TASKS_SUPPRESSIONS_FILE)) return suppressions;

  try {
    const content = fs.readFileSync(TASKS_SUPPRESSIONS_FILE, 'utf-8');
    const parsed = JSON5.parse(content) as Record<string, TaskSuppressionEntry>;

    for (const [taskId, entry] of Object.entries(parsed)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      suppressions.set(taskId, entry);
    }
  } catch (error) {
    console.warn('Warning: Could not load task suppressions file:', error);
  }

  return suppressions;
}

function isTaskFieldSuppressed(
  taskSuppressions: Map<string, TaskSuppressionEntry>,
  taskId: string,
  field: string
): boolean {
  const entry = taskSuppressions.get(taskId);
  if (!entry) return false;
  return entry[field] === true;
}

function isObjectiveSuppressed(
  taskSuppressions: Map<string, TaskSuppressionEntry>,
  taskId: string,
  objectiveId: string
): boolean {
  const entry = taskSuppressions.get(taskId);
  if (!entry?.objectives) return false;
  return entry.objectives[objectiveId] === true;
}

/**
 * Load suppressed fields from both:
 * 1. Tasks overlay (API was wrong, we corrected it)
 * 2. Wiki-incorrect suppressions (API is correct, wiki is wrong)
 *
 * Returns a Set of "taskId:field" keys to exclude from results
 */
function loadSuppressedFields(): SuppressedFieldsResult {
  const suppressed = new Set<string>();
  const wikiIncorrectKeys = new Set<string>();
  let overlayCount = 0;
  let wikiIncorrectCount = 0;

  // Load overlay file (corrections where API was wrong)
  if (fs.existsSync(TASKS_OVERLAY_FILE)) {
    try {
      const content = fs.readFileSync(TASKS_OVERLAY_FILE, 'utf-8');
      const overlay = JSON5.parse(content) as Record<
        string,
        Record<string, unknown>
      >;

      for (const [taskId, fields] of Object.entries(overlay)) {
        for (const field of Object.keys(fields)) {
          const beforeSize = suppressed.size;

          // Map overlay field names to discrepancy field names
          if (field === 'objectives') {
            const objectiveOverrides = (fields as Record<string, unknown>)[
              field
            ];
            if (objectiveOverrides && typeof objectiveOverrides === 'object') {
              for (const objOverride of Object.values(
                objectiveOverrides as Record<string, unknown>
              )) {
                if (!objOverride || typeof objOverride !== 'object') continue;
                if ('count' in (objOverride as Record<string, unknown>)) {
                  suppressed.add(`${taskId}:objectives.count`);
                }
                if ('description' in (objOverride as Record<string, unknown>)) {
                  suppressed.add(`${taskId}:objectives.description`);
                }
                if ('maps' in (objOverride as Record<string, unknown>)) {
                  suppressed.add(`${taskId}:objectives.maps`);
                }
                const itemOverrideKeys = [
                  'items',
                  'usingWeapon',
                  'usingWeaponMods',
                  'useAny',
                  'containsAll',
                  'markerItem',
                  'questItem',
                  'item',
                  'requiredKeys',
                ];
                if (
                  itemOverrideKeys.some(
                    (key) => key in (objOverride as Record<string, unknown>)
                  )
                ) {
                  suppressed.add(`${taskId}:objectives.items`);
                }
              }
            } else {
              suppressed.add(`${taskId}:objectives.count`);
            }
          } else if (
            field === 'experience' ||
            field === 'minPlayerLevel' ||
            field === 'taskRequirements' ||
            field === 'reputation' ||
            field === 'money' ||
            field === 'finishRewards' ||
            field === 'map'
          ) {
            suppressed.add(`${taskId}:${field}`);

            if (
              field === 'finishRewards' &&
              fields &&
              typeof fields === 'object'
            ) {
              const finishRewards = (fields as Record<string, unknown>)[field];
              if (finishRewards && typeof finishRewards === 'object') {
                const rewards = finishRewards as Record<string, unknown>;
                const items = Array.isArray(rewards.items) ? rewards.items : [];
                const hasRoubles = items.some((item) => {
                  if (!item || typeof item !== 'object') return false;
                  const rewardItem = item as Record<string, unknown>;
                  const itemInfo = rewardItem.item as
                    | Record<string, unknown>
                    | undefined;
                  const itemName =
                    typeof itemInfo?.name === 'string' ? itemInfo.name : '';
                  const itemId =
                    typeof itemInfo?.id === 'string' ? itemInfo.id : '';
                  return (
                    itemName === 'Roubles' ||
                    itemId === '5449016a4bdc2d6f028b456f'
                  );
                });
                if (hasRoubles) {
                  suppressed.add(`${taskId}:money`);
                }

                const traderStanding = Array.isArray(rewards.traderStanding)
                  ? rewards.traderStanding
                  : [];
                for (const entry of traderStanding) {
                  if (!entry || typeof entry !== 'object') continue;
                  const traderEntry = entry as Record<string, unknown>;
                  const trader = traderEntry.trader as
                    | Record<string, unknown>
                    | undefined;
                  const traderName =
                    typeof trader?.name === 'string' ? trader.name : '';
                  if (traderName) {
                    suppressed.add(`${taskId}:reputation.${traderName}`);
                  }
                }
              }
            }
          }

          // Also add the raw field name for flexibility
          suppressed.add(`${taskId}:${field}`);

          overlayCount += suppressed.size - beforeSize;
        }
      }
    } catch (error) {
      console.warn('Warning: Could not load overlay file:', error);
    }
  }

  // Load wiki-incorrect suppressions (where API is correct, wiki is wrong)
  if (fs.existsSync(WIKI_INCORRECT_FILE)) {
    try {
      const content = fs.readFileSync(WIKI_INCORRECT_FILE, 'utf-8');
      const suppressions = JSON5.parse(content) as Record<string, string[]>;

      for (const [taskId, fields] of Object.entries(suppressions)) {
        for (const field of fields) {
          const key = `${taskId}:${field}`;
          suppressed.add(key);
          wikiIncorrectKeys.add(key);
          wikiIncorrectCount++;
        }
      }
    } catch (error) {
      console.warn('Warning: Could not load wiki-incorrect file:', error);
    }
  }

  return { suppressed, overlayCount, wikiIncorrectCount, wikiIncorrectKeys };
}

function loadTaskRequirementOverrides(): Map<string, TaskRequirement[]> {
  const overrides = new Map<string, TaskRequirement[]>();

  if (!fs.existsSync(TASKS_OVERLAY_FILE)) return overrides;

  try {
    const content = fs.readFileSync(TASKS_OVERLAY_FILE, 'utf-8');
    const overlay = JSON5.parse(content) as Record<
      string,
      Record<string, unknown>
    >;

    for (const [taskId, fields] of Object.entries(overlay)) {
      if (!fields || typeof fields !== 'object') continue;
      const reqs = (fields as Record<string, unknown>).taskRequirements;
      if (Array.isArray(reqs)) {
        overrides.set(taskId, reqs as TaskRequirement[]);
      }
    }
  } catch (error) {
    console.warn('Warning: Could not load task requirement overrides:', error);
  }

  return overrides;
}

function buildNextTaskMap(
  tasks: ExtendedTaskData[],
  requirementOverrides?: Map<string, TaskRequirement[]>
): Map<string, string[]> {
  const nextMap = new Map<string, Set<string>>();

  for (const task of tasks) {
    const requirements =
      requirementOverrides?.get(task.id) ?? task.taskRequirements ?? [];
    for (const req of requirements) {
      const reqTaskId = req?.task?.id;
      if (!reqTaskId) continue;
      const set = nextMap.get(reqTaskId) ?? new Set<string>();
      set.add(task.name);
      nextMap.set(reqTaskId, set);
    }
  }

  const result = new Map<string, string[]>();
  for (const [taskId, names] of nextMap.entries()) {
    result.set(taskId, Array.from(names));
  }
  return result;
}

function parseArgs(argv: string[]): CliOptions & { help?: boolean } {
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

function printUsage(): void {
  console.log('Usage:');
  console.log('  tsx scripts/wiki-task-spike.ts [options] [taskName]');
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
  console.log('  tsx scripts/wiki-task-spike.ts Grenadier');
  console.log('  tsx scripts/wiki-task-spike.ts --all --cache');
  console.log(
    '  tsx scripts/wiki-task-spike.ts --all --cache --group-by=priority'
  );
  console.log('  tsx scripts/wiki-task-spike.ts --all --refresh --output');
  console.log(
    '  tsx scripts/wiki-task-spike.ts --all --output data/results/pve-comparison.json'
  );
  console.log('  tsx scripts/wiki-task-spike.ts --all --gameMode=pve --cache');
  console.log();
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Normalize task name for comparison by removing common suffixes and variations
 */
function normalizeTaskName(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      // Remove [PVP ZONE] suffix
      .replace(/\s*\[pvp zone\]\s*$/i, '')
      // Remove (quest) disambiguation suffix
      .replace(/\s*\(quest\)\s*$/i, '')
      // Normalize hyphens to spaces for comparison
      .replace(/-/g, ' ')
      // Collapse multiple spaces
      .replace(/\s+/g, ' ')
      .trim()
  );
}

function resolveTask(
  tasks: TaskData[],
  options: CliOptions
): TaskData | undefined {
  if (options.id) {
    return findTaskById(tasks, options.id);
  }

  const name = options.name ?? DEFAULT_TASK_NAME;
  const normalized = normalizeName(name);
  return tasks.find((task) => normalizeName(task.name) === normalized);
}

function resolveWikiTitle(task: TaskData, wikiOverride?: string): string {
  if (wikiOverride && wikiOverride.trim().length > 0) {
    return wikiOverride.trim();
  }

  if (task.wikiLink) {
    const match = task.wikiLink.match(/\/wiki\/(.+)$/);
    if (match && match[1]) {
      return decodeURIComponent(match[1]);
    }
  }

  return task.name;
}

type WikiFetchResult = {
  title: string;
  wikitext: string;
  lastRevision?: {
    timestamp: string;
    user: string;
    comment: string;
  };
};

async function fetchWikiWikitext(pageTitle: string): Promise<WikiFetchResult> {
  // Fetch wikitext
  const parseParams = new URLSearchParams({
    action: 'parse',
    page: pageTitle,
    prop: 'wikitext',
    format: 'json',
  });

  const parseResponse = await fetch(`${WIKI_API}?${parseParams.toString()}`);
  if (!parseResponse.ok) {
    throw new Error(
      `Wiki request failed: ${parseResponse.status} ${parseResponse.statusText}`
    );
  }

  const parseData = (await parseResponse.json()) as {
    parse?: {
      title?: string;
      wikitext?: { '*': string };
    };
    error?: { info?: string };
  };

  if (parseData.error?.info) {
    throw new Error(`Wiki error: ${parseData.error.info}`);
  }

  const wikitext = parseData.parse?.wikitext?.['*'];
  if (!wikitext) {
    throw new Error('Wiki response missing wikitext');
  }

  const title = parseData.parse?.title ?? pageTitle;

  // Fetch last revision info
  const revParams = new URLSearchParams({
    action: 'query',
    titles: title,
    prop: 'revisions',
    rvprop: 'timestamp|user|comment',
    rvlimit: '1',
    format: 'json',
  });

  let lastRevision: WikiFetchResult['lastRevision'];
  try {
    const revResponse = await fetch(`${WIKI_API}?${revParams.toString()}`);
    if (revResponse.ok) {
      const revData = (await revResponse.json()) as {
        query?: {
          pages?: Record<
            string,
            {
              revisions?: Array<{
                timestamp?: string;
                user?: string;
                comment?: string;
              }>;
            }
          >;
        };
      };

      const pages = revData.query?.pages;
      if (pages) {
        const page = Object.values(pages)[0];
        const rev = page?.revisions?.[0];
        if (rev?.timestamp) {
          lastRevision = {
            timestamp: rev.timestamp,
            user: rev.user ?? 'unknown',
            comment: rev.comment ?? '',
          };
        }
      }
    }
  } catch {
    // Revision fetch failed, continue without it
  }

  return { title, wikitext, lastRevision };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractSectionLines(wikitext: string, heading: string): string[] {
  const lines = wikitext.split('\n');
  const headingRegex = new RegExp(
    `^==\\s*${escapeRegExp(heading)}\\s*==\\s*$`,
    'i'
  );
  const startIndex = lines.findIndex((line) => headingRegex.test(line.trim()));
  if (startIndex === -1) return [];

  const items: string[] = [];
  const isTopLevelHeading = (line: string): boolean => {
    const trimmed = line.trim();
    return (
      trimmed.startsWith('==') &&
      !trimmed.startsWith('===') &&
      trimmed.endsWith('==') &&
      !trimmed.endsWith('===')
    );
  };

  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const raw = lines[i].trim();
    if (isTopLevelHeading(raw)) break;
    // Capture bulleted and numbered list entries.
    if (/^[*#]/.test(raw)) {
      items.push(raw.replace(/^[*#]+\s*/, ''));
      continue;
    }
    // Also capture Note lines (for PvE/PvP differences)
    if (raw.startsWith("'''Note:") || raw.startsWith("''Note:")) {
      items.push(raw);
    }
  }

  return items;
}

function stripWikiMarkup(value: string): string {
  return removeHtmlTags(value)
    .replace(/''+/g, '')
    .replace(/\[\[(?:[^|\]]*\|)?([^\]]+)\]\]/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function removeHtmlTags(value: string): string {
  let result = '';
  let inTag = false;

  for (const char of value) {
    if (char === '<') {
      inTag = true;
      continue;
    }
    if (char === '>') {
      inTag = false;
      continue;
    }
    if (!inTag) result += char;
  }

  return result;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeCyrillic(value: string): string {
  // Replace Cyrillic characters commonly mistaken for Latin ones (e.g., PMСs).
  return value.replace(/[\u0421\u0441]/g, 'c');
}

function normalizeObjectiveText(value: string): string {
  const normalizedTimes = normalizeCyrillic(value).replace(
    /\b0(\d):(\d{2})\b/g,
    '$1:$2'
  );
  return normalizeWhitespace(
    stripWikiMarkup(normalizedTimes)
      .toLowerCase()
      .replace(/[’']/g, '')
      .replace(/[^a-z0-9]+/gi, ' ')
      .replace(/\b(all over|throughout)\s+the\s+tarkov\s+territory\b/g, ' ')
      .replace(/\bover\s+(the\s+)?tarkov\s+territory\b/g, ' ')
      .replace(/\bon\s+any\s+(location|map)\b/g, ' ')
      .replace(/\bany\s+location\b/g, ' ')
      .replace(/\bon\s+(the\s+)?location\b/g, ' ')
      .replace(/\bfind a way (inside|into)\b/g, 'enter')
      .replace(/\bone of\b/g, ' ')
      .replace(/\b(the|a|an|any|all)\b/g, ' ')
      .replace(/\bskill level of \d+\b/g, 'skill level')
      .replace(
        /\brequired\s+\d+\s+([a-z]+)\s+skill\s+level\b/g,
        'required $1 skill level'
      )
      .replace(/\blocate and check\b/g, 'locate')
      .replace(/\blocate and obtain\b/g, 'obtain')
      .replace(/\blocate and mark\b/g, 'mark')
      .replace(/\blocate and neutralize\b/g, 'eliminate')
      .replace(/\blocate and eliminate\b/g, 'eliminate')
      .replace(/\bneutralize\b/g, 'eliminate')
      .replace(/\bkill\b/g, 'eliminate')
      .replace(/\bget into\b/g, 'enter')
      .replace(/\bfind\b/g, 'locate')
      .replace(/\bwhile using\b/g, 'using')
      .replace(/\bwith\b/g, 'using')
      .replace(
        /\b([a-z]{2,4}\s?\d{1,3}[a-z0-9]*)\s+series\s+assault\s+rifle\b/g,
        '$1'
      )
      .replace(/\bbunkhouses\b/g, 'bunkhouse')
      .replace(/\band\b/g, ' ')
      .replace(/\bthat\b/g, ' ')
      .replace(/\b(is|are|was|were)\b/g, ' ')
      .replace(/\baway\b/g, ' ')
      .replace(/\boptional\b/g, ' ')
      .replace(/\bfound in raid items?\b/g, 'found in raid')
      .replace(/\bhand grenades?\b/g, 'grenades')
      .replace(/\bscav\s+(bosses?|raiders?)\b/g, '$1')
      .replace(
        /\bto\s+(prapor|therapist|skier|peacekeeper|mechanic|ragman|jaeger|fence|lightkeeper|ref)\b/g,
        ' '
      )
      .replace(/\bpmc operatives?\b/g, 'pmc')
      .replace(/\bpmcs\b/g, 'pmc')
      .replace(/\benemies?\b/g, 'target')
  );
}

function objectiveHasCategoryItemRequirement(text: string): boolean {
  const normalized = text.toLowerCase();
  const categoryPatterns = [
    /\bany\b.*\b(weapon|gun|firearm)\b/,
    /\bmelee weapons?\b/,
    /\bgrenades?\b/,
    /\bgrenade launchers?\b/,
    /\bassault rifles?\b/,
    /\bbolt[-\s]?action rifles?\b/,
    /\bsniper rifles?\b/,
    /\bmarksman rifles?\b/,
    /\bdmrs?\b/,
    /\bsmgs?\b/,
    /\blmgs?\b/,
    /\bshotguns?\b/,
    /\bpistols?\b/,
    /\brevolvers?\b/,
    /\bak[-\s]?series\b/,
    /\bar[-\s]?15\b/,
    /\bplatform weapons?\b/,
    /\bseries\b.*\bweapons?\b/,
    /\bsuppressed\b.*\bweapons?\b/,
    /\bsilenced\b.*\bweapons?\b/,
    /\bsuppressors?\b/,
    /\bsilencers?\b/,
    /\bbrand equipment\b/,
    /\bbrand items?\b/,
    /\bany\b.*\b(backpacks?|tactical rigs?|chest rigs?|plate carriers?|armored rigs?|body armou?r|helmets?)\b/,
    /\bany\b.*\b(medical|medicine|meds|medication)\b/,
    /\b(ballistic plates?|armor plates?)\b/,
  ];

  return categoryPatterns.some((pattern) => pattern.test(normalized));
}

function stripCountPhrases(value: string): string {
  const normalizedValue = normalizeCyrillic(value);
  const countWords =
    '(times?|kills?|targets?|pmcs?|scavs?|operatives?|headshots?|shots?|enemies?|guards?|bosses?|matches?|raiders?|rogues?|snipers?|dogtags?|tags?)';
  const verbCounts =
    '(find|hand over|handover|turn in|submit|deliver|give|bring|obtain|collect|stash|sell|win)';
  const numberWordMap: Record<string, string> = {
    one: '1',
    two: '2',
    three: '3',
    four: '4',
    five: '5',
    six: '6',
    seven: '7',
    eight: '8',
    nine: '9',
    ten: '10',
    eleven: '11',
    twelve: '12',
  };
  const normalizedNumbers = normalizedValue.replace(
    /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/gi,
    (match) => numberWordMap[match.toLowerCase()] ?? match
  );

  return normalizedNumbers
    .replace(/\bwin\b\s+\d+\s+out\s+of\s+\d+\b/gi, 'win')
    .replace(/\b\d+\s+times?\b/gi, '')
    .replace(/\b\d+\s+of\b/gi, '')
    .replace(
      new RegExp(`\\b\\d+\\b\\s+((?:[a-z]+\\s+){0,2}${countWords})\\b`, 'gi'),
      '$1'
    )
    .replace(new RegExp(`\\b${countWords}\\b\\s*\\d+\\b`, 'gi'), '$1')
    .replace(new RegExp(`\\b(item|items)\\b\\s*:\\s*\\d+\\b`, 'gi'), '$1:')
    .replace(
      new RegExp(`\\b${verbCounts}\\b\\s+(?:any\\s+)?(the\\s+)?\\d+\\b`, 'gi'),
      (_match, verb, article) => `${verb} ${article ?? ''}`.trim()
    )
    .replace(
      /\b(sell)\b\s+(prapor|therapist|skier|peacekeeper|mechanic|ragman|jaeger|fence|lightkeeper|ref)\s+(?:any\s+)?\d+\b/gi,
      '$1 $2'
    )
    .replace(/\s+/g, ' ')
    .trim();
}

function singularizeCountWords(value: string): string {
  return value
    .replace(/\btimes\b/g, 'time')
    .replace(/\bkills\b/g, 'kill')
    .replace(/\btargets\b/g, 'target')
    .replace(/\bpmcs\b/g, 'pmc')
    .replace(/\bscavs\b/g, 'scav')
    .replace(/\boperatives\b/g, 'operative')
    .replace(/\bheadshots\b/g, 'headshot')
    .replace(/\bshots\b/g, 'shot')
    .replace(/\benemies\b/g, 'enemy')
    .replace(/\bguards\b/g, 'guard')
    .replace(/\bbosses\b/g, 'boss')
    .replace(/\bmatches\b/g, 'match')
    .replace(/\braiders\b/g, 'raider')
    .replace(/\brogues\b/g, 'rogue')
    .replace(/\bsnipers\b/g, 'sniper')
    .replace(/\bdogtags\b/g, 'dogtag')
    .replace(/\btags\b/g, 'tag');
}

function normalizeObjectiveMatchKey(value: string): string {
  return singularizeCountWords(
    normalizeObjectiveText(stripCountPhrases(value))
  );
}

function normalizeMapName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\bnight factory\b/g, 'factory')
    .replace(/\s+21\+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeItemName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^#+/, '')
    .replace(/#(?=\d)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function uniqueList(values: string[]): string[] {
  return Array.from(new Set(values.filter((v) => v.trim().length > 0)));
}

const WIKI_ITEM_EXCLUSIONS = new Set([
  'found in raid',
  'in raid',
  'fi r',
  'weapon',
  'weapons',
  'assault rifles',
  'sniper rifles',
  'bolt-action rifles',
  'melee weapon',
  'melee weapons',
  'grenade',
  'grenades',
  'grenade launcher',
  'grenade launchers',
  'dmrs',
  'smgs',
  'lmgs',
  'shotguns',
  'pistols',
  'usec',
  'bear',
  'pmc',
  'pmcs',
  'scav',
  'scavs',
  'boss',
  'bosses',
  'rogues',
  'raiders',
  'scav raiders',
  'glukhar',
  'killa',
  'vengeful killa',
  'reshala',
  'shturman',
  'tagilla',
  'shadow of tagilla',
  'sanitar',
  'kaban',
  'kollontay',
  'basmach',
  'gus',
  'partisan',
  'goons',
  'minotaur',
  'zryachiy',
  'birdeye',
  'big pipe',
  'knight',
  'medical',
  'medicine',
  'meds',
  'medication',
  'backpack',
  'backpacks',
  'tactical rig',
  'tactical rigs',
  'chest rig',
  'chest rigs',
  'plate carrier',
  'plate carriers',
  'armored rig',
  'armored rigs',
  'body armor',
  'body armour',
  'helmet',
  'helmets',
  'armor plate',
  'armor plates',
  'ballistic plate',
  'ballistic plates',
  'weapon mods',
  'weapon_mods',
  'search',
  'stress resistance',
  'strength',
  'endurance',
  'metabolism',
  'immunity',
  'intellect',
  'attention',
  'perception',
  'memory',
  'charisma',
  'health',
  'prapor',
  'therapist',
  'skier',
  'peacekeeper',
  'mechanic',
  'ragman',
  'jaeger',
  'fence',
  'lightkeeper',
  'ref',
  'arena',
]);

function isExcludedWikiItem(value: string): boolean {
  return WIKI_ITEM_EXCLUSIONS.has(normalizeItemName(value));
}

function filterWikiItems(items: string[]): string[] {
  return items.filter((item) => !isExcludedWikiItem(item));
}

function selectWikiItemLabel(
  link: WikiLink,
  mapAliasMap: Map<string, string>
): string {
  const target = link.target;
  const display = link.display?.trim();
  if (!display) return target;

  const normalizedTarget = normalizeItemName(target);
  const normalizedDisplay = normalizeItemName(display);
  if (normalizedTarget === normalizedDisplay) return target;

  const isMapTarget = mapAliasMap.has(normalizeMapName(target));
  const isMapDisplay = mapAliasMap.has(normalizeMapName(display));
  if (isMapTarget || isMapDisplay) return target;

  if (isExcludedWikiItem(target) || isExcludedWikiItem(display)) return target;

  if (
    normalizedDisplay.includes(normalizedTarget) ||
    normalizedTarget.includes(normalizedDisplay)
  ) {
    return normalizedDisplay.length >= normalizedTarget.length
      ? display
      : target;
  }

  return target;
}

function getObjectiveVerbKey(text: string): string | undefined {
  const normalized = text.toLowerCase();
  if (
    /\bhand over\b|\bhandover\b|\bturn in\b|\bsubmit\b|\bdeliver\b|\bgive\b|\bbring\b/.test(
      normalized
    )
  ) {
    return 'hand_over';
  }
  if (/\bfind\b|\bloc(at|ate)\b|\bobtain\b|\bcollect\b/.test(normalized)) {
    return 'find';
  }
  if (/\bmark\b|\bplace\b|\bplant\b|\binstall\b|\bstash\b/.test(normalized)) {
    return 'mark';
  }
  if (/\buse\b|\butilize\b/.test(normalized)) {
    return 'use';
  }
  if (/\beliminate\b|\bkill\b|\bshoot\b/.test(normalized)) {
    return 'eliminate';
  }
  if (/\bextract\b|\bsurvive\b|\bescape\b/.test(normalized)) {
    return 'extract';
  }
  return undefined;
}

type ObjectiveItemRef = { name: string; shortName?: string; id?: string };

function normalizeItemAliases(item: ObjectiveItemRef): string[] {
  const aliases: string[] = [];
  if (item.name) aliases.push(normalizeItemName(item.name));
  if (item.shortName) aliases.push(normalizeItemName(item.shortName));
  if (item.name && /dogtag/i.test(item.name)) aliases.push('dogtag');
  if (item.shortName && /dogtag/i.test(item.shortName)) aliases.push('dogtag');
  return uniqueList(aliases);
}

function normalizeItemAliasesWithContext(
  item: ObjectiveItemRef,
  context?: string
): string[] {
  const aliases = normalizeItemAliases(item);
  if (!context || !item.name) return aliases;

  const contextKey = normalizeItemName(context);
  if (contextKey.length === 0) return aliases;

  const match = item.name.match(/\(([^)]+)\)\s*$/);
  if (!match || !match[1]) return aliases;
  const suffix = normalizeItemName(match[1]);
  if (suffix.length === 0) return aliases;

  if (suffix.includes(contextKey)) {
    const stripped = normalizeItemName(
      item.name.replace(/\s*\([^)]+\)\s*$/, '')
    );
    if (stripped.length > 0) aliases.push(stripped);
  }

  return uniqueList(aliases);
}

function normalizeWikiItemAliases(item: string, context?: string): string[] {
  const aliases = [normalizeItemName(item)];
  if (/\(quest item\)/i.test(item)) {
    const stripped = normalizeItemName(item.replace(/\s*\([^)]+\)\s*$/, ''));
    if (stripped.length > 0) aliases.push(stripped);
  }
  if (!context) return aliases;

  const contextKey = normalizeItemName(context);
  if (contextKey.length === 0) return aliases;

  const match = item.match(/\(([^)]+)\)\s*$/);
  if (!match || !match[1]) return aliases;
  const suffix = normalizeItemName(match[1]);
  if (suffix.includes(contextKey)) {
    const stripped = normalizeItemName(item.replace(/\s*\([^)]+\)\s*$/, ''));
    if (stripped.length > 0) aliases.push(stripped);
  }

  return uniqueList(aliases);
}

function buildAliasSet(
  items: ObjectiveItemRef[],
  context?: string
): Set<string> {
  const aliasSet = new Set<string>();
  for (const item of items) {
    for (const alias of normalizeItemAliasesWithContext(item, context))
      aliasSet.add(alias);
  }
  return aliasSet;
}

function hasItemIntersection(
  apiItems: ObjectiveItemRef[],
  wikiItems: string[],
  context?: string
): boolean {
  if (apiItems.length === 0 || wikiItems.length === 0) return false;
  const apiAliasSet = buildAliasSet(apiItems, context);
  for (const item of wikiItems) {
    const wikiAliases = normalizeWikiItemAliases(item, context);
    if (wikiAliases.some((alias) => apiAliasSet.has(alias))) return true;
  }
  return false;
}

function aliasSetIntersects(
  aliasSet: Set<string>,
  wikiItems: string[]
): boolean {
  if (aliasSet.size === 0 || wikiItems.length === 0) return false;
  for (const item of wikiItems) {
    if (aliasSet.has(normalizeItemName(item))) return true;
  }
  return false;
}

function itemsMatch(
  apiItems: ObjectiveItemRef[],
  wikiItems: string[],
  context?: string
): boolean {
  if (apiItems.length === 0 && wikiItems.length === 0) return true;
  if (apiItems.length === 0 || wikiItems.length === 0) return false;

  const wikiAliases = wikiItems.map((item) =>
    normalizeWikiItemAliases(item, context)
  );
  const matchedWikiIndexes = new Set<number>();

  for (const apiItem of apiItems) {
    const aliases = normalizeItemAliasesWithContext(apiItem, context);
    const matchIndex = wikiAliases.findIndex((values) =>
      values.some((value) => aliases.includes(value))
    );
    if (matchIndex === -1) return false;
    matchedWikiIndexes.add(matchIndex);
  }

  return wikiAliases.every((_, index) => matchedWikiIndexes.has(index));
}

function collectMapNames(tasks: ExtendedTaskData[]): string[] {
  const names = new Set<string>();
  for (const task of tasks) {
    if (task.map?.name) names.add(task.map.name);
    for (const obj of task.objectives ?? []) {
      for (const map of obj.maps ?? []) {
        if (map?.name) names.add(map.name);
      }
    }
  }
  return Array.from(names);
}

function buildMapAliasMap(mapNames: string[]): Map<string, string> {
  const aliasMap = new Map<string, string>();

  const addAlias = (alias: string, canonical: string): void => {
    const key = normalizeMapName(alias);
    if (key.length === 0) return;
    if (!aliasMap.has(key)) aliasMap.set(key, canonical);
  };

  for (const name of mapNames) {
    addAlias(name, name);
    if (name.toLowerCase().startsWith('the ')) {
      addAlias(name.slice(4), name);
    }
    if (name.toLowerCase().endsWith(' of tarkov')) {
      addAlias(name.replace(/\s+of tarkov$/i, ''), name);
    }
  }

  // Common shorthand
  if (mapNames.some((n) => n.toLowerCase() === 'the lab')) {
    addAlias('lab', 'The Lab');
    addAlias('laboratory', 'The Lab');
  }
  if (mapNames.some((n) => n.toLowerCase() === 'streets of tarkov')) {
    addAlias('streets', 'Streets of Tarkov');
  }
  if (mapNames.some((n) => n.toLowerCase() === 'ground zero')) {
    addAlias('gz', 'Ground Zero');
  }

  return aliasMap;
}

function extractWikiLinkData(line: string): WikiLink[] {
  const results: WikiLink[] = [];
  const regex = /\[\[([^|\]]+)(?:\|([^\]]+))?\]\]/g;
  let match = regex.exec(line);
  while (match) {
    const target = match[1]?.trim();
    if (target && !/^(File|Category):/i.test(target)) {
      const cleanedTarget = stripWikiMarkup(target.split('#')[0]);
      const displayRaw = match[2]?.trim();
      const cleanedDisplay = displayRaw
        ? stripWikiMarkup(displayRaw.split('#')[0])
        : undefined;
      results.push({ target: cleanedTarget, display: cleanedDisplay });
    }
    match = regex.exec(line);
  }
  return results;
}

function extractWikiLinks(line: string): string[] {
  return extractWikiLinkData(line).map((link) => link.target);
}

function isExcludedMapMention(text: string, mapName: string): boolean {
  const normalized = text.toLowerCase();
  const map = mapName.toLowerCase();
  if (!normalized.includes(map)) return false;

  const clauseRegex = /\b(excluding|except)\b([^.)]*)/gi;
  let match = clauseRegex.exec(normalized);
  while (match) {
    const clause = match[2] ?? '';
    const mapRegex = new RegExp(`\\b${escapeRegExp(map)}\\b`, 'i');
    if (mapRegex.test(clause)) return true;
    match = clauseRegex.exec(normalized);
  }

  return false;
}

function extractMapsFromText(
  text: string,
  aliasMap: Map<string, string>
): string[] {
  const results = new Set<string>();
  for (const [alias, canonical] of aliasMap.entries()) {
    if (isExcludedMapMention(text, alias)) continue;
    if (alias === 'lab' || alias === 'the lab') {
      const pattern = new RegExp(
        `\\b${escapeRegExp(alias)}\\b(?!\\s+scientist)`,
        'i'
      );
      if (pattern.test(text)) results.add(canonical);
      continue;
    }
    const pattern = new RegExp(`\\b${escapeRegExp(alias)}\\b`, 'i');
    if (pattern.test(text)) results.add(canonical);
  }
  return Array.from(results);
}

function stripMapAliases(value: string, aliasMap: Map<string, string>): string {
  let result = value;
  for (const alias of aliasMap.keys()) {
    const normalizedAlias = normalizeObjectiveText(alias);
    if (!normalizedAlias) continue;
    const prepositionPattern = new RegExp(
      `\\b(?:on|in|at|from|near)\\s+${escapeRegExp(normalizedAlias)}\\b`,
      'gi'
    );
    result = result.replace(prepositionPattern, ' ');
    const pattern = new RegExp(`\\b${escapeRegExp(normalizedAlias)}\\b`, 'gi');
    result = result.replace(pattern, ' ');
  }
  return normalizeWhitespace(result);
}

function extractItemTokens(value: string): string[] {
  const cleaned = normalizeItemName(value)
    .replace(/\b\d+(?:\.\d+)?(?:x\d+(?:\.\d+)?)?\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

  const stopWords = new Set([
    'machine',
    'gun',
    'rifle',
    'pistol',
    'launcher',
    'grenade',
    'automatic',
    'assault',
    'sniper',
    'marksman',
    'bolt',
    'action',
    'submachine',
    'smg',
    'lmg',
    'dmr',
    'carbine',
    'weapon',
    'weapons',
    'heavy',
    'light',
  ]);

  const tokens = cleaned.split(/\s+/).filter(Boolean);
  const filtered = tokens.filter(
    (token) => token.length > 1 && !stopWords.has(token) && !/^\d+$/.test(token)
  );
  return uniqueList(filtered);
}

const COVERAGE_STOP_WORDS = new Set([
  'key',
  'keys',
  'keycard',
  'keycards',
  'card',
  'cards',
  'room',
  'rooms',
  'dorm',
  'dorms',
  'office',
  'offices',
  'door',
  'doors',
  'bunker',
  'bunkers',
  'warehouse',
  'warehouses',
  'shop',
  'shops',
  'store',
  'stores',
  'station',
  'stations',
  'base',
  'bases',
  'floor',
  'floors',
  'building',
  'buildings',
  'hangar',
  'hangars',
  'checkpoint',
  'checkpoints',
  'gate',
  'gates',
  'corridor',
  'hall',
  'hallway',
  'hallways',
  'exit',
  'entrance',
  'entrances',
  'route',
  'road',
  'bridge',
  'tunnel',
  'yard',
  'roof',
]);

function extractCoverageTokens(value: string): string[] {
  return extractItemTokens(value).filter(
    (token) => !COVERAGE_STOP_WORDS.has(token)
  );
}

function objectiveMentionsItem(
  itemName: string,
  text: string,
  mapAliasMap: Map<string, string>
): boolean {
  if (!text.trim()) return false;
  const normalizedText = stripMapAliases(
    normalizeObjectiveText(text),
    mapAliasMap
  );
  if (!normalizedText) return false;

  const tokens = extractItemTokens(itemName);
  if (tokens.length === 0) return false;

  return tokens.some((token) => normalizedText.includes(token));
}

function objectiveTextCoversApiItems(
  itemRefs: ObjectiveItemRef[],
  text: string,
  mapAliasMap: Map<string, string>
): boolean {
  if (!text.trim() || itemRefs.length === 0) return false;
  const normalizedText = stripMapAliases(
    normalizeObjectiveText(text),
    mapAliasMap
  );
  if (!normalizedText) return false;

  const itemNames = itemRefs
    .map((item) => item.name)
    .filter((name): name is string => Boolean(name));
  if (itemNames.length === 0) return false;

  const tokenCounts = new Map<string, number>();
  for (const name of itemNames) {
    const tokens = extractCoverageTokens(name);
    if (tokens.length === 0) continue;
    for (const token of tokens) {
      tokenCounts.set(token, (tokenCounts.get(token) ?? 0) + 1);
    }
  }

  if (tokenCounts.size === 0) return false;
  const threshold = Math.max(1, Math.floor(itemNames.length * 0.5));
  for (const [token, count] of tokenCounts) {
    if (count >= threshold && normalizedText.includes(token)) return true;
  }

  return false;
}

function toNormalizedSet(
  values: string[],
  normalize: (value: string) => string
): Set<string> {
  return new Set(values.map(normalize).filter((v) => v.length > 0));
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
}

function isSubset(subset: Set<string>, superset: Set<string>): boolean {
  for (const value of subset) {
    if (!superset.has(value)) return false;
  }
  return true;
}

function collectObjectiveItems(objective: ApiObjective): ObjectiveItemRef[] {
  const items = new Map<string, ObjectiveItemRef>();

  const addItemRef = (item?: {
    id?: string;
    name?: string;
    shortName?: string;
  }): void => {
    if (!item?.name || item.name.trim().length === 0) return;
    const key = item.id ?? normalizeItemName(item.name);
    const existing = items.get(key);
    if (existing) {
      if (!existing.shortName && item.shortName)
        existing.shortName = item.shortName;
      return;
    }
    items.set(key, {
      id: item.id,
      name: item.name,
      shortName: item.shortName,
    });
  };

  const addItems = (
    list?: Array<{ id?: string; name?: string; shortName?: string }>
  ): void => {
    for (const item of list ?? []) addItemRef(item);
  };

  const addItemGroups = (
    groups?: Array<Array<{ id?: string; name?: string; shortName?: string }>>
  ): void => {
    for (const group of groups ?? []) {
      for (const item of group ?? []) addItemRef(item);
    }
  };

  const addMaybeGroupedItems = (
    value?:
      | Array<{ id?: string; name?: string; shortName?: string }>
      | Array<Array<{ id?: string; name?: string; shortName?: string }>>
  ): void => {
    if (!value) return;
    if (Array.isArray(value) && value.length > 0 && Array.isArray(value[0])) {
      addItemGroups(
        value as Array<
          Array<{ id?: string; name?: string; shortName?: string }>
        >
      );
    } else {
      addItems(
        value as Array<{ id?: string; name?: string; shortName?: string }>
      );
    }
  };

  addItems(objective.items);
  addItems(objective.useAny);
  addItems(objective.usingWeapon);
  addItemGroups(objective.usingWeaponMods);
  addItems(objective.containsAll);
  addItemRef(objective.markerItem);
  addItemRef(objective.questItem);
  addItemRef(objective.item);
  addMaybeGroupedItems(objective.requiredKeys);

  return Array.from(items.values());
}

function collectObjectiveItemNames(objective: ApiObjective): string[] {
  return uniqueList(collectObjectiveItems(objective).map((item) => item.name));
}

function parseMinLevel(requirements: string[]): number | undefined {
  for (const line of requirements) {
    const match = stripWikiMarkup(line).match(/level\s+(\d+)/i);
    if (match && match[1]) {
      return Number(match[1]);
    }
  }
  return undefined;
}

function extractCount(text: string, links: string[] = []): number | undefined {
  const normalized = stripWikiMarkup(text).toLowerCase();
  if (!/\d/.test(normalized)) return undefined;

  let scrubbed = normalized;

  // Remove linked item names to avoid pulling numbers from item titles.
  for (const link of links) {
    const linkText = link.trim().toLowerCase();
    if (linkText.length === 0) continue;
    const escaped = linkText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    scrubbed = scrubbed.replace(new RegExp(escaped, 'g'), '');
  }

  // Remove distance patterns like "75 meters".
  scrubbed = scrubbed.replace(/\b\d+\s*meters?\b/gi, '');
  // Remove percentage ranges and single percentages like "0-50%" or "75%".
  scrubbed = scrubbed.replace(/\b\d+\s*[-–]\s*\d+\s*%/g, '');
  scrubbed = scrubbed.replace(/\b\d+\s*%/g, '');
  // Remove numeric ranges like "3-4".
  scrubbed = scrubbed.replace(/\b\d+\s*[-–]\s*\d+\b/g, '');
  // Remove calibers/dimensions like "7.62x51" or "12x70".
  scrubbed = scrubbed.replace(
    /\b\d+(?:\.\d+)?\s*(?:x|×)\s*\d+(?:\.\d+)?\b/g,
    ''
  );
  // Remove decimals like "7.62".
  scrubbed = scrubbed.replace(/\b\d+\.\d+\b/g, '');
  // Remove numbers like "#2".
  scrubbed = scrubbed.replace(/#\d+\b/g, '');
  // Remove 4-digit numbers starting with 0 (item IDs like "0052").
  scrubbed = scrubbed.replace(/\b0\d{3,}\b/g, '');
  // Remove alphanumeric model tokens (e.g., "SV-98", "AK-74", "6B43", "DVL-10").
  scrubbed = scrubbed
    .replace(/\b[a-z]+-?\d+[a-z0-9-]*\b/g, '')
    .replace(/\b\d+-[a-z0-9-]+\b/g, '')
    .replace(/\b[a-z0-9-]+-\d+\b/g, '')
    .replace(/\b\d+[a-z][a-z0-9-]*\b/g, '')
    .replace(/\b[a-z]+\d+[a-z0-9-]*\b/g, '');
  // Remove location numbers like "room 203" or "gate 3".
  scrubbed = scrubbed.replace(
    /\b(?:room|dorm|gate|floor|level|block|sector|wing|building|office|warehouse|shop|store|hangar|checkpoint|bunker)\s+\d+\b/g,
    ''
  );

  const numberPattern = '\\d{1,3}(?:,\\d{3})*';
  const countWords =
    '(?:times?|kills?|targets?|pmcs?|scavs?|operatives?|headshots?|shots?|matches?|raiders?|rogues?|snipers?|dogtags?|tags?)';
  const verbs =
    '(?:kill|eliminate|neutralize|find|locate|obtain|get|hand over|handover|turn in|submit|deliver|give|bring|collect|stash|install|mark|plant|place|reach|visit|use|transfer|complete|survive|extract|escape|hit|shoot)';

  let match = scrubbed.match(
    new RegExp(`\\b(${numberPattern})\\b\\s*${countWords}\\b`, 'i')
  );
  if (match?.[1]) return Number(match[1].replace(/,/g, ''));

  match = scrubbed.match(
    new RegExp(`\\b${countWords}\\b\\s*(${numberPattern})\\b`, 'i')
  );
  if (match?.[1]) return Number(match[1].replace(/,/g, ''));

  match = scrubbed.match(new RegExp(`\\b(${numberPattern})\\b\\s*x\\b`, 'i'));
  if (match?.[1]) return Number(match[1].replace(/,/g, ''));

  match = scrubbed.match(new RegExp(`\\bx\\s*(${numberPattern})\\b`, 'i'));
  if (match?.[1]) return Number(match[1].replace(/,/g, ''));

  match = scrubbed.match(
    new RegExp(`\\b${verbs}\\b[^\\d]{0,24}\\b(${numberPattern})\\b`, 'i')
  );
  if (match?.[1]) return Number(match[1].replace(/,/g, ''));

  match = scrubbed.match(
    new RegExp(
      `\\b(${numberPattern})\\b\\s*(?:items?|pcs?|pieces?|packs?|bottles?|units?)\\b`,
      'i'
    )
  );
  if (match?.[1]) return Number(match[1].replace(/,/g, ''));

  return undefined;
}

function parseObjectives(
  lines: string[],
  mapAliasMap: Map<string, string>
): WikiObjective[] {
  const objectives: WikiObjective[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const clean = stripWikiMarkup(line);

    // Check if this is a PvE note line (not a main objective)
    // Pattern: "Note: The objective in the PvE mode is to ... X targets"
    const isPveNote = /PvE\s*mode/i.test(line) || /PVE/i.test(line);
    if (isPveNote && objectives.length > 0) {
      // Extract PvE count and attach to previous objective
      const pveCount = extractCount(clean);
      if (pveCount !== undefined) {
        objectives[objectives.length - 1].pveCount = pveCount;
      }
      continue;
    }

    // Skip Note lines that aren't PvE-specific
    if (/^'''?Note:?'''?/i.test(line.trim())) {
      continue;
    }

    const linkData = extractWikiLinkData(line);
    const links = linkData.map((link) => link.target);
    const mapLinkEntries: Array<{ canonical: string; link: string }> = [];
    const mapLinkIndexes = new Set<number>();

    linkData.forEach((link, index) => {
      const candidates = [link.target, link.display].filter(
        (value): value is string => Boolean(value)
      );
      let matchedMap = false;
      for (const candidate of candidates) {
        const canonical = mapAliasMap.get(normalizeMapName(candidate));
        if (canonical) {
          mapLinkEntries.push({ canonical, link: candidate });
          matchedMap = true;
        }
      }
      if (matchedMap) mapLinkIndexes.add(index);
    });

    const mapsFromLinks = mapLinkEntries
      .filter((entry) => !isExcludedMapMention(clean, entry.link))
      .map((entry) => entry.canonical);
    const mapsFromText =
      mapsFromLinks.length > 0 ? [] : extractMapsFromText(clean, mapAliasMap);
    const maps = uniqueList([...mapsFromLinks, ...mapsFromText]);
    const items = filterWikiItems(
      uniqueList(
        linkData
          .filter((_, index) => !mapLinkIndexes.has(index))
          .map((link) => selectWikiItemLabel(link, mapAliasMap))
      )
    );

    // Regular objective line
    objectives.push({
      text: clean,
      count: extractCount(clean, links),
      maps,
      items,
      links,
    });
  }

  return objectives;
}

function parseRewards(lines: string[]): WikiRewards {
  let xp: number | undefined;
  const reputations: TraderReputation[] = [];
  let money: number | undefined;
  const items: Array<{ name: string; count: number }> = [];

  for (const line of lines) {
    const clean = stripWikiMarkup(line);

    const xpMatch = clean.match(/\+?([\d,]+)\s*EXP/i);
    if (xpMatch && xpMatch[1]) {
      xp = Number(xpMatch[1].replace(/,/g, ''));
      continue;
    }

    // Extract trader name and reputation value
    // Wiki format: "[[Prapor]] Rep +0.02" or "Prapor Rep +0.02"
    const repMatch = clean.match(/(\w+)\s+Rep\s*\+?([0-9.]+)/i);
    if (repMatch && repMatch[1] && repMatch[2]) {
      reputations.push({
        trader: repMatch[1],
        value: Number(repMatch[2]),
      });
      continue;
    }

    // Only take first rouble value (base amount, not IC bonuses)
    if (money === undefined) {
      const moneyMatch = clean.match(/([\d,]+)\s*Roubles/i);
      if (moneyMatch && moneyMatch[1]) {
        money = Number(moneyMatch[1].replace(/,/g, ''));
        continue;
      }
    }

    const itemMatch = clean.match(
      new RegExp(`^(\\d+)\\s*(?:x|\\u00d7)\\s*(.+)$`, 'i')
    );
    if (itemMatch && itemMatch[1] && itemMatch[2]) {
      items.push({ count: Number(itemMatch[1]), name: itemMatch[2].trim() });
    }
  }

  return {
    xp,
    reputations,
    money,
    items,
    raw: lines.map(stripWikiMarkup),
  };
}

function parseRelatedQuestItems(wikitext: string): WikiRelatedItem[] {
  const lines = wikitext.split('\n');
  const items: WikiRelatedItem[] = [];
  let inTable = false;
  let currentRow: string[] = [];

  const flushRow = (): void => {
    if (currentRow.length < 4) {
      currentRow = [];
      return;
    }

    const itemCell = currentRow[1] ?? '';
    const requirementCell = currentRow[3] ?? '';
    const name =
      extractWikiLinks(itemCell)[0] ?? stripWikiMarkup(itemCell).trim();
    if (name.length === 0) {
      currentRow = [];
      return;
    }

    items.push({
      name,
      requirement: stripWikiMarkup(requirementCell).trim(),
    });
    currentRow = [];
  };

  for (const line of lines) {
    if (!inTable && /Related Quest Items/i.test(line)) {
      inTable = true;
      continue;
    }

    if (!inTable) continue;

    const trimmed = line.trim();
    if (trimmed.startsWith('|}')) {
      flushRow();
      break;
    }

    if (trimmed.startsWith('|-')) {
      flushRow();
      continue;
    }

    if (/^[|!]/.test(trimmed)) {
      const raw = trimmed.replace(/^[|!]/, '');
      const cells = raw.split(/\s*(?:\|\||!!)\s*/);
      for (const cell of cells) {
        currentRow.push(cell.trim());
      }
    }
  }

  return items;
}

function parseInfoboxLinks(wikitext: string, field: string): string[] {
  // Use [ \t]* instead of \s* to avoid matching newlines
  const regex = new RegExp(
    `^\\|\\s*${escapeRegExp(field)}\\s*=[ \\t]*(.+)$`,
    'mi'
  );
  const match = wikitext.match(regex);
  if (!match || !match[1]) return [];
  const value = match[1].trim();
  const results: string[] = [];

  const linkRegex = /\[\[([^|\]]+)/g;
  let linkMatch: RegExpExecArray | null = linkRegex.exec(value);
  while (linkMatch) {
    if (linkMatch[1]) {
      results.push(stripWikiMarkup(linkMatch[1]));
    }
    linkMatch = linkRegex.exec(value);
  }

  return results;
}

function parseInfoboxValue(
  wikitext: string,
  field: string
): string | undefined {
  // Use [ \t]* instead of \s* to avoid matching newlines
  const regex = new RegExp(
    `^\\|\\s*${escapeRegExp(field)}\\s*=[ \\t]*(.+)$`,
    'mi'
  );
  const match = wikitext.match(regex);
  if (!match || !match[1]) return undefined;
  return match[1].trim();
}

function parseWikiTask(
  pageTitle: string,
  wikitext: string,
  mapAliasMap: Map<string, string>,
  lastRevision?: WikiTaskData['lastRevision']
): WikiTaskData {
  const requirements = extractSectionLines(wikitext, 'Requirements');
  const objectivesLines = extractSectionLines(wikitext, 'Objectives');
  const rewardsLines = extractSectionLines(wikitext, 'Rewards');
  const mapFields = ['location', 'map', 'maps', 'locations'];
  const mapsFromInfobox = new Set<string>();

  for (const field of mapFields) {
    const links = parseInfoboxLinks(wikitext, field);
    for (const link of links) {
      const canonical = mapAliasMap.get(normalizeMapName(link));
      const rawValue = parseInfoboxValue(wikitext, field) ?? '';
      if (canonical && !isExcludedMapMention(rawValue, link)) {
        mapsFromInfobox.add(canonical);
      }
    }
    if (links.length === 0) {
      const rawValue = parseInfoboxValue(wikitext, field);
      if (rawValue) {
        for (const mapName of extractMapsFromText(rawValue, mapAliasMap)) {
          mapsFromInfobox.add(mapName);
        }
      }
    }
  }

  const relatedItems = parseRelatedQuestItems(wikitext);
  const relatedRequiredItems = uniqueList(
    relatedItems
      .filter((item) => /required/i.test(item.requirement ?? ''))
      .map((item) => item.name)
  );
  const relatedHandoverItems = uniqueList(
    relatedItems
      .filter((item) => /handover/i.test(item.requirement ?? ''))
      .map((item) => item.name)
  );

  const nextTasks = uniqueList([
    ...parseInfoboxLinks(wikitext, 'next'),
    ...parseInfoboxLinks(wikitext, 'next_task'),
    ...parseInfoboxLinks(wikitext, 'next task'),
    ...parseInfoboxLinks(wikitext, 'next_quest'),
    ...parseInfoboxLinks(wikitext, 'next quest'),
  ]);

  return {
    pageTitle,
    requirements,
    objectives: parseObjectives(objectivesLines, mapAliasMap),
    rewards: parseRewards(rewardsLines),
    minPlayerLevel: parseMinLevel(requirements),
    previousTasks: parseInfoboxLinks(wikitext, 'previous'),
    nextTasks,
    maps: Array.from(mapsFromInfobox),
    relatedItems,
    relatedRequiredItems,
    relatedHandoverItems,
    lastRevision,
  };
}

function printWikiData(wiki: WikiTaskData): void {
  printHeader('WIKI EXTRACTION');
  console.log(`${bold('Page')}: ${wiki.pageTitle}`);

  // Show last revision info
  if (wiki.lastRevision) {
    const revDate = new Date(wiki.lastRevision.timestamp);
    const daysAgo = Math.floor(
      (Date.now() - revDate.getTime()) / (1000 * 60 * 60 * 24)
    );
    const dateStr = revDate.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
    const isPost1_0 = revDate >= TARKOV_1_0_LAUNCH;
    const freshness = isPost1_0 ? '🟢 Post-1.0' : '🔴 Pre-1.0';
    console.log(
      `${bold('Last Edit')}: ${dateStr} (${daysAgo} days ago) ${freshness}`
    );
    console.log(`  ${dim(`by ${wiki.lastRevision.user}`)}`);
  }

  console.log(`${bold('Requirements')}: ${wiki.requirements.length}`);
  for (const line of wiki.requirements) {
    console.log(`  - ${stripWikiMarkup(line)}`);
  }
  if (wiki.minPlayerLevel !== undefined) {
    console.log(
      `  ${dim(`Detected level requirement: ${wiki.minPlayerLevel}`)}`
    );
  }
  if (wiki.maps.length > 0) {
    console.log(`  ${dim(`Detected map(s): ${wiki.maps.join(', ')}`)}`);
  }

  console.log();
  console.log(`${bold('Objectives')}: ${wiki.objectives.length}`);
  for (const obj of wiki.objectives) {
    const count = obj.count !== undefined ? ` (count: ${obj.count})` : '';
    console.log(`  - ${obj.text}${count}`);
  }

  console.log();
  console.log(`${bold('Rewards')}: ${wiki.rewards.raw.length}`);
  for (const reward of wiki.rewards.raw) {
    console.log(`  - ${reward}`);
  }
  if (wiki.rewards.items.length > 0) {
    console.log(
      `  ${dim(`Parsed ${wiki.rewards.items.length} reward item(s)`)}`
    );
  }

  console.log();
  if (wiki.previousTasks.length > 0) {
    console.log(`${bold('Previous Tasks')}: ${wiki.previousTasks.join(', ')}`);
  }
  if (wiki.nextTasks.length > 0) {
    console.log(`${bold('Next Tasks')}: ${wiki.nextTasks.join(', ')}`);
  }
  console.log();
}

function compareTasks(
  apiTask: ExtendedTaskData,
  wiki: WikiTaskData,
  mapAliasMap: Map<string, string>,
  verbose = true,
  nextTaskMap?: Map<string, string[]>,
  taskSuppressions?: Map<string, TaskSuppressionEntry>
): Discrepancy[] {
  const discrepancies: Discrepancy[] = [];
  const taskId = apiTask.id;
  const taskName = apiTask.name;

  // Calculate wiki edit age for discrepancy context
  let wikiLastEdit: string | undefined;
  let wikiEditDaysAgo: number | undefined;
  let wikiEditedPost1_0: boolean | undefined;
  if (wiki.lastRevision?.timestamp) {
    const revDate = new Date(wiki.lastRevision.timestamp);
    wikiLastEdit = revDate.toISOString().split('T')[0];
    wikiEditDaysAgo = Math.floor(
      (Date.now() - revDate.getTime()) / (1000 * 60 * 60 * 24)
    );
    wikiEditedPost1_0 = revDate >= TARKOV_1_0_LAUNCH;
  }

  if (verbose) printHeader('COMPARISON');

  // minPlayerLevel
  if (wiki.minPlayerLevel !== undefined) {
    if (apiTask.minPlayerLevel !== wiki.minPlayerLevel) {
      discrepancies.push({
        taskId,
        taskName,
        field: 'minPlayerLevel',
        apiValue: apiTask.minPlayerLevel,
        wikiValue: wiki.minPlayerLevel,
        priority: getPriority('minPlayerLevel'),
        trustsWiki: true,
        wikiLastEdit,
        wikiEditDaysAgo,
        wikiEditedPost1_0,
      });
      if (verbose)
        console.log(
          `${icons.warning} minPlayerLevel: API=${apiTask.minPlayerLevel}, Wiki=${wiki.minPlayerLevel}`
        );
    } else if (verbose) {
      console.log(
        `${icons.success} minPlayerLevel matches (${apiTask.minPlayerLevel})`
      );
    }
  }

  const isPveTask =
    apiTask.gameModes?.length === 1 && apiTask.gameModes[0] === 'pve';

  // Task-level map/location
  const apiMapName = apiTask.map?.name;
  const wikiObjectiveMaps = uniqueList(
    wiki.objectives.flatMap((obj) => obj.maps ?? [])
  );
  const wikiTaskMaps = wiki.maps.length > 0 ? wiki.maps : wikiObjectiveMaps;
  const wikiTaskMapSet = toNormalizedSet(wikiTaskMaps, normalizeMapName);

  if (wikiTaskMapSet.size > 0) {
    const apiMapSet = apiMapName
      ? new Set([normalizeMapName(apiMapName)])
      : new Set<string>();
    const mapsMatch = apiMapName ? setsEqual(apiMapSet, wikiTaskMapSet) : false;

    if (!mapsMatch) {
      discrepancies.push({
        taskId,
        taskName,
        field: 'map',
        apiValue: apiMapName ?? 'none',
        wikiValue: wikiTaskMaps.join(', ') || 'none',
        priority: getPriority('map'),
        trustsWiki: true,
        wikiLastEdit,
        wikiEditDaysAgo,
        wikiEditedPost1_0,
      });
      if (verbose)
        console.log(
          `${icons.warning} map: API=${apiMapName ?? 'none'}, Wiki=${
            wikiTaskMaps.join(', ') || 'none'
          }`
        );
    } else if (verbose) {
      console.log(`${icons.success} map matches (${apiMapName})`);
    }
  } else if (verbose && apiMapName) {
    console.log(
      `${icons.info} map in API: ${apiMapName}, Wiki=none (not specified)`
    );
  }

  // Objective matching by normalized description
  const wikiCandidates = wiki.objectives.map((wikiObj, index) => ({
    wiki: wikiObj,
    index,
    textKey: stripMapAliases(
      normalizeObjectiveMatchKey(wikiObj.text),
      mapAliasMap
    ),
    verb: getObjectiveVerbKey(wikiObj.text),
    items: uniqueList(wikiObj.items ?? []),
  }));

  const matchedObjectives: Array<{
    api: ApiObjective;
    wiki: WikiObjective;
    matchType: 'text' | 'item';
  }> = [];
  const unmatchedApi: ApiObjective[] = [];
  const unmatchedWikiIndexes = new Set(wikiCandidates.map((c) => c.index));
  const apiQuestItemSet = toNormalizedSet(
    (apiTask.objectives ?? [])
      .map((obj) => obj.questItem?.name)
      .filter((name): name is string => Boolean(name)),
    normalizeItemName
  );

  for (const apiObj of apiTask.objectives ?? []) {
    const apiTextKey = stripMapAliases(
      normalizeObjectiveMatchKey(apiObj.description ?? ''),
      mapAliasMap
    );
    const apiVerb = getObjectiveVerbKey(apiObj.description ?? '');
    const apiItemRefs = collectObjectiveItems(apiObj);
    const apiFoundInRaid =
      apiObj.foundInRaid === true ||
      /found in raid/i.test(apiObj.description ?? '');

    let matched = false;

    if (apiTextKey.length > 0) {
      const candidate = wikiCandidates.find(
        (c) => unmatchedWikiIndexes.has(c.index) && c.textKey === apiTextKey
      );
      if (candidate) {
        matchedObjectives.push({
          api: apiObj,
          wiki: candidate.wiki,
          matchType: 'text',
        });
        unmatchedWikiIndexes.delete(candidate.index);
        matched = true;
      }
    }

    if (!matched && apiTextKey.length > 0) {
      const apiTokens = apiTextKey.split(' ').filter(Boolean);
      if (apiTokens.length >= 4) {
        const substringMatches = wikiCandidates.filter((c) => {
          if (!unmatchedWikiIndexes.has(c.index)) return false;
          if (!c.textKey || c.textKey.length === 0) return false;
          const wikiTokens = c.textKey.split(' ').filter(Boolean);
          if (wikiTokens.length < 4) return false;
          return (
            c.textKey.includes(apiTextKey) || apiTextKey.includes(c.textKey)
          );
        });

        if (substringMatches.length === 1) {
          const candidate = substringMatches[0];
          matchedObjectives.push({
            api: apiObj,
            wiki: candidate.wiki,
            matchType: 'text',
          });
          unmatchedWikiIndexes.delete(candidate.index);
          matched = true;
        }
      }
    }

    if (!matched && apiVerb && apiItemRefs.length > 0) {
      let candidate = wikiCandidates.find(
        (c) =>
          unmatchedWikiIndexes.has(c.index) &&
          c.verb === apiVerb &&
          hasItemIntersection(apiItemRefs, c.items, taskName)
      );
      if (!candidate && apiVerb === 'hand_over' && apiFoundInRaid) {
        candidate = wikiCandidates.find(
          (c) =>
            unmatchedWikiIndexes.has(c.index) &&
            c.verb === 'find' &&
            hasItemIntersection(apiItemRefs, c.items, taskName)
        );
      }
      if (candidate) {
        matchedObjectives.push({
          api: apiObj,
          wiki: candidate.wiki,
          matchType: 'item',
        });
        unmatchedWikiIndexes.delete(candidate.index);
        matched = true;
      }
    }

    if (!matched) {
      unmatchedApi.push(apiObj);
    }
  }

  const apiFoundInRaidItemSets = (apiTask.objectives ?? [])
    .filter(
      (obj) =>
        obj.foundInRaid === true || /found in raid/i.test(obj.description ?? '')
    )
    .map((obj) => buildAliasSet(collectObjectiveItems(obj)));

  const unmatchedWiki: WikiObjective[] = [];
  for (const candidate of wikiCandidates) {
    if (!unmatchedWikiIndexes.has(candidate.index)) continue;

    if (candidate.verb === 'find' && candidate.items.length > 0) {
      const redundantFind = apiFoundInRaidItemSets.some((aliasSet) =>
        aliasSetIntersects(aliasSet, candidate.items)
      );
      if (redundantFind) continue;
    }

    unmatchedWiki.push(candidate.wiki);
  }

  // If both sides have exactly one objective, compare them directly even if text doesn't match
  if (
    matchedObjectives.length === 0 &&
    (apiTask.objectives ?? []).length === 1 &&
    wiki.objectives.length === 1
  ) {
    matchedObjectives.push({
      api: (apiTask.objectives ?? [])[0],
      wiki: wiki.objectives[0],
      matchType: 'text',
    });
    unmatchedApi.length = 0;
    unmatchedWiki.length = 0;
  }

  for (const apiObj of unmatchedApi) {
    if (taskSuppressions && isObjectiveSuppressed(taskSuppressions, taskId, apiObj.id)) {
      continue;
    }
    const desc = apiObj.description ?? apiObj.id;
    discrepancies.push({
      taskId,
      taskName,
      field: 'objectives.description',
      apiValue: desc,
      wikiValue: 'not found',
      priority: getPriority('objectives.description'),
      trustsWiki: true,
      wikiLastEdit,
      wikiEditDaysAgo,
      wikiEditedPost1_0,
    });
    if (verbose)
      console.log(`${icons.warning} objective missing in wiki: ${desc}`);
  }

  for (const wikiObj of unmatchedWiki) {
    discrepancies.push({
      taskId,
      taskName,
      field: 'objectives.description',
      apiValue: 'not found',
      wikiValue: wikiObj.text,
      priority: getPriority('objectives.description'),
      trustsWiki: true,
      wikiLastEdit,
      wikiEditDaysAgo,
      wikiEditedPost1_0,
    });
    if (verbose)
      console.log(`${icons.warning} objective missing in API: ${wikiObj.text}`);
  }

  for (const { api: apiObj, wiki: wikiObj, matchType } of matchedObjectives) {
    if (taskSuppressions && isObjectiveSuppressed(taskSuppressions, taskId, apiObj.id)) {
      continue;
    }

    const apiDesc = normalizeWhitespace(apiObj.description ?? '');
    const wikiDesc = normalizeWhitespace(wikiObj.text);
    const objectiveLabel = apiObj.description ?? wikiObj.text ?? apiObj.id;
    const apiVerb = getObjectiveVerbKey(apiObj.description ?? '');
    const apiItemRefs = collectObjectiveItems(apiObj);
    const apiItems = uniqueList(apiItemRefs.map((item) => item.name));
    const wikiItems = uniqueList(wikiObj.items ?? []);
    const apiRequiredKeys = buildAliasSet(
      Array.isArray(apiObj.requiredKeys)
        ? (apiObj.requiredKeys.flat() as ObjectiveItemRef[])
        : [],
      taskName
    );
    const matchingRequiredItems =
      apiRequiredKeys.size > 0
        ? wiki.relatedRequiredItems.filter((item) =>
            normalizeWikiItemAliases(item, taskName).some((alias) =>
              apiRequiredKeys.has(alias)
            )
          )
        : [];
    const apiHasQuestItem = Boolean(apiObj.questItem);
    const wikiItemsForCompare = uniqueList([
      ...wikiItems,
      ...matchingRequiredItems,
      ...(wikiItems.length === 0 && (apiHasQuestItem || apiVerb === 'hand_over')
        ? wiki.relatedHandoverItems
        : []),
    ]);
    const itemsMatchForDescription =
      apiItemRefs.length > 0 &&
      wikiItemsForCompare.length > 0 &&
      itemsMatch(apiItemRefs, wikiItemsForCompare, taskName);

    const apiCount =
      apiObj.count ??
      extractCount(apiObj.description ?? '', collectObjectiveItemNames(apiObj));
    const wikiCount =
      isPveTask && wikiObj.pveCount !== undefined
        ? wikiObj.pveCount
        : wikiObj.count;
    const shouldStripCounts = apiObj.count !== undefined;
    const apiDescStripped = shouldStripCounts
      ? normalizeWhitespace(stripCountPhrases(apiDesc))
      : apiDesc;
    const wikiDescStripped = shouldStripCounts
      ? normalizeWhitespace(stripCountPhrases(wikiDesc))
      : wikiDesc;
    const apiDescForCompare =
      apiDescStripped.length > 0 ? apiDescStripped : apiDesc;
    const wikiDescForCompare =
      wikiDescStripped.length > 0 ? wikiDescStripped : wikiDesc;

    const normalizedApi = stripMapAliases(
      normalizeObjectiveText(apiDescForCompare),
      mapAliasMap
    );
    const normalizedWiki = stripMapAliases(
      normalizeObjectiveText(wikiDescForCompare),
      mapAliasMap
    );
    const normalizedApiKey = stripMapAliases(
      normalizeObjectiveMatchKey(apiDescForCompare),
      mapAliasMap
    );
    const normalizedWikiKey = stripMapAliases(
      normalizeObjectiveMatchKey(wikiDescForCompare),
      mapAliasMap
    );

    if (
      matchType === 'text' &&
      apiDesc &&
      wikiDesc &&
      normalizedApi !== normalizedWiki &&
      normalizedApiKey !== normalizedWikiKey &&
      !itemsMatchForDescription
    ) {
      discrepancies.push({
        taskId,
        taskName,
        field: 'objectives.description',
        apiValue: apiDescForCompare,
        wikiValue: wikiDescForCompare,
        priority: getPriority('objectives.description'),
        trustsWiki: true,
        wikiLastEdit,
        wikiEditDaysAgo,
        wikiEditedPost1_0,
      });
      if (verbose)
        console.log(
          `${icons.warning} objective text differs: API="${apiDescForCompare}", Wiki="${wikiDescForCompare}"`
        );
    }

    if (apiCount !== undefined && wikiCount !== undefined) {
      const matchesPveVariant =
        wikiObj.pveCount !== undefined &&
        (apiCount === wikiObj.count || apiCount === wikiObj.pveCount);

      if (!matchesPveVariant && apiCount !== wikiCount) {
        discrepancies.push({
          taskId,
          taskName,
          field: 'objectives.count',
          apiValue: `${apiCount} (${objectiveLabel})`,
          wikiValue: `${wikiCount} (${wikiObj.text})`,
          priority: getPriority('objectives.count'),
          trustsWiki: true,
          wikiLastEdit,
          wikiEditDaysAgo,
          wikiEditedPost1_0,
        });
        if (verbose)
          console.log(
            `${icons.warning} objective count: API=${apiCount}, Wiki=${wikiCount} (${objectiveLabel})`
          );
      } else if (verbose) {
        console.log(`${icons.success} objective count matches (${apiCount})`);
      }
    }

    let apiMapNames = uniqueList((apiObj.maps ?? []).map((m) => m.name));
    if (apiMapNames.length === 0) {
      apiMapNames = extractMapsFromText(apiObj.description ?? '', mapAliasMap);
    }
    const wikiMapNames = uniqueList(wikiObj.maps ?? []);
    if (wikiMapNames.length > 0) {
      const apiSet = toNormalizedSet(apiMapNames, normalizeMapName);
      const wikiSet = toNormalizedSet(wikiMapNames, normalizeMapName);
      const descForTransit = `${apiObj.description ?? ''} ${
        wikiObj.text ?? ''
      }`;
      const isTransitObjective =
        /\btransit\b|\btransfer\b|\bpassage\b|\bleading to\b/i.test(
          descForTransit
        );
      const allowTransitSuperset =
        isTransitObjective && apiSet.size > 0 && isSubset(apiSet, wikiSet);
      const skipMapCompare = apiVerb === 'hand_over' && apiSet.size === 0;

      if (
        !setsEqual(apiSet, wikiSet) &&
        !allowTransitSuperset &&
        !skipMapCompare
      ) {
        discrepancies.push({
          taskId,
          taskName,
          field: 'objectives.maps',
          apiValue: `${apiMapNames.join(', ') || 'none'} (${objectiveLabel})`,
          wikiValue: `${wikiMapNames.join(', ') || 'none'} (${wikiObj.text})`,
          priority: getPriority('objectives.maps'),
          trustsWiki: true,
          wikiLastEdit,
          wikiEditDaysAgo,
          wikiEditedPost1_0,
        });
        if (verbose)
          console.log(
            `${icons.warning} objective maps differ: API=${
              apiMapNames.join(', ') || 'none'
            }, Wiki=${wikiMapNames.join(', ') || 'none'}`
          );
      }
    } else if (verbose && apiMapNames.length > 0) {
      console.log(
        `${icons.info} objective maps: API=${apiMapNames.join(
          ', '
        )}, Wiki=none (not specified)`
      );
    }

    if (apiItemRefs.length > 0 || wikiItemsForCompare.length > 0) {
      const apiDescText = apiObj.description ?? '';
      const isSkillObjective =
        /\bskill level\b/i.test(apiDescText) ||
        /\bskill level\b/i.test(wikiObj.text ?? '');
      if (isSkillObjective) {
        if (verbose)
          console.log(
            `${icons.info} objective items: skill requirement, skipping item compare`
          );
        continue;
      }
      const usesRelatedItems =
        matchingRequiredItems.length > 0 ||
        (wikiItems.length === 0 &&
          (apiHasQuestItem || apiVerb === 'hand_over') &&
          wiki.relatedHandoverItems.length > 0);
      const mentionsItemsInText =
        wikiItems.length > 0 &&
        wikiItems.every(
          (item) =>
            objectiveMentionsItem(item, apiDescText, mapAliasMap) ||
            objectiveMentionsItem(item, wikiObj.text ?? '', mapAliasMap)
        );
      const objectiveText = `${apiDescText} ${wikiObj.text ?? ''}`;
      const textCoversApiItems =
        apiItemRefs.length > 0 &&
        wikiItemsForCompare.length === 0 &&
        objectiveTextCoversApiItems(apiItemRefs, objectiveText, mapAliasMap);
      if (
        apiItemRefs.length === 0 &&
        !usesRelatedItems &&
        apiVerb !== 'hand_over' &&
        mentionsItemsInText
      ) {
        if (verbose)
          console.log(
            `${icons.info} objective items: item mentioned in text, skipping strict compare`
          );
        continue;
      }
      const apiAnyItem =
        /\bany\b/i.test(apiDescText) &&
        apiItemRefs.length >= 8 &&
        wikiItemsForCompare.length === 0;
      const categoryRequirement =
        objectiveHasCategoryItemRequirement(apiDescText) ||
        objectiveHasCategoryItemRequirement(wikiObj.text ?? '');
      const handoverMatchesQuestItem =
        apiItemRefs.length === 0 &&
        apiVerb === 'hand_over' &&
        wikiItemsForCompare.length > 0 &&
        Array.from(
          toNormalizedSet(wikiItemsForCompare, normalizeItemName)
        ).every((item) => apiQuestItemSet.has(item));

      if (categoryRequirement && wikiItemsForCompare.length === 0) {
        if (verbose)
          console.log(
            `${icons.info} objective items: category requirement, skipping strict compare`
          );
      } else if (textCoversApiItems) {
        if (verbose)
          console.log(
            `${icons.info} objective items: objective text covers API items, skipping strict compare`
          );
      } else if (apiAnyItem) {
        if (verbose)
          console.log(
            `${icons.info} objective items: API allows any item, skipping strict compare`
          );
      } else if (handoverMatchesQuestItem) {
        if (verbose)
          console.log(
            `${icons.info} objective items: handover matches quest item, skipping strict compare`
          );
      } else if (!itemsMatch(apiItemRefs, wikiItemsForCompare, taskName)) {
        discrepancies.push({
          taskId,
          taskName,
          field: 'objectives.items',
          apiValue: `${apiItems.join(', ') || 'none'} (${objectiveLabel})`,
          wikiValue: `${wikiItemsForCompare.join(', ') || 'none'} (${
            wikiObj.text
          })`,
          priority: getPriority('objectives.items'),
          trustsWiki: true,
          wikiLastEdit,
          wikiEditDaysAgo,
          wikiEditedPost1_0,
        });
        if (verbose)
          console.log(
            `${icons.warning} objective items differ: API=${
              apiItems.join(', ') || 'none'
            }, Wiki=${wikiItems.join(', ') || 'none'}`
          );
      }
    }
  }

  // Prerequisites (previous tasks)
  {
    const apiReqNames = (apiTask.taskRequirements ?? [])
      .map((req) => req.task?.name)
      .filter((n): n is string => Boolean(n));
    const apiSet = toNormalizedSet(apiReqNames, normalizeTaskName);
    const wikiSet = toNormalizedSet(
      wiki.previousTasks ?? [],
      normalizeTaskName
    );

    if (apiSet.size > 0 || wikiSet.size > 0) {
      if (!setsEqual(apiSet, wikiSet)) {
        discrepancies.push({
          taskId,
          taskName,
          field: 'taskRequirements',
          apiValue: apiReqNames.join(', ') || 'none',
          wikiValue: wiki.previousTasks.join(', ') || 'none',
          priority: getPriority('taskRequirements'),
          trustsWiki: true,
          wikiLastEdit,
          wikiEditDaysAgo,
          wikiEditedPost1_0,
        });
        if (verbose) {
          const missing = wiki.previousTasks.filter(
            (t) => !apiSet.has(normalizeTaskName(t))
          );
          const extra = apiReqNames.filter(
            (t) => !wikiSet.has(normalizeTaskName(t))
          );
          if (missing.length > 0)
            console.log(
              `${icons.warning} prerequisites missing in API: ${missing.join(
                ', '
              )}`
            );
          if (extra.length > 0)
            console.log(
              `${icons.warning} prerequisites extra in API: ${extra.join(', ')}`
            );
        }
      } else if (verbose) {
        console.log(`${icons.success} prerequisites match`);
      }
    }
  }

  // Next tasks (unlocks)
  {
    const apiNextNames = nextTaskMap?.get(taskId) ?? [];
    const apiSet = toNormalizedSet(apiNextNames, normalizeTaskName);
    const wikiSet = toNormalizedSet(wiki.nextTasks ?? [], normalizeTaskName);

    if (apiSet.size > 0 || wikiSet.size > 0) {
      if (!setsEqual(apiSet, wikiSet)) {
        discrepancies.push({
          taskId,
          taskName,
          field: 'nextTasks',
          apiValue: apiNextNames.join(', ') || 'none',
          wikiValue: wiki.nextTasks.join(', ') || 'none',
          priority: getPriority('nextTasks'),
          trustsWiki: true,
          wikiLastEdit,
          wikiEditDaysAgo,
          wikiEditedPost1_0,
        });
        if (verbose) {
          const missing = wiki.nextTasks.filter(
            (t) => !apiSet.has(normalizeTaskName(t))
          );
          const extra = apiNextNames.filter(
            (t) => !wikiSet.has(normalizeTaskName(t))
          );
          if (missing.length > 0)
            console.log(
              `${icons.warning} next tasks missing in API: ${missing.join(
                ', '
              )}`
            );
          if (extra.length > 0)
            console.log(
              `${icons.warning} next tasks extra in API: ${extra.join(', ')}`
            );
        }
      } else if (verbose) {
        console.log(`${icons.success} next tasks match`);
      }
    }
  }

  // Experience (XP)
  if (wiki.rewards.xp !== undefined && apiTask.experience !== undefined) {
    if (apiTask.experience !== wiki.rewards.xp) {
      discrepancies.push({
        taskId,
        taskName,
        field: 'experience',
        apiValue: apiTask.experience,
        wikiValue: wiki.rewards.xp,
        priority: getPriority('experience'),
        trustsWiki: true,
        wikiLastEdit,
        wikiEditDaysAgo,
        wikiEditedPost1_0,
      });
      if (verbose)
        console.log(
          `${icons.warning} experience: API=${apiTask.experience}, Wiki=${wiki.rewards.xp}`
        );
    } else if (verbose) {
      console.log(
        `${icons.success} experience matches (${apiTask.experience})`
      );
    }
  }

  // Reputation (per trader)
  if (
    wiki.rewards.reputations.length > 0 &&
    apiTask.finishRewards?.traderStanding
  ) {
    for (const wikiRep of wiki.rewards.reputations) {
      // Find matching trader in API data (case-insensitive)
      const apiTraderRep = apiTask.finishRewards.traderStanding.find(
        (t) => t.trader.name.toLowerCase() === wikiRep.trader.toLowerCase()
      );

      if (apiTraderRep) {
        if (Math.abs(apiTraderRep.standing - wikiRep.value) > 0.001) {
          discrepancies.push({
            taskId,
            taskName,
            field: `reputation.${wikiRep.trader}`,
            apiValue: apiTraderRep.standing,
            wikiValue: wikiRep.value,
            priority: getPriority('reputation'),
            trustsWiki: true,
            wikiLastEdit,
            wikiEditDaysAgo,
            wikiEditedPost1_0,
          });
          if (verbose) {
            console.log(
              `${icons.warning} ${wikiRep.trader} rep: API=${apiTraderRep.standing}, Wiki=${wikiRep.value}`
            );
          }
        } else if (verbose) {
          console.log(
            `${icons.success} ${wikiRep.trader} rep matches (${apiTraderRep.standing})`
          );
        }
      } else if (verbose) {
        console.log(
          `${icons.info} ${wikiRep.trader} rep: Wiki=${wikiRep.value}, not found in API`
        );
      }
    }
  }

  // Money (Roubles)
  if (wiki.rewards.money !== undefined && apiTask.finishRewards?.items) {
    const apiMoney = apiTask.finishRewards.items.find(
      (i) => i.item.name === 'Roubles'
    )?.count;
    if (apiMoney !== undefined && apiMoney !== wiki.rewards.money) {
      discrepancies.push({
        taskId,
        taskName,
        field: 'money',
        apiValue: apiMoney,
        wikiValue: wiki.rewards.money,
        priority: getPriority('money'),
        trustsWiki: true,
        wikiLastEdit,
        wikiEditDaysAgo,
        wikiEditedPost1_0,
      });
      if (verbose)
        console.log(
          `${icons.warning} money: API=${apiMoney}, Wiki=${wiki.rewards.money}`
        );
    } else if (verbose && apiMoney !== undefined) {
      console.log(`${icons.success} money matches (${apiMoney})`);
    }
  }

  if (verbose) {
    console.log();
    if (discrepancies.length === 0) {
      printSuccess('No discrepancies detected.');
    } else {
      printSuccess(`Detected ${discrepancies.length} discrepancy(ies).`);
    }
  }

  return discrepancies;
}

async function runSingleTask(
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

async function runBulkMode(
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

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printUsage();
    return;
  }

  printHeader('WIKI TASK SPIKE');

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

main().catch((error) => {
  printError('Wiki spike failed:', error as Error);
  process.exit(1);
});
