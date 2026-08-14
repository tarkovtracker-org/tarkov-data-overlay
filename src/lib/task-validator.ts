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

function canonicalMapKey(map?: { id?: string; name?: string }): string | undefined {
  if (!map) return undefined;
  const name = map.name?.trim();
  if (name) {
    const alias = MAP_NAME_ALIASES[name.toLowerCase()];
    return alias ?? name;
  }
  return map.id;
}

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

function hasMultipleObjectiveMaps(override: TaskOverride, apiTask: TaskData): boolean {
  const apiObjectives = (apiTask.objectives ?? []) as ObjectiveLike[];
  const overrideObjectives = Object.values(override.objectives ?? {}) as ObjectiveLike[];
  const mapKeys = new Set<string>();

  for (const key of collectObjectiveMapKeys(apiObjectives)) mapKeys.add(key);
  for (const key of collectObjectiveMapKeys(overrideObjectives)) mapKeys.add(key);

  return mapKeys.size > 1;
}

/**
 * Create a simple field comparison validator
 */
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

/**
 * Validate map field with awareness of multi-map objectives
 */
const validateMap: FieldValidator = (override, apiTask) => {
  const overrideValue = override.map;
  const apiValue = apiTask.map;
  const hasMultiMaps = hasMultipleObjectiveMaps(override, apiTask);

  if (hasMultiMaps) {
    if (overrideValue === undefined) {
      if (apiValue === null || apiValue === undefined) {
        return null;
      }
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

  if (overrideValue === undefined) return null;

  const isMatch = compareSubset(overrideValue, apiValue);

  return {
    field: 'map',
    status: isMatch ? 'fixed' : 'needed',
    message: isMatch
      ? `map: ${formatValue(apiValue)} - FIXED IN API`
      : `map: API=${formatValue(apiValue)}, Override=${formatValue(overrideValue)} - STILL NEEDED`,
  };
};

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

  const remaining = apiReqs.map((req) => traderRequirementKey(req));
  const unmatched: string[] = [];

  for (const overrideReq of overrideReqs) {
    const key = traderRequirementKey(overrideReq);
    const index = remaining.indexOf(key);
    if (index === -1) {
      unmatched.push(
        `${overrideReq.trader?.name ?? overrideReq.trader?.id ?? '?'} ${overrideReq.requirementType} ${overrideReq.compareMethod} ${overrideReq.value}`
      );
    } else {
      remaining.splice(index, 1);
    }
  }

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
      message: `traderRequirements: override omits ${remaining.length} API requirement(s) (${remaining.join('; ')}) - STILL NEEDED`,
    };
  }

  return {
    field: 'traderRequirements',
    status: 'fixed',
    message: 'traderRequirements: FIXED IN API',
  };
};

/**
 * Validate task requirements field
 */
const validateTaskRequirements: FieldValidator = (override, apiTask) => {
  if (override.taskRequirements === undefined) return null;

  const apiReqs = (apiTask.taskRequirements || []).filter(
    (r) =>
      !(r.status ?? []).some((status) =>
        ['active', 'accepted'].includes(status.trim().toLowerCase())
      )
  );
  const overrideReqs = override.taskRequirements;

  if (apiReqs.length === 0 && overrideReqs.length > 0) {
    return {
      field: 'taskRequirements',
      status: 'needed',
      message: `taskRequirements: API=[] (empty), Override has ${overrideReqs.length} requirement(s) - STILL NEEDED`,
    };
  }

  if (apiReqs.length > 0) {
    const apiReqIds = apiReqs.map((r) => r.task?.id).sort();
    const overrideReqIds = overrideReqs.map((r) => r.task?.id).sort();

    if (JSON.stringify(apiReqIds) !== JSON.stringify(overrideReqIds)) {
      return {
        field: 'taskRequirements',
        status: 'needed',
        message: `taskRequirements: API has different requirements (${apiReqIds.join(
          ', '
        )}) vs Override (${overrideReqIds.join(', ')}) - NEEDS REVIEW`,
      };
    }

    return {
      field: 'taskRequirements',
      status: 'fixed',
      message: 'taskRequirements: FIXED IN API',
    };
  }

  return null;
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
  validateTaskRequirements,
  validateTraderRequirements,
];

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

  // Handle nested objective validations separately for full detail
  if (override.objectives) {
    for (const [objId, objOverride] of Object.entries(override.objectives)) {
      const apiObj = apiTask.objectives?.find((o) => o.id === objId);

      if (!apiObj) {
        details.push({
          field: `objective:${objId}`,
          status: 'check',
          message: `objective ${objId}: Not found in API - CHECK MANUALLY`,
        });
      } else {
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
    }
  }

  // Check if added objectives have appeared in API
  if (override.objectivesAdd) {
    for (const added of override.objectivesAdd) {
      const apiMatch = apiTask.objectives?.find(
        (o) => o.id === added.id || o.description === added.description
      );
      if (apiMatch) {
        details.push({
          field: `objectivesAdd:${added.id || added.description}`,
          status: 'fixed',
          message: `added objective '${added.description}': NOW IN API - MOVE TO OBJECTIVES OR REMOVE`,
        });
      } else {
        details.push({
          field: `objectivesAdd:${added.id || added.description}`,
          status: 'needed',
          message: `added objective '${added.description}': Still missing from API - STILL NEEDED`,
        });
      }
    }
  }

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
