/**
 * Tests for tarkov-api module
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchTasks, findTaskById, type TaskData } from '../src/lib/index.js';

describe('tarkov-api', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('fetchTasks returns tasks when API request succeeds', async () => {
    const tasks: TaskData[] = [{ id: 'task-1', name: 'Task 1' }];
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ data: { tasks } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await fetchTasks();

    expect(result).toEqual(tasks);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.tarkov.dev/graphql',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
    );
  });

  it('fetchTasks throws when HTTP response is not ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        json: async () => ({}),
      })
    );

    await expect(fetchTasks()).rejects.toThrow(
      'API request failed: 503 Service Unavailable'
    );
  });

  it('fetchTasks throws when GraphQL errors are returned', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          errors: [{ message: 'Something failed' }],
        }),
      })
    );

    await expect(fetchTasks()).rejects.toThrow('GraphQL errors');
  });

  it('fetchTasks retries without usingWeapon when upstream has a broken item reference', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          errors: [
            {
              message: 'No item found with id undefined',
              path: ['tasks', 218, 'objectives', 0, 'usingWeapon', 0],
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ data: { tasks: [{ id: 'task-1', name: 'Task 1' }] } }),
      });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchTasks()).resolves.toEqual([{ id: 'task-1', name: 'Task 1' }]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstRequest = fetchMock.mock.calls[0][1] as { body?: string };
    const firstPayload = JSON.parse(String(firstRequest.body)) as { query: string };
    expect(firstPayload.query).toContain('usingWeapon { id name shortName }');

    const retryRequest = fetchMock.mock.calls[1][1] as { body?: string };
    const retryPayload = JSON.parse(String(retryRequest.body)) as { query: string };
    expect(retryPayload.query).not.toContain('usingWeapon { id name shortName }');
    expect(retryPayload.query).toContain('usingWeaponMods { id name shortName }');
  });

  it('fetchTasks retries without usingWeapon when the upstream missing-item wording changes', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({
          errors: [
            {
              message: 'Item not found for id 660bbc47c38b837877075e47',
              path: ['tasks', 218, 'objectives', 0, 'usingWeapon', 0],
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ data: { tasks: [{ id: 'task-1', name: 'Task 1' }] } }),
      });
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchTasks()).resolves.toEqual([{ id: 'task-1', name: 'Task 1' }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fetchTasks sends pve gameMode variables when requested', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ data: { tasks: [] } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    await fetchTasks('pve');

    const request = fetchMock.mock.calls[0][1] as { body?: string };
    const payload = JSON.parse(String(request.body)) as {
      variables?: { gameMode?: string };
    };

    expect(payload.variables).toEqual({ gameMode: 'pve' });
  });

  it('fetchTasks throws when GraphQL response is not an object', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => null,
      })
    );

    await expect(fetchTasks()).rejects.toThrow(
      'Invalid GraphQL response: expected an object, got null'
    );
  });

  it('fetchTasks throws when GraphQL response is missing data', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({}),
      })
    );

    await expect(fetchTasks()).rejects.toThrow(
      'Invalid GraphQL response: missing data field'
    );
  });

  it('fetchTasks throws when GraphQL response is missing tasks', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ data: {} }),
      })
    );

    await expect(fetchTasks()).rejects.toThrow(
      'Invalid GraphQL response: missing data.tasks'
    );
  });

  it('fetchTasks throws when GraphQL tasks payload is not an array', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ data: { tasks: {} } }),
      })
    );

    await expect(fetchTasks()).rejects.toThrow(
      'Invalid GraphQL response: expected data.tasks to be an array, got object'
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
