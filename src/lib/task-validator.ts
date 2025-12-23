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
    const isMatch = JSON.stringify(apiValue) === JSON.stringify(overrideValue);

    return {
      field,
      status: isMatch ? 'fixed' : 'needed',
      message: isMatch
        ? `${field}: ${formatValue(apiValue)} - FIXED IN API`
        : `${field}: API=${formatValue(apiValue)}, Override=${formatValue(overrideValue)} - STILL NEEDED`,
    };
  };
}

/**
 * Format a value for display
 */
function formatValue(value: unknown): string {
  if (value === undefined || value === null) return 'undefined';
  if (typeof value === 'string') return `"${value}"`;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * Validate task requirements field
 */
const validateTaskRequirements: FieldValidator = (override, apiTask) => {
  if (override.taskRequirements === undefined) return null;

  const apiReqs = (apiTask.taskRequirements || []).filter(
    r => !r.status || !r.status.includes('active')
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
    const apiReqIds = apiReqs.map(r => r.task?.id).sort();
    const overrideReqIds = overrideReqs.map(r => r.task?.id).sort();

    if (JSON.stringify(apiReqIds) !== JSON.stringify(overrideReqIds)) {
      return {
        field: 'taskRequirements',
        status: 'needed',
        message: `taskRequirements: API has different requirements (${apiReqIds.join(', ')}) vs Override (${overrideReqIds.join(', ')}) - NEEDS REVIEW`,
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
  const apiTask = apiTasks.find(t => t.id === taskId);

  // Task not found in API
  if (!apiTask) {
    return {
      id: taskId,
      name: 'Unknown',
      status: 'REMOVED_FROM_API',
      stillNeeded: false,
      details: [{
        field: 'task',
        status: 'info',
        message: 'Task not found in API - has been removed from tarkov.dev',
      }],
    };
  }

  // Task marked as disabled
  if (override.disabled === true) {
    return {
      id: taskId,
      name: apiTask.name,
      status: 'REMOVED_FROM_API',
      stillNeeded: false,
      details: [{
        field: 'disabled',
        status: 'info',
        message: 'Task still in API but marked as disabled - should be removed from API or override can be removed',
      }],
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
      const apiObj = apiTask.objectives?.find(o => o.id === objId);

      if (!apiObj) {
        details.push({
          field: `objective:${objId}`,
          status: 'check',
          message: `objective ${objId}: Not found in API - CHECK MANUALLY`,
        });
      } else if (objOverride.count !== undefined && apiObj.count !== objOverride.count) {
        details.push({
          field: `objective:${objId}:count`,
          status: 'needed',
          message: `objective count: API=${apiObj.count}, Override=${objOverride.count} - STILL NEEDED`,
        });
      } else if (objOverride.count !== undefined) {
        details.push({
          field: `objective:${objId}:count`,
          status: 'fixed',
          message: `objective count: ${apiObj.count} - FIXED IN API`,
        });
      }
    }
  }

  // Determine overall status
  const needsOverride = details.some(d => d.status === 'needed' || d.status === 'check');
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
    stillNeeded: results.filter(r => r.stillNeeded),
    fixed: results.filter(r => r.status === 'FIXED'),
    removedFromApi: results.filter(r => r.status === 'REMOVED_FROM_API'),
  };
}
