/**
 * Shared value comparison helpers
 *
 * Extracted from task-validator so every override checker (tasks, prestige,
 * items, traders, hideout) compares values with identical semantics.
 *
 * Comparison is order-insensitive for arrays and key-order-insensitive for
 * objects, because tarkov.dev does not guarantee stable ordering.
 */

export type CompareOptions = {
  /**
   * 'exact'  - override array must deep-equal the API array
   * 'subset' - every override entry must match some distinct API entry
   */
  arrayMode?: 'exact' | 'subset';
};

function sortKey(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  const json = JSON.stringify(value);
  return json ?? String(value);
}

/** Recursively sort arrays and object keys so comparison ignores ordering. */
export function normalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    const normalized = value.map(normalizeValue);
    return normalized
      .map((item) => ({ key: sortKey(item), value: item }))
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((item) => item.value);
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

/** Order-insensitive deep equality. */
export function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === undefined && b === undefined) return true;
  return JSON.stringify(normalizeValue(a)) === JSON.stringify(normalizeValue(b));
}

/**
 * Check whether `overrideValue` is satisfied by `apiValue`.
 *
 * An undefined override is vacuously satisfied. Objects compare only the keys
 * the override specifies, so an override that patches one field does not
 * require the whole object to match.
 */
export function compareSubset(
  overrideValue: unknown,
  apiValue: unknown,
  options: CompareOptions = {}
): boolean {
  if (overrideValue === undefined) return true;
  if (overrideValue === null || typeof overrideValue !== 'object') {
    return valuesEqual(overrideValue, apiValue);
  }

  if (Array.isArray(overrideValue)) {
    if (!Array.isArray(apiValue)) return false;
    if (options.arrayMode !== 'subset') {
      return valuesEqual(overrideValue, apiValue);
    }
    if (overrideValue.length === 0) return true;

    const usedApiIndexes = new Set<number>();
    for (const overrideEntry of overrideValue) {
      let matched = false;
      for (let i = 0; i < apiValue.length; i += 1) {
        if (usedApiIndexes.has(i)) continue;
        if (compareSubset(overrideEntry, apiValue[i], options)) {
          usedApiIndexes.add(i);
          matched = true;
          break;
        }
      }
      if (!matched) return false;
    }

    return true;
  }

  if (!apiValue || typeof apiValue !== 'object' || Array.isArray(apiValue)) return false;

  const overrideObject = overrideValue as Record<string, unknown>;
  const apiObject = apiValue as Record<string, unknown>;

  for (const key of Object.keys(overrideObject)) {
    if (!compareSubset(overrideObject[key], apiObject[key], options)) {
      return false;
    }
  }

  return true;
}

/** Format a value for terminal display. */
export function formatValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return `'${value}'`;
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
