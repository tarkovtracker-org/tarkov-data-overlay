/**
 * Task validation logic
 *
 * Validates task overrides against tarkov.dev API data using a
 * configuration-driven approach for easier maintenance.
 */

import type {
  TaskOverride,
  TaskData,
  ValidationResult,
  ValidationDetail,
  ValidationStatus,
} from './types.js';
import { compareSubset, formatValue, type CompareOptions } from './value-compare.js';

/** Field validator function signature */
type FieldValidator = (override: TaskOverride, apiTask: TaskData) => ValidationDetail | null;

type ObjectiveLike = { maps?: Array<{ id?: string; name?: string }> };

const MAP_NAME_ALIASES: Record<string, string> = {
  'night factory': 'Factory',
  'ground zero 21+': 'Ground Zero',
};

/** Return the comparison key for a map, including known display-name aliases. */
function canonicalMapKey(map?: { id?: string; name?: string }): string | undefined {
  if (!map) return undefined;
  const name = map.name?.trim();
  if (name) {
    const alias = MAP_NAME_ALIASES[name.toLowerCase()];
    return alias ?? name;
  }
  return map.id;
}

/** Collect all map keys referenced by a set of task objectives. */
function collectObjectiveMapKeys(objectives: ObjectiveLike[]): Set<string> {
  const mapKeys = new Set<string>();
  for (const objective of objectives) {
    for (const map of objective.maps ?? []) {
      const key = canonicalMapKey(map);
      if (key) mapKeys.add(key);
    }
  }
  return mapKeys;
}

/** Determine whether a task spans more than one objective map. */
function hasMultipleObjectiveMaps(override: TaskOverride, apiTask: TaskData): boolean {
  const apiObjectives = (apiTask.objectives ?? []) as ObjectiveLike[];
  const overrideObjectives = Object.values(override.objectives ?? {}) as ObjectiveLike[];
  const mapKeys = new Set<string>();

  for (const key of collectObjectiveMapKeys(apiObjectives)) mapKeys.add(key);
  for (const key of collectObjectiveMapKeys(overrideObjectives)) mapKeys.add(key);

  return mapKeys.size > 1;
}

/** Create a simple field comparison validator. */
function createFieldValidator<K extends keyof TaskOverride & keyof TaskData>(
  field: K,
  compareOptions?: CompareOptions
): FieldValidator {
  return (override, apiTask) => {
    const overrideValue = override[field];
    if (overrideValue === undefined) return null;

    const apiValue = apiTask[field];
    const isMatch = compareSubset(overrideValue, apiValue, compareOptions);

    return {
      field,
      status: isMatch ? 'fixed' : 'needed',
      message: isMatch
        ? `${field}: ${formatValue(apiValue)} - FIXED IN API`
        : `${field}: API=${formatValue(apiValue)}, Override=${formatValue(
            overrideValue
          )} - STILL NEEDED`,
    };
  };
}

/** Validate an override for a task whose objectives span multiple maps. */
function validateMultiMapOverride(
  overrideValue: TaskOverride['map'],
  apiValue: TaskData['map']
): ValidationDetail | null {
  if (overrideValue === undefined) {
    if (apiValue === null || apiValue === undefined) return null;
    return {
      field: 'map',
      status: 'needed',
      message: `map: task has multiple objective maps; add map: null to clear top-level map (API=${formatValue(
        apiValue
      )}) - STILL NEEDED`,
    };
  }

  if (overrideValue !== null) {
    return {
      field: 'map',
      status: 'needed',
      message: `map: task has multiple objective maps; override should be null (API=${formatValue(
        apiValue
      )}, Override=${formatValue(overrideValue)}) - STILL NEEDED`,
    };
  }

  const isMatch = compareSubset(overrideValue, apiValue);
  return {
    field: 'map',
    status: isMatch ? 'fixed' : 'needed',
    message: isMatch
      ? 'map: null - FIXED IN API'
      : `map: API=${formatValue(apiValue)}, Override=null - STILL NEEDED`,
  };
}

