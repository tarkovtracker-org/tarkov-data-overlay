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
 *
 *   OK        We have an override, the API is (still) wrong, and the override
 *             matches the reference. -> working as intended, keep it.
 *
 * Fields with no reference value (the reference can't adjudicate) are skipped,
 * so this never produces false GAPs. The reference is per game-mode; pass --mode
 * to pick which tarkov.dev mode and which mode-specific override file to audit
 * against (defaults to pve). Shared overrides
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

import { existsSync, writeFileSync } from 'fs';
import { isAbsolute, join } from 'path';
import { pathToFileURL } from 'url';

import {
  fetchTasks,
  findTaskById,
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
import { loadEftTasks, detectReferenceMode, type EftTask } from './eft-compare.js';

type Verdict = 'GAP' | 'STALE' | 'CONFLICT' | 'OK';
type Field = 'experience' | 'minPlayerLevel' | `objective[${string}].count`;

interface Row {
  taskId: string;
  taskName: string;
  field: Field;
  reference: number;
  api: number | undefined;
  override: number | undefined;
  verdict: Verdict;
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
    const merged: TaskOverride = { ...(out[id] ?? {}), ...ov };
    if (out[id]?.objectives || ov.objectives) {
      merged.objectives = { ...(out[id]?.objectives ?? {}), ...(ov.objectives ?? {}) };
    }
    out[id] = merged;
  }
  return out;
}

/** Classify one (task, field) across the three sources. */
function classify(
  reference: number,
  api: number | undefined,
  override: number | undefined,
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

function buildRows(
  eftTasks: Map<string, EftTask>,
  apiTasks: TaskData[],
  overrides: Record<string, TaskOverride>,
): Row[] {
  const rows: Row[] = [];

  for (const eft of eftTasks.values()) {
    const api = findTaskById(apiTasks, eft.id);
    if (!api) continue; // task not in this API mode; nothing to audit
    const ov = overrides[eft.id];
    const name = api.name;

    const scalar = (
      field: 'experience' | 'minPlayerLevel',
      reference: number | undefined,
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

    // Objective counts (keyed by objective/condition id).
    const apiObjectives = new Map((api.objectives ?? []).map((o) => [o.id, o]));
    for (const [objId, refCount] of eft.counts) {
      const apiObj = apiObjectives.get(objId);
      const apiCount = typeof apiObj?.count === 'number' ? apiObj.count : undefined;
      const objOverride = ov?.objectives?.[objId];
      const overrideCount =
        typeof objOverride?.count === 'number' ? objOverride.count : undefined;
      const verdict = classify(refCount, apiCount, overrideCount);
      if (verdict) {
        rows.push({
          taskId: eft.id,
          taskName: name,
          field: `objective[${objId}].count`,
          reference: refCount,
          api: apiCount,
          override: overrideCount,
          verdict,
        });
      }
    }
  }

  return rows;
}

interface Options {
  eftDir: string;
  mode: GameMode;
  jsonOut?: string;
}

function parseArgs(argv: string[]): Options {
  let eftDir = 'eft';
  let mode: GameMode = 'pve';
  let jsonOut: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--mode') {
      const v = argv[(i += 1)];
      if (v !== 'pve' && v !== 'regular') {
        throw new Error(`--mode must be 'pve' or 'regular', got '${v}'`);
      }
      mode = v;
    } else if (arg === '--json') {
      jsonOut = argv[(i += 1)];
    } else if (!arg.startsWith('--')) {
      eftDir = arg;
    }
  }
  return { eftDir: isAbsolute(eftDir) ? eftDir : join(process.cwd(), eftDir), mode, jsonOut };
}

const VERDICT_META: Record<Verdict, { icon: string; color: string; blurb: string }> = {
  GAP: { icon: icons.error, color: colors.red, blurb: 'API wrong, NO override - add one' },
  CONFLICT: { icon: icons.error, color: colors.red, blurb: 'override disagrees with reference - fix it' },
  STALE: { icon: icons.warning, color: colors.yellow, blurb: 'API fixed upstream - override redundant, remove it' },
  OK: { icon: icons.success, color: colors.green, blurb: 'override correct and still needed' },
};

function fieldLabel(field: Field): string {
  return field.startsWith('objective[')
    ? field.replace(/^objective\[(.*)\]\.count$/, 'objective.count ($1)')
    : field;
}

function printReport(rows: Row[], mode: GameMode): void {
  printHeader(`THREE-WAY AUDIT  (reference -> tarkov.dev ${mode} -> overrides)`);

  const order: Verdict[] = ['GAP', 'CONFLICT', 'STALE', 'OK'];
  for (const verdict of order) {
    const items = rows.filter((r) => r.verdict === verdict);
    if (items.length === 0) continue;
    const meta = VERDICT_META[verdict];
    console.log(
      bold(`\n${meta.icon} ${meta.color}${verdict}${colors.reset} (${items.length}) ${dim('- ' + meta.blurb)}`),
    );
    for (const r of items) {
      console.log(
        `  ${r.taskName} ${dim(`(${r.taskId})`)} ${dim(fieldLabel(r.field))}\n` +
          `     reference: ${colors.green}${r.reference}${colors.reset}  ` +
          `api: ${colors.red}${r.api}${colors.reset}  ` +
          `override: ${r.override === undefined ? dim('none') : colors.cyan + r.override + colors.reset}`,
      );
    }
  }

  const count = (v: Verdict) => rows.filter((r) => r.verdict === v).length;
  printHeader('SUMMARY');
  console.log(`  ${icons.error} GAP      (add override):    ${bold(String(count('GAP')))}`);
  console.log(`  ${icons.error} CONFLICT (fix override):    ${bold(String(count('CONFLICT')))}`);
  console.log(`  ${icons.warning} STALE    (remove override): ${bold(String(count('STALE')))}`);
  console.log(`  ${icons.success} OK       (keep override):   ${bold(String(count('OK')))}`);
  console.log();
}

async function main(): Promise<void> {
  try {
    const opts = parseArgs(process.argv.slice(2));

    printProgress(`Loading quest reference file from ${opts.eftDir}...`);
    const eftTasks = loadEftTasks(opts.eftDir);
    if (!eftTasks) {
      printError(
        `No quest reference file found in ${opts.eftDir}`,
        new Error('place a quest reference file in eft/ to run the audit'),
      );
      process.exit(1);
    }
    printSuccess(`Loaded ${eftTasks.size} quests from the reference file`);

    // The reference file is mode-specific. Auditing it against a different
    // tarkov.dev mode produces false GAP/CONFLICT rows (e.g. a PVE reference's
    // lower XP looks like a "gap" against regular-mode values). Refuse the
    // mismatch rather than emit misleading results.
    const refMode = detectReferenceMode(opts.eftDir);
    if (refMode && refMode !== opts.mode) {
      printError(
        'Reference/mode mismatch',
        new Error(
          `The reference file in ${opts.eftDir} is a ${refMode} file, but --mode is ${opts.mode}. ` +
            `Auditing across modes yields false positives. Re-run with --mode ${refMode}, ` +
            `or supply a ${opts.mode} reference file.`,
        ),
      );
      process.exit(1);
    }
    if (!refMode) {
      console.log(
        dim(`  (could not detect reference mode; trusting --mode ${opts.mode})`),
      );
    }

    printProgress(`Fetching ${opts.mode} tasks from tarkov.dev...`);
    const apiTasks = await fetchTasks(opts.mode);
    printSuccess(`Fetched ${apiTasks.length} ${opts.mode} tasks`);

    const overrides = effectiveOverrides(opts.mode);
    printSuccess(`Loaded effective overrides for ${Object.keys(overrides).length} tasks\n`);

    const rows = buildRows(eftTasks, apiTasks, overrides);
    printReport(rows, opts.mode);

    if (opts.jsonOut) {
      writeFileSync(opts.jsonOut, JSON.stringify(rows, null, 2));
      printSuccess(`Wrote ${rows.length} audit rows to ${opts.jsonOut}`);
    }

    process.exit(0);
  } catch (error) {
    printError('Error during three-way audit:', error as Error);
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

export { buildRows, classify, effectiveOverrides, type Row, type Verdict };
