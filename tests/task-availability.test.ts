import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OverlayOutput, TaskAddition } from '../src/lib/index.js';
import {
  buildReport,
  getTaskAddition as getReportTaskAddition,
  getTasksForMode,
  loadOverlay,
  parseArgs,
} from '../scripts/task-availability.js';
import type { TaskData } from '../src/lib/index.js';

const sharedAddition = {
  id: 'task-id',
  name: 'Shared task',
  wikiLink: 'https://example.com/shared-task',
  trader: { name: 'Prapor' },
  objectives: [],
} satisfies TaskAddition;

const modeAddition = {
  ...sharedAddition,
  name: 'PvE task',
  disabled: true,
} satisfies TaskAddition;

const overlay = {
  tasksAdd: { sharedKey: sharedAddition },
  modes: {
    pve: { tasksAdd: { modeKey: modeAddition } },
  },
} as unknown as OverlayOutput;

describe('task availability report helpers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('prefers the mode-specific addition when resolving report metadata', () => {
    expect(getReportTaskAddition(overlay, 'pve', sharedAddition.id)).toBe(modeAddition);
    expect(getReportTaskAddition(overlay, 'regular', sharedAddition.id)).toBe(sharedAddition);
  });

  it('ignores a source key that disagrees with an addition id', () => {
    const mismatched = {
      tasksAdd: { [sharedAddition.id]: { ...sharedAddition, id: 'different-id' } },
    } as unknown as OverlayOutput;

    expect(getReportTaskAddition(mismatched, 'regular', sharedAddition.id)).toBeUndefined();
  });

  it('builds a mode report with overlay precedence, additions, filtering, and access data', async () => {
    const routes: Record<string, unknown> = {
      'regular/tasks': {
        data: {
          tasks: {
            'api-task': {
              id: 'api-task',
              name: 'api-task name',
              trader: 'trader-1',
              map: 'map-1',
              taskRequirements: [{ task: 'prerequisite', status: ['complete'] }],
            },
            prerequisite: { id: 'prerequisite', name: 'prerequisite name' },
            'disabled-task': { id: 'disabled-task', name: 'disabled-task name' },
          },
        },
      },
      'regular/tasks_en': {
        data: {
          'api-task name': 'API task',
          'prerequisite name': 'Prerequisite',
          'disabled-task name': 'Disabled task',
        },
      },
      'regular/items': { data: { items: {} } },
      'regular/items_en': { data: {} },
      'regular/maps': {
        data: { maps: { 'map-1': { id: 'map-1', name: 'map-1 name', minPlayerLevel: 5 } } },
      },
      'regular/maps_en': { data: { 'map-1 name': 'Customs' } },
      'regular/traders': {
        data: { 'trader-1': { id: 'trader-1', name: 'trader-1 name', levels: [] } },
      },
      'regular/traders_en': { data: { 'trader-1 name': 'Prapor' } },
    };
    const fetchMock = vi.fn(async (url: string) => {
      const path = url.replace('https://json.tarkov.dev/', '');
      const payload = routes[path];
      if (payload === undefined) {
        return new Response('{}', { status: 404, statusText: 'Not Found' });
      }
      return new Response(JSON.stringify(payload), {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const modeAddition = {
      ...sharedAddition,
      name: 'Mode addition',
    } satisfies TaskAddition;
    const reportOverlay = {
      $meta: { version: '1.80', generated: '2026-08-31T00:00:00.000Z' },
      tasks: {
        'api-task': {
          minPlayerLevel: 10,
          taskRequirements: [{ task: { id: 'prerequisite', name: 'Override prerequisite' } }],
          otherRequirements: [null],
        },
        'disabled-task': { disabled: true },
      },
      tasksAdd: { sharedKey: sharedAddition },
      modes: {
        regular: {
          tasks: { 'api-task': { factionName: 'USEC' } },
          tasksAdd: { modeKey: { ...modeAddition, name: 'Mode addition', disabled: false } },
        },
      },
    } as unknown as OverlayOutput;

    const report = await buildReport('regular', reportOverlay, false);

    expect(report.$meta.gameMode).toBe('regular');
    expect(report.$meta.taskCount).toBe(3);
    expect(report.$meta.disabledTaskCount).toBe(1);
    expect(report.tasks['api-task'].unlock.all).toContainEqual({
      type: 'playerLevel',
      compareMethod: '>=',
      value: 10,
    });
    expect(report.tasks['api-task'].unlock.all).toContainEqual({
      type: 'faction',
      faction: 'USEC',
    });
    expect(report.tasks['api-task'].unlock.taskRequirements).toContainEqual({
      type: 'taskStatus',
      task: { id: 'prerequisite', name: 'Override prerequisite' },
      statuses: ['complete'],
    });
    expect(report.$meta.hiddenRequirementCounts).toEqual({ malformed: 1 });
    expect(report.tasks['task-id'].name).toBe('Mode addition');
    expect(report.tasks['disabled-task']).toBeUndefined();
    expect(report.maps).toEqual({
      'map-1': expect.objectContaining({ name: 'Customs', minPlayerLevel: 5 }),
    });
    expect(report.traders).toEqual(
      expect.objectContaining({
        'trader-1': expect.objectContaining({ name: 'Prapor' }),
      })
    );

    const paths = fetchMock.mock.calls.map(([url]) => url.replace('https://json.tarkov.dev/', ''));
    expect(paths.filter((path) => path === 'regular/maps')).toHaveLength(1);
    expect(paths.filter((path) => path === 'regular/maps_en')).toHaveLength(1);
    expect(paths.filter((path) => path === 'regular/traders')).toHaveLength(1);
    expect(paths.filter((path) => path === 'regular/traders_en')).toHaveLength(1);
  });

  it('rejects unexpected positional arguments', () => {
    expect(() => parseArgs(['regular'])).toThrow('Unknown argument: regular');
  });

  it('requires the built overlay unless overlay use is explicitly disabled', () => {
    expect(loadOverlay(false)).toBeUndefined();
    expect(loadOverlay(true)).toEqual(expect.objectContaining({ $meta: expect.any(Object) }));
  });

  it('rejects an addition that collides with an upstream task ID', () => {
    const apiTask = { id: 'task-id', name: 'API task' } as TaskData;
    const collidingOverlay = {
      tasksAdd: { local_key: sharedAddition },
    } as unknown as OverlayOutput;

    expect(() => getTasksForMode([apiTask], collidingOverlay, 'regular')).toThrow(
      'collides with a task served by tarkov.dev'
    );
  });

  it('rejects a disabled addition that collides with an upstream task ID', () => {
    const apiTask = { id: 'task-id', name: 'API task' } as TaskData;
    const collidingOverlay = {
      tasksAdd: { local_key: { ...sharedAddition, disabled: true } },
    } as unknown as OverlayOutput;

    expect(() => getTasksForMode([apiTask], collidingOverlay, 'regular')).toThrow(
      'collides with a task served by tarkov.dev'
    );
  });

  it('includes disabled additions only when requested', () => {
    expect(getTasksForMode([], overlay, 'pve')).toEqual([]);
    expect(getTasksForMode([], overlay, 'pve', true).map((task) => task.id)).toEqual([
      sharedAddition.id,
    ]);
  });

  it('rejects duplicate upstream task IDs instead of silently dropping one', () => {
    expect(() =>
      getTasksForMode(
        [
          { id: 'duplicate', name: 'One' },
          { id: 'duplicate', name: 'Two' },
        ],
        undefined,
        'regular'
      )
    ).toThrow("duplicate task id 'duplicate'");
  });
});
