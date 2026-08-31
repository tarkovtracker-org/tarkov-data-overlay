import { describe, expect, it } from 'vitest';
import {
  deriveTaskUnlockDefinition,
  evaluateTaskUnlock,
  withTaskUnlockAlternatives,
  type TaskData,
  type TaskUnlockCondition,
} from '../src/lib/index.js';

const trader = { id: 'trader-1', name: 'Prapor' };
const map = { id: 'map-1', name: 'Customs' };
const prerequisite = { id: 'task-1', name: 'Debut' };

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
