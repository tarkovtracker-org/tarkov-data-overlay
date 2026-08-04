/**
 * Tests for wiki-compare overlay loading and the shared compare helpers.
 *
 * The overlay filter previously read only src/overrides/tasks.json5, so
 * discrepancies already corrected in a mode-specific file were reported as
 * new. That noise is why the regular-mode experience regression stayed hidden.
 */

import { describe, it, expect } from 'vitest';
import { join } from 'path';
import {
  taskOverlayFiles,
  loadDivergentFieldKeys,
  loadSuppressedFields,
} from '../scripts/wiki-compare/overlay.js';
import { compareSubset, valuesEqual, formatValue } from '../src/lib/index.js';

const base = join('src', 'overrides', 'tasks.json5');
const regularFile = join('src', 'overrides', 'modes', 'regular', 'tasks.json5');
const pveFile = join('src', 'overrides', 'modes', 'pve', 'tasks.json5');

describe('taskOverlayFiles', () => {
  it('includes the base override file', () => {
    expect(taskOverlayFiles().some((f) => f.endsWith(base))).toBe(true);
  });

  it('includes both mode files in the default "both" scope', () => {
    const files = taskOverlayFiles('both');
    expect(files.some((f) => f.endsWith(regularFile))).toBe(true);
    expect(files.some((f) => f.endsWith(pveFile))).toBe(true);
  });

  it('scopes to base + the requested mode only', () => {
    const regular = taskOverlayFiles('regular');
    expect(regular.some((f) => f.endsWith(regularFile))).toBe(true);
    expect(regular.some((f) => f.endsWith(pveFile))).toBe(false);

    const pve = taskOverlayFiles('pve');
    expect(pve.some((f) => f.endsWith(pveFile))).toBe(true);
    expect(pve.some((f) => f.endsWith(regularFile))).toBe(false);
  });
});

describe('loadSuppressedFields', () => {
  it('suppresses fields corrected in mode-specific files, not just the base file', () => {
    // Anesthesia's active experience correction lives in the REGULAR mode file;
    // the PvE entry is parked (commented out). Default scope reads both.
    const { suppressed } = loadSuppressedFields();
    expect(suppressed.has('5eda19f0edce541157209cee:experience')).toBe(true);
  });

  it('does not let a regular-mode correction suppress when scoped to pve', () => {
    // The regression this PR guards against: a correction present only in the
    // regular file must not mask a pve comparison. Anesthesia is corrected in
    // regular, so under pve scope its key must be absent.
    const { suppressed } = loadSuppressedFields('pve');
    expect(suppressed.has('5eda19f0edce541157209cee:experience')).toBe(false);
  });

  it('still suppresses the regular correction under regular scope', () => {
    const { suppressed } = loadSuppressedFields('regular');
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
    expect(compareSubset([{ a: 1 }], [{ a: 1 }, { a: 2 }], { arrayMode: 'subset' })).toBe(true);
  });

  it('subset matching backtracks past a bad greedy pick (overlapping candidates)', () => {
    // Override [{a:1}, {a:1,b:2}] against API [{a:1,b:2}, {a:1}]: a greedy
    // first-match binds {a:1}->{a:1,b:2}, then {a:1,b:2} can't match {a:1}.
    // A correct distinct assignment exists, so this must be true.
    expect(
      compareSubset([{ a: 1 }, { a: 1, b: 2 }], [{ a: 1, b: 2 }, { a: 1 }], { arrayMode: 'subset' })
    ).toBe(true);
  });

  it('subset matching rejects when no distinct assignment exists', () => {
    expect(compareSubset([{ a: 1 }, { a: 1 }], [{ a: 1 }], { arrayMode: 'subset' })).toBe(false);
  });

  it('subset matching finds an assignment that requires reshuffling (augmenting path)', () => {
    // {a:1} and {b:2} both also match {a:1,b:2}; only a reshuffle yields a full
    // distinct assignment: {a:1}->[1], {b:2}->[2], {a:1,b:2}->[0].
    expect(
      compareSubset([{ a: 1 }, { b: 2 }, { a: 1, b: 2 }], [{ a: 1, b: 2 }, { a: 1 }, { b: 2 }], {
        arrayMode: 'subset',
      })
    ).toBe(true);
  });

  it('treats reordered mixed-type arrays as equal (type-tagged sort keys)', () => {
    expect(valuesEqual([1, '1', true], [true, '1', 1])).toBe(true);
    // The number 1 and the string '1' must remain distinguishable.
    expect(valuesEqual([1, 1], ['1', '1'])).toBe(false);
  });

  it('distinguishes null from undefined when formatting', () => {
    expect(formatValue(null)).toBe('null');
    expect(formatValue(undefined)).toBe('undefined');
  });
});
