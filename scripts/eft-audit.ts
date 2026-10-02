#!/usr/bin/env tsx
/**
 * Three-way task data audit:  REFERENCE  ->  tarkov.dev API  ->  OUR OVERRIDES
 *
 * The local quest reference file is the authority for the numeric quest fields
 * (experience, minPlayerLevel, objective counts). This audit lines up all three
 * sources for every comparable field and tells you, per (task, field), exactly
 * what to do:
 *
 *   GAP       API disagrees with the reference and we have NO override for it.
 *             -> tarkov.dev is wrong and uncorrected; add an override.
 *
 *   STALE     We have an override, but the API now equals the reference.
 *             -> tarkov.dev fixed it upstream; the override is redundant and
 *                can be removed.
 *
 *   CONFLICT  We have an override, but the override value disagrees with the
 *             reference. -> our override is wrong; fix it.
 *   UNRESOLVED Prerequisite targets/statuses cannot be adjudicated, or a target
 *              is absent from the selected API mode. -> obtain evidence or
 *              investigate the missing task; do not infer a safe override.
 *
 *   OK        We have an override, the API is (still) wrong, and the override
 *             matches the reference. -> working as intended, keep it.
 *
 * Numeric fields with no reference value are skipped. Prerequisites lacking
 * accepted-status evidence are UNRESOLVED, as are reference targets absent from
 * the selected API mode: an override for one would create a dangling task edge.
 * Separate Quest conditions remain AND gates, each with its own status set.
 * The reference is
 * per game-mode; pass --mode to pick which tarkov.dev mode and which mode-specific
 * override file to audit against (defaults to pve). Shared overrides
 * (src/overrides/tasks.json5) are merged with the mode file the same way the
 * built overlay applies them (mode wins per field).
 *
 * LOCAL-ONLY: requires a reference file in eft/ (gitignored). No-ops cleanly if absent.
 *
 * Usage:
 *   tsx scripts/eft-audit.ts [eftDir] [--mode pve|regular] [--json out.json]
 *   npm run eft:audit
 *
 * Exit codes: 0 when the audit ran (regardless of how many rows it found);
 * 1 only when it could not run (no reference file, or a mode mismatch). Use
 * --json for machine-readable output.
 */

import { existsSync } from 'fs';
import { join } from 'path';

import {
  isDirectExecution,
  fetchTasks,
  findTaskById,
  mergeTaskOverride,
  loadJson5File,
  getProjectPaths,
  printHeader,
  printProgress,
  printSuccess,
  printError,
  bold,
  dim,
  colors,
  icons,
  type GameMode,
  type TaskData,
  type TaskOverride,
} from '../src/lib/index.js';
import { normalizeTaskStatus } from '../src/lib/task-unlocks.js';
import { loadReferenceTasks, parseModeArgs, writeJsonOutput, type EftTask } from './eft-compare.js';

type Verdict = 'GAP' | 'STALE' | 'CONFLICT' | 'UNRESOLVED' | 'OK';
type Field = 'experience' | 'minPlayerLevel' | 'taskRequirements' | `objective[${string}].count`;

interface Row {
  taskId: string;
  taskName: string;
  field: Field;
  reference: number | string;
  api: number | string | undefined;
  override: number | string | undefined;
  verdict: Verdict;
  note?: string;
}

const { srcDir } = getProjectPaths();

/** Load a JSON5 override map, tolerating an absent file. A missing file is a
 * legitimately empty override set; any other error (malformed JSON5, no read
 * permission, etc.) is real and must surface rather than be silently treated
 * as "no overrides", which would produce a bogus audit. */
function loadOverrideFile(relPath: string): Record<string, TaskOverride> {
  const abs = join(srcDir, relPath);
  if (!existsSync(abs)) return {};
  return loadJson5File<Record<string, TaskOverride>>(abs);
}

/**
 * Effective task overrides for a mode: shared overrides merged with the
 * mode-specific file, mode winning per top-level field (objectives merged by
 * objective id). Mirrors how the consumer applies base + mode overlays.
 */