/** Validate an ordinary single-map override. */
function validateSingleMapOverride(
  overrideValue: TaskOverride['map'],
  apiValue: TaskData['map']
): ValidationDetail | null {
  if (overrideValue === undefined) return null;

  const isMatch = compareSubset(overrideValue, apiValue);
  return {
    field: 'map',
    status: isMatch ? 'fixed' : 'needed',
    message: isMatch
      ? `map: ${formatValue(apiValue)} - FIXED IN API`
      : `map: API=${formatValue(apiValue)}, Override=${formatValue(overrideValue)} - STILL NEEDED`,
  };
}

/** Validate map field with awareness of multi-map objectives. */
const validateMap: FieldValidator = (override, apiTask) =>
  hasMultipleObjectiveMaps(override, apiTask)
    ? validateMultiMapOverride(override.map, apiTask.map)
    : validateSingleMapOverride(override.map, apiTask.map);

type TraderRequirementLike = {
  id?: string;
  requirementType?: string;
  compareMethod?: string;
  value?: number;
  trader?: { id?: string; name?: string };
};

/**
 * Semantic identity of a trader requirement: everything a consumer uses to
 * evaluate it, excluding the `id` (which differs between upstream and
 * overlay-authored entries).
 */
function traderRequirementKey(req: TraderRequirementLike): string {
  return [req.trader?.id ?? '', req.requirementType ?? '', req.compareMethod ?? '', req.value].join(
    '|'
  );
}

/** Format a trader requirement for a validation diagnostic. */
function formatTraderRequirement(req: TraderRequirementLike): string {
  return `${req.trader?.name ?? req.trader?.id ?? '?'} ${req.requirementType} ${req.compareMethod} ${req.value}`;
}

interface RequirementMatches<T> {
  remaining: T[];
  unmatched: string[];
}

/** Match override requirements to API requirements by a semantic identity. */
function matchByKey<T>(
  overrideReqs: readonly T[],
  apiReqs: readonly T[],
  keyOf: (requirement: T) => string,
  formatOf: (requirement: T) => string
): RequirementMatches<T> {
  const remaining = [...apiReqs];
  const unmatched: string[] = [];

  for (const overrideReq of overrideReqs) {
    const key = keyOf(overrideReq);
    const index = remaining.findIndex((apiReq) => keyOf(apiReq) === key);
    if (index === -1) unmatched.push(formatOf(overrideReq));
    else remaining.splice(index, 1);
  }

  return { remaining, unmatched };
}

/** Match trader requirements by the semantics consumed by the validator. */
function matchTraderRequirements(
  overrideReqs: readonly TraderRequirementLike[],
  apiReqs: readonly TraderRequirementLike[]
): RequirementMatches<TraderRequirementLike> {
  return matchByKey(overrideReqs, apiReqs, traderRequirementKey, formatTraderRequirement);
}

/**
 * Validate trader requirements by semantic identity.
 *
 * The `id` field is deliberately excluded from the comparison: overlay-authored
 * requirements carry a synthetic `overlay.*` id that will never match upstream,
 * and upstream-preserved ids are only merge identity, not semantics. Comparing
 * `trader.id + requirementType + compareMethod + value` keeps Fence LL1 and
 * Fence reputation `>= 1` distinguishable while treating an id-only difference
 * as "already fixed upstream".
 *
 * This holds even if an upstream entry ever arrives without an id: an override
 * cannot address an id-less upstream requirement, so keeping it would append a
 * duplicate under a patch-by-id merge. `fixed` ("remove it") stays the correct
 * verdict there.
 */
