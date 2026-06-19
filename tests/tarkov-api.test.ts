/**
 * Tests for the json.tarkov.dev adapter (tarkov-api module)
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchTasks, findTaskById, type TaskData } from '../src/lib/index.js';

type Routes = Record<string, unknown>;

/**
 * Stub global fetch with a path-routing mock. Keys are endpoint paths relative
 * to the json.tarkov.dev base (e.g. `regular/tasks`, `regular/tasks_en`).
 */
function mockEndpoints(routes: Routes) {
  const fetchMock = vi.fn(async (url: string) => {
    const path = String(url).replace('https://json.tarkov.dev/', '');
    if (!(path in routes)) {
      return {
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: async () => ({}),
      };
    }
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => routes[path],
    };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Minimal set of empty endpoints so a fetch never hits the 404 path. */
function baseRoutes(mode: string, overrides: Routes = {}): Routes {
  return {
    [`${mode}/tasks`]: { data: { tasks: {} } },
    [`${mode}/tasks_en`]: { data: {} },
    [`${mode}/items`]: { data: { items: {} } },
    [`${mode}/items_en`]: { data: {} },
    [`${mode}/maps`]: { data: { maps: {} } },
    [`${mode}/maps_en`]: { data: {} },
    [`${mode}/traders`]: { data: {} },
    [`${mode}/traders_en`]: { data: {} },
    ...overrides,
  };
}

describe('tarkov-api (json.tarkov.dev adapter)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('resolves task name and objective description from the _en map', async () => {
    mockEndpoints(
      baseRoutes('regular', {
        'regular/tasks': {
          data: {
            tasks: {
              t1: {
                id: 't1',
                name: 't1 name',
                wikiLink: 'https://wiki/T1',
                objectives: [{ id: 'o1', type: 'visit', description: 'o1' }],
              },
            },
          },
        },
        'regular/tasks_en': {
          data: { 't1 name': 'The First Task', o1: 'Visit the place' },
        },
      })
    );

    const tasks = await fetchTasks();

    expect(tasks).toHaveLength(1);
    expect(tasks[0].name).toBe('The First Task');
    expect(tasks[0].objectives?.[0].description).toBe('Visit the place');
  });

  it('expands item id refs to {id,name,shortName} and preserves nested matrices', async () => {
    mockEndpoints(
      baseRoutes('regular', {
        'regular/tasks': {
          data: {
            tasks: {
              t1: {
                id: 't1',
                name: 't1 name',
                objectives: [
                  {
                    id: 'o1',
                    type: 'shoot',
                    description: 'o1',
                    usingWeapon: ['w1'],
                    usingWeaponMods: [['m1'], ['m2']],
                  },
                ],
              },
            },
          },
        },
        'regular/tasks_en': { data: { 't1 name': 'T1', o1: 'Kill' } },
        'regular/items': {
          data: {
            items: {
              w1: { id: 'w1', name: 'w1 name', shortName: 'w1 short' },
              m1: { id: 'm1', name: 'm1 name', shortName: 'm1 short' },
              m2: { id: 'm2', name: 'm2 name', shortName: 'm2 short' },
            },
          },
        },
        'regular/items_en': {
          data: {
            'w1 name': 'Weapon One',
            'w1 short': 'W1',
            'm1 name': 'Mod One',
            'm1 short': 'M1',
            'm2 name': 'Mod Two',
            'm2 short': 'M2',
          },
        },
      })
    );

    const tasks = await fetchTasks();
    const objective = tasks[0].objectives?.[0];

    expect(objective?.usingWeapon).toEqual([{ id: 'w1', name: 'Weapon One', shortName: 'W1' }]);
    expect(objective?.usingWeaponMods).toEqual([
      [{ id: 'm1', name: 'Mod One', shortName: 'M1' }],
      [{ id: 'm2', name: 'Mod Two', shortName: 'M2' }],
    ]);
  });

  it('resolves map refs and keeps map: null intact', async () => {
    mockEndpoints(
      baseRoutes('regular', {
        'regular/tasks': {
          data: {
            tasks: {
              mapped: { id: 'mapped', name: 'mapped name', map: 'map1' },
              nomap: { id: 'nomap', name: 'nomap name', map: null },
            },
          },
        },
        'regular/tasks_en': { data: { 'mapped name': 'Mapped', 'nomap name': 'NoMap' } },
        'regular/maps': { data: { maps: { map1: { id: 'map1', name: 'map1 name' } } } },
        'regular/maps_en': { data: { 'map1 name': 'Customs' } },
      })
    );

    const tasks = await fetchTasks();
    const byId = Object.fromEntries(tasks.map((t) => [t.id, t]));

    expect(byId.mapped.map).toEqual({ id: 'map1', name: 'Customs' });
    expect(byId.nomap.map).toBeNull();
  });

  it('omits map when the field is absent (not forced to null)', async () => {
    mockEndpoints(
      baseRoutes('regular', {
        'regular/tasks': {
          data: { tasks: { t1: { id: 't1', name: 't1 name' } } },
        },
        'regular/tasks_en': { data: { 't1 name': 'T1' } },
      })
    );

    const tasks = await fetchTasks();

    expect('map' in tasks[0]).toBe(false);
  });

  it('resolves trader refs in requirements and reward standings', async () => {
    mockEndpoints(
      baseRoutes('regular', {
        'regular/tasks': {
          data: {
            tasks: {
              t1: {
                id: 't1',
                name: 't1 name',
                traderRequirements: [{ trader: 'tr1', value: 2, compareMethod: '>=' }],
                finishRewards: {
                  traderStanding: [{ trader: 'tr1', standing: 0.05 }],
                  items: [{ item: 'i1', count: 3 }],
                },
              },
            },
          },
        },
        'regular/tasks_en': { data: { 't1 name': 'T1' } },
        'regular/traders': { data: { tr1: { id: 'tr1', name: 'tr1 name' } } },
        'regular/traders_en': { data: { 'tr1 name': 'Prapor' } },
        'regular/items': { data: { items: { i1: { id: 'i1', name: 'i1 name', shortName: 'i1s' } } } },
        'regular/items_en': { data: { 'i1 name': 'Bandage', 'i1s': 'Band' } },
      })
    );

    const tasks = await fetchTasks();
    const task = tasks[0];

    expect(task.traderRequirements?.[0].trader).toEqual({ id: 'tr1', name: 'Prapor' });
    expect(task.finishRewards?.traderStanding?.[0].trader).toEqual({ id: 'tr1', name: 'Prapor' });
    expect(task.finishRewards?.items?.[0].item).toEqual({
      id: 'i1',
      name: 'Bandage',
      shortName: 'Band',
    });
  });

  it('resolves requiredPrestige from the prestige array', async () => {
    mockEndpoints(
      baseRoutes('regular', {
        'regular/tasks': {
          data: {
            tasks: {
              t1: { id: 't1', name: 't1 name', requiredPrestige: 'p1' },
            },
            prestige: [{ id: 'p1', name: 'p1 name', prestigeLevel: 2 }],
          },
        },
        'regular/tasks_en': { data: { 't1 name': 'New Beginning', 'p1 name': 'Prestige 2' } },
      })
    );

    const tasks = await fetchTasks();

    expect(tasks[0].requiredPrestige).toEqual({
      id: 'p1',
      name: 'Prestige 2',
      prestigeLevel: 2,
    });
  });

  it('resolves taskRequirements task refs', async () => {
    mockEndpoints(
      baseRoutes('regular', {
        'regular/tasks': {
          data: {
            tasks: {
              prereq: { id: 'prereq', name: 'prereq name' },
              t1: {
                id: 't1',
                name: 't1 name',
                taskRequirements: [{ task: 'prereq', status: ['complete'] }],
              },
            },
          },
        },
        'regular/tasks_en': { data: { 'prereq name': 'Debut', 't1 name': 'Shootout' } },
      })
    );

    const tasks = await fetchTasks();
    const t1 = tasks.find((t) => t.id === 't1');

    expect(t1?.taskRequirements?.[0]).toEqual({
      task: { id: 'prereq', name: 'Debut' },
      status: ['complete'],
    });
  });

  it('falls back to the raw key when a name has no translation', async () => {
    mockEndpoints(
      baseRoutes('regular', {
        'regular/tasks': {
          data: { tasks: { t1: { id: 't1', name: 't1 name' } } },
        },
        'regular/tasks_en': { data: {} },
      })
    );

    const tasks = await fetchTasks();

    expect(tasks[0].name).toBe('t1 name');
  });

  it('requests pve endpoints when pve mode is requested', async () => {
    const fetchMock = mockEndpoints(baseRoutes('pve'));

    await fetchTasks('pve');

    const requested = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(requested).toContain('https://json.tarkov.dev/pve/tasks');
    expect(requested).toContain('https://json.tarkov.dev/pve/items_en');
    expect(requested.every((url) => !url.includes('/regular/'))).toBe(true);
  });

  it('fetches each endpoint exactly once per call', async () => {
    const fetchMock = mockEndpoints(baseRoutes('regular'));

    await fetchTasks();

    // Sanity: each endpoint requested by buildContext is hit at most once.
    // (The dedup branch in fetchEnvelope is defensive — production code paths
    // request each path once today, but the per-call cache stays correct if
    // that ever changes.)
    const callsByUrl = new Map<string, number>();
    for (const call of fetchMock.mock.calls) {
      const url = String(call[0]);
      callsByUrl.set(url, (callsByUrl.get(url) ?? 0) + 1);
    }
    for (const [url, count] of callsByUrl) {
      expect(count, url).toBe(1);
    }
  });

  it('refetches on subsequent calls (no cross-call memo)', async () => {
    const fetchMock = mockEndpoints(baseRoutes('regular'));

    await fetchTasks();
    await fetchTasks();

    const tasksCalls = fetchMock.mock.calls.filter(
      (call) => String(call[0]) === 'https://json.tarkov.dev/regular/tasks'
    );
    expect(tasksCalls).toHaveLength(2);
  });

  it('throws when an endpoint returns a non-ok response', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        json: async () => ({}),
      })
    );

    const promise = fetchTasks();
    const assertion = expect(promise).rejects.toThrow(
      'tarkov.dev request failed: 503 Service Unavailable'
    );
    await vi.runAllTimersAsync();
    await assertion;
    vi.useRealTimers();
  });

  it('throws when the tasks envelope is missing data', async () => {
    mockEndpoints({ 'regular/tasks': {} });

    await expect(fetchTasks()).rejects.toThrow(
      'Invalid json.tarkov.dev response for regular/tasks: missing data'
    );
  });

  it('throws when data.tasks is not an object', async () => {
    mockEndpoints({ 'regular/tasks': { data: { tasks: [] } } });

    await expect(fetchTasks()).rejects.toThrow(
      'Invalid json.tarkov.dev response for regular/tasks: expected data.tasks object'
    );
  });

  it('findTaskById returns matching task', () => {
    const tasks: TaskData[] = [
      { id: 'task-1', name: 'Task 1' },
      { id: 'task-2', name: 'Task 2' },
    ];

    expect(findTaskById(tasks, 'task-2')).toEqual({ id: 'task-2', name: 'Task 2' });
    expect(findTaskById(tasks, 'missing')).toBeUndefined();
  });
});
