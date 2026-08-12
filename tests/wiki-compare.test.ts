import { describe, expect, it } from 'vitest';
import {
  compareTasks,
  getPriority,
  normalizeItemName,
  normalizeMapName,
  itemsMatch,
  type ExtendedTaskData,
  type WikiTaskData,
} from '../scripts/wiki-compare.js';
import {
  isObjectiveSuppressed,
  isTaskFieldSuppressed,
  type TaskSuppressionEntry,
} from '../scripts/wiki-compare/overlay.js';
import { normalizeTaskName, resolveTask } from '../scripts/wiki-compare/api.js';
import { extractCount } from '../scripts/wiki-compare/wiki.js';
import type { TaskData } from '../src/lib/types.js';

const EMPTY_ALIASES = new Map<string, string>();

function makeWiki(overrides: Partial<WikiTaskData> = {}): WikiTaskData {
  return {
    pageTitle: 'Test Task',
    requirements: [],
    objectives: [],
    rewards: { reputations: [], items: [], raw: [] },
    previousTasks: [],
    nextTasks: [],
    maps: [],
    relatedItems: [],
    relatedRequiredItems: [],
    relatedHandoverItems: [],
    ...overrides,
  };
}

describe('getPriority', () => {
  it('classifies progression-blocking fields as high', () => {
    expect(getPriority('minPlayerLevel')).toBe('high');
    expect(getPriority('taskRequirements')).toBe('high');
    expect(getPriority('objectives.description')).toBe('high');
  });

  it('classifies trader-specific reputation as medium', () => {
    expect(getPriority('reputation.Prapor')).toBe('medium');
    expect(getPriority('map')).toBe('medium');
  });

  it('falls back to low for non-blocking fields', () => {
    expect(getPriority('experience')).toBe('low');
    expect(getPriority('money')).toBe('low');
    expect(getPriority('unknown')).toBe('low');
  });
});

describe('normalizers', () => {
  it('normalizeItemName is case/space insensitive', () => {
    expect(normalizeItemName('  Salewa First Aid Kit ')).toBe(
      normalizeItemName('salewa first aid kit')
    );
  });

  it('normalizeMapName collapses casing', () => {
    expect(normalizeMapName('Customs')).toBe(normalizeMapName('customs'));
  });

  it('itemsMatch intersects api/wiki item references', () => {
    const apiItems = [{ name: 'Bottle of vodka "Tarkovskaya"' }];
    expect(itemsMatch(apiItems, ['Bottle of vodka "Tarkovskaya"'])).toBe(true);
    expect(itemsMatch(apiItems, ['Bottle of beer'])).toBe(false);
  });
});

describe('task suppressions', () => {
  const suppressions = new Map<string, TaskSuppressionEntry>([
    [
      'task-1',
      {
        minPlayerLevel: true,
        objectives: {
          o1: { fields: { count: true } },
          o2: { fields: { 'objectives.maps': true } },
          o3: true,
        },
      },
    ],
  ]);

  it('supports task-level boolean suppressions', () => {
    expect(isTaskFieldSuppressed(suppressions, 'task-1', 'minPlayerLevel')).toBe(true);
    expect(isTaskFieldSuppressed(suppressions, 'task-1', 'experience')).toBe(false);
  });

  it('supports both objective boolean and nested fields suppressions', () => {
    expect(isObjectiveSuppressed(suppressions, 'task-1', 'o1', 'objectives.count')).toBe(true);
    expect(isObjectiveSuppressed(suppressions, 'task-1', 'o2', 'objectives.maps')).toBe(true);
    expect(isObjectiveSuppressed(suppressions, 'task-1', 'o1', 'objectives.items')).toBe(false);
    expect(isObjectiveSuppressed(suppressions, 'task-1', 'o3', 'objectives.items')).toBe(true);
  });
});