const validateTraderRequirements: FieldValidator = (override, apiTask) => {
  if (override.traderRequirements === undefined) return null;

  const apiReqs = apiTask.traderRequirements ?? [];
  const overrideReqs = override.traderRequirements;

  // An empty override array means "no requirements" and replaces upstream
  // entries; surface it as needed rather than letting a vacuous subset match
  // hide the fact that requirements are being cleared.
  if (overrideReqs.length === 0) {
    if (apiReqs.length === 0) return null;
    return {
      field: 'traderRequirements',
      status: 'needed',
      message: `traderRequirements: API has ${apiReqs.length} requirement(s), Override=[] (clears all) - STILL NEEDED`,
    };
  }

  if (apiReqs.length === 0) {
    return {
      field: 'traderRequirements',
      status: 'needed',
      message: `traderRequirements: API=[] (empty), Override has ${overrideReqs.length} requirement(s) - STILL NEEDED`,
    };
  }

  const { remaining, unmatched } = matchTraderRequirements(overrideReqs, apiReqs);

  if (unmatched.length > 0) {
    return {
      field: 'traderRequirements',
      status: 'needed',
      message: `traderRequirements: ${unmatched.length} requirement(s) differ from API (${unmatched.join('; ')}) - STILL NEEDED`,
    };
  }

  // A non-empty override remains a whole-array replacement for consumers that
  // have not migrated to patch-by-id. Matching only a strict subset therefore
  // intentionally clears the omitted API requirements and is still needed.
  if (remaining.length > 0) {
    return {
      field: 'traderRequirements',
      status: 'needed',
      message: `traderRequirements: override omits ${remaining.length} API requirement(s) (${remaining.map(formatTraderRequirement).join('; ')}) - STILL NEEDED`,
    };
  }

  return {
    field: 'traderRequirements',
    status: 'fixed',
    message: 'traderRequirements: FIXED IN API',
  };
};

type TaskRequirementLike = {
  task?: { id?: string; name?: string };
  status?: unknown;
} | null;

const TASK_STATUS_ALIASES: Readonly<Record<string, string>> = {
  accepted: 'active',
  availableafter: 'active',
  availableforfinish: 'active',
  availableforstart: 'active',
  completed: 'complete',
  expired: 'failed',
  fail: 'failed',
  failedrestartable: 'failed',
  markedasfailed: 'failed',
  started: 'active',
  success: 'complete',
};

/** Normalize the status semantics used by the task unlock evaluator. */
function normalizeTaskRequirementStatus(status: unknown): string {
  if (typeof status !== 'string') return `invalid:${String(status)}`;
  const normalized = status
    .trim()
    .toLowerCase()
    .replace(/[\s_-]/g, '');
  return TASK_STATUS_ALIASES[normalized] ?? normalized;
}

/** Build the semantic identity of one task prerequisite. */
function taskRequirementKey(requirement: TaskRequirementLike): string {
  if (!requirement || typeof requirement !== 'object') return 'malformed|taskRequirement';

  const taskId = requirement.task?.id ?? '';
  const statuses =
    requirement.status === undefined
      ? ['complete']
      : Array.isArray(requirement.status)
        ? [...new Set(requirement.status.map(normalizeTaskRequirementStatus))].sort()
        : ['invalid-status'];
  return `${taskId}|${statuses.join(',')}`;
}

/** Format a task prerequisite for a validation diagnostic. */
function formatTaskRequirement(requirement: TaskRequirementLike): string {
  if (!requirement || typeof requirement !== 'object') return 'malformed task requirement';
  const task = requirement.task?.name ?? requirement.task?.id ?? '?';
  const statuses = requirement.status === undefined ? 'complete' : formatValue(requirement.status);
  return `${task} [${statuses}]`;
}

/** Match task prerequisites by the semantics used by availability evaluation. */
function matchTaskRequirements(
  overrideReqs: readonly TaskRequirementLike[],
  apiReqs: readonly TaskRequirementLike[]
): RequirementMatches<TaskRequirementLike> {
  return matchByKey(overrideReqs, apiReqs, taskRequirementKey, formatTaskRequirement);
}

