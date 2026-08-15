/**
 * Mode-divergence validation
 *
 * Checks the recorded true per-mode values in `src/divergences/tasks.json5`
 * against what consumers would actually receive for each upstream game mode -
 * `regular`, `pve`, and `pvp-season` - that is,
 * the tarkov.dev value with our overrides merged on top.
 *
 * This exists because tarkov.dev derives one mode's numbers from the other for
 * some tasks and the mirror direction can flip. Validating only the mode that
 * is broken today cannot detect a flip; validating every recorded mode against
 * a recorded truth can.
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
 * Registry field keys of the form `objective[<id>].count` address a count on
 * one objective (mirroring how the rest of the overlay patches objectives by
 * id). Returns the objective id, or null for plain scalar fields.
 */
const OBJECTIVE_FIELD_KEY = /^objective\[([0-9a-fA-F]{24})\]\.count$/;

function objectiveFieldId(field: string): string | null {
  const match = OBJECTIVE_FIELD_KEY.exec(field);
  return match ? match[1] : null;
}

/**
 * Read a field off an override entry, resolving `objective[<id>].count` keys
 * into the id-keyed objectives map. Returns undefined when the entry does not
 * cover the field (so callers fall through to the next override layer).
 */
function overrideFieldValue(entry: TaskOverride | undefined, field: string): unknown {
  if (!entry) return undefined;
  const objectiveId = objectiveFieldId(field);
  if (objectiveId) {
    return entry.objectives?.[objectiveId]?.count;
  }
  return (entry as unknown as Record<string, unknown>)[field];
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
  const modeValue = overrideFieldValue(modeOverrides[taskId], field);
  if (modeValue !== undefined) return modeValue;

  return overrideFieldValue(baseOverrides[taskId], field);
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
  const objectiveId = objectiveFieldId(field);
  if (objectiveId) {
    return task.objectives?.find((o) => o.id === objectiveId)?.count;
  }
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
  const recordedModes = (Object.keys(contexts) as DivergenceMode[]).filter(
    (mode) => fieldDef[mode] !== undefined
  );

  for (let left = 0; left < recordedModes.length; left += 1) {
    for (let right = left + 1; right < recordedModes.length; right += 1) {
      const leftMode = recordedModes[left];
      const rightMode = recordedModes[right];
      if (valuesEqual(fieldDef[leftMode], fieldDef[rightMode])) continue;

      const leftTask = contexts[leftMode]?.apiTasks.find((task) => task.id === taskId);
      const rightTask = contexts[rightMode]?.apiTasks.find((task) => task.id === taskId);
      if (!leftTask || !rightTask) continue;

      if (valuesEqual(apiFieldValue(leftTask, field), apiFieldValue(rightTask, field))) {
        return true;
      }
    }
  }

  return false;
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
