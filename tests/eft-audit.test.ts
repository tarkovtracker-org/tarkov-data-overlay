import { describe, it, expect, vi } from 'vitest';
import { classify, buildRows, effectiveOverrides } from '../scripts/eft-audit.js';
import { parseEftTasks, type EftTask } from '../scripts/eft-compare.js';
import { loadJson5File, type TaskData, type TaskOverride } from '../src/lib/index.js';

vi.mock('../src/lib/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/index.js')>();
  return { ...actual, loadJson5File: vi.fn(actual.loadJson5File) };
});

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
      overrides
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

  it('reports a client edge to an API-missing task as unresolved', () => {
    const reference = parseEftTasks([
      {
        _id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
        conditions: {
          AvailableForStart: [
            {
              id: 'cccccccccccccccccccccccc',
              conditionType: 'Quest',
              target: 'dddddddddddddddddddddddd',
            },
          ],
        },
      },
    ] as never);

    const rows = buildRows(reference, [apiTask({ taskRequirements: [] })], {});

    expect(rows).toEqual([
      expect.objectContaining({
        field: 'taskRequirements',
        reference: 'dddddddddddddddddddddddd',
        api: '(none)',
        verdict: 'UNRESOLVED',
        note: expect.stringContaining('dddddddddddddddddddddddd'),
      }),
    ]);
  });
});

describe('eft-audit prerequisite condition semantics', () => {
  const taskId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
  const target = 'dddddddddddddddddddddddd';
  const requirement = (statuses?: string[]) => ({
    task: { id: target, name: 'Prerequisite' },
    ...(statuses === undefined ? {} : { status: statuses }),
  });
  const reference = (...args: [statuses?: unknown[]]) =>
    parseEftTasks([
      {
        _id: taskId,
        conditions: {
          AvailableForStart: [
            {
              id: 'condition',
              conditionType: 'Quest',
              target,
              status: args.length === 0 ? [4] : args[0],
            },
          ],
        },
      },
    ] as never);
  const audit = (
    eft: Map<string, EftTask>,
    requirements: TaskData['taskRequirements'],
    override?: TaskOverride
  ) =>
    buildRows(
      eft,
      [
        { id: taskId, name: 'Task', taskRequirements: requirements },
        { id: target, name: 'Prerequisite' },
      ],
      override ? { [taskId]: override } : {}
    ).filter((row) => row.field === 'taskRequirements');

  it('reports a status-only upstream discrepancy as GAP', () => {
    expect(audit(reference(), [requirement(['active'])])[0].verdict).toBe('GAP');
  });

  it('reports a corrected status override as OK rather than STALE', () => {
    expect(
      audit(reference(), [requirement(['active'])], { taskRequirements: [requirement()] })[0]
        .verdict
    ).toBe('OK');
  });

  it('reports an override with the wrong status as CONFLICT', () => {
    expect(
      audit(reference(), [requirement()], { taskRequirements: [requirement(['active'])] })[0]
        .verdict
    ).toBe('CONFLICT');
  });

  it('accepts legitimate aliases, omitted completion, and reordered status sets', () => {
    expect(
      audit(reference(), [requirement()], { taskRequirements: [requirement(['completed'])] })[0]
        .verdict
    ).toBe('STALE');
    expect(
      audit(reference([2, 4]), [requirement(['completed', 'accepted'])], {
        taskRequirements: [requirement(['started', 'success', 'started'])],
      })[0].verdict
    ).toBe('STALE');
  });

  it.each([
    [1, 'active'],
    [3, 'active'],
    [9, 'active'],
    [6, 'failed'],
    [7, 'failed'],
    [8, 'failed'],
  ])('keeps numeric state %s distinct from %s', (state, conflated) => {
    expect(audit(reference([state]), [requirement([String(conflated)])])[0].verdict).toBe('GAP');
  });

  it('preserves repeated-target AND conditions rather than unioning their statuses', () => {
    const eft = parseEftTasks([
      {
        _id: taskId,
        conditions: {
          AvailableForStart: [
            { id: 'first', conditionType: 'Quest', target, status: [2] },
            { id: 'second', conditionType: 'Quest', target, status: [4] },
          ],
        },
      },
    ] as never);
    expect(audit(eft, [requirement(['active', 'complete'])])[0].verdict).toBe('GAP');
    expect(
      audit(eft, [requirement(['active']), requirement()], {
        taskRequirements: [requirement(['completed']), requirement(['started'])],
      })[0].verdict
    ).toBe('STALE');
  });

  it.each([undefined, [], [4, 99], ['unknown']])(
    'reports unavailable or unsupported capture statuses %j as UNRESOLVED',
    (statuses) => {
      expect(
        audit(reference(statuses), [requirement()], { taskRequirements: [requirement()] })[0]
          .verdict
      ).toBe('UNRESOLVED');
    }
  );

  it('does not infer statuses from legacy ID-only reference objects', () => {
    const eft = reference();
    delete eft.get(taskId)!.prerequisiteConditions;
    expect(audit(eft, [requirement()])[0].verdict).toBe('UNRESOLVED');
  });

  it('reports malformed target evidence and API/override statuses as UNRESOLVED', () => {
    const eft = parseEftTasks([
      {
        _id: taskId,
        conditions: { AvailableForStart: [{ id: 'first', conditionType: 'Quest', status: [4] }] },
      },
    ] as never);
    expect(audit(eft, [])[0].verdict).toBe('UNRESOLVED');
    expect(audit(reference(), [requirement([])])[0].verdict).toBe('UNRESOLVED');
    expect(
      audit(reference(), [requirement()], { taskRequirements: [requirement(['unknown'])] })[0]
        .verdict
    ).toBe('UNRESOLVED');
  });

  it('retains the guard against flattening grouped requirements', () => {
    expect(
      audit(reference(), [], { taskRequirements: [], taskRequirementGroups: [[requirement()]] })
    ).toEqual([]);
    expect(
      buildRows(
        reference(),
        [
          { id: taskId, name: 'Task', taskRequirementGroups: [[requirement()]] },
          { id: target, name: 'Prerequisite' },
        ],
        {}
      )
    ).toEqual([]);
  });

  it('adjudicates an explicitly empty reference prerequisite list', () => {
    const eft = parseEftTasks([{ _id: taskId, conditions: { AvailableForStart: [] } }] as never);
    expect(audit(eft, [], { taskRequirements: [requirement()] })[0].verdict).toBe('CONFLICT');
  });
});