/** Validate task requirements without discarding active or accepted edges. */
const validateTaskRequirements: FieldValidator = (override, apiTask) => {
  if (override.taskRequirements === undefined) return null;

  const apiReqs = (apiTask.taskRequirements ?? []) as TaskRequirementLike[];
  const overrideReqs = override.taskRequirements as TaskRequirementLike[];

  if (overrideReqs.length === 0) {
    if (apiReqs.length === 0) return null;
    return {
      field: 'taskRequirements',
      status: 'needed',
      message: `taskRequirements: API has ${apiReqs.length} requirement(s), Override=[] (clears all) - STILL NEEDED`,
    };
  }

  if (apiReqs.length === 0) {
    return {
      field: 'taskRequirements',
      status: 'needed',
      message: `taskRequirements: API=[] (empty), Override has ${overrideReqs.length} requirement(s) - STILL NEEDED`,
    };
  }

  const { remaining, unmatched } = matchTaskRequirements(overrideReqs, apiReqs);
  if (unmatched.length > 0) {
    return {
      field: 'taskRequirements',
      status: 'needed',
      message: `taskRequirements: ${unmatched.length} requirement(s) differ from API (${unmatched.join('; ')}) - STILL NEEDED`,
    };
  }

  if (remaining.length > 0) {
    return {
      field: 'taskRequirements',
      status: 'needed',
      message: `taskRequirements: override omits ${remaining.length} API requirement(s) (${remaining.map(formatTaskRequirement).join('; ')}) - STILL NEEDED`,
    };
  }

  return {
    field: 'taskRequirements',
    status: 'fixed',
    message: 'taskRequirements: FIXED IN API',
  };
};

/** Validate task-prerequisite groups while preserving explicit array clearing. */
const validateTaskRequirementGroups: FieldValidator = (override, apiTask) => {
  if (override.taskRequirementGroups === undefined) return null;

  const apiGroups = apiTask.taskRequirementGroups ?? [];
  const overrideGroups = override.taskRequirementGroups;
  if (overrideGroups.length === 0) {
    if (apiGroups.length === 0) return null;
    return {
      field: 'taskRequirementGroups',
      status: 'needed',
      message: `taskRequirementGroups: API has ${apiGroups.length} group(s), Override=[] (clears all) - STILL NEEDED`,
    };
  }

  return createFieldValidator('taskRequirementGroups')(override, apiTask);
};

/** All field validators in order */
const FIELD_VALIDATORS: FieldValidator[] = [
  createFieldValidator('minPlayerLevel'),
  createFieldValidator('name'),
  createFieldValidator('wikiLink'),
  validateMap,
  createFieldValidator('experience'),
  createFieldValidator('startRewards', { arrayMode: 'subset' }),
  createFieldValidator('finishRewards', { arrayMode: 'subset' }),
  createFieldValidator('factionName'),
  createFieldValidator('requiredPrestige'),
  createFieldValidator('kappaRequired'),
  createFieldValidator('lightkeeperRequired'),
  createFieldValidator('otherRequirements'),
  createFieldValidator('neededKeys'),
  createFieldValidator('availableDelaySecondsMin'),
  createFieldValidator('availableDelaySecondsMax'),
  validateTaskRequirementGroups,
  validateTaskRequirements,
  validateTraderRequirements,
];

/** Validate field-level corrections for objectives already known to the API. */
function validateObjectiveOverrides(override: TaskOverride, apiTask: TaskData): ValidationDetail[] {
  const details: ValidationDetail[] = [];
  if (!override.objectives) return details;

  for (const [objId, objOverride] of Object.entries(override.objectives)) {
    const apiObj = apiTask.objectives?.find((objective) => objective.id === objId);
    if (!apiObj) {
      details.push({
        field: `objective:${objId}`,
        status: 'check',
        message: `objective ${objId}: Not found in API - CHECK MANUALLY`,
      });
      continue;
    }

    for (const [field, overrideValue] of Object.entries(objOverride)) {
      if (overrideValue === undefined) continue;
      const apiValue = (apiObj as unknown as Record<string, unknown>)[field];
      const isMatch = compareSubset(overrideValue, apiValue);
      details.push({
        field: `objective:${objId}:${field}`,
        status: isMatch ? 'fixed' : 'needed',
        message: isMatch
          ? `objective ${field}: ${formatValue(apiValue)} - FIXED IN API`
          : `objective ${field}: API=${formatValue(apiValue)}, Override=${formatValue(overrideValue)} - STILL NEEDED`,
      });
    }
  }

  return details;
}

