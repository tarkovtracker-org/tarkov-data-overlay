import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchTasks, type TaskData } from '../src/lib/index.js';

const { fetchApiTasks } = createRequire(import.meta.url)('../monitor/lib/tarkov-api.js') as {
  fetchApiTasks: (mode?: string) => Promise<TaskData[]>;
};
const { fetchTarkovJson } = createRequire(import.meta.url)(
  '../monitor/lib/tarkov-transport.js'
) as {
  fetchTarkovJson: (path: unknown, signal?: AbortSignal) => Promise<Response>;
};

function mockEndpoints(mode: string, task: Record<string, unknown>) {
  const routes: Record<string, unknown> = {
    [`${mode}/tasks`]: {
      data: { tasks: { task }, questItems: [{ id: 'quest', name: 'quest.name' }] },
    },
    [`${mode}/tasks_en`]: {
      data: {
        'task.name': 'Synthetic task',
        objective: 'Visit a place',
        'quest.name': 'Quest item',
      },
    },
    [`${mode}/items`]: {
      data: { items: { item: { id: 'item', name: 'item.name', shortName: 'item.short' } } },
    },
    [`${mode}/items_en`]: { data: { 'item.name': 'Synthetic item', 'item.short': 'Item' } },
    [`${mode}/maps`]: { data: { maps: { map: { id: 'map', name: 'map.name' } } } },
    [`${mode}/maps_en`]: { data: { 'map.name': 'Synthetic map' } },
    [`${mode}/traders`]: { data: { trader: { id: 'trader', name: 'trader.name' } } },
    [`${mode}/traders_en`]: { data: { 'trader.name': 'Synthetic trader' } },
  };
  const mock = vi.fn(async (url: string) => {
    const key = String(url).replace('https://json.tarkov.dev/', '');
    return new Response(JSON.stringify(routes[key] ?? {}), { status: key in routes ? 200 : 404 });
  });
  vi.stubGlobal('fetch', mock);
  return mock;
}

afterEach(() => vi.unstubAllGlobals());

describe('monitor transport policy', () => {
  it.each(['endpoints', 'regular/tasks', 'pve/maps_en', 'pvp-season/items_en'])(
    'keeps the requested origin fixed for %s',
    async (path) => {
      const fetch = vi.fn().mockResolvedValue(new Response('{}'));
      vi.stubGlobal('fetch', fetch);
      const signal = new AbortController().signal;
      await fetchTarkovJson(path, signal);
      expect(fetch).toHaveBeenCalledWith(`https://json.tarkov.dev/${path}`, {
        headers: {
          Accept: 'application/json',
          'User-Agent':
            'tarkov-data-overlay (+https://github.com/tarkovtracker-org/tarkov-data-overlay)',
        },
        signal,
      });
    }
  );

  it.each([
    '../tasks',
    'regular/../tasks',
    '//example.com/tasks',
    'https://example.com/tasks',
    'regular/tasks?host=example.com',
    'regular/tasks#fragment',
    'regular/tasks/extra',
    'regular\\tasks',
    'regular/%2e%2e/tasks',
    'regular/unknown',
    null,
  ])('rejects unsafe or unknown endpoint %j before fetching', async (path) => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(fetchTarkovJson(path)).rejects.toMatchObject({
      message: 'Invalid tarkov.dev endpoint',
      fatal: true,
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('monitor and validator normalization', () => {
  it.each(['regular', 'pve', 'pvp-season'] as const)(
    'resolves public synthetic references identically in %s',
    async (mode) => {
      mockEndpoints(mode, {
        id: 'task',
        name: 'task.name',
        trader: 'trader',
        map: 'map',
        taskRequirements: [{ task: 'task', status: ['complete'] }],
        objectives: [
          {
            id: 'objective',
            description: 'objective',
            maps: ['map'],
            items: ['item'],
            item: 'item',
            markerItem: 'item',
            questItem: 'quest',
            useAny: ['item'],
            containsAll: ['item'],
            usingWeapon: ['item'],
            usingWeaponMods: [['item']],
            requiredKeys: [['item']],
            wearing: [['item']],
            notWearing: ['item'],
            zones: [{ map: 'map', position: { x: 1, y: 2, z: 3 } }],
            possibleLocations: [{ map: 'map', position: { x: 4, y: 5, z: 6 } }],
          },
        ],
        finishRewards: {
          items: [{ item: 'item', count: 2 }],
          traderStanding: [{ trader: 'trader', standing: 0.1 }],
          offerUnlock: [{ trader: 'trader', item: 'item' }],
          traderUnlock: 'trader',
          traderDialogueUnlock: ['trader'],
          locationUnlock: ['map'],
        },
      });
      const validator = await fetchTasks(mode);
      const monitor = await fetchApiTasks(mode);
      expect(monitor).toEqual(validator);
      expect(monitor[0].finishRewards?.locationUnlock).toEqual([
        { id: 'map', name: 'Synthetic map' },
      ]);
      expect(monitor[0].objectives?.[0].possibleLocations).toEqual([
        { map: { id: 'map', name: 'Synthetic map' }, position: { x: 4, y: 5, z: 6 } },
      ]);
    }
  );

  it('keeps synthetic trader requirement identities specific to the validator', async () => {
    mockEndpoints('regular', {
      id: 'task',
      name: 'task.name',
      traderRequirements: [
        { trader: 'trader', requirementType: 'level', compareMethod: '>=', value: 2 },
      ],
    });
    const [monitor] = await fetchApiTasks();
    const [validator] = await fetchTasks();
    expect(monitor.traderRequirements?.[0]).not.toHaveProperty('id');
    expect(validator.traderRequirements?.[0].id).toMatch(/^overlay\./);
  });

  it('rejects path-shaped modes before sending a request', async () => {
    const mock = mockEndpoints('regular', {});
    await expect(fetchApiTasks('../pve')).rejects.toThrow('Invalid game mode');
    expect(mock).not.toHaveBeenCalled();
  });

  it('retains malformed task validation in the extracted transport', async () => {
    mockEndpoints('regular', { name: 'missing id' });
    await expect(fetchApiTasks()).rejects.toThrow("task 'task' has no id");
  });
});
