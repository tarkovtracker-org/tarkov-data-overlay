/**
 * Tests for the json.tarkov.dev adapter (tarkov-api module)
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deriveTaskUnlockDefinition,
  evaluateTaskUnlock,
  fetchTasks,
  fetchTasksWithRequirementCounts,
  fetchModeAccessData,
  fetchTaskModeData,
  fetchLocaleBundle,
  fetchRawEntities,
  findTaskById,
  FETCH_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  USER_AGENT,
  type TaskData,
} from '../src/lib/index.js';

type Routes = Record<string, unknown>;

/**
 * Stub global fetch with a path-routing mock. Keys are endpoint paths relative
 * to the json.tarkov.dev base (e.g. `regular/tasks`, `regular/tasks_en`).
 */
function mockEndpoints(routes: Routes) {
  const fetchMock = vi.fn(async (url: string) => {
    const path = String(url).replace('https://json.tarkov.dev/', '');
    if (!(path in routes)) {
      return new Response('{}', { status: 404, statusText: 'Not Found' });
    }
    return new Response(JSON.stringify(routes[path]), {
      status: 200,
      statusText: 'OK',
      headers: { 'content-type': 'application/json' },
    });
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

  it('sends Accept: application/json and the descriptive User-Agent on every request', async () => {
    const fetchMock = mockEndpoints(baseRoutes('regular'));

    await fetchTasks();

    // A named UA is required in practice: Cloudflare 403s browser-mimicking UAs
    // from non-browser clients, so this contract must not silently regress.
    expect(fetchMock).toHaveBeenCalled();
    const calls = fetchMock.mock.calls as unknown as Array<
      [string, { headers?: Record<string, string> }?]
    >;
    for (const [, init] of calls) {
      const headers = init?.headers ?? {};
      expect(headers.Accept).toBe('application/json');
      expect(headers['User-Agent']).toBe(USER_AGENT);
    }
    expect(USER_AGENT).toBe(
      'tarkov-data-overlay (+https://github.com/tarkovtracker-org/tarkov-data-overlay)'
    );
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

  it('drops unsafe object keys while adapting tasks and rewards', async () => {
    const unsafeTask = JSON.parse(
      '{"id":"t1","name":"t1 name","__proto__":"remote","constructor":"remote","prototype":"remote","startRewards":{"__proto__":"remote","constructor":"remote","prototype":"remote"}}'
    );
    mockEndpoints(
      baseRoutes('regular', {
        'regular/tasks': { data: { tasks: { t1: unsafeTask } } },
        'regular/tasks_en': { data: { 't1 name': 'Task One' } },
      })
    );

    const [task] = await fetchTasks();

    expect(Object.hasOwn(task, '__proto__')).toBe(false);
    expect(Object.hasOwn(task, 'constructor')).toBe(false);
    expect(Object.hasOwn(task, 'prototype')).toBe(false);
    expect(Object.hasOwn(task.startRewards ?? {}, '__proto__')).toBe(false);
    expect(Object.hasOwn(task.startRewards ?? {}, 'constructor')).toBe(false);
    expect(Object.hasOwn(task.startRewards ?? {}, 'prototype')).toBe(false);
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
                traderRequirements: [
                  {
                    id: 'req-1',
                    requirementType: 'level',
                    compareMethod: '>=',
                    value: 2,
                    trader: 'tr1',
                  },
                ],
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
        'regular/items': {
          data: { items: { i1: { id: 'i1', name: 'i1 name', shortName: 'i1s' } } },
        },
        'regular/items_en': { data: { 'i1 name': 'Bandage', i1s: 'Band' } },
      })
    );

    const tasks = await fetchTasks();
    const task = tasks[0];

    expect(task.traderRequirements?.[0]).toEqual({
      id: 'req-1',
      requirementType: 'level',
      compareMethod: '>=',
      value: 2,
      trader: { id: 'tr1', name: 'Prapor' },
    });
    expect(task.finishRewards?.traderStanding?.[0].trader).toEqual({ id: 'tr1', name: 'Prapor' });
    expect(task.finishRewards?.items?.[0].item).toEqual({
      id: 'i1',
      name: 'Bandage',
      shortName: 'Band',
    });
  });

  it('adapts task unlock metadata, key requirements, and trader unlock rewards', async () => {
    mockEndpoints(
      baseRoutes('regular', {
        'regular/tasks': {
          data: {
            tasks: {
              t1: {
                id: 't1',
                name: 't1 name',
                trader: 'tr1',
                availableDelaySecondsMin: 10,
                availableDelaySecondsMax: 20,
                otherRequirements: [
                  { id: 'dialogue-1', type: 'dialogue', traders: ['tr1'] },
                  {
                    id: 'condition-1',
                    type: 'globalVariable',
                    variableId: 'variable-1',
                    compareMethod: '>=',
                    value: 3,
                  },
                ],
                neededKeys: [{ map: 'map1', keys: ['key1'] }],
                finishRewards: {
                  traderUnlock: ['tr2'],
                  traderDialogueUnlock: ['tr1'],
                  locationUnlock: ['map1'],
                },
              },
            },
          },
        },
        'regular/tasks_en': { data: { 't1 name': 'Task One' } },
        'regular/maps': { data: { maps: { map1: { id: 'map1', name: 'map1 name' } } } },
        'regular/maps_en': { data: { 'map1 name': 'Customs' } },
        'regular/items': {
          data: { items: { key1: { id: 'key1', name: 'key1 name' } } },
        },
        'regular/items_en': { data: { 'key1 name': 'Customs Office Key' } },
        'regular/traders': {
          data: {
            tr1: { id: 'tr1', name: 'tr1 name' },
            tr2: { id: 'tr2', name: 'tr2 name' },
          },
        },
        'regular/traders_en': { data: { 'tr1 name': 'Prapor', 'tr2 name': 'Ref' } },
      })
    );

    const [task] = await fetchTasks();

    expect(task.trader).toEqual({ id: 'tr1', name: 'Prapor' });
    expect(task.otherRequirements).toEqual([
      { id: 'dialogue-1', type: 'dialogue', traders: [{ id: 'tr1', name: 'Prapor' }] },
      {
        id: 'condition-1',
        type: 'globalVariable',
        variableId: 'variable-1',
        compareMethod: '>=',
        value: 3,
      },
    ]);
    expect(task.neededKeys).toEqual([
      { map: { id: 'map1', name: 'Customs' }, keys: [{ id: 'key1', name: 'Customs Office Key' }] },
    ]);
    expect(task.availableDelaySecondsMin).toBe(10);
    expect(task.availableDelaySecondsMax).toBe(20);
    expect(task.finishRewards?.traderUnlock).toEqual([{ id: 'tr2', name: 'Ref' }]);
    expect(task.finishRewards?.traderDialogueUnlock).toEqual([{ id: 'tr1', name: 'Prapor' }]);
    expect(task.finishRewards?.locationUnlock).toEqual([{ id: 'map1', name: 'Customs' }]);
  });

  it('preserves malformed hidden requirements so evaluation can fail closed', async () => {
    mockEndpoints(
      baseRoutes('regular', {
        'regular/tasks': {
          data: {
            tasks: {
              t1: {
                id: 't1',
                name: 't1 name',
                otherRequirements: [
                  null,
                  { id: 'dialogue-1', type: 'dialogue', traders: [] },
                  { id: 'dialogue-2', type: 'dialogue', traders: ['missing-trader'] },
                ],
              },
            },
          },
        },
        'regular/tasks_en': { data: { 't1 name': 'Task One' } },
      })
    );

    const [task] = await fetchTasks();

    expect(task.otherRequirements).toEqual([
      { id: 'malformed-requirement', type: 'malformed' },
      { id: 'dialogue-1', type: 'dialogue', traders: [] },
      {
        id: 'dialogue-2',
        type: 'dialogue',
        traders: [{ id: '', name: 'Unknown trader' }],
      },
    ]);
  });

  it('preserves malformed requirement containers for fail-closed evaluation', async () => {
    mockEndpoints(
      baseRoutes('regular', {
        'regular/tasks': {
          data: {
            tasks: {
              t1: {
                id: 't1',
                name: 't1 name',
                taskRequirements: {},
                taskRequirementGroups: {},
                traderRequirements: {},
                otherRequirements: {},
              },
            },
          },
        },
        'regular/tasks_en': { data: { 't1 name': 'Task One' } },
      })
    );

    const [task] = await fetchTasks();

    expect(task.taskRequirements).toEqual([{}]);
    expect(task.taskRequirementGroups).toEqual([[]]);
    expect(task.traderRequirements).toHaveLength(1);
    expect(task.otherRequirements).toEqual([{ id: 'malformed-requirement', type: 'malformed' }]);
    const definition = deriveTaskUnlockDefinition(task);
    expect(
      evaluateTaskUnlock(task, definition, {
        traderUnlocked: {},
        mapAccess: {},
      }).status
    ).toBe('unknown');
  });

  it('fetchModeAccessData keeps map entry rules and trader level thresholds', async () => {
    mockEndpoints(
      baseRoutes('pve', {
        'pve/maps': {
          data: {
            maps: {
              map1: {
                id: 'map1',
                name: 'map1 name',
                minPlayerLevel: 5,
                maxPlayerLevel: 20,
                accessKeys: ['key1'],
                accessKeysMinPlayerLevel: 10,
              },
            },
          },
        },
        'pve/maps_en': { data: { 'map1 name': 'Ground Zero' } },
        'pve/traders': {
          data: {
            tr1: {
              id: 'tr1',
              name: 'tr1 name',
              levels: [
                {
                  level: 2,
                  requiredPlayerLevel: 6,
                  requiredReputation: 0.7,
                  requiredCommerce: 0,
                },
              ],
            },
          },
        },
        'pve/traders_en': { data: { 'tr1 name': 'Prapor' } },
      })
    );

    await expect(fetchModeAccessData('pve')).resolves.toEqual({
      maps: {
        map1: {
          id: 'map1',
          name: 'Ground Zero',
          minPlayerLevel: 5,
          maxPlayerLevel: 20,
          accessKeys: ['key1'],
          accessKeysMinPlayerLevel: 10,
        },
      },
      traders: {
        tr1: {
          id: 'tr1',
          name: 'Prapor',
          levels: [
            {
              level: 2,
              requiredPlayerLevel: 6,
              requiredReputation: 0.7,
              requiredCommerce: 0,
            },
          ],
        },
      },
    });
  });

  it('generates stable, distinct ids for id-less trader requirements', async () => {
    mockEndpoints(
      baseRoutes('regular', {
        'regular/tasks': {
          data: {
            tasks: {
              '657315e1dccd301f1301416a': {
                id: '657315e1dccd301f1301416a',
                name: 'task name',
                traderRequirements: [
                  {
                    requirementType: 'level',
                    compareMethod: '>=',
                    value: 2,
                    trader: '54cb50c76803fa8b248b4571',
                  },
                  {
                    requirementType: 'reputation',
                    compareMethod: '>=',
                    value: 1,
                    trader: '579dc571d53a0658a154fbec',
                  },
                  {
                    requirementType: 'level',
                    compareMethod: '>=',
                    value: 2,
                    trader: '54cb50c76803fa8b248b4571',
                  },
                  {
                    requirementType: 'level',
                    compareMethod: '>=',
                    value: 2,
                    trader: '54cb50c76803fa8b248b4571',
                  },
                ],
              },
            },
          },
        },
        'regular/tasks_en': { data: { 'task name': 'Task' } },
        'regular/traders': {
          data: {
            '54cb50c76803fa8b248b4571': {
              id: '54cb50c76803fa8b248b4571',
              name: 'prapor name',
            },
            '579dc571d53a0658a154fbec': {
              id: '579dc571d53a0658a154fbec',
              name: 'fence name',
            },
          },
        },
        'regular/traders_en': { data: { 'prapor name': 'Prapor', 'fence name': 'Fence' } },
      })
    );

    const [task] = await fetchTasks();

    expect(task.traderRequirements?.map((requirement) => requirement.id)).toEqual([
      'overlay.657315e1dccd301f1301416a.54cb50c76803fa8b248b4571.level.>=.2',
      'overlay.657315e1dccd301f1301416a.579dc571d53a0658a154fbec.reputation.>=.1',
      'overlay.657315e1dccd301f1301416a.54cb50c76803fa8b248b4571.level.>=.2.occurrence.2',
      'overlay.657315e1dccd301f1301416a.54cb50c76803fa8b248b4571.level.>=.2.occurrence.3',
    ]);
  });

  it('resolves requiredPrestige from the prestige array', async () => {
    mockEndpoints(
      baseRoutes('regular', {
        'regular/tasks': {
          data: {
            tasks: {
              t1: { id: 't1', name: 't1 name', requiredPrestige: 'p1' },
              t2: {
                id: 't2',
                name: 't2 name',
                requiredPrestige: { name: 'inline prestige', prestigeLevel: 3 },
              },
            },
            prestige: [{ id: 'p1', name: 'p1 name', prestigeLevel: 2 }],
          },
        },
        'regular/tasks_en': {
          data: {
            't1 name': 'New Beginning',
            'p1 name': 'Prestige 2',
            'inline prestige': 'Prestige 3',
          },
        },
      })
    );

    const tasks = await fetchTasks();

    expect(tasks[0].requiredPrestige).toEqual({
      id: 'p1',
      name: 'Prestige 2',
      prestigeLevel: 2,
    });
    expect(tasks[1].requiredPrestige).toEqual({
      name: 'Prestige 3',
      prestigeLevel: 3,
    });
  });

  it('preserves an unresolved requiredPrestige as an invalid requirement', async () => {
    mockEndpoints(
      baseRoutes('regular', {
        'regular/tasks': {
          data: {
            tasks: {
              t1: { id: 't1', name: 't1 name', requiredPrestige: 'missing-prestige' },
              t2: { id: 't2', name: 't2 name', requiredPrestige: 'broken-prestige' },
            },
            prestige: [{ id: 'broken-prestige', name: 'broken name' }],
          },
        },
        'regular/tasks_en': { data: { 't1 name': 'Task One', 't2 name': 'Task Two' } },
      })
    );

    const tasks = await fetchTasks();

    expect(tasks[0]?.requiredPrestige).toEqual({
      id: 'missing-prestige',
      name: 'missing-prestige',
      prestigeLevel: -1,
    });
    expect(tasks[1]?.requiredPrestige).toEqual({
      id: 'broken-prestige',
      name: 'broken name',
      prestigeLevel: -1,
    });
  });

  it('preserves malformed task gates so availability evaluation fails closed', async () => {
    mockEndpoints(
      baseRoutes('regular', {
        'regular/tasks': {
          data: {
            tasks: {
              t1: {
                id: 't1',
                name: 't1 name',
                trader: 'missing-trader',
                map: 'missing-map',
                minPlayerLevel: '10',
                factionName: { value: 'USEC' },
                lightkeeperRequired: 'false',
                availableDelaySecondsMin: '10',
              },
            },
          },
        },
        'regular/tasks_en': { data: { 't1 name': 'Task One' } },
      })
    );

    const [task] = await fetchTasks();
    expect(Number.isNaN(task.minPlayerLevel)).toBe(true);
    expect(task.factionName).toBeNull();
    expect(task.lightkeeperRequired).toBeNull();
    expect(Number.isNaN(task.availableDelaySecondsMin)).toBe(true);

    const definition = deriveTaskUnlockDefinition(task);
    expect(
      evaluateTaskUnlock(task, definition, {
        playerLevel: 100,
        faction: 'USEC',
        traderUnlocked: { 'missing-trader': true },
        mapAccess: { 'missing-map': true },
        nowSeconds: 100,
        taskAvailableSince: { t1: 0 },
      }).status
    ).toBe('unknown');
  });

  it('rejects malformed and duplicate upstream task records', async () => {
    mockEndpoints(
      baseRoutes('regular', {
        'regular/tasks': { data: { tasks: { t1: { id: 't1', name: 'Task' }, missing: {} } } },
      })
    );
    await expect(fetchTasks()).rejects.toThrow(/task 'missing' has no id/);

    mockEndpoints(
      baseRoutes('regular', {
        'regular/tasks': {
          data: {
            tasks: {
              first: { id: 'duplicate', name: 'First' },
              second: { id: 'duplicate', name: 'Second' },
            },
          },
        },
      })
    );
    await expect(fetchTasks()).rejects.toThrow(/duplicate task id 'duplicate'/);
  });

  it('rejects duplicate map and trader IDs instead of silently taking the last record', async () => {
    mockEndpoints(
      baseRoutes('regular', {
        'regular/maps': {
          data: {
            maps: {
              first: { id: 'duplicate-map', name: 'First' },
              second: { id: 'duplicate-map', name: 'Second' },
            },
          },
        },
      })
    );
    await expect(fetchModeAccessData('regular')).rejects.toThrow(
      "Duplicate regular/maps id 'duplicate-map'"
    );

    mockEndpoints(
      baseRoutes('regular', {
        'regular/traders': {
          data: {
            first: { id: 'duplicate-trader', name: 'First' },
            second: { id: 'duplicate-trader', name: 'Second' },
          },
        },
      })
    );
    await expect(fetchModeAccessData('regular')).rejects.toThrow(
      "Duplicate regular/traders id 'duplicate-trader'"
    );
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
                taskRequirementGroups: [[{ task: 'prereq', status: ['active'] }]],
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
    expect(t1?.taskRequirementGroups).toEqual([
      [{ task: { id: 'prereq', name: 'Debut' }, status: ['active'] }],
    ]);
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

  it('continues without retrying when a mode is missing one translation endpoint', async () => {
    const routes = baseRoutes('pvp-season');
    delete routes['pvp-season/items_en'];

    const fetchMock = mockEndpoints(routes);

    await expect(fetchTasks('pvp-season')).resolves.toEqual([]);
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/pvp-season/items_en'))
    ).toHaveLength(1);
  });

  it('fails when a required translation endpoint is missing', async () => {
    const routes = baseRoutes('regular');
    delete routes['regular/tasks_en'];
    mockEndpoints(routes);
    vi.useFakeTimers();

    try {
      const request = expect(fetchTasks()).rejects.toThrow(/regular\/tasks_en/);
      await vi.runAllTimersAsync();
      await request;
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails when a required translation endpoint has the wrong shape', async () => {
    mockEndpoints(
      baseRoutes('regular', {
        'regular/tasks_en': { data: 'not a translation map' },
      })
    );

    await expect(fetchTasks()).rejects.toThrow(
      'Invalid json.tarkov.dev response for regular/tasks_en: expected data object'
    );
  });

  it('accepts array-shaped entity collections in fetchLocaleBundle', async () => {
    const fetchMock = mockEndpoints({
      'regular/tasks': {
        data: {
          tasks: [{ id: 't1', name: 't1 name' }],
          prestige: [{ id: 'p1', name: 'p1 name', prestigeLevel: 1 }],
        },
      },
      'regular/items': { data: { items: [{ id: 'i1', name: 'i1 name' }] } },
      'regular/maps': { data: { maps: [{ id: 'm1', name: 'm1 name' }] } },
      'regular/traders': { data: [{ id: 'tr1', name: 'tr1 name' }] },
      'regular/tasks_en': { data: {} },
      'regular/items_en': { data: {} },
      'regular/maps_en': { data: {} },
      'regular/traders_en': { data: {} },
    });

    const bundle = await fetchLocaleBundle('regular', 'en');

    expect(bundle.tasksById.has('t1')).toBe(true);
    expect(bundle.itemsById.has('i1')).toBe(true);
    expect(bundle.mapsById.has('m1')).toBe(true);
    expect(bundle.tradersById.has('tr1')).toBe(true);
    expect(fetchMock).toHaveBeenCalled();
  });

  it('fails when a required entity collection is missing', async () => {
    mockEndpoints(
      baseRoutes('regular', {
        'regular/items': { data: {} },
      })
    );

    await expect(fetchTasks()).rejects.toThrow(
      'Invalid json.tarkov.dev response for regular/items data.items: expected a collection'
    );
  });

  it('requests pve endpoints when pve mode is requested', async () => {
    const fetchMock = mockEndpoints(baseRoutes('pve'));

    await fetchTasks('pve');

    const requested = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(requested).toContain('https://json.tarkov.dev/pve/tasks');
    expect(requested).toContain('https://json.tarkov.dev/pve/items_en');
    expect(requested.every((url) => !url.includes('/regular/'))).toBe(true);
  });

  it('reports raw missing trader-requirement IDs before adapter normalization', async () => {
    mockEndpoints(
      baseRoutes('regular', {
        'regular/tasks': {
          data: {
            tasks: {
              t1: {
                id: 't1',
                name: 't1 name',
                traderRequirements: [{ requirementType: 'level', value: 2 }],
              },
            },
          },
        },
        'regular/tasks_en': { data: { 't1 name': 'Task One' } },
      })
    );

    const snapshot = await fetchTasksWithRequirementCounts();

    expect(snapshot.traderRequirementIds).toEqual({ total: 1, missing: 1 });
    expect(snapshot.tasks[0]?.traderRequirements?.[0]?.id).toMatch(/^overlay\.t1\./);
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

  it('shares endpoint reads when fetching tasks and access data together', async () => {
    const fetchMock = mockEndpoints(baseRoutes('regular'));

    await fetchTaskModeData('regular');

    const callsByPath = new Map<string, number>();
    for (const [url] of fetchMock.mock.calls) {
      const path = String(url).replace('https://json.tarkov.dev/', '');
      callsByPath.set(path, (callsByPath.get(path) ?? 0) + 1);
    }
    expect(callsByPath.get('regular/maps')).toBe(1);
    expect(callsByPath.get('regular/maps_en')).toBe(1);
    expect(callsByPath.get('regular/traders')).toBe(1);
    expect(callsByPath.get('regular/traders_en')).toBe(1);
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

  it('rejects a response whose declared body exceeds the size limit', async () => {
    const json = vi.fn(async () => ({ data: { tasks: {} } }));
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: () => String(MAX_RESPONSE_BYTES + 1) },
      json,
    }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchTasks()).rejects.toThrow(/exceeds the .*byte limit/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(json).not.toHaveBeenCalled();
  });

  it('aborts and retries a stalled request before failing deterministically', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      async (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        })
    );
    vi.stubGlobal('fetch', fetchMock);

    try {
      const request = expect(fetchTasks()).rejects.toThrow(
        `tarkov.dev request timed out after ${FETCH_TIMEOUT_MS}ms`
      );
      await vi.runAllTimersAsync();
      await request;
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
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

  it('fetchLocaleBundle fetches the requested locale endpoints and builds raw lookups', async () => {
    const fetchMock = mockEndpoints({
      'regular/tasks': {
        data: {
          tasks: { t1: { id: 't1', name: 't1 name', wikiLink: 'https://wiki/T1' } },
          prestige: [{ id: 'p1', name: 'p1 name', prestigeLevel: 1 }],
        },
      },
      'regular/items': { data: { items: { i1: { id: 'i1', name: 'i1 Name' } } } },
      'regular/maps': { data: { maps: { m1: { id: 'm1', name: 'm1 Name' } } } },
      'regular/traders': { data: { tr1: { id: 'tr1', name: 'tr1 Nickname' } } },
      'regular/tasks_de': { data: { 't1 name': 'Neuanfang' } },
      'regular/items_de': { data: { 'i1 Name': 'Rubel' } },
      'regular/maps_de': { data: {} },
      'regular/traders_de': { data: {} },
    });

    const bundle = await fetchLocaleBundle('regular', 'de');

    expect(bundle.locale).toBe('de');
    // Core records stay raw (translation keys as field values, wikiLink inline)
    expect(bundle.tasksById.get('t1')).toEqual({
      id: 't1',
      name: 't1 name',
      wikiLink: 'https://wiki/T1',
    });
    expect(bundle.prestigeById.get('p1')?.prestigeLevel).toBe(1);
    expect(bundle.itemsById.get('i1')?.name).toBe('i1 Name');
    expect(bundle.mapsById.has('m1')).toBe(true);
    expect(bundle.tradersById.has('tr1')).toBe(true);
    // Locale maps come from the _<locale> endpoints
    expect(bundle.tasksLocale['t1 name']).toBe('Neuanfang');
    expect(bundle.itemsLocale['i1 Name']).toBe('Rubel');

    const requested = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(requested).toContain('https://json.tarkov.dev/regular/tasks_de');
    expect(requested).toContain('https://json.tarkov.dev/regular/items_de');
    expect(requested.every((url) => !url.endsWith('_en'))).toBe(true);
  });

  it('fetchLocaleBundle defaults to regular mode and the en locale', async () => {
    const fetchMock = mockEndpoints(baseRoutes('regular'));

    const bundle = await fetchLocaleBundle();

    expect(bundle.locale).toBe('en');
    const requested = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(requested).toContain('https://json.tarkov.dev/regular/tasks_en');
    expect(requested.every((url) => !url.includes('/pve/'))).toBe(true);
  });

  it('findTaskById returns matching task', () => {
    const tasks: TaskData[] = [
      { id: 'task-1', name: 'Task 1' },
      { id: 'task-2', name: 'Task 2' },
    ];

    expect(findTaskById(tasks, 'task-2')).toEqual({ id: 'task-2', name: 'Task 2' });
    expect(findTaskById(tasks, 'missing')).toBeUndefined();
  });

  describe('fetchRawEntities', () => {
    it('indexes a top-level array collection by id (crafts endpoint shape)', async () => {
      mockEndpoints({
        'regular/crafts': {
          data: [
            { id: 'craft-a', station: 's1', level: 1 },
            { id: 'craft-b', station: 's2', level: 2 },
          ],
        },
      });

      const entities = await fetchRawEntities('regular', 'crafts');

      expect(entities.size).toBe(2);
      expect(entities.get('craft-a')).toMatchObject({ id: 'craft-a', level: 1 });
      expect(entities.get('craft-b')).toMatchObject({ id: 'craft-b', level: 2 });
    });

    it('drills into a nested collection when collectionKey is provided', async () => {
      mockEndpoints({
        'regular/items': { data: { items: { 'item-a': { id: 'item-a' } } } },
      });

      const entities = await fetchRawEntities('regular', 'items', 'items');

      expect(entities.size).toBe(1);
      expect(entities.get('item-a')).toBeDefined();
    });

    it('throws when a top-level array is combined with a collectionKey', async () => {
      mockEndpoints({
        'regular/crafts': { data: [{ id: 'craft-a' }] },
      });

      await expect(fetchRawEntities('regular', 'crafts', 'crafts')).rejects.toThrow(
        /collectionKey 'crafts' was provided/
      );
    });

    it('treats the data object itself as the collection when no key is provided', async () => {
      mockEndpoints({
        'regular/traders': { data: { 'trader-a': { id: 'trader-a' } } },
      });

      const entities = await fetchRawEntities('regular', 'traders');

      expect(entities.size).toBe(1);
      expect(entities.get('trader-a')).toBeDefined();
    });

    it('throws when a named collection is missing', async () => {
      mockEndpoints({ 'regular/items': { data: {} } });

      await expect(fetchRawEntities('regular', 'items', 'items')).rejects.toThrow(
        /expected data\.items collection/
      );
    });
  });
});