describe('compareTasks', () => {
  const baseApi: ExtendedTaskData = {
    id: 'task-1',
    name: 'Test Task',
    minPlayerLevel: 10,
    objectives: [
      { id: 'o1', type: 'shoot', description: 'Eliminate 5 Scavs on Customs', count: 5 },
    ],
  };

  it('returns no discrepancies when api and wiki agree', () => {
    const wiki = makeWiki({
      minPlayerLevel: 10,
      objectives: [{ text: 'Eliminate 5 Scavs on Customs', count: 5 }],
    });
    const result = compareTasks(baseApi, wiki, EMPTY_ALIASES, false);
    expect(result.find((d) => d.field === 'minPlayerLevel')).toBeUndefined();
  });

  it('flags a minPlayerLevel mismatch as high priority', () => {
    const wiki = makeWiki({
      minPlayerLevel: 15,
      objectives: [{ text: 'Eliminate 5 Scavs on Customs', count: 5 }],
    });
    const result = compareTasks(baseApi, wiki, EMPTY_ALIASES, false);
    const level = result.find((d) => d.field === 'minPlayerLevel');
    expect(level).toBeDefined();
    expect(level?.apiValue).toBe(10);
    expect(level?.wikiValue).toBe(15);
    expect(level?.priority).toBe('high');
  });

  it('detects an objective count mismatch', () => {
    const wiki = makeWiki({
      minPlayerLevel: 10,
      objectives: [{ text: 'Eliminate 5 Scavs on Customs', count: 8 }],
    });
    const result = compareTasks(baseApi, wiki, EMPTY_ALIASES, false);
    expect(result.some((d) => d.field === 'objectives.count')).toBe(true);
  });

  it('honors nested objective field suppressions', () => {
    const wiki = makeWiki({
      minPlayerLevel: 10,
      objectives: [{ text: 'Eliminate 8 Scavs on Customs', count: 8, maps: ['Customs'] }],
    });
    const suppressions = new Map<string, TaskSuppressionEntry>([
      ['task-1', { objectives: { o1: { fields: { count: true } } } }],
    ]);

    const result = compareTasks(baseApi, wiki, EMPTY_ALIASES, false, undefined, suppressions);

    expect(result.some((d) => d.field === 'objectives.count')).toBe(false);
  });

  // Regression: a handover objective whose description says "(not found in raid)"
  // is an explicit non-FiR exception and must not suppress an unmatched wiki
  // find objective as redundant. Previously the positive-only /found in raid/i
  // test matched the negation, hiding a real discrepancy.
  it('does not treat "not found in raid" objectives as FiR for redundant-find suppression', () => {
    const api: ExtendedTaskData = {
      id: 'task-1',
      name: 'Test Task',
      minPlayerLevel: 10,
      objectives: [
        {
          id: 'o1',
          type: 'handOver',
          description: 'Hand over the flash drive (not found in raid)',
          items: [{ id: 'item-1', name: 'Flash drive' }],
        },
        // A second objective so the both-sides-single-objective shortcut does
        // not kick in and force-match the objectives.
        { id: 'o2', type: 'shoot', description: 'Eliminate 5 Scavs on Customs', count: 5 },
      ],
    };
    const wiki = makeWiki({
      minPlayerLevel: 10,
      // The verb is derived from the text by getObjectiveVerbKey ("Find" -> find).
      objectives: [{ text: 'Find the flash drive', items: ['Flash drive'] }],
    });

    const result = compareTasks(api, wiki, EMPTY_ALIASES, false);

    // The wiki find objective is not redundant, so it stays unmatched and is
    // reported as missing from the API.
    expect(
      result.some((d) => d.field === 'objectives.description' && d.apiValue === 'not found')
    ).toBe(true);
  });

  it('does not print when verbose is false', () => {
    const logs: unknown[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => logs.push(args);
    try {
      compareTasks(baseApi, makeWiki({ minPlayerLevel: 10 }), EMPTY_ALIASES, false);
    } finally {
      console.log = original;
    }
    expect(logs).toHaveLength(0);
  });
});

describe('normalizeTaskName', () => {
  it('strips the [PVP ZONE] suffix', () => {
    expect(normalizeTaskName('Task Name [PVP ZONE]')).toBe('task name');
    expect(normalizeTaskName('Task Name [pvp zone]')).toBe('task name');
  });

  it('strips the (quest) disambiguation suffix', () => {
    expect(normalizeTaskName('Task Name (quest)')).toBe('task name');
    expect(normalizeTaskName('Task Name (Quest)')).toBe('task name');
  });

  it('normalizes hyphens and collapses repeated whitespace', () => {
    expect(normalizeTaskName('Multi-Word-Task')).toBe('multi word task');
    expect(normalizeTaskName('Task   Multiple   Spaces')).toBe('task multiple spaces');
  });

  it('strips stacked suffixes', () => {
    expect(normalizeTaskName('Task [PVP ZONE] (quest)')).toBe('task');
    expect(normalizeTaskName('Task (quest) [PVP ZONE]')).toBe('task');
  });

  it('combines every normalization', () => {
    expect(normalizeTaskName('Complex-Name  (quest)')).toBe('complex name');
  });
});

describe('resolveTask', () => {
  const tasks: TaskData[] = [
    { id: '1', name: 'Simple Task' },
    { id: '2', name: 'Multi-Word Task [PVP ZONE]' },
    { id: '3', name: 'Quest-Task (quest)' },
  ];

  it('resolves by id when one is supplied', () => {
    expect(resolveTask(tasks, { id: '2' })?.id).toBe('2');
  });

  // Regression: resolveTask previously used a trim/lowercase-only normalizer, so
  // a name carrying a [PVP ZONE]/(quest) suffix or hyphens never matched.
  it('resolves names whose upstream form carries a suffix or hyphens', () => {
    expect(resolveTask(tasks, { name: 'Simple  Task' })?.id).toBe('1');
    expect(resolveTask(tasks, { name: 'multi word task' })?.id).toBe('2');
    expect(resolveTask(tasks, { name: 'Quest Task' })?.id).toBe('3');
  });
});

describe('extractCount', () => {
  it('parses counts from count-word patterns', () => {
    expect(extractCount('Eliminate 5 Scavs on Customs')).toBe(5);
    expect(extractCount('Find 3 dogtags')).toBe(3);
  });

  it('parses counts from the verb fallback', () => {
    expect(extractCount('Reach 15 Strength skill level')).toBe(15);
    expect(extractCount('Visit 4 locations on Woods')).toBe(4);
  });

  // Regression: the verb fallback used to treat any nearby number as the count,
  // so a duration qualifier like "for 5 minutes" produced a false count of 5.
  it('ignores numbers that belong to time/distance qualifiers', () => {
    expect(extractCount('Survive for 5 minutes while suffering from dehydration')).toBeUndefined();
    expect(extractCount('Visit the pier within 20 minutes of the raid start')).toBeUndefined();
    expect(extractCount('Eliminate Scavs from over 40 meters away')).toBeUndefined();
  });
});
