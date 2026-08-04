/**
 * Tests for divergence-validator module
 *
 * These cover the failure mode that motivated the registry: tarkov.dev serving
 * one game mode's value in the other, and the mirror direction flipping over
 * time so that a single-mode override silently becomes insufficient.
 */

import { describe, it, expect } from 'vitest';
import {
  validateDivergences,
  categorizeDivergenceResults,
  effectiveOverrideValue,
  type DivergenceModeContext,
  type TaskData,
  type TaskDivergence,
  type TaskOverride,
} from '../src/lib/index.js';

const TASK_ID = '5eda19f0edce541157209cee';

const makeTask = (experience: number): TaskData =>
  ({
    id: TASK_ID,
    name: 'Anesthesia',
    minPlayerLevel: 10,
    objectives: [],
    experience,
  }) as unknown as TaskData;

const registry = (
  overrides: Partial<TaskDivergence['fields']['experience']> = {}
): Record<string, TaskDivergence> => ({
  [TASK_ID]: {
    name: 'Anesthesia',
    proof: 'https://escapefromtarkov.fandom.com/wiki/Anesthesia',
    status: 'divergent',
    fields: {
      experience: {
        regular: 18100,
        pve: 9800,
        confidence: 'high',
        verified: '2026-08-03',
        ...overrides,
      },
    },
  },
});

const ctx = (
  experience: number,
  modeOverrides: Record<string, TaskOverride> = {}
): DivergenceModeContext => ({
  apiTasks: [makeTask(experience)],
  modeOverrides,
});

describe('effectiveOverrideValue', () => {
  it('prefers mode-specific overrides over base overrides', () => {
    const base = { [TASK_ID]: { experience: 1 } } as Record<string, TaskOverride>;
    const mode = { [TASK_ID]: { experience: 2 } } as Record<string, TaskOverride>;

    expect(effectiveOverrideValue(TASK_ID, 'experience', base, mode)).toBe(2);
  });

  it('falls back to the base override when the mode file does not cover the field', () => {
    const base = { [TASK_ID]: { experience: 1 } } as Record<string, TaskOverride>;

    expect(effectiveOverrideValue(TASK_ID, 'experience', base, {})).toBe(1);
  });

  it('returns undefined when no override covers the field', () => {
    expect(effectiveOverrideValue(TASK_ID, 'experience', {}, {})).toBeUndefined();
  });

  it('treats an explicit null override as a value, not as absence', () => {
    const base = { [TASK_ID]: { map: null } } as unknown as Record<string, TaskOverride>;

    expect(effectiveOverrideValue(TASK_ID, 'map', base, {})).toBeNull();
  });
});

