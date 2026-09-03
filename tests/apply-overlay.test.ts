import { describe, expect, it } from 'vitest';
import {
  applyTaskOverride,
  getTaskAdditionsForMode,
  getTaskOverrideForMode,
} from '../examples/apply-overlay.js';

describe('apply-overlay example', () => {
  it('preserves shared objective fields when a mode overrides another field', () => {
    const override = getTaskOverrideForMode(
      'task-1',
      {
        tasks: {
          'task-1': {
            objectives: { objective: { description: 'Shared text', count: 1 } },
            objectivesAdd: [{ id: 'shared-add', description: 'Shared objective' }],
          },
        },
        modes: {
          regular: {
            tasks: {
              'task-1': {
                objectives: { objective: { count: 2 } },
                objectivesAdd: [{ id: 'mode-add', description: 'Mode objective' }],
              },
            },
          },
        },
        $meta: { version: '1.0', generated: '2026-01-01T00:00:00.000Z', sha256: '' },
      },
      'regular'
    );

    expect(override).toEqual({
      objectives: { objective: { description: 'Shared text', count: 2 } },
      objectivesAdd: [
        { id: 'shared-add', description: 'Shared objective' },
        { id: 'mode-add', description: 'Mode objective' },
      ],
    });
  });

  it('applies an explicit null map override', () => {
    const task = applyTaskOverride(
      {
        id: 'task-1',
        name: 'Task',
        minPlayerLevel: 1,
        map: { id: 'map-1', name: 'Customs' },
        objectives: [],
      },
      { map: null }
    );

    expect(task?.map).toBeNull();
  });

  it('rejects disabled additions that collide with an API task', () => {
    expect(() =>
      getTaskAdditionsForMode(
        {
          tasksAdd: {
            local: {
              id: 'task-1',
              name: 'Disabled task',
              trader: { name: 'Prapor' },
              objectives: [],
              disabled: true,
            },
          },
          $meta: { version: '1.0', generated: '2026-01-01T00:00:00.000Z', sha256: '' },
        },
        'regular',
        new Set(['task-1'])
      )
    ).toThrow("Task addition 'task-1' collides with an API task");
  });
});
