/**
 * Mode-divergence validation
 *
 * Checks the recorded true per-mode values in `src/divergences/tasks.json5`
 * against what consumers would actually receive for each game mode - that is,
 * the tarkov.dev value with our overrides merged on top.
 *
 * This exists because tarkov.dev derives one mode's numbers from the other for
 * some tasks and the mirror direction can flip. Validating only the mode that
 * is broken today cannot detect a flip; validating both modes against a
 * recorded truth can.
 *
 * Merge precedence matches docs/INTEGRATION.md: base overrides apply to BOTH
 * modes, and mode-specific overrides shallow-merge on top.
 */

import type {
  DivergenceField,
  DivergenceResult,
  DivergenceVerdict,
  DivergenceMode,
  TaskData,
  TaskDivergence,
  TaskOverride,
} from './types.js';
import { existsSync } from 'fs';
import { loadJson5File } from './file-loader.js';
import { valuesEqual } from './value-compare.js';

/**
 * Load and parse the mode-divergence registry (src/divergences/tasks.json5).
 * Returns {} when the file is absent, so callers can treat it as optional.
 */
export function loadDivergenceRegistry(filePath: string): Record<string, TaskDivergence> {
  if (!existsSync(filePath)) return {};
  const parsed = loadJson5File<Record<string, TaskDivergence>>(filePath);
  return parsed && typeof parsed === 'object' ? parsed : {};
}

/**
 * `taskId:field` keys for fields the registry marks genuinely divergent.
 * Used to raise the priority of matching wiki/API discrepancies, since a
 * mismatch on a divergent field is evidence of upstream mode mirroring.
 */
export function divergentFieldKeys(registry: Record<string, TaskDivergence>): Set<string> {
  const keys = new Set<string>();
  for (const [taskId, entry] of Object.entries(registry)) {
    if (!entry || entry.status !== 'divergent' || !entry.fields) continue;
    for (const field of Object.keys(entry.fields)) {
      keys.add(`${taskId}:${field}`);
    }
  }
  return keys;
}

/** Per-mode inputs needed to adjudicate a registered field */
export interface DivergenceModeContext {
  /** tarkov.dev tasks for this mode */
  apiTasks: TaskData[];
  /** Mode-specific overrides (src/overrides/modes/<mode>/tasks.json5) */
  modeOverrides: Record<string, TaskOverride>;
}

/**
 * Resolve the value a consumer would see for `field` in `mode`, considering
 * only the overlay (not the API). Returns undefined when no override covers it.
 *
 * Mode-specific entries win over base entries, matching the documented
 * `{ ...shared, ...modeSpecific }` merge.
 */
export function effectiveOverrideValue(
  taskId: string,
  field: string,
  baseOverrides: Record<string, TaskOverride>,
  modeOverrides: Record<string, TaskOverride>
): unknown {
  const modeEntry = modeOverrides[taskId] as Record<string, unknown> | undefined;
  if (modeEntry && field in modeEntry) return modeEntry[field];

  const baseEntry = baseOverrides[taskId] as Record<string, unknown> | undefined;
  if (baseEntry && field in baseEntry) return baseEntry[field];

  return undefined;
}

function verdictFor(expected: unknown, upstream: unknown, override: unknown): DivergenceVerdict {
  const actual = override !== undefined ? override : upstream;

  if (valuesEqual(actual, expected)) {
    if (override === undefined) return 'UPSTREAM_CORRECT';
    return valuesEqual(upstream, expected) ? 'OVERRIDE_REDUNDANT' : 'OVERRIDE_ACTIVE';
  }

  return override === undefined ? 'OVERRIDE_MISSING' : 'OVERRIDE_WRONG';
}

/** Read a field off an API task without widening TaskData. */
function apiFieldValue(task: TaskData, field: string): unknown {
  return (task as unknown as Record<string, unknown>)[field];
}

/**
 * Detect whether upstream serves an identical value in both modes for a field
 * the registry says should differ - the signature of mode mirroring.
 */
function isMirrored(
  taskId: string,
  field: string,
  fieldDef: DivergenceField,
  contexts: Partial<Record<DivergenceMode, DivergenceModeContext>>
): boolean {
  if (fieldDef.regular === undefined || fieldDef.pve === undefined) return false;
  if (valuesEqual(fieldDef.regular, fieldDef.pve)) return false;

  const regularTask = contexts.regular?.apiTasks.find((t) => t.id === taskId);
  const pveTask = contexts.pve?.apiTasks.find((t) => t.id === taskId);
  if (!regularTask || !pveTask) return false;

  return valuesEqual(apiFieldValue(regularTask, field), apiFieldValue(pveTask, field));
}

/**
 * Validate every registered divergence against both game modes.
 *
 * @param registry - parsed src/divergences/tasks.json5
 * @param baseOverrides - parsed src/overrides/tasks.json5 (applies to all modes)
 * @param contexts - per-mode API data and mode-specific overrides
 */
export function validateDivergences(
  registry: Record<string, TaskDivergence>,
  baseOverrides: Record<string, TaskOverride>,
  contexts: Partial<Record<DivergenceMode, DivergenceModeContext>>
): DivergenceResult[] {
  const results: DivergenceResult[] = [];

  for (const [taskId, entry] of Object.entries(registry)) {
    for (const [field, fieldDef] of Object.entries(entry.fields)) {
      const mirrored = isMirrored(taskId, field, fieldDef, contexts);

      for (const mode of Object.keys(contexts) as DivergenceMode[]) {
        const context = contexts[mode];
        if (!context) continue;

        // A field with no recorded value for this mode is not applicable here
        // (e.g. a PvE-exclusive task has no `regular` value).
        if (!(mode in fieldDef)) continue;
        const expected = fieldDef[mode];

        const apiTask = context.apiTasks.find((t) => t.id === taskId);

        if (!apiTask) {
          results.push({
            taskId,
            taskName: entry.name,
            field,
            mode,
            verdict: 'NOT_IN_MODE',
            expected,
            upstream: undefined,
            override: undefined,
            confidence: fieldDef.confidence,
            proof: entry.proof,
            mirrored,
          });
          continue;
        }

        const upstream = apiFieldValue(apiTask, field);
        const override = effectiveOverrideValue(
          taskId,
          field,
          baseOverrides,
          context.modeOverrides
        );

        results.push({
          taskId,
          taskName: entry.name,
          field,
          mode,
          verdict: verdictFor(expected, upstream, override),
          expected,
          upstream,
          override,
          confidence: fieldDef.confidence,
          proof: entry.proof,
          mirrored,
        });
      }
    }
  }

  return results;
}

/**
 * Group divergence results by severity.
 *
 * `wrong` and `missing` mean consumers are being served incorrect data and are
 * actionable failures. `redundant` entries are intentional guards - they are
 * reported for visibility but must never be presented as "delete this", since
 * deleting the redundant half is what allows a mirror flip to go unnoticed.
 */
export function categorizeDivergenceResults(results: DivergenceResult[]) {
  return {
    missing: results.filter((r) => r.verdict === 'OVERRIDE_MISSING'),
    wrong: results.filter((r) => r.verdict === 'OVERRIDE_WRONG'),
    active: results.filter((r) => r.verdict === 'OVERRIDE_ACTIVE'),
    redundant: results.filter((r) => r.verdict === 'OVERRIDE_REDUNDANT'),
    upstreamCorrect: results.filter((r) => r.verdict === 'UPSTREAM_CORRECT'),
    notInMode: results.filter((r) => r.verdict === 'NOT_IN_MODE'),
    mirrored: results.filter((r) => r.mirrored),
  };
}
