import { describe, it, expect } from 'vitest';
import { classify, buildRows } from '../scripts/eft-audit.js';
import { parseEftTasks, type EftTask } from '../scripts/eft-compare.js';
import type { TaskData, TaskOverride } from '../src/lib/index.js';

describe('eft-audit classify (reference -> api -> override)', () => {
  const REFERENCE = 10;

  it('GAP: api wrong, no override', () => {
    expect(classify(REFERENCE, 20, undefined)).toBe('GAP');
  });

  it('OK: api wrong, override matches client', () => {
    expect(classify(REFERENCE, 20, 10)).toBe('OK');
  });

  it('STALE: override present but api now equals client', () => {
    expect(classify(REFERENCE, 10, 10)).toBe('STALE');
  });

  it('CONFLICT: override disagrees with client', () => {
    expect(classify(REFERENCE, 20, 15)).toBe('CONFLICT');
  });

  it('null (nothing to do): api correct, no override', () => {
    expect(classify(REFERENCE, 10, undefined)).toBeNull();
  });

  it('null: api value unknown and no override (cannot judge a gap)', () => {
    expect(classify(REFERENCE, undefined, undefined)).toBeNull();
  });

  it('CONFLICT even when api is missing, if override != client', () => {
    expect(classify(REFERENCE, undefined, 15)).toBe('CONFLICT');
  });
});

describe('eft-audit buildRows', () => {
  // Reference (authoritative): level 10, xp 7500, objective count 36.
  const quests = [
    {
      _id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      name: 'aaaaaaaaaaaaaaaaaaaaaaaa name',
      rewards: { Success: [{ type: 'Experience', value: 7500 }] },
      conditions: {
        AvailableForStart: [{ id: 'lvl', conditionType: 'Level', value: 10 }],
        AvailableForFinish: [
          { id: 'bbbbbbbbbbbbbbbbbbbbbbbb', conditionType: 'CounterCreator', value: 36 },
        ],
      },
    },
  ];
  const eft: Map<string, EftTask> = parseEftTasks(quests as never);

  const apiTask = (over: Partial<TaskData>): TaskData => ({
    id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    name: 'Test Task',
    ...over,
  });

  it('flags a GAP when api is wrong and no override exists', () => {
    const rows = buildRows(eft, [apiTask({ minPlayerLevel: 20, experience: 7500 })], {});
    const gap = rows.find((r) => r.field === 'minPlayerLevel')!;
    expect(gap.verdict).toBe('GAP');
    expect(gap.reference).toBe(10);
    expect(gap.api).toBe(20);
    expect(gap.override).toBeUndefined();
  });

  it('flags OK when override corrects a still-wrong api value', () => {
    const overrides: Record<string, TaskOverride> = {
      aaaaaaaaaaaaaaaaaaaaaaaa: { minPlayerLevel: 10 },
    };
    const rows = buildRows(eft, [apiTask({ minPlayerLevel: 20, experience: 7500 })], overrides);
    const ok = rows.find((r) => r.field === 'minPlayerLevel')!;
    expect(ok.verdict).toBe('OK');
    expect(ok.override).toBe(10);
  });

  it('flags STALE when api caught up but override is still present', () => {
    const overrides: Record<string, TaskOverride> = {
      aaaaaaaaaaaaaaaaaaaaaaaa: { experience: 7500 },
    };
    const rows = buildRows(eft, [apiTask({ minPlayerLevel: 10, experience: 7500 })], overrides);
    const stale = rows.find((r) => r.field === 'experience')!;
    expect(stale.verdict).toBe('STALE');
  });

  it('flags CONFLICT on an objective count override that disagrees with the client', () => {
    const overrides: Record<string, TaskOverride> = {
      aaaaaaaaaaaaaaaaaaaaaaaa: {
        objectives: { bbbbbbbbbbbbbbbbbbbbbbbb: { count: 24 } },
      },
    };
    const rows = buildRows(
      eft,
      [
        apiTask({
          minPlayerLevel: 10,
          experience: 7500,
          objectives: [{ id: 'bbbbbbbbbbbbbbbbbbbbbbbb', count: 36 }],
        }),
      ],
      overrides,
    );
    const conflict = rows.find((r) => r.field.startsWith('objective['))!;
    expect(conflict.verdict).toBe('CONFLICT');
    expect(conflict.reference).toBe(36);
    expect(conflict.override).toBe(24);
  });

  it('emits nothing when all three sources already agree', () => {
    const rows = buildRows(eft, [apiTask({ minPlayerLevel: 10, experience: 7500 })], {});
    expect(rows).toHaveLength(0);
  });

  it('skips tasks absent from the chosen api mode', () => {
    const rows = buildRows(eft, [apiTask({ id: 'cccccccccccccccccccccccc' })], {});
    expect(rows).toHaveLength(0);
  });
});