function effectiveOverrides(mode: GameMode): Record<string, TaskOverride> {
  const base = loadOverrideFile(join('overrides', 'tasks.json5'));
  const modeOv = loadOverrideFile(join('overrides', 'modes', mode, 'tasks.json5'));

  const out: Record<string, TaskOverride> = {};
  for (const [id, ov] of Object.entries(base)) out[id] = { ...ov };
  for (const [id, ov] of Object.entries(modeOv)) {
    out[id] = mergeTaskOverride(out[id], ov);
  }
  return out;
}

/** Classify one (task, field) across the three sources. */
function classify<T extends number | string>(
  reference: T,
  api: T | undefined,
  override: T | undefined
): Verdict | null {
  const apiCorrect = api !== undefined && api === reference;
  const hasOverride = override !== undefined;

  if (!hasOverride) {
    // No override: only interesting when the API is wrong.
    return apiCorrect || api === undefined ? null : 'GAP';
  }
  // Override present.
  if (override !== reference) return 'CONFLICT'; // our override is wrong
  if (apiCorrect) return 'STALE'; // API caught up; override redundant
  return 'OK'; // API still wrong, override fixes it
}

/**
 * Canonical, comparable form of an unordered requirement set: sorted members
 * joined with `+`, or `(none)` when empty. Order in the source data is not
 * meaningful, so sorting keeps a reordering from reading as a difference.
 */
function canonicalJoin(members: Iterable<string>): string {
  const sorted = [...new Set(members)].sort();
  return sorted.length === 0 ? '(none)' : sorted.join('+');
}

/** Preserve separate AND gates, normalizing only aliases and status-set order. */
function canonicalConditions(
  conditions: NonNullable<EftTask['prerequisiteConditions']>
): string | undefined {
  const keys: string[] = [];
  for (const condition of conditions) {
    if (!condition.target || !Array.isArray(condition.statuses) || condition.statuses.length === 0)
      return undefined;
    const normalized = condition.statuses.map(normalizeTaskStatus);
    if (normalized.some((status) => status === undefined)) return undefined;
    keys.push(`${condition.target} [${[...new Set(normalized)].sort().join(', ')}]`);
  }
  return canonicalJoin(keys);
}

/** Omitted upstream/overlay statuses conventionally require completion. */
function canonicalRequirements(
  requirements: NonNullable<TaskData['taskRequirements']>
): string | undefined {
  return canonicalConditions(
    requirements.map((requirement) => ({
      target: requirement?.task?.id,
      statuses: requirement?.status === undefined ? ['complete'] : requirement.status,
    }))
  );
}

/** Normalize the three prerequisite sources without guessing missing evidence. */
function prerequisiteValues(eft: EftTask, api: TaskData, override: TaskOverride | undefined) {
  return {
    reference: canonicalConditions(
      eft.prerequisiteConditions ?? (eft.prerequisites.size === 0 ? [] : [{ statuses: undefined }])
    ),
    api: canonicalRequirements(api.taskRequirements ?? []),
    override:
      override?.taskRequirements === undefined
        ? undefined
        : canonicalRequirements(override.taskRequirements),
  };
}

/** Missing status evidence cannot license a correction, even if IDs match. */
function prerequisiteVerdict(
  values: ReturnType<typeof prerequisiteValues>,
  hasOverride: boolean
): Verdict | null {
  if (
    values.reference === undefined ||
    values.api === undefined ||
    (hasOverride && values.override === undefined)
  ) {
    return 'UNRESOLVED';
  }
  return classify(values.reference, values.api, values.override);
}

/** Grouped OR requirements cannot be compared with flat reference AND gates. */
function hasPrerequisiteGroups(api: TaskData, override: TaskOverride | undefined): boolean {
  return (
    (api.taskRequirementGroups?.length ?? 0) > 0 ||
    (override?.taskRequirementGroups?.length ?? 0) > 0
  );
}

