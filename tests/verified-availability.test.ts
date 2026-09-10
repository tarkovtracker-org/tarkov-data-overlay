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
  type TaskUnlockDefinition,
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
  '69ce21e990144e437802b1e0',
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

  // Derivation already rejects a blank requirement id, so build the condition
  // directly: consumers vendor these types and can supply their own definition.
  it('fails closed for a condition with no requirement id', () => {
    const task: TaskData = {
      id: 'test',
      name: 'Test',
      trader: { id: 'trader', name: 'Trader' },
    };
    const state = {
      traderUnlocked: { trader: true },
      storyObjectives: { boreas: { [objectiveId]: true } },
    };
    const condition = {
      type: 'storyObjective',
      requirementId: '',
      storyChapter: { id: 'boreas', name: 'Boreas' },
      objective: { id: objectiveId, name: 'Hand over drives' },
    } as const;
    const definition: TaskUnlockDefinition = {
      all: [condition],
      taskRequirements: [],
      anyOf: [],
      context: { trader: { id: 'trader', name: 'Trader' } },
    };
    expect(evaluateTaskUnlock(task, definition, state).status).toBe('unknown');
    const valid: TaskUnlockDefinition = {
      ...definition,
      all: [{ ...condition, requirementId: 'overlay.test.boreas' }],
    };
    expect(evaluateTaskUnlock(task, valid, state).status).toBe('available');
  });

  it('ignores inherited chapter and objective entries', () => {
    const requirement = tasks[boreasTasks[0]].otherRequirements![0];
    const inheritedObjective = Object.create({ [objectiveId]: true }) as Record<string, boolean>;
    expect(
      evaluate([requirement], { storyObjectives: { boreas: inheritedObjective } }).status
    ).toBe('unknown');
    const inheritedChapter = Object.create({ boreas: { [objectiveId]: true } }) as Record<
      string,
      Record<string, boolean>
    >;
    expect(evaluate([requirement], { storyObjectives: inheritedChapter }).status).toBe('unknown');
  });

  it('explains an unmet objective gate without claiming completion', () => {
    const requirement = tasks[boreasTasks[0]].otherRequirements![0];
    const blocked = evaluate([requirement], {
      storyObjectives: { boreas: { [objectiveId]: false } },
    });
    expect(blocked.status).toBe('blocked');
    const reasons = blocked.blockers.map((blocker) => blocker.reason);
    expect(reasons).toContain(
      'requires story objective: Ask Mechanic for help decoding the hard drives from the icebreaker'
    );
    for (const reason of reasons) expect(reason).not.toMatch(/objective completed/);
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
