import { describe, expect, it } from 'vitest';
import { join } from 'path';
import {
  deriveTaskUnlockDefinition,
  evaluateTaskUnlock,
  evaluateTaskProgression,
  getProjectPaths,
  loadJson5File,
  SUPPORTED_GAME_MODES,
  TARKOV_TRADER_NAMES_BY_ID,
  type StoryChapter,
  type TaskData,
  type TaskOverride,
} from '../src/lib/index.js';
import { applyTaskOverride, getTaskOverrideForMode } from '../examples/apply-overlay.js';

const paths = getProjectPaths();
const tasks = loadJson5File<Record<string, TaskOverride>>(
  join(paths.srcDir, 'overrides/tasks.json5')
);
const chapters = loadJson5File<Record<string, StoryChapter>>(
  join(paths.srcDir, 'additions/storyChapters.json5')
);
const objectiveId = '69bc0b6069651f9af0993d2c';
const boreasTasks = [
  '69ce1cfb298a6529b30d712b',
  '69ce204c8702b378f9091e4b',
  '69ce1de03e15cd80bd06f6c9',
];

function evaluate(requirements: TaskData['otherRequirements'], state = {}) {
  const task: TaskData = {
    id: 'test',
    name: 'Test',
    trader: { id: 'trader', name: 'Trader' },
    otherRequirements: requirements,
  };
  return evaluateTaskUnlock(task, deriveTaskUnlockDefinition(task), {
    traderUnlocked: { trader: true },
    ...state,
  });
}

describe('verified story objective gates', () => {
  it.each(boreasTasks)('references the existing hand-in objective for %s', (id) => {
    const requirement = tasks[id].otherRequirements?.[0];
    const objective = chapters.boreas.objectives?.find((entry) => entry.id === objectiveId);
    expect(objective).toBeDefined();
    expect(requirement).toMatchObject({
      type: 'storyObjective',
      storyChapter: { id: chapters.boreas.id, name: chapters.boreas.name },
      objective: { id: objectiveId, name: objective?.description },
    });
    expect(tasks[id].taskRequirements).toBeUndefined();
    expect(evaluate(tasks[id].otherRequirements).status).toBe('unknown');
    expect(evaluate(tasks[id].otherRequirements, { storyChapters: { boreas: true } }).status).toBe(
      'unknown'
    );
    expect(
      evaluate(tasks[id].otherRequirements, {
        storyObjectives: { boreas: { [objectiveId]: false } },
      }).status
    ).toBe('blocked');
    expect(
      evaluate(tasks[id].otherRequirements, {
        storyObjectives: { boreas: { [objectiveId]: true } },
      }).status
    ).toBe('available');
  });

  it('fails closed for malformed definitions and account values', () => {
    const requirement = tasks[boreasTasks[0]].otherRequirements![0];
    for (const objective of [undefined, {}, { id: '', name: 'invalid' }]) {
      expect(evaluate([{ ...requirement, objective }]).status).toBe('unknown');
    }
    for (const value of [null, 1, 'true']) {
      expect(
        evaluate([requirement], {
          storyObjectives: { boreas: { [objectiveId]: value } },
        }).status
      ).toBe('unknown');
    }
    expect(
      evaluate([requirement], {
        storyObjectives: { otherChapter: { [objectiveId]: true } },
      }).status
    ).toBe('unknown');
  });

  it('preserves recorded lifecycle history when objective progress is unavailable', () => {
    const task: TaskData = {
      id: boreasTasks[0],
      name: 'A Wedge Between Us',
      trader: { id: 'trader', name: 'Trader' },
      otherRequirements: tasks[boreasTasks[0]].otherRequirements,
    };
    for (const status of ['active', 'complete']) {
      const result = evaluateTaskProgression(
        task,
        {
          traderUnlocked: { trader: true },
          taskStatuses: { [task.id]: status },
        },
        { mode: 'regular' }
      );
      expect(result.recordedStatus).toBe(status);
      expect(result.status).toBe('unknown');
    }
  });

  it('does not bypass an independent global-variable gate', () => {
    const requirements = [
      ...tasks[boreasTasks[0]].otherRequirements!,
      {
        id: 'counter',
        type: 'globalVariable' as const,
        variableId: 'group',
        compareMethod: '>=' as const,
        value: 2,
      },
    ];
    const state = { storyObjectives: { boreas: { [objectiveId]: true } } };
    expect(evaluate(requirements, state).status).toBe('unknown');
    expect(evaluate(requirements, { ...state, globalVariables: { group: 1 } }).status).toBe(
      'blocked'
    );
    expect(evaluate(requirements, { ...state, globalVariables: { group: 2 } }).status).toBe(
      'available'
    );
  });
});

describe('verified faction and loyalty corrections', () => {
  it.each(SUPPORTED_GAME_MODES)('preserves independent gates in %s', (mode) => {
    const modeTasks = loadJson5File<Record<string, TaskOverride>>(
      join(paths.srcDir, 'overrides/modes', mode, 'tasks.json5')
    );
    const overlay = { tasks, modes: { [mode]: { tasks: modeTasks } } };
    for (const [id, faction, level] of [
      ['59ca1a6286f774509a270942', 'USEC', 3],
      ['5a27b7d686f77460d847e6a6', 'BEAR', 2],
      ['68ee1c18b4e5bc9a68018cd7', 'Any', 4],
    ] as const) {
      const upstream = {
        id,
        name: 'Test',
        factionName: 'Any',
        objectives: [],
        minPlayerLevel: 0,
        otherRequirements: [
          {
            id: 'counter',
            type: 'globalVariable',
            variableId: 'group',
            compareMethod: '>=',
            value: 2,
          },
        ],
      };
      const result = applyTaskOverride(
        upstream,
        getTaskOverrideForMode(id, overlay as never, mode)
      ) as TaskData | null;
      expect(result?.factionName).toBe(faction);
      expect(result?.otherRequirements).toEqual(upstream.otherRequirements);
      const requirement = result?.traderRequirements?.[0];
      expect(requirement?.value).toBe(level);
      expect(requirement?.trader.name).toBe(TARKOV_TRADER_NAMES_BY_ID[requirement!.trader.id]);
    }
  });
});
