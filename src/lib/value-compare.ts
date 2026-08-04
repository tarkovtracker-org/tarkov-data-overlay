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
  // Prefix with a type tag so distinct types never collide (e.g. the number 1
  // and the string '1'), which would otherwise make the sort unstable and let
  // valuesEqual report a false mismatch for mixed-type arrays.
  if (value === undefined) return 'u';
  if (value === null) return 'z';
  if (typeof value === 'string') return `s:${value}`;
  if (typeof value === 'number') return `n:${value}`;
  if (typeof value === 'boolean') return `b:${value}`;
  const json = JSON.stringify(value);
  return `o:${json ?? String(value)}`;
}

/** Deterministic, locale-independent string order (UTF-16 code units). */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Recursively sort arrays and object keys so comparison ignores ordering. */
export function normalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    const normalized = value.map(normalizeValue);
    return normalized
      .map((item) => ({ key: sortKey(item), value: item }))
      .sort((a, b) => compareStrings(a.key, b.key))
      .map((item) => item.value);
  }

  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort(compareStrings);
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
    // More override entries than api entries can never map to distinct targets.
    if (overrideValue.length > apiValue.length) return false;

    // Each override entry must map to a DISTINCT api entry. Greedy first-match
    // can fail when candidates overlap; naive backtracking is factorial. Use
    // Kuhn's algorithm (augmenting paths) for maximum bipartite matching, which
    // is polynomial O(V*E) and keeps strict validation predictable.
    const candidates: number[][] = overrideValue.map((entry) => {
      const matches: number[] = [];
      for (let j = 0; j < apiValue.length; j += 1) {
        if (compareSubset(entry, apiValue[j], options)) matches.push(j);
      }
      return matches;
    });
    // An entry with no candidate can never be matched - fail fast.
    if (candidates.some((c) => c.length === 0)) return false;

    const apiMatchedBy = new Array<number>(apiValue.length).fill(-1);
    const augment = (entryIndex: number, seen: boolean[]): boolean => {
      for (const j of candidates[entryIndex]) {
        if (seen[j]) continue;
        seen[j] = true;
        if (apiMatchedBy[j] === -1 || augment(apiMatchedBy[j], seen)) {
          apiMatchedBy[j] = entryIndex;
          return true;
        }
      }
      return false;
    };

    for (let i = 0; i < overrideValue.length; i += 1) {
      const seen = new Array<boolean>(apiValue.length).fill(false);
      if (!augment(i, seen)) return false;
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
