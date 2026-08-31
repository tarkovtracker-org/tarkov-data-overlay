#!/usr/bin/env tsx
/**
 * Produce a compact, mode-scoped task availability report.
 *
 * The report contains only task start gates, account-state context, map entry
 * rules, trader level rules, and task key requirements. It intentionally does
 * not copy objectives, rewards, dialogue text, loot, or other payload noise.
 *
 * Usage:
 *   npm run tasks:availability
 *   npm run tasks:availability -- --mode pve --out data/task-availability/pve.json
 *   npm run tasks:availability -- --mode regular --stdout
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import {
  deriveTaskUnlockDefinition,
  fetchModeAccessData,
  fetchTasks,
  getProjectPaths,
  isDirectExecution,
  loadJsonFile,
  SUPPORTED_GAME_MODES,
  type GameMode,
  type OverlayOutput,
  type TaskData,
  type TaskAddition,
  type TaskUnlockDefinition,
} from '../src/lib/index.js';

interface Options {
  modes: GameMode[];
  out: string;
  stdout: boolean;
  includeDisabled: boolean;
  applyOverlay: boolean;
}

interface ReportTask {
  id: string;
  name: string;
  unlock: TaskUnlockDefinition;
  disabled?: boolean;
}

interface ModeAvailabilityReport {
  $meta: {
    schemaVersion: '1';
    generated: string;
    gameMode: GameMode;
    source: string;
    overlayVersion?: string;
    taskCount: number;
    disabledTaskCount: number;
    hiddenRequirementCounts: Record<string, number>;
    semantics: {
      all: string;
      anyOf: string;
      taskRequirements: string;
      statuses: string;
      unknown: string;
    };
  };
  maps: Record<string, unknown>;
  traders: Record<string, unknown>;
  tasks: Record<string, ReportTask>;
}

const DEFAULT_OUTPUT_DIR = 'data/task-availability';

/** Parse and validate a comma-separated list of supported game modes. */
function parseModes(value: string): GameMode[] {
  const requested = value
    .split(',')
    .map((mode) => mode.trim())
    .filter(Boolean);
  const invalid = requested.filter(
    (mode): mode is string => !(SUPPORTED_GAME_MODES as readonly string[]).includes(mode)
  );
  if (invalid.length > 0) {
    throw new Error(`Unknown game mode(s): ${invalid.join(', ')}. Use regular, pve, pvp-season.`);
  }
  const modes = [...new Set(requested)] as GameMode[];
  if (modes.length === 0) throw new Error('--mode requires at least one game mode');
  return modes;
}

/** Read the value that follows a command-line option. */
function requiredOptionValue(argv: string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(
      option === '--mode'
        ? '--mode requires a value'
        : `${option} requires a file or directory path`
    );
  }
  return value;
}

/** Parse command-line options for the availability report generator. */
function parseArgs(argv: string[]): Options {
  let modes = [...SUPPORTED_GAME_MODES];
  let out = DEFAULT_OUTPUT_DIR;
  let stdout = false;
  let includeDisabled = false;
  let applyOverlay = true;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--mode':
        modes = parseModes(requiredOptionValue(argv, index, arg));
        index += 1;
        break;
      case '--out':
      case '--json':
        out = requiredOptionValue(argv, index, arg);
        index += 1;
        break;
      case '--stdout':
        stdout = true;
        break;
      case '--include-disabled':
        includeDisabled = true;
        break;
      case '--no-overlay':
        applyOverlay = false;
        break;
      default:
        if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
    }
  }

  return { modes, out, stdout, includeDisabled, applyOverlay };
}

/** Load the built overlay unless the caller explicitly disables overlay use. */
function loadOverlay(applyOverlay: boolean): OverlayOutput | undefined {
  if (!applyOverlay) return undefined;
  const { distDir } = getProjectPaths();
  const path = join(distDir, 'overlay.json');
  return existsSync(path) ? loadJsonFile<OverlayOutput>(path) : undefined;
}

/** Apply shared then mode-specific task overrides to an API task. */
function applyTaskOverlay(
  task: TaskData,
  overlay: OverlayOutput | undefined,
  mode: GameMode
): TaskData {
  if (!overlay) return task;
  const shared = overlay.tasks?.[task.id] ?? {};
  const modeSpecific = overlay.modes?.[mode]?.tasks?.[task.id] ?? {};
  return { ...task, ...shared, ...modeSpecific } as TaskData;
}

/** Convert an addition into the task shape consumed by the unlock model. */
function additionAsTask(addition: TaskAddition): TaskData {
  const { trader, disabled: _disabled, ...data } = addition;
  return {
    ...data,
    ...(trader.id ? { trader: { id: trader.id, name: trader.name } } : {}),
  } as TaskData;
}

/** Resolve a task addition with mode-specific data taking precedence. */
function getTaskAddition(
  overlay: OverlayOutput | undefined,
  mode: GameMode,
  taskId: string
): TaskAddition | undefined {
  return overlay?.modes?.[mode]?.tasksAdd?.[taskId] ?? overlay?.tasksAdd?.[taskId];
}

/** Combine API tasks with shared and mode-specific additions for one mode. */
function getTasksForMode(apiTasks: TaskData[], overlay: OverlayOutput | undefined, mode: GameMode) {
  const tasks = new Map(apiTasks.map((task) => [task.id, task]));
  const additions = {
    ...(overlay?.tasksAdd ?? {}),
    ...(overlay?.modes?.[mode]?.tasksAdd ?? {}),
  };
  for (const addition of Object.values(additions)) {
    if (!tasks.has(addition.id)) tasks.set(addition.id, additionAsTask(addition));
  }
  return [...tasks.values()];
}

