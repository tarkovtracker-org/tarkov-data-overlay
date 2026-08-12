/**
 * tarkov.dev task fetching (mode-aware, with local cache) and task/wiki
 * title resolution.
 *
 * Extracted from the former single-file scripts/wiki-compare.ts.
 */

import { fetchTasks, findTaskById } from '../../src/lib/index.js';
import type { TaskData } from '../../src/lib/types.js';
import { CliOptions, DEFAULT_TASK_NAME, ExtendedTaskData } from './types.js';

export async function fetchTasksForMode(mode: 'regular' | 'pve'): Promise<ExtendedTaskData[]> {
  const tasks = await fetchTasks(mode);
  // Tag each task with its game mode
  return tasks.map((t) => ({ ...t, gameModes: [mode] }));
}

/**
 * Fetch tasks from one or both game modes.
 * In `both` mode, retain mode-specific task entries so PvE-specific data is not lost.
 */
export async function fetchExtendedTasks(
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

/** Trailing disambiguation suffixes upstream appends to task names. */
const TASK_NAME_SUFFIX = /\s*(?:\[pvp zone\]|\(quest\))\s*$/i;

/**
 * Normalize task name for comparison by removing common suffixes and variations
 *
 * Suffixes are stripped in a loop: they stack (e.g. `Task [PVP ZONE] (quest)`),
 * and a single pass per suffix would leave the inner one behind once the outer
 * one stops being terminal.
 */
export function normalizeTaskName(value: string): string {
  let name = value.trim().toLowerCase();
  let previous: string;
  do {
    previous = name;
    name = name.replace(TASK_NAME_SUFFIX, '');
  } while (name !== previous);

  return (
    name
      // Normalize hyphens to spaces for comparison
      .replace(/-/g, ' ')
      // Collapse multiple spaces
      .replace(/\s+/g, ' ')
      .trim()
  );
}

export function resolveTask(tasks: TaskData[], options: CliOptions): TaskData | undefined {
  if (options.id) {
    return findTaskById(tasks, options.id);
  }

  const name = options.name ?? DEFAULT_TASK_NAME;

  // Prefer an exact (case-insensitive) match so a caller naming one specific
  // variant - e.g. 'Task [PVP ZONE]' - still selects that task rather than
  // whichever variant happens to come first under the looser normalization.
  const exact = name.trim().toLowerCase();
  const exactMatch = tasks.find((task) => task.name.trim().toLowerCase() === exact);
  if (exactMatch) return exactMatch;

  // Fall back to the comparison code's normalization so a name carrying a
  // `[PVP ZONE]`/`(quest)` suffix, hyphens, or repeated whitespace still
  // resolves against the upstream task name.
  const normalized = normalizeTaskName(name);
  return tasks.find((task) => normalizeTaskName(task.name) === normalized);
}

export function resolveWikiTitle(task: TaskData, wikiOverride?: string): string {
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