it('merges shared objective counts with mode descriptions in the effective audit overlay', () => {
  const taskId = 'aaaaaaaaaaaaaaaaaaaaaaaa';
  const objectiveId = 'bbbbbbbbbbbbbbbbbbbbbbbb';
  vi.mocked(loadJson5File)
    .mockReturnValueOnce({
      [taskId]: {
        objectives: { [objectiveId]: { count: 36 } },
        objectivesAdd: [{ id: 'shared', description: 'Shared' }],
      },
    })
    .mockReturnValueOnce({
      [taskId]: {
        objectives: { [objectiveId]: { description: 'Mode description' } },
        objectivesAdd: [{ id: 'mode', description: 'Mode' }],
      },
    });
  const merged = effectiveOverrides('pve');
  expect(merged[taskId].objectives?.[objectiveId]).toEqual({
    count: 36,
    description: 'Mode description',
  });
  expect(merged[taskId].objectivesAdd?.map((objective) => objective.id)).toEqual([
    'shared',
    'mode',
  ]);
  const eft = parseEftTasks([
    {
      _id: taskId,
      conditions: {
        AvailableForStart: [],
        AvailableForFinish: [{ id: objectiveId, conditionType: 'CounterCreator', value: 36 }],
      },
    },
  ] as never);
  expect(
    buildRows(
      eft,
      [{ id: taskId, name: 'Task', objectives: [{ id: objectiveId, count: 24 }] }],
      merged
    )[0].verdict
  ).toBe('OK');
});
