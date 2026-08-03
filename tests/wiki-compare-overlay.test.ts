/**
 * Tests for wiki-compare overlay loading and the shared compare helpers.
 *
 * The overlay filter previously read only src/overrides/tasks.json5, so
 * discrepancies already corrected in a mode-specific file were reported as
 * new. That noise is why the regular-mode experience regression stayed hidden.
 */

import { describe, it, expect } from 'vitest';
import {
  taskOverlayFiles,
  loadDivergentFieldKeys,
  loadSuppressedFields,
} from '../scripts/wiki-compare/overlay.js';
import { compareSubset, valuesEqual, formatValue } from '../src/lib/index.js';

describe('taskOverlayFiles', () => {
  const files = taskOverlayFiles();

  it('includes the base override file', () => {
    expect(files.some((f) => f.endsWith('src/overrides/tasks.json5'))).toBe(true);
  });

  it('includes both mode-specific override files', () => {
    expect(
      files.some((f) => f.endsWith('src/overrides/modes/regular/tasks.json5'))
    ).toBe(true);
    expect(files.some((f) => f.endsWith('src/overrides/modes/pve/tasks.json5'))).toBe(
      true
    );
  });
});

describe('loadSuppressedFields', () => {
  it('suppresses fields corrected in mode-specific files, not just the base file', () => {
    const { suppressed } = loadSuppressedFields();

    // Anesthesia's experience correction lives in the PvE mode file.
    expect(suppressed.has('5eda19f0edce541157209cee:experience')).toBe(true);
  });
});

describe('loadDivergentFieldKeys', () => {
  const keys = loadDivergentFieldKeys();

  it('returns taskId:field keys for registered divergences', () => {
    expect(keys.has('5eda19f0edce541157209cee:experience')).toBe(true);
  });

  it('excludes converged entries, which need no elevation', () => {
    // A Fuel Matter is recorded as converged.
    expect(keys.has('608974d01a66564e74191fc0:minPlayerLevel')).toBe(false);
  });
});

describe('shared compare helpers', () => {
  it('ignores array ordering', () => {
    expect(valuesEqual([1, 2, 3], [3, 2, 1])).toBe(true);
  });

  it('ignores object key ordering', () => {
    expect(valuesEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
  });

  it('treats a subset object override as satisfied', () => {
    expect(compareSubset({ a: 1 }, { a: 1, b: 2 })).toBe(true);
  });

  it('does not treat a differing value as satisfied', () => {
    expect(compareSubset({ a: 1 }, { a: 2 })).toBe(false);
  });

  it('matches arrays as a subset only when asked', () => {
    expect(compareSubset([{ a: 1 }], [{ a: 1 }, { a: 2 }])).toBe(false);
    expect(compareSubset([{ a: 1 }], [{ a: 1 }, { a: 2 }], { arrayMode: 'subset' })).toBe(
      true
    );
  });

  it('distinguishes null from undefined when formatting', () => {
    expect(formatValue(null)).toBe('null');
    expect(formatValue(undefined)).toBe('undefined');
  });
});
