import { describe, expect, it } from 'vitest';
import {
  deriveTaskUnlockDefinition,
  evaluateTaskUnlock,
  withTaskUnlockAlternatives,
  type TaskData,
  type TaskRequirement,
  type TaskRequirementGroup,
  type TraderRequirement,
  type TaskUnlockCondition,
} from '../src/lib/index.js';

const trader = { id: 'trader-1', name: 'Prapor' };
const map = { id: 'map-1', name: 'Customs' };
const prerequisite = { id: 'task-1', name: 'Debut' };

/** Build the smallest task fixture needed by the unlock-model tests. */
function makeTask(overrides: Partial<TaskData> = {}): TaskData {
  return {
    id: 'task-2',
    name: 'Shootout',
    trader,
    map,
    ...overrides,
  };
}

describe('task unlock model', () => {
  it('normalizes every start-gate source without mixing in needed keys', () => {
    const definition = deriveTaskUnlockDefinition(
      makeTask({
        minPlayerLevel: 10,
        factionName: 'USEC',
        requiredPrestige: { id: 'prestige-1', name: 'New Beginning', prestigeLevel: 2 },
        taskRequirements: [{ task: prerequisite, status: ['complete', 'failed'] }],
        taskRequirementGroups: [[{ task: { id: 'task-3', name: 'Alternative' } }]],
        traderRequirements: [
          {
            id: 'trader-level-1',
            requirementType: 'level',
            compareMethod: '>=',
            value: 2,
            trader,
          },
          {
            id: 'trader-reputation-1',
            requirementType: 'reputation',
            compareMethod: '>=',
            value: 0.7,
            trader,
          },
        ],
        otherRequirements: [
          { id: 'dialogue-1', type: 'dialogue', traders: [trader] },
          {
            id: 'global-1',
            type: 'globalVariable',
            variableId: 'variable-1',
            compareMethod: '>=',
            value: 3,
          },
        ],
        availableDelaySecondsMin: 10,
        availableDelaySecondsMax: 20,
        neededKeys: [{ map, keys: [{ id: 'key-1', name: 'Key' }] }],
      })
    );

    expect(definition.all).toEqual([
      { type: 'playerLevel', compareMethod: '>=', value: 10 },
      { type: 'faction', faction: 'USEC' },
      {
        type: 'prestigeLevel',
        prestige: { id: 'prestige-1', name: 'New Beginning', prestigeLevel: 2 },
        compareMethod: '>=',
        value: 2,
      },
      {
        type: 'traderLevel',
        requirementId: 'trader-level-1',
        trader,
        compareMethod: '>=',
        value: 2,
      },
      {
        type: 'traderReputation',
        requirementId: 'trader-reputation-1',
        trader,
        compareMethod: '>=',
        value: 0.7,
      },
      { type: 'dialogue', requirementId: 'dialogue-1', traders: [trader] },
      {
        type: 'globalVariable',
        requirementId: 'global-1',
        variableId: 'variable-1',
        compareMethod: '>=',
        value: 3,
      },
    ]);
    expect(definition.taskRequirements).toEqual([
      { type: 'taskStatus', task: prerequisite, statuses: ['complete', 'failed'] },
    ]);
    expect(definition.anyOf).toEqual([
      [{ type: 'taskStatus', task: { id: 'task-3', name: 'Alternative' }, statuses: ['complete'] }],
    ]);
    expect(definition.context).toEqual({ trader, map });
    expect(definition.timing).toEqual({ minSeconds: 10, maxSeconds: 20 });
    expect(definition.completion).toEqual({
      neededKeys: [{ map, keys: [{ id: 'key-1', name: 'Key' }] }],
    });
  });

  it('does not show a task as available when hidden/account state is missing', () => {
    const task = makeTask({
      taskRequirements: [{ task: prerequisite }],
      otherRequirements: [
        {
          id: 'global-1',
          type: 'globalVariable',
          variableId: 'variable-1',
          compareMethod: '>=',
          value: 1,
        },
      ],
    });
    const definition = deriveTaskUnlockDefinition(task);

    const result = evaluateTaskUnlock(task, definition, {});

    expect(result.status).toBe('unknown');
    expect(result.blockers).toHaveLength(0);
    expect(result.unknown.length).toBeGreaterThan(0);
  });

  it('requires every AND condition, while status values and groups are ORs', () => {
    const task = makeTask({
      taskRequirements: [{ task: prerequisite, status: ['complete', 'failed'] }],
      taskRequirementGroups: [
        [
          { task: { id: 'task-3', name: 'Alternative A' } },
          { task: { id: 'task-4', name: 'Alternative B' } },
        ],
      ],
    });
    const definition = deriveTaskUnlockDefinition(task);
    const baseState = {
      traderUnlocked: { [trader.id]: true },
      mapAccess: { [map.id]: true },
      taskStatuses: { [prerequisite.id]: 'failed', 'task-4': 'complete' },
    };

    expect(evaluateTaskUnlock(task, definition, baseState).status).toBe('available');
    expect(
      evaluateTaskUnlock(task, definition, {
        ...baseState,
        taskStatuses: { [prerequisite.id]: 'active', 'task-4': 'complete' },
      }).status
    ).toBe('blocked');
    expect(
      evaluateTaskUnlock(task, definition, {
        ...baseState,
        taskStatuses: { [prerequisite.id]: 'complete' },
      }).status
    ).toBe('unknown');
  });

  it('accepts BSG numeric quest statuses and condition-id dialogue state', () => {
    const task = makeTask({
      taskRequirements: [{ task: prerequisite, status: ['complete'] }],
      otherRequirements: [{ id: 'dialogue-1', type: 'dialogue', traders: [trader] }],
    });
    const definition = deriveTaskUnlockDefinition(task);

    expect(
      evaluateTaskUnlock(task, definition, {
        traderUnlocked: { [trader.id]: true },
        mapAccess: { [map.id]: true },
        taskStatuses: { [prerequisite.id]: 4 },
        completedConditionIds: ['dialogue-1'],
      }).status
    ).toBe('available');
  });

  it('can require an explicit story branch as an alternative to the base path', () => {
    const task = makeTask({
      taskRequirements: [{ task: prerequisite }],
      traderRequirements: [
        {
          id: 'rep-1',
          requirementType: 'reputation',
          compareMethod: '>=',
          value: 2,
          trader,
        },
      ],
    });
    const storyCondition: TaskUnlockCondition = {
      type: 'storyChapterProgress',
      storyChapter: { id: 'batya', name: 'Batya' },
    };
    const definition = withTaskUnlockAlternatives(
      deriveTaskUnlockDefinition(task),
      [[storyCondition]],
      true
    );
    const state = {
      traderUnlocked: { [trader.id]: true },
      mapAccess: { [map.id]: true },
      traderReputation: { [trader.id]: 2 },
      taskStatuses: { [prerequisite.id]: 'active' },
    };

    expect(evaluateTaskUnlock(task, definition, state).status).toBe('unknown');
    expect(
      evaluateTaskUnlock(task, definition, { ...state, storyChapters: { batya: true } }).status
    ).toBe('available');
    expect(
      evaluateTaskUnlock(task, definition, {
        ...state,
        taskStatuses: { [prerequisite.id]: 'complete' },
        storyChapters: { batya: false },
      }).status
    ).toBe('blocked');

    const nonExclusiveDefinition = withTaskUnlockAlternatives(
      deriveTaskUnlockDefinition(task),
      [[storyCondition]],
      false
    );
    expect(
      evaluateTaskUnlock(task, nonExclusiveDefinition, {
        ...state,
        taskStatuses: { [prerequisite.id]: 'complete' },
        storyChapters: { batya: false },
      }).status
    ).toBe('available');
  });

  it('does not treat an unmodeled ordinary path as available beside story branches', () => {
    const task = makeTask();
    const definition = withTaskUnlockAlternatives(
      deriveTaskUnlockDefinition(task),
      [[{ type: 'storyChapterProgress', storyChapter: { id: 'batya', name: 'Batya' } }]],
      true
    );
    const state = {
      traderUnlocked: { [trader.id]: true },
      mapAccess: { [map.id]: true },
    };

    expect(evaluateTaskUnlock(task, definition, state).status).toBe('unknown');
    expect(
      evaluateTaskUnlock(task, definition, { ...state, storyChapters: { batya: false } }).status
    ).toBe('blocked');
  });

  it('derives exclusive story branches from overlay chapters', () => {
    const task = makeTask({ id: 'story-unlocked-task' });
    const definition = deriveTaskUnlockDefinition(task, {
      storyChapters: {
        batya: {
          id: 'batya',
          name: 'Batya',
          questUnlocks: [{ id: task.id, name: task.name }],
        },
        'the-ticket': {
          id: 'the-ticket',
          name: 'The Ticket',
          questUnlocks: [{ id: task.id, name: task.name }],
        },
        unrelated: {
          id: 'unrelated',
          name: 'Unrelated',
          questUnlocks: [{ id: 'another-task', name: 'Another Task' }],
        },
      },
    });
    const state = {
      traderUnlocked: { [trader.id]: true },
      mapAccess: { [map.id]: true },
    };

    expect(definition.alternatives).toEqual([
      [{ type: 'storyChapterProgress', storyChapter: { id: 'batya', name: 'Batya' } }],
      [
        {
          type: 'storyChapterProgress',
          storyChapter: { id: 'the-ticket', name: 'The Ticket' },
        },
      ],
    ]);
    expect(definition.alternativesExclusive).toBe(true);
    expect(evaluateTaskUnlock(task, definition, state).status).toBe('unknown');
    expect(
      evaluateTaskUnlock(task, definition, {
        ...state,
        storyChapters: { batya: false, 'the-ticket': false },
      }).status
    ).toBe('blocked');
    expect(
      evaluateTaskUnlock(task, definition, { ...state, storyChapters: { 'the-ticket': true } })
        .status
    ).toBe('available');
  });

  it('reports malformed story chapters as unknown alternatives', () => {
    const task = makeTask({ id: 'story-unlocked-task' });
    const definition = deriveTaskUnlockDefinition(task, {
      storyChapters: {
        malformedA: {
          id: '' as unknown as string,
          name: 'Malformed A',
          questUnlocks: [{ id: task.id, name: task.name }],
        },
        malformedB: {
          id: undefined as unknown as string,
          name: 'Malformed B',
          questUnlocks: [{ id: task.id, name: task.name }],
        },
      },
    });

    expect(definition.alternatives).toEqual([
      [
        {
          type: 'unknown',
          requirementId: 'malformed-requirement',
          requirementType: 'malformed-story-chapter',
        },
      ],
      [
        {
          type: 'unknown',
          requirementId: 'malformed-requirement',
          requirementType: 'malformed-story-chapter',
        },
      ],
    ]);
    expect(
      evaluateTaskUnlock(task, definition, {
        traderUnlocked: { [trader.id]: true },
        mapAccess: { [map.id]: true },
      }).status
    ).toBe('unknown');
  });

  it('gates Lightkeeper-only tasks with account state', () => {
    const task = makeTask({ lightkeeperRequired: true });
    const definition = deriveTaskUnlockDefinition(task);
    const state = {
      traderUnlocked: { [trader.id]: true },
      mapAccess: { [map.id]: true },
    };

    expect(evaluateTaskUnlock(task, definition, state).status).toBe('unknown');
    expect(
      evaluateTaskUnlock(task, definition, { ...state, lightkeeperUnlocked: false }).status
    ).toBe('blocked');
    expect(
      evaluateTaskUnlock(task, definition, { ...state, lightkeeperUnlocked: true }).status
    ).toBe('available');
  });

  it('fails closed for malformed account booleans, faction, and timing values', () => {
    const baseState = {
      traderUnlocked: { [trader.id]: true },
      mapAccess: { [map.id]: true },
    };

    const factionTask = makeTask({ factionName: 'USEC' });
    expect(
      evaluateTaskUnlock(factionTask, deriveTaskUnlockDefinition(factionTask), {
        ...baseState,
        faction: null,
      } as unknown as Parameters<typeof evaluateTaskUnlock>[2]).status
    ).toBe('unknown');

    const lightkeeperTask = makeTask({ lightkeeperRequired: true });
    expect(
      evaluateTaskUnlock(lightkeeperTask, deriveTaskUnlockDefinition(lightkeeperTask), {
        ...baseState,
        lightkeeperUnlocked: 'false',
      } as unknown as Parameters<typeof evaluateTaskUnlock>[2]).status
    ).toBe('unknown');

    const timedTask = makeTask({ availableDelaySecondsMin: 10 });
    expect(
      evaluateTaskUnlock(timedTask, deriveTaskUnlockDefinition(timedTask), {
        ...baseState,
        nowSeconds: null,
        taskAvailableSince: { [timedTask.id]: null },
      } as unknown as Parameters<typeof evaluateTaskUnlock>[2]).status
    ).toBe('unknown');
  });

  it('fails closed for malformed task-level numeric definitions', () => {
    const baseState = {
      playerLevel: 100,
      prestigeLevel: 100,
      traderUnlocked: { [trader.id]: true },
      mapAccess: { [map.id]: true },
      nowSeconds: 100,
      taskAvailableSince: { 'task-2': 0 },
    };

    for (const task of [
      makeTask({ minPlayerLevel: -1 }),
      makeTask({ requiredPrestige: { name: 'Broken', prestigeLevel: -1 } }),
      makeTask({ requiredPrestige: { id: '', name: 'Broken', prestigeLevel: 1 } }),
      makeTask({ availableDelaySecondsMin: -1 }),
      makeTask({ availableDelaySecondsMin: 20, availableDelaySecondsMax: 10 }),
    ]) {
      const definition = deriveTaskUnlockDefinition(task);
      expect(evaluateTaskUnlock(task, definition, baseState).status).toBe('unknown');
    }
  });

  it('does not default malformed task status requirements to complete', () => {
    const task = makeTask({
      taskRequirements: [{ task: prerequisite, status: [123 as unknown as string] }],
    });
    const definition = deriveTaskUnlockDefinition(task);
    const result = evaluateTaskUnlock(task, definition, {
      traderUnlocked: { [trader.id]: true },
      mapAccess: { [map.id]: true },
      taskStatuses: { [prerequisite.id]: 'complete' },
    });

    expect(result.status).toBe('unknown');
    expect(result.unknown).toHaveLength(1);
  });

  it('does not accept unknown future task statuses as satisfied', () => {
    const task = makeTask({
      taskRequirements: [{ task: prerequisite, status: ['future-status'] }],
    });
    const definition = deriveTaskUnlockDefinition(task);
    const result = evaluateTaskUnlock(task, definition, {
      traderUnlocked: { [trader.id]: true },
      mapAccess: { [map.id]: true },
      taskStatuses: { [prerequisite.id]: 'future-status' },
    });

    expect(result.status).toBe('unknown');
  });

  it('fails closed instead of throwing for malformed definitions or state', () => {
    const task = makeTask();
    const malformedDefinition = {
      all: [null],
      taskRequirements: [],
      anyOf: [[{ type: 'future-condition' }]],
      context: {},
      alternatives: [[]],
    } as unknown as Parameters<typeof evaluateTaskUnlock>[1];
    const malformedState = null as unknown as Parameters<typeof evaluateTaskUnlock>[2];

    expect(() => evaluateTaskUnlock(task, malformedDefinition, malformedState)).not.toThrow();
    expect(evaluateTaskUnlock(task, malformedDefinition, malformedState).status).toBe('unknown');
  });

  it('fails closed for malformed context, timing, task, and options values', () => {
    const task = makeTask();
    const definition = {
      ...deriveTaskUnlockDefinition(task),
      context: { trader: 'not-a-trader', map: [] },
      timing: 'not-timing',
      alternatives: [
        [{ type: 'storyChapterProgress', storyChapter: { id: 'chapter', name: 'C' } }],
      ],
      alternativesExclusive: 'false',
    } as unknown as Parameters<typeof evaluateTaskUnlock>[1];

    expect(() =>
      evaluateTaskUnlock(
        null as unknown as Parameters<typeof evaluateTaskUnlock>[0],
        definition,
        {},
        null as unknown as Parameters<typeof evaluateTaskUnlock>[3]
      )
    ).not.toThrow();
    expect(
      evaluateTaskUnlock(
        null as unknown as Parameters<typeof evaluateTaskUnlock>[0],
        definition,
        {},
        null as unknown as Parameters<typeof evaluateTaskUnlock>[3]
      ).status
    ).toBe('unknown');
  });

  it('fails closed for malformed known condition definitions', () => {
    const state = {
      faction: '',
      taskStatuses: { prerequisite: 'complete' },
      traderLevels: { [trader.id]: 4 },
      globalVariables: { variable: 10 },
      dialogues: { dialogue: true },
      storyChapters: { chapter: true },
    };
    const invalidConditions: TaskUnlockCondition[] = [
      { type: 'faction', faction: '' },
      { type: 'taskStatus', task: { id: '', name: 'Broken' }, statuses: ['complete'] },
      {
        type: 'traderLevel',
        requirementId: '',
        trader,
        compareMethod: '>=',
        value: 1,
      },
      {
        type: 'globalVariable',
        requirementId: 'global',
        variableId: '',
        compareMethod: '>=',
        value: 1,
      },
      { type: 'dialogue', requirementId: 'dialogue', traders: [] },
      {
        type: 'storyChapterProgress',
        storyChapter: { id: '', name: 'Broken chapter' },
      },
    ];

    for (const condition of invalidConditions) {
      const definition = {
        all: [condition],
        taskRequirements: [],
        anyOf: [],
        context: {},
      };
      expect(evaluateTaskUnlock(makeTask(), definition, state).status).toBe('unknown');
    }
  });

  it('fails closed for a task with an empty identity', () => {
    const task = makeTask({ id: '', name: '' });
    const definition = deriveTaskUnlockDefinition(task);

    expect(evaluateTaskUnlock(task, definition, {}).status).toBe('unknown');
  });

  it.each([null, {}, [], ['', 'complete'], 123, Number.NaN])(
    'returns unknown instead of throwing for malformed profile status %j',
    (status) => {
      const task = makeTask({ taskRequirements: [{ task: prerequisite }] });
      const definition = deriveTaskUnlockDefinition(task);
      const state = {
        traderUnlocked: { [trader.id]: true },
        mapAccess: { [map.id]: true },
        taskStatuses: { [prerequisite.id]: status },
      } as unknown as Parameters<typeof evaluateTaskUnlock>[2];

      expect(() => evaluateTaskUnlock(task, definition, state)).not.toThrow();
      expect(evaluateTaskUnlock(task, definition, state).status).toBe('unknown');
    }
  );

  it('returns unknown for malformed completed condition state', () => {
    const task = makeTask({
      otherRequirements: [{ id: 'dialogue-1', type: 'dialogue', traders: [trader] }],
    });
    const definition = deriveTaskUnlockDefinition(task);
    const state = {
      traderUnlocked: { [trader.id]: true },
      mapAccess: { [map.id]: true },
      completedConditionIds: { includes: () => true },
    } as unknown as Parameters<typeof evaluateTaskUnlock>[2];

    expect(() => evaluateTaskUnlock(task, definition, state)).not.toThrow();
    expect(evaluateTaskUnlock(task, definition, state).status).toBe('unknown');
  });

  it('does not skip sparse malformed requirement or profile arrays', () => {
    const sparseRequirements = new Array<TaskRequirement>(1);
    const task = makeTask({ taskRequirements: sparseRequirements });
    const definition = deriveTaskUnlockDefinition(task);
    const state = {
      traderUnlocked: { [trader.id]: true },
      mapAccess: { [map.id]: true },
      taskStatuses: {},
    };

    expect(evaluateTaskUnlock(task, definition, state).status).toBe('unknown');

    const malformedStatus = new Array<string>(2);
    malformedStatus[0] = 'complete';
    const statusTask = makeTask({ taskRequirements: [{ task: prerequisite }] });
    const statusDefinition = deriveTaskUnlockDefinition(statusTask);
    expect(
      evaluateTaskUnlock(statusTask, statusDefinition, {
        traderUnlocked: { [trader.id]: true },
        mapAccess: { [map.id]: true },
        taskStatuses: { [prerequisite.id]: malformedStatus },
      })
    ).toMatchObject({ status: 'unknown' });

    const dialogueTask = makeTask({
      otherRequirements: [{ id: 'dialogue-1', type: 'dialogue', traders: [trader] }],
    });
    const dialogueDefinition = deriveTaskUnlockDefinition(dialogueTask);
    const completedConditionIds = new Array<string>(2);
    completedConditionIds[0] = 'dialogue-1';
    expect(
      evaluateTaskUnlock(dialogueTask, dialogueDefinition, {
        traderUnlocked: { [trader.id]: true },
        mapAccess: { [map.id]: true },
        completedConditionIds,
      })
    ).toMatchObject({ status: 'unknown' });
  });

  it('fails closed for malformed nested requirements', () => {
    const task = makeTask({
      taskRequirements: [null as unknown as TaskRequirement],
      taskRequirementGroups: [null as unknown as TaskRequirementGroup],
      traderRequirements: [null as unknown as TraderRequirement],
    });
    const definition = deriveTaskUnlockDefinition(task);
    const state = {
      traderUnlocked: { [trader.id]: true },
      mapAccess: { [map.id]: true },
    };

    expect(() => evaluateTaskUnlock(task, definition, state)).not.toThrow();
    expect(evaluateTaskUnlock(task, definition, state).status).toBe('unknown');
  });

  it('allows callers to skip unavailable account feeds explicitly', () => {
    const task = makeTask({
      lightkeeperRequired: true,
      availableDelaySecondsMin: 10,
      availableDelaySecondsMax: 20,
    });
    const definition = deriveTaskUnlockDefinition(task);
    const result = evaluateTaskUnlock(
      task,
      definition,
      {},
      {
        checkTraderUnlock: false,
        checkLightkeeperAccess: false,
        checkMapAccess: false,
        checkTiming: false,
      }
    );

    expect(result.status).toBe('available');
    expect(result.context).toEqual([]);
  });

  it('rejects empty externally supplied alternative branches', () => {
    expect(() => withTaskUnlockAlternatives(deriveTaskUnlockDefinition(makeTask()), [[]])).toThrow(
      /at least one condition/
    );
    expect(() => withTaskUnlockAlternatives(deriveTaskUnlockDefinition(makeTask()), [])).toThrow(
      /at least one branch/
    );
  });

  it('does not treat an explicit empty alternatives definition as absent', () => {
    const task = makeTask({ taskRequirements: [{ task: prerequisite }] });
    const definition = {
      ...deriveTaskUnlockDefinition(task),
      alternatives: [],
      alternativesExclusive: true,
    };

    expect(
      evaluateTaskUnlock(task, definition, {
        traderUnlocked: { [trader.id]: true },
        mapAccess: { [map.id]: true },
        taskStatuses: { [prerequisite.id]: 'complete' },
      }).status
    ).toBe('unknown');
  });

  it('keeps a random availability window unknown until its upper bound elapses', () => {
    const task = makeTask({ availableDelaySecondsMin: 10, availableDelaySecondsMax: 20 });
    const definition = deriveTaskUnlockDefinition(task);
    const state = {
      traderUnlocked: { [trader.id]: true },
      mapAccess: { [map.id]: true },
      taskAvailableSince: { [task.id]: 100 },
      nowSeconds: 115,
    };

    expect(evaluateTaskUnlock(task, definition, state).status).toBe('unknown');
    expect(evaluateTaskUnlock(task, definition, { ...state, nowSeconds: 120 }).status).toBe(
      'available'
    );
  });
});