describe('validateDivergences', () => {
  it('flags OVERRIDE_MISSING when upstream is wrong and nothing corrects it', () => {
    // The regression shape: upstream mirrors the PvE value into regular.
    const results = validateDivergences(
      registry(),
      {},
      {
        regular: ctx(9800),
        pve: ctx(9800),
      }
    );

    const regular = results.find((r) => r.mode === 'regular');
    expect(regular?.verdict).toBe('OVERRIDE_MISSING');
    expect(regular?.expected).toBe(18100);
    expect(regular?.upstream).toBe(9800);
  });

  it('detects that upstream is mirroring one mode into the other', () => {
    const results = validateDivergences(
      registry(),
      {},
      {
        regular: ctx(9800),
        pve: ctx(9800),
      }
    );

    expect(results.every((r) => r.mirrored)).toBe(true);
  });

  it('does not report mirroring when upstream serves distinct values', () => {
    const results = validateDivergences(
      registry(),
      {},
      {
        regular: ctx(18100),
        pve: ctx(9800),
      }
    );

    expect(results.some((r) => r.mirrored)).toBe(false);
    expect(results.every((r) => r.verdict === 'UPSTREAM_CORRECT')).toBe(true);
  });

  it('reports OVERRIDE_ACTIVE when an override supplies the value upstream lacks', () => {
    const results = validateDivergences(
      registry(),
      {},
      {
        regular: ctx(9800, { [TASK_ID]: { experience: 18100 } as TaskOverride }),
        pve: ctx(9800),
      }
    );

    expect(results.find((r) => r.mode === 'regular')?.verdict).toBe('OVERRIDE_ACTIVE');
  });

  it('reports OVERRIDE_REDUNDANT rather than "stale" when upstream agrees', () => {
    // This is the case that must never be presented as "safe to delete":
    // removing it is what lets a mirror flip go unnoticed.
    const results = validateDivergences(
      registry(),
      {},
      {
        pve: ctx(9800, { [TASK_ID]: { experience: 9800 } as TaskOverride }),
      }
    );

    expect(results[0].verdict).toBe('OVERRIDE_REDUNDANT');
  });

  it('reports OVERRIDE_WRONG when an override disagrees with recorded truth', () => {
    const results = validateDivergences(
      registry(),
      {},
      {
        regular: ctx(9800, { [TASK_ID]: { experience: 12345 } as TaskOverride }),
      }
    );

    expect(results[0].verdict).toBe('OVERRIDE_WRONG');
  });

  it('reports NOT_IN_MODE when the task is absent from that mode', () => {
    const results = validateDivergences(
      registry(),
      {},
      {
        regular: { apiTasks: [], modeOverrides: {} },
      }
    );

    expect(results[0].verdict).toBe('NOT_IN_MODE');
  });

  it('skips modes the registry records no value for', () => {
    const pveOnly: Record<string, TaskDivergence> = {
      [TASK_ID]: {
        name: 'Easy Money - Part 2',
        proof: 'https://escapefromtarkov.fandom.com/wiki/Easy_Money_-_Part_2',
        status: 'mode-exclusive',
        fields: {
          experience: { pve: 2900, confidence: 'high', verified: '2026-08-03' },
        },
      },
    };

    const results = validateDivergences(
      pveOnly,
      {},
      {
        regular: ctx(2900),
        pve: ctx(2900),
      }
    );

    expect(results).toHaveLength(1);
    expect(results[0].mode).toBe('pve');
  });

  it('honours base overrides when no mode-specific override exists', () => {
    const base = { [TASK_ID]: { experience: 18100 } } as Record<string, TaskOverride>;
    const results = validateDivergences(registry(), base, { regular: ctx(9800) });

    expect(results[0].verdict).toBe('OVERRIDE_ACTIVE');
  });

  it('carries confidence and proof through to the result', () => {
    const results = validateDivergences(
      registry({ confidence: 'medium' }),
      {},
      {
        regular: ctx(9800),
      }
    );

    expect(results[0].confidence).toBe('medium');
    expect(results[0].proof).toContain('escapefromtarkov.fandom.com');
  });

  it('reports UPSTREAM_CORRECT in both modes for a converged entry', () => {
    // A converged field holds the same value for both modes and upstream serves
    // it, so no override is needed and nothing should read as mirrored.
    const converged: Record<string, TaskDivergence> = {
      '608974d01a66564e74191fc0': {
        name: 'A Fuel Matter',
        proof: 'https://escapefromtarkov.fandom.com/wiki/A_Fuel_Matter',
        status: 'converged',
        fields: {
          minPlayerLevel: { regular: 15, pve: 15, confidence: 'high', verified: '2026-08-03' },
        },
      },
    };
    const withLevel = (level: number): DivergenceModeContext => ({
      apiTasks: [
        {
          id: '608974d01a66564e74191fc0',
          name: 'A Fuel Matter',
          minPlayerLevel: level,
          objectives: [],
        } as unknown as TaskData,
      ],
      modeOverrides: {},
    });

    const results = validateDivergences(
      converged,
      {},
      {
        regular: withLevel(15),
        pve: withLevel(15),
      }
    );

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.verdict === 'UPSTREAM_CORRECT')).toBe(true);
    expect(results.some((r) => r.mirrored)).toBe(false);
  });
});

describe('categorizeDivergenceResults', () => {
  it('separates actionable problems from intentional guards', () => {
    const results = validateDivergences(
      registry(),
      {},
      {
        regular: ctx(9800),
        pve: ctx(9800, { [TASK_ID]: { experience: 9800 } as TaskOverride }),
      }
    );

    const grouped = categorizeDivergenceResults(results);

    expect(grouped.missing).toHaveLength(1);
    expect(grouped.redundant).toHaveLength(1);
    expect(grouped.wrong).toHaveLength(0);
  });
});