/** Keep only map records that expose meaningful entry restrictions. */
function relevantMaps(access: Awaited<ReturnType<typeof fetchModeAccessData>>['maps']) {
  return Object.fromEntries(
    Object.entries(access).filter(([, map]) => {
      return (
        (map.accessKeys?.length ?? 0) > 0 ||
        (map.accessKeysMinPlayerLevel ?? 0) > 0 ||
        (map.minPlayerLevel ?? 0) > 0 ||
        (map.maxPlayerLevel ?? 100) < 100
      );
    })
  );
}

/** Count hidden task requirements by their upstream discriminator. */
function countHiddenRequirements(tasks: readonly TaskData[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const task of tasks) {
    for (const requirement of task.otherRequirements ?? []) {
      counts[requirement.type] = (counts[requirement.type] ?? 0) + 1;
    }
  }
  return counts;
}

interface ReportTaskResult {
  task?: ReportTask;
  disabled: boolean;
}

/** Merge shared and mode-specific disabled flags for one task. */
function taskOverrideFor(
  taskId: string,
  overlay: OverlayOutput | undefined,
  mode: GameMode
): { disabled?: boolean } {
  return {
    ...(overlay?.tasks?.[taskId] ?? {}),
    ...(overlay?.modes?.[mode]?.tasks?.[taskId] ?? {}),
  };
}

/** Create the compact report entry for one adapted task. */
function makeReportTask(
  task: TaskData,
  unlock: TaskUnlockDefinition,
  disabled: boolean
): ReportTask {
  return {
    id: task.id,
    name: task.name,
    unlock,
    ...(disabled ? { disabled: true } : {}),
  };
}

/** Build one report task and retain its disabled-state accounting. */
function buildReportTask(
  apiTask: TaskData,
  overlay: OverlayOutput | undefined,
  mode: GameMode,
  includeDisabled: boolean
): ReportTaskResult {
  const override = taskOverrideFor(apiTask.id, overlay, mode);
  const addition = getTaskAddition(overlay, mode, apiTask.id);
  const disabled = override.disabled === true || addition?.disabled === true;
  if (disabled && !includeDisabled) return { disabled };

  const task = applyTaskOverlay(apiTask, overlay, mode);
  const unlock = deriveTaskUnlockDefinition(task, {
    storyChapters: overlay?.storyChapters,
  });

  return { disabled, task: makeReportTask(task, unlock, disabled) };
}

/** Fetch and assemble one mode's task availability report. */
async function buildReport(
  mode: GameMode,
  overlay: OverlayOutput | undefined,
  includeDisabled: boolean
): Promise<ModeAvailabilityReport> {
  const [apiTasks, access] = await Promise.all([fetchTasks(mode), fetchModeAccessData(mode)]);
  const tasks = getTasksForMode(apiTasks, overlay, mode);
  const reportTasks: Record<string, ReportTask> = {};
  let disabledTaskCount = 0;

  for (const apiTask of tasks) {
    const result = buildReportTask(apiTask, overlay, mode, includeDisabled);
    if (result.disabled) disabledTaskCount += 1;
    if (result.task) reportTasks[result.task.id] = result.task;
  }

  return {
    $meta: {
      schemaVersion: '1',
      generated: new Date().toISOString(),
      gameMode: mode,
      source: `https://json.tarkov.dev/${mode}/tasks`,
      overlayVersion: overlay?.$meta.version,
      taskCount: Object.keys(reportTasks).length,
      disabledTaskCount,
      hiddenRequirementCounts: countHiddenRequirements(tasks),
      semantics: {
        all: 'Every entry in unlock.all and unlock.context must be met.',
        anyOf:
          'Every unlock.anyOf group needs one met entry in the ordinary path; with alternatives present, alternativesExclusive=true omits that path, while false keeps it as an OR candidate.',
        taskRequirements:
          'Every unlock.taskRequirements entry is required in the ordinary path; with alternatives present, alternativesExclusive=true uses only those alternatives, while false keeps the ordinary path as an OR candidate.',
        statuses: 'Statuses within one taskStatus condition are ORed.',
        unknown: 'Missing account state is unknown and must not be rendered as available.',
      },
    },
    maps: relevantMaps(access.maps),
    traders: access.traders,
    tasks: Object.fromEntries(
      Object.entries(reportTasks).sort(([left], [right]) => left.localeCompare(right))
    ),
  };
}

/** Resolve the output filename for one or several requested modes. */
function outputPath(out: string, mode: GameMode, singleMode: boolean): string {
  const absolute = resolve(out);
  if (singleMode && absolute.endsWith('.json')) return absolute;
  return join(absolute, `${mode}.json`);
}

/** Parse options, build reports, and write them to stdout or disk. */
async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const overlay = loadOverlay(options.applyOverlay);
  const reports = await Promise.all(
    options.modes.map((mode) => buildReport(mode, overlay, options.includeDisabled))
  );

  if (options.stdout) {
    const value =
      reports.length === 1
        ? reports[0]
        : Object.fromEntries(reports.map((report) => [report.$meta.gameMode, report]));
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }

  for (const report of reports) {
    const path = outputPath(options.out, report.$meta.gameMode, options.modes.length === 1);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Wrote ${report.$meta.gameMode} availability report: ${path}`);
  }
}

if (isDirectExecution(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

export { buildReport, getTaskAddition, parseArgs };