/** Audit one flat prerequisite list, preserving unresolved evidence and targets. */
function prerequisiteRow(
  eft: EftTask,
  api: TaskData,
  override: TaskOverride | undefined,
  apiTaskIds: ReadonlySet<string>
): Row | null {
  if (hasPrerequisiteGroups(api, override)) return null;

  const values = prerequisiteValues(eft, api, override);
  const row = {
    taskId: eft.id,
    taskName: api.name,
    field: 'taskRequirements' as const,
    reference: values.reference ?? canonicalJoin(eft.prerequisites),
    api: values.api,
    override: values.override,
  };
  const missingReferenceTargets = [...eft.prerequisites].filter(
    (taskId) => !apiTaskIds.has(taskId)
  );

  // A missing target takes precedence over missing statuses: consumers cannot
  // safely represent this edge until the task exists in the selected mode.
  if (missingReferenceTargets.length > 0) {
    return {
      ...row,
      verdict: 'UNRESOLVED',
      note:
        `client prerequisite target(s) absent from selected API mode: ${missingReferenceTargets.join(', ')}; ` +
        'do not add a dangling task override',
    };
  }
  const verdict = prerequisiteVerdict(values, override?.taskRequirements !== undefined);
  if (verdict === 'UNRESOLVED') {
    return {
      ...row,
      verdict,
      note: 'prerequisite target or accepted-status evidence unavailable or unsupported; do not infer completion',
    };
  }
  return verdict ? { ...row, verdict } : null;
}

/** Compare objective counts by condition ID without changing row order. */
function objectiveCountRows(
  eft: EftTask,
  api: TaskData,
  override: TaskOverride | undefined
): Row[] {
  const rows: Row[] = [];
  const apiObjectives = new Map((api.objectives ?? []).map((o) => [o.id, o]));
  for (const [objId, refCount] of eft.counts) {
    const apiObj = apiObjectives.get(objId);
    const apiCount = typeof apiObj?.count === 'number' ? apiObj.count : undefined;
    const objOverride = override?.objectives?.[objId];
    const overrideCount = typeof objOverride?.count === 'number' ? objOverride.count : undefined;
    const verdict = classify(refCount, apiCount, overrideCount);
    if (verdict) {
      rows.push({
        taskId: eft.id,
        taskName: api.name,
        field: `objective[${objId}].count`,
        reference: refCount,
        api: apiCount,
        override: overrideCount,
        verdict,
      });
    }
  }
  return rows;
}

/** Compare reference-backed fields with upstream and effective overrides, flagging missing prerequisite targets. */
function buildRows(
  eftTasks: Map<string, EftTask>,
  apiTasks: TaskData[],
  overrides: Record<string, TaskOverride>
): Row[] {
  const rows: Row[] = [];
  const apiTaskIds = new Set(apiTasks.map((task) => task.id));

  for (const eft of eftTasks.values()) {
    const api = findTaskById(apiTasks, eft.id);
    if (!api) continue; // task not in this API mode; nothing to audit
    const ov = overrides[eft.id];
    const name = api.name;

    const scalar = (
      field: 'experience' | 'minPlayerLevel',
      reference: number | undefined
    ): void => {
      if (reference === undefined) return; // reference can't adjudicate
      const verdict = classify(reference, api[field], ov?.[field]);
      if (verdict) {
        rows.push({
          taskId: eft.id,
          taskName: name,
          field,
          reference,
          api: api[field],
          override: ov?.[field],
          verdict,
        });
      }
    };
    scalar('experience', eft.experience);
    scalar('minPlayerLevel', eft.minPlayerLevel);

    const prerequisite = prerequisiteRow(eft, api, ov, apiTaskIds);
    if (prerequisite) rows.push(prerequisite);

    rows.push(...objectiveCountRows(eft, api, ov));
  }

  return rows;
}

