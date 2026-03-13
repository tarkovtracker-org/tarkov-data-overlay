/**
 * Tests for scripts/check-overrides.ts helpers
 */

import { describe, expect, it } from 'vitest';
import {
  normalizeWikiLink,
  checkTaskAdditions,
  checkEditionTaskReferences,
} from '../scripts/check-overrides.js';
import type { TaskAddition, TaskData } from '../src/lib/index.js';

function createTaskAddition(overrides: Partial<TaskAddition> = {}): TaskAddition {
  return {
    id: overrides.id ?? 'addition-id',
    name: overrides.name ?? 'Test Addition',
    wikiLink:
      overrides.wikiLink ??
      'https://escapefromtarkov.fandom.com/wiki/Test_Addition',
    trader: overrides.trader ?? { name: 'Prapor' },
    objectives: overrides.objectives ?? [{ id: 'obj-1', description: 'Do thing' }],
    ...overrides,
  };
}

function createApiTask(overrides: Partial<TaskData> = {}): TaskData {
  return {
    id: overrides.id ?? 'api-id',
    name: overrides.name ?? 'Test Task',
    wikiLink: overrides.wikiLink,
    ...overrides,
  };
}

describe('normalizeWikiLink', () => {
  it('normalizes scheme, host, query, fragment, and trailing slashes', () => {
    const link =
      'http://www.escapefromtarkov.fandom.com/wiki/New_Beginning/?oldid=1#History';
    expect(normalizeWikiLink(link)).toBe(
      'https://escapefromtarkov.fandom.com/wiki/new_beginning'
    );
  });

  it('returns a trimmed lowercase fallback for malformed URLs', () => {
    expect(normalizeWikiLink('  escapefromtarkov.fandom.com/Wiki/Test/  ')).toBe(
      'escapefromtarkov.fandom.com/wiki/test'
    );
  });

  it('returns undefined for empty values', () => {
    expect(normalizeWikiLink(undefined)).toBeUndefined();
    expect(normalizeWikiLink('   ')).toBeUndefined();
  });
});

describe('checkTaskAdditions', () => {
  it('marks additions as resolved when wiki links match after normalization', () => {
    const additions = {
      taskA: createTaskAddition({
        name: 'New Beginning',
        wikiLink:
          'http://www.escapefromtarkov.fandom.com/wiki/New_Beginning/?oldid=1#History',
      }),
    };
    const apiTasks = [
      createApiTask({
        id: 'api-1',
        name: 'Different Name',
        wikiLink: 'https://escapefromtarkov.fandom.com/wiki/new_beginning/',
      }),
    ];

    const [result] = checkTaskAdditions(additions, apiTasks);

    expect(result?.status).toBe('RESOLVED');
    expect(result?.message).toContain('by wikiLink');
  });

  it('marks additions for review when only name matches are found', () => {
    const additions = {
      singleNameMatch: createTaskAddition({
        name: 'Signal - Part 3',
        wikiLink: 'https://example.com/wiki/does-not-match',
      }),
      duplicateNameMatch: createTaskAddition({
        name: 'The Punisher',
        wikiLink: 'https://example.com/wiki/also-does-not-match',
      }),
    };
    const apiTasks = [
      createApiTask({
        id: 'api-single',
        name: 'Signal - Part 3',
        wikiLink: 'https://escapefromtarkov.fandom.com/wiki/Signal_-_Part_3',
      }),
      createApiTask({ id: 'api-a', name: 'The Punisher' }),
      createApiTask({ id: 'api-b', name: 'The Punisher' }),
    ];

    const results = checkTaskAdditions(additions, apiTasks);

    expect(results).toHaveLength(2);
    expect(results[0]?.status).toBe('CHECK');
    expect(results[0]?.message).toContain('by name only');
    expect(results[1]?.status).toBe('CHECK');
    expect(results[1]?.message).toContain('Multiple API tasks share this name');
  });

  it('marks prestige-based additions as missing when API only has other prestige tiers', () => {
    const additions = {
      prestigeMissing: createTaskAddition({
        name: 'New Beginning',
        wikiLink: 'https://escapefromtarkov.fandom.com/wiki/New_Beginning_(Prestige_5)',
        requiredPrestige: { name: 'Prestige 4', prestigeLevel: 4 },
      }),
    };
    const apiTasks = [
      createApiTask({
        id: 'api-p0',
        name: 'New Beginning',
        requiredPrestige: undefined,
      }),
      createApiTask({
        id: 'api-p1',
        name: 'New Beginning',
        requiredPrestige: { name: 'Prestige 1', prestigeLevel: 1 },
      }),
      createApiTask({
        id: 'api-p2',
        name: 'New Beginning',
        requiredPrestige: { name: 'Prestige 2', prestigeLevel: 2 },
      }),
      createApiTask({
        id: 'api-p3',
        name: 'New Beginning',
        requiredPrestige: { name: 'Prestige 3', prestigeLevel: 3 },
      }),
    ];

    const [result] = checkTaskAdditions(additions, apiTasks);

    expect(result?.status).toBe('MISSING');
    expect(result?.message).toContain('none match requiredPrestige=4');
  });

  it('marks prestige-based additions for review when API has the same prestige tier', () => {
    const additions = {
      prestigeMatch: createTaskAddition({
        name: 'New Beginning',
        wikiLink: 'https://example.com/wiki/new-beginning-alt',
        requiredPrestige: { name: 'Prestige 4', prestigeLevel: 4 },
      }),
    };
    const apiTasks = [
      createApiTask({
        id: 'api-p4',
        name: 'New Beginning',
        requiredPrestige: { name: 'Prestige 4', prestigeLevel: 4 },
      }),
    ];

    const [result] = checkTaskAdditions(additions, apiTasks);

    expect(result?.status).toBe('CHECK');
    expect(result?.message).toContain('requiredPrestige=4');
  });

  it('marks additions as missing when no wiki or name match exists', () => {
    const additions = {
      missing: createTaskAddition({
        name: 'Unreleased Task',
        wikiLink: 'https://example.com/wiki/missing-task',
      }),
    };
    const apiTasks = [createApiTask({ id: 'api-1', name: 'Different Task' })];

    const [result] = checkTaskAdditions(additions, apiTasks);

    expect(result?.status).toBe('MISSING');
    expect(result?.message).toContain('Still missing from API');
  });
});

describe('checkEditionTaskReferences', () => {
  it('reports missing exclusive and excluded task references', () => {
    const editions = {
      standard: {
        id: 'standard',
        title: 'Standard Edition',
        exclusiveTaskIds: ['task-present', 'task-missing-exclusive'],
        excludedTaskIds: ['task-present-2', 'task-missing-excluded'],
      },
    };
    const apiTasks = [
      createApiTask({ id: 'task-present', name: 'Task Present' }),
      createApiTask({ id: 'task-present-2', name: 'Task Present 2' }),
    ];

    const results = checkEditionTaskReferences(editions, apiTasks);

    expect(results).toHaveLength(2);
    expect(results).toContainEqual({
      editionId: 'standard',
      editionTitle: 'Standard Edition',
      taskId: 'task-missing-exclusive',
      kind: 'exclusive',
    });
    expect(results).toContainEqual({
      editionId: 'standard',
      editionTitle: 'Standard Edition',
      taskId: 'task-missing-excluded',
      kind: 'excluded',
    });
  });
});
