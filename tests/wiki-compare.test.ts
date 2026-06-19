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