const VERDICT_META: Record<Verdict, { icon: string; color: string; blurb: string }> = {
  GAP: { icon: icons.error, color: colors.red, blurb: 'API wrong, NO override - add one' },
  CONFLICT: {
    icon: icons.error,
    color: colors.red,
    blurb: 'override disagrees with reference - fix it',
  },
  STALE: {
    icon: icons.warning,
    color: colors.yellow,
    blurb: 'API fixed upstream - override redundant, remove it',
  },
  UNRESOLVED: {
    icon: icons.warning,
    color: colors.yellow,
    blurb: 'prerequisite evidence incomplete or target absent from API - no safe override',
  },
  OK: { icon: icons.success, color: colors.green, blurb: 'override correct and still needed' },
};

function fieldLabel(field: Field): string {
  return field.startsWith('objective[')
    ? field.replace(/^objective\[(.*)\]\.count$/, 'objective.count ($1)')
    : field;
}

function printReport(rows: Row[], mode: GameMode): void {
  printHeader(`THREE-WAY AUDIT  (reference -> tarkov.dev ${mode} -> overrides)`);

  const order: Verdict[] = ['GAP', 'CONFLICT', 'UNRESOLVED', 'STALE', 'OK'];
  for (const verdict of order) {
    const items = rows.filter((r) => r.verdict === verdict);
    if (items.length === 0) continue;
    const meta = VERDICT_META[verdict];
    console.log(bold(`\n${verdict} (${items.length}) : ${meta.icon} ${dim('- ' + meta.blurb)}`));
    for (const r of items) {
      console.log(
        `  ${r.taskName} ${dim(`(${r.taskId})`)} ${dim(fieldLabel(r.field))}\n` +
          `     reference: ${colors.green}${r.reference}${colors.reset}  ` +
          `api: ${colors.red}${r.api}${colors.reset}  ` +
          `override: ${r.override === undefined ? dim('none') : colors.cyan + r.override + colors.reset}` +
          (r.note ? `\n     note: ${dim(r.note)}` : '')
      );
    }
  }

  const count = (v: Verdict) => rows.filter((r) => r.verdict === v).length;
  printHeader('SUMMARY');
  console.log(`  GAP      (add override):    ${bold(String(count('GAP')))} : ${icons.error}`);
  console.log(`  CONFLICT (fix override):    ${bold(String(count('CONFLICT')))} : ${icons.error}`);
  console.log(
    `  UNRESOLVED (no safe override): ${bold(String(count('UNRESOLVED')))} : ${icons.warning}`
  );
  console.log(`  STALE    (remove override): ${bold(String(count('STALE')))} : ${icons.warning}`);
  console.log(`  OK       (keep override):   ${bold(String(count('OK')))} : ${icons.success}`);
  console.log();
}

async function main(): Promise<void> {
  try {
    const opts = parseModeArgs(process.argv.slice(2));

    printProgress(`Loading quest reference file from ${opts.eftDir}...`);
    const { tasks: eftTasks, refMode } = loadReferenceTasks(
      opts,
      'Place a quest reference file in eft/ to run the audit.'
    );
    printSuccess(`Loaded ${eftTasks.size} quests from the reference file`);

    // The reference file is mode-specific; auditing across modes yields
    // false GAP/CONFLICT rows, so refuse a mismatch.
    if (!refMode) {
      console.log(dim(`  (could not detect reference mode; trusting --mode ${opts.mode})`));
    }

    printProgress(`Fetching ${opts.mode} tasks from tarkov.dev...`);
    const apiTasks = await fetchTasks(opts.mode);
    printSuccess(`Fetched ${apiTasks.length} ${opts.mode} tasks`);

    const overrides = effectiveOverrides(opts.mode);
    printSuccess(`Loaded effective overrides for ${Object.keys(overrides).length} tasks\n`);

    const rows = buildRows(eftTasks, apiTasks, overrides);
    printReport(rows, opts.mode);

    if (opts.jsonOut) {
      writeJsonOutput(opts.jsonOut, rows, 'audit rows');
    }

    process.exit(0);
  } catch (error) {
    printError('Error during three-way audit:', error as Error);
    process.exit(1);
  }
}

if (isDirectExecution(import.meta.url)) {
  main();
}

export { buildRows, classify, effectiveOverrides, type Row, type Verdict };
