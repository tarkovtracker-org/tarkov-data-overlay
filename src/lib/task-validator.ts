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

/** Field validator function signature */
type FieldValidator = (
  override: TaskOverride,
  apiTask: TaskData
) => ValidationDetail | null;

function sortKey(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  const json = JSON.stringify(value);
  return json ?? String(value);
}

function normalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    const normalized = value.map(normalizeValue);
    return normalized
      .map(item => ({ key: sortKey(item), value: item }))
      .sort((a, b) => a.key.localeCompare(b.key))
      .map(item => item.value);
  }

  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const normalized: Record<string, unknown> = {};
    for (const key of keys) {
      normalized[key] = normalizeValue(obj[key]);
    }
    return normalized;
  }

  return value;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === undefined && b === undefined) return true;
  return JSON.stringify(normalizeValue(a)) === JSON.stringify(normalizeValue(b));
}

function compareSubset(overrideValue: unknown, apiValue: unknown): boolean {
  if (overrideValue === undefined) return true;
  if (overrideValue === null || typeof overrideValue !== 'object' || Array.isArray(overrideValue)) {
    return valuesEqual(overrideValue, apiValue);
  }

  if (!apiValue || typeof apiValue !== 'object' || Array.isArray(apiValue)) return false;

  const overrideObject = overrideValue as Record<string, unknown>;
  const apiObject = apiValue as Record<string, unknown>;

  for (const key of Object.keys(overrideObject)) {
    if (!compareSubset(overrideObject[key], apiObject[key])) {
      return false;
    }
  }

  return true;
}

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
  field: K
): FieldValidator {
  return (override, apiTask) => {
    const overrideValue = override[field];
    if (overrideValue === undefined) return null;

    const apiValue = apiTask[field];
    const isMatch = compareSubset(overrideValue, apiValue);

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
      ? `${'map'}: ${formatValue(apiValue)} - FIXED IN API`
      : `map: API=${formatValue(apiValue)}, Override=${formatValue(overrideValue)} - STILL NEEDED`,
  };
};

/**
 * Format a value for display
 */
function formatValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return `'${value}'`;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

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
  createFieldValidator('startRewards'),
  createFieldValidator('finishRewards'),
  createFieldValidator('factionName'),
  createFieldValidator('requiredPrestige'),
  validateTaskRequirements,
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
  const needsOverride = details.some(
    (d) => d.status === 'needed' || d.status === 'check'
  );
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
export function categorizeResults(results: ValidationResult[]) {
  return {
    stillNeeded: results.filter((r) => r.stillNeeded),
    fixed: results.filter((r) => r.status === 'FIXED'),
    removedFromApi: results.filter((r) => r.status === 'REMOVED_FROM_API'),
  };
}
