/**
 * tarkov.dev task fetching (mode-aware, with local cache) and task/wiki
 * title resolution.
 *
 * Extracted from the former single-file scripts/wiki-compare.ts.
 */

import {
  fetchTasks,
  findTaskById,
} from '../../src/lib/index.js';
import type { TaskData, GameMode } from '../../src/lib/types.js';
import {
  CliOptions,
  DEFAULT_TASK_NAME,
  ExtendedTaskData,
} from './types.js';

export async function fetchTasksForMode(mode: GameMode): Promise<ExtendedTaskData[]> {
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

export function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Normalize task name for comparison by removing common suffixes and variations
 */
export function normalizeTaskName(value: string): string {
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

export function resolveTask(
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
