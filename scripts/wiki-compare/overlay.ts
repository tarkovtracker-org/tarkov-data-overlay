/**
 * Overlay/suppression loading: filters discrepancies that are already
 * addressed by overrides or intentionally suppressed.
 *
 * Extracted from the former single-file scripts/wiki-compare.ts.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import JSON5 from 'json5';
import type { TaskRequirement } from '../../src/lib/types.js';
import { SUPPORTED_GAME_MODES } from '../../src/lib/types.js';
import {
  ExtendedTaskData,
} from './types.js';

// Overlay file for filtering already-addressed discrepancies
export const TASKS_OVERLAY_FILE = path.join(
  process.cwd(),
  'src',
  'overrides',
  'tasks.json5'
);

/**
 * Every task-override file that affects served data.
 *
 * Mode-specific overrides matter here as much as base ones: a discrepancy this
 * tool reports for a field already corrected in `modes/<mode>/tasks.json5` is
 * noise, and that noise is what buried the regular-mode experience regression.
 */
export function taskOverlayFiles(): string[] {
  const files = [TASKS_OVERLAY_FILE];
  for (const mode of SUPPORTED_GAME_MODES) {
    files.push(
      path.join(process.cwd(), 'src', 'overrides', 'modes', mode, 'tasks.json5')
    );
  }
  return files.filter((file) => fs.existsSync(file));
}

/** Parse a task-override file, returning {} when missing or malformed. */
function readOverlayFile(file: string): Record<string, Record<string, unknown>> {
  try {
    const content = fs.readFileSync(file, 'utf-8');
    const parsed = JSON5.parse(content) as Record<string, Record<string, unknown>>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    console.warn(`Warning: Could not load overlay file ${file}:`, error);
    return {};
  }
}

export const DIVERGENCES_FILE = path.join(
  process.cwd(),
  'src',
  'divergences',
  'tasks.json5'
);

/**
 * `taskId:field` keys for fields recorded as genuinely mode-divergent.
 *
 * `getPriority` ranks `experience` as low because XP is not needed to track
 * progression. That is fine in general, but for a registered divergence a
 * wrong value is evidence of upstream mode mirroring - the exact defect class
 * that previously went unnoticed - so those discrepancies get elevated.
 */
export function loadDivergentFieldKeys(): Set<string> {
  const keys = new Set<string>();
  if (!fs.existsSync(DIVERGENCES_FILE)) return keys;

  try {
    const content = fs.readFileSync(DIVERGENCES_FILE, 'utf-8');
    const parsed = JSON5.parse(content) as Record<string, unknown>;

    for (const [taskId, rawEntry] of Object.entries(parsed)) {
      if (!rawEntry || typeof rawEntry !== 'object') continue;
      const entry = rawEntry as Record<string, unknown>;
      if (entry.status !== 'divergent') continue;
      const fields = entry.fields;
      if (!fields || typeof fields !== 'object') continue;
      for (const field of Object.keys(fields as Record<string, unknown>)) {
        keys.add(`${taskId}:${field}`);
      }
    }
  } catch (error) {
    console.warn('Warning: Could not load divergence registry:', error);
  }

  return keys;
}

export const TASKS_SUPPRESSIONS_FILE = path.join(
  process.cwd(),
  'src',
  'suppressions',
  'tasks.json5'
);

// Suppressions file for discrepancies where wiki is wrong and API is correct
export const WIKI_INCORRECT_FILE = path.join(
  process.cwd(),
  'src',
  'suppressions',
  'wiki-incorrect.json5'
);

export type SuppressedFieldsResult = {
  suppressed: Set<string>;
  overlayCount: number;
  wikiIncorrectCount: number;
  wikiIncorrectKeys: Set<string>; // Track wiki-incorrect separately to check for stale entries
};

export type ObjectiveSuppressionValue =
  | true
  | { fields?: Record<string, boolean> };

export type TaskSuppressionEntry = {
  objectives?: Record<string, ObjectiveSuppressionValue>;
  [field: string]: unknown;
};

export function loadTaskSuppressions(): Map<string, TaskSuppressionEntry> {
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

export function isTaskFieldSuppressed(
  taskSuppressions: Map<string, TaskSuppressionEntry>,
  taskId: string,
  field: string
): boolean {
  const entry = taskSuppressions.get(taskId);
  if (!entry) return false;
  return entry[field] === true;
}

export function isObjectiveSuppressed(
  taskSuppressions: Map<string, TaskSuppressionEntry>,
  taskId: string,
  objectiveId: string,
  field?: string
): boolean {
  const entry = taskSuppressions.get(taskId);
  const suppression = entry?.objectives?.[objectiveId];
  if (suppression === true) return true;
  if (!field || !suppression || typeof suppression !== 'object') return false;

  const fields = suppression.fields ?? {};
  const shortField = field.startsWith('objectives.')
    ? field.slice('objectives.'.length)
    : field;
  return fields[field] === true || fields[shortField] === true;
}

/**
 * Load suppressed fields from both:
 * 1. Tasks overlay (API was wrong, we corrected it)
 * 2. Wiki-incorrect suppressions (API is correct, wiki is wrong)
 *
 * Returns a Set of "taskId:field" keys to exclude from results
 */
export function loadSuppressedFields(): SuppressedFieldsResult {
  const suppressed = new Set<string>();
  const wikiIncorrectKeys = new Set<string>();
  let overlayCount = 0;
  let wikiIncorrectCount = 0;

  // Load overlay files (corrections where API was wrong), base + per-mode
  for (const overlayFile of taskOverlayFiles()) {
    const overlay = readOverlayFile(overlayFile);

    for (const [taskId, fields] of Object.entries(overlay)) {
      if (!fields || typeof fields !== 'object') continue;
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

export function loadTaskRequirementOverrides(): Map<string, TaskRequirement[]> {
  const overrides = new Map<string, TaskRequirement[]>();

  // Later files win, matching the documented base -> mode merge precedence.
  for (const overlayFile of taskOverlayFiles()) {
    const overlay = readOverlayFile(overlayFile);

    for (const [taskId, fields] of Object.entries(overlay)) {
      if (!fields || typeof fields !== 'object') continue;
      const reqs = (fields as Record<string, unknown>).taskRequirements;
      if (Array.isArray(reqs)) {
        overrides.set(taskId, reqs as TaskRequirement[]);
      }
    }
  }

  return overrides;
}

export function buildNextTaskMap(
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
