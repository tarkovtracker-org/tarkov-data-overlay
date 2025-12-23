/**
 * Tests for task-validator module
 */

import { describe, it, expect } from 'vitest';
import {
  validateTaskOverride,
  validateAllOverrides,
  categorizeResults,
  type TaskOverride,
  type TaskData,
} from '../src/lib/index.js';

describe('validateTaskOverride', () => {
  const createApiTask = (overrides: Partial<TaskData> = {}): TaskData => ({
    id: 'test-task-id',
    name: 'Test Task',
    minPlayerLevel: 10,
    wikiLink: 'https://wiki.example.com/test',
    objectives: [],
    ...overrides,
  });

  const apiTasks = [createApiTask()];

  describe('when task not found in API', () => {
    it('returns REMOVED_FROM_API status', () => {
      const override: TaskOverride = { minPlayerLevel: 15 };
      const result = validateTaskOverride('non-existent-id', override, apiTasks);

      expect(result.status).toBe('REMOVED_FROM_API');
      expect(result.stillNeeded).toBe(false);
      expect(result.name).toBe('Unknown');
    });
  });

  describe('when task is marked as disabled', () => {
    it('returns REMOVED_FROM_API status', () => {
      const override: TaskOverride = { disabled: true };
      const result = validateTaskOverride('test-task-id', override, apiTasks);

      expect(result.status).toBe('REMOVED_FROM_API');
      expect(result.stillNeeded).toBe(false);
    });
  });

  describe('minPlayerLevel validation', () => {
    it('returns NEEDED when API value differs from override', () => {
      const override: TaskOverride = { minPlayerLevel: 15 };
      const result = validateTaskOverride('test-task-id', override, apiTasks);

      expect(result.status).toBe('NEEDED');
      expect(result.stillNeeded).toBe(true);
      expect(result.details.some(d => d.field === 'minPlayerLevel' && d.status === 'needed')).toBe(true);
    });

    it('returns FIXED when API value matches override', () => {
      const override: TaskOverride = { minPlayerLevel: 10 };
      const result = validateTaskOverride('test-task-id', override, apiTasks);

      expect(result.status).toBe('FIXED');
      expect(result.stillNeeded).toBe(false);
      expect(result.details.some(d => d.field === 'minPlayerLevel' && d.status === 'fixed')).toBe(true);
    });
  });

  describe('name validation', () => {
    it('returns NEEDED when API name differs from override', () => {
      const override: TaskOverride = { name: 'Different Name' };
      const result = validateTaskOverride('test-task-id', override, apiTasks);

      expect(result.status).toBe('NEEDED');
      expect(result.stillNeeded).toBe(true);
    });

    it('returns FIXED when API name matches override', () => {
      const override: TaskOverride = { name: 'Test Task' };
      const result = validateTaskOverride('test-task-id', override, apiTasks);

      expect(result.status).toBe('FIXED');
      expect(result.stillNeeded).toBe(false);
    });
  });

  describe('wikiLink validation', () => {
    it('returns NEEDED when API wikiLink differs from override', () => {
      const override: TaskOverride = { wikiLink: 'https://different.url' };
      const result = validateTaskOverride('test-task-id', override, apiTasks);

      expect(result.status).toBe('NEEDED');
      expect(result.stillNeeded).toBe(true);
    });
  });

  describe('objectives validation', () => {
    const apiTaskWithObjectives = createApiTask({
      objectives: [
        { id: 'obj-1', count: 5 },
        { id: 'obj-2', count: 10 },
      ],
    });

    it('returns NEEDED when objective count differs', () => {
      const override: TaskOverride = {
        objectives: { 'obj-1': { count: 8 } },
      };
      const result = validateTaskOverride('test-task-id', override, [apiTaskWithObjectives]);

      expect(result.status).toBe('NEEDED');
      expect(result.stillNeeded).toBe(true);
    });

    it('returns FIXED when objective count matches', () => {
      const override: TaskOverride = {
        objectives: { 'obj-1': { count: 5 } },
      };
      const result = validateTaskOverride('test-task-id', override, [apiTaskWithObjectives]);

      expect(result.status).toBe('FIXED');
      expect(result.stillNeeded).toBe(false);
    });

    it('returns check status when objective not found in API', () => {
      const override: TaskOverride = {
        objectives: { 'non-existent-obj': { count: 5 } },
      };
      const result = validateTaskOverride('test-task-id', override, [apiTaskWithObjectives]);

      expect(result.stillNeeded).toBe(true);
      expect(result.details.some(d => d.status === 'check')).toBe(true);
    });
  });

  describe('taskRequirements validation', () => {
    it('returns NEEDED when API has no requirements but override does', () => {
      const override: TaskOverride = {
        taskRequirements: [{ task: { id: 'prereq-1', name: 'Prereq Task' } }],
      };
      const result = validateTaskOverride('test-task-id', override, apiTasks);

      expect(result.status).toBe('NEEDED');
      expect(result.stillNeeded).toBe(true);
    });
  });

  describe('multiple field validation', () => {
    it('returns NEEDED if any field still needs override', () => {
      const override: TaskOverride = {
        minPlayerLevel: 10, // matches API
        name: 'Different Name', // differs from API
      };
      const result = validateTaskOverride('test-task-id', override, apiTasks);

      expect(result.status).toBe('NEEDED');
      expect(result.stillNeeded).toBe(true);
    });

    it('returns FIXED only if all fields match API', () => {
      const override: TaskOverride = {
        minPlayerLevel: 10,
        name: 'Test Task',
        wikiLink: 'https://wiki.example.com/test',
      };
      const result = validateTaskOverride('test-task-id', override, apiTasks);

      expect(result.status).toBe('FIXED');
      expect(result.stillNeeded).toBe(false);
    });
  });
});

describe('validateAllOverrides', () => {
  it('validates multiple overrides and returns array of results', () => {
    const apiTasks: TaskData[] = [
      { id: 'task-1', name: 'Task 1', minPlayerLevel: 5 },
      { id: 'task-2', name: 'Task 2', minPlayerLevel: 10 },
    ];

    const overrides: Record<string, TaskOverride> = {
      'task-1': { minPlayerLevel: 5 }, // matches
      'task-2': { minPlayerLevel: 15 }, // differs
    };

    const results = validateAllOverrides(overrides, apiTasks);

    expect(results).toHaveLength(2);
    expect(results.find(r => r.id === 'task-1')?.status).toBe('FIXED');
    expect(results.find(r => r.id === 'task-2')?.status).toBe('NEEDED');
  });
});

describe('categorizeResults', () => {
  it('categorizes results into stillNeeded, fixed, and removedFromApi', () => {
    const results = [
      { id: '1', name: 'Task 1', status: 'NEEDED' as const, stillNeeded: true, details: [] },
      { id: '2', name: 'Task 2', status: 'FIXED' as const, stillNeeded: false, details: [] },
      { id: '3', name: 'Task 3', status: 'REMOVED_FROM_API' as const, stillNeeded: false, details: [] },
      { id: '4', name: 'Task 4', status: 'NEEDED' as const, stillNeeded: true, details: [] },
    ];

    const categorized = categorizeResults(results);

    expect(categorized.stillNeeded).toHaveLength(2);
    expect(categorized.fixed).toHaveLength(1);
    expect(categorized.removedFromApi).toHaveLength(1);
  });
});
