import { describe, expect, it } from 'vitest';
import {
  fetchCached,
  mergeTaskOverride,
  readResponseJson,
  resolveReferenceMatrix,
} from '../src/lib/tarkov-api-shared.cjs';

describe('fetchCached', () => {
  it('reuses in-flight requests and evicts rejected entries', async () => {
    const cache = new Map<string, Promise<string>>();
    let calls = 0;
    const load = async () => {
      calls += 1;
      throw new Error('boom');
    };

    const first = fetchCached(cache, 'items', load);
    expect(fetchCached(cache, 'items', load)).toBe(first);
    await expect(first).rejects.toThrow('boom');
    expect(cache.has('items')).toBe(false);

    await expect(fetchCached(cache, 'items', load)).rejects.toThrow('boom');
    expect(calls).toBe(2);
  });
});

describe('resolveReferenceMatrix', () => {
  it('wraps single entries, omits empty groups, and rejects non-array input', () => {
    const resolve = (value: unknown) => (value === 'skip' ? undefined : { id: String(value) });

    expect(resolveReferenceMatrix(['item', ['skip']], resolve)).toEqual([[{ id: 'item' }]]);
    expect(resolveReferenceMatrix('item', resolve)).toBeUndefined();
  });
});

describe('mergeTaskOverride', () => {
  it('merges objective patches without treating special keys as prototype setters', () => {
    const shared = JSON.parse('{"objectives":{"__proto__":{"count":1}}}');
    const modeSpecific = JSON.parse('{"objectives":{"__proto__":{"foundInRaid":true}}}');

    const merged = mergeTaskOverride(shared, modeSpecific) as {
      objectives: Record<string, Record<string, unknown>>;
    };

    expect(Object.hasOwn(merged.objectives, '__proto__')).toBe(true);
    expect(merged.objectives.__proto__).toEqual({ count: 1, foundInRaid: true });
    expect(Object.getPrototypeOf(merged.objectives)).toBe(Object.prototype);
  });
});

describe('readResponseJson', () => {
  it('parses native responses and rejects malformed JSON without retry semantics', async () => {
    await expect(readResponseJson(new Response('{"data":{}}'), 'regular/tasks')).resolves.toEqual({
      data: {},
    });
    await expect(readResponseJson(new Response('{'), 'regular/tasks')).rejects.toThrow(
      'Invalid JSON response from tarkov.dev for regular/tasks'
    );
  });

  it('rejects a streamed body after it crosses the configured limit', async () => {
    await expect(readResponseJson(new Response('12345'), 'regular/tasks', 4)).rejects.toThrow(
      'exceeds the 4-byte limit'
    );
  });
});