/** Check whether objectives added by the overlay have appeared upstream. */
function validateObjectiveAdditions(override: TaskOverride, apiTask: TaskData): ValidationDetail[] {
  const details: ValidationDetail[] = [];
  if (!override.objectivesAdd) return details;

  for (const added of override.objectivesAdd) {
    const apiMatch = apiTask.objectives?.find(
      (objective) => objective.id === added.id || objective.description === added.description
    );
    const field = `objectivesAdd:${added.id || added.description}`;
    details.push(
      apiMatch
        ? {
            field,
            status: 'fixed',
            message: `added objective '${added.description}': NOW IN API - MOVE TO OBJECTIVES OR REMOVE`,
          }
        : {
            field,
            status: 'needed',
            message: `added objective '${added.description}': Still missing from API - STILL NEEDED`,
          }
    );
  }

  return details;
}

/**
 * Validate a single task override against API data
 *
 * @param taskId - The task ID to validate
 * @param override - The override data
 * @param apiTasks - All tasks from the API
 * @returns Validation result with status and details
 */
export function validateTaskOverride(
  taskId: string,
  override: TaskOverride,
  apiTasks: TaskData[]
): ValidationResult {
  const apiTask = apiTasks.find((t) => t.id === taskId);

  // Task not found in API
  if (!apiTask) {
    return {
      id: taskId,
      name: 'Unknown',
      status: 'REMOVED_FROM_API',
      stillNeeded: false,
      details: [
        {
          field: 'task',
          status: 'info',
          message: 'Task not found in API - has been removed from tarkov.dev',
        },
      ],
    };
  }

  // Task marked as disabled
  if (override.disabled === true) {
    return {
      id: taskId,
      name: apiTask.name,
      status: 'NEEDED',
      stillNeeded: true,
      details: [
        {
          field: 'disabled',
          status: 'check',
          message:
            'disabled: task still present in API - verify removal from gameplay or keep override if intentional',
        },
      ],
    };
  }

  // Run all field validators
  const details: ValidationDetail[] = [];

  for (const validator of FIELD_VALIDATORS) {
    const result = validator(override, apiTask);
    if (result) details.push(result);
  }

  // Handle nested objective validations separately for full detail.
  details.push(...validateObjectiveOverrides(override, apiTask));
  details.push(...validateObjectiveAdditions(override, apiTask));

  // Determine overall status
  const needsOverride = details.some((d) => d.status === 'needed' || d.status === 'check');
  const status: ValidationStatus = needsOverride ? 'NEEDED' : 'FIXED';

  return {
    id: taskId,
    name: apiTask.name,
    status,
    stillNeeded: needsOverride,
    details,
  };
}

/**
 * Validate all task overrides against API data
 *
 * @param overrides - Map of task ID to override data
 * @param apiTasks - All tasks from the API
 * @returns Array of validation results
 */
export function validateAllOverrides(
  overrides: Record<string, TaskOverride>,
  apiTasks: TaskData[]
): ValidationResult[] {
  return Object.entries(overrides).map(([taskId, override]) =>
    validateTaskOverride(taskId, override, apiTasks)
  );
}

/**
 * Categorize validation results by status
 */
export function categorizeResults<T extends { stillNeeded: boolean; status: string }>(
  results: T[]
) {
  return {
    stillNeeded: results.filter((r) => r.stillNeeded),
    fixed: results.filter((r) => r.status === 'FIXED'),
    removedFromApi: results.filter((r) => r.status === 'REMOVED_FROM_API'),
  };
}
