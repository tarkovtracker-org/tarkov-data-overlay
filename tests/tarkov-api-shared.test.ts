import { describe, expect, it } from 'vitest';
import { fetchCached, resolveReferenceMatrix } from '../src/lib/tarkov-api-shared.cjs';

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
