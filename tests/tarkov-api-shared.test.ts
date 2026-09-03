import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  fetchCached,
  adaptReward,
  getNextTagVersion,
  isVersionStale,
  mergeTaskOverride,
  readResponseJson,
  resolveReferenceMatrix,
} from '../src/lib/tarkov-api-shared.cjs';

function createGitRepo(): string {
  const directory = mkdtempSync(join(tmpdir(), 'tarkov-overlay-tags-'));
  execFileSync('git', ['-C', directory, 'init', '--quiet'], { stdio: 'ignore' });
  execFileSync('git', ['-C', directory, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', directory, 'config', 'user.name', 'Test']);
  execFileSync('git', ['-C', directory, 'commit', '--quiet', '--allow-empty', '-m', 'init']);
  return directory;
}

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

describe('getNextTagVersion', () => {
  it('uses the highest supported tag and ignores lower prereleases', () => {
    const directory = createGitRepo();
    try {
      for (const tag of ['v1.9', 'v1.10.0-rc.2', 'v1.10.0', 'not-a-version']) {
        execFileSync('git', ['-C', directory, 'tag', tag]);
      }

      expect(getNextTagVersion(directory)).toBe('v1.11');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('starts with v1.0 when no supported tags exist', () => {
    const directory = createGitRepo();
    try {
      expect(getNextTagVersion(directory)).toBe('v1.0');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('ignores canonical-looking tags that are not reachable from HEAD', () => {
    const directory = createGitRepo();
    try {
      execFileSync('git', ['-C', directory, 'tag', 'v1.0']);
      execFileSync('git', ['-C', directory, 'checkout', '--quiet', '-b', 'unmerged-release']);
      execFileSync('git', [
        '-C',
        directory,
        'commit',
        '--quiet',
        '--allow-empty',
        '-m',
        'unmerged',
      ]);
      execFileSync('git', ['-C', directory, 'tag', 'v99.99']);
      execFileSync('git', ['-C', directory, 'checkout', '--quiet', '-']);

      expect(getNextTagVersion(directory)).toBe('v1.1');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('compares large numeric prerelease identifiers without precision loss', () => {
    expect(isVersionStale('1.0.0-rc.9007199254740992', '1.0.0-rc.9007199254740993')).toBe(true);
  });

  it('ignores invalid prerelease identifiers', () => {
    const directory = createGitRepo();
    try {
      for (const tag of ['v1.0', 'v99.99.0-01', 'v99.99.0-123_']) {
        execFileSync('git', ['-C', directory, 'tag', tag]);
      }

      expect(getNextTagVersion(directory)).toBe('v1.1');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
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

describe('adaptReward', () => {
  it('adds explicit names to unresolved trader and map references', () => {
    const compact = (value: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
    const result = adaptReward(
      { traderUnlock: ['missing-trader'], locationUnlock: ['missing-map'] },
      {},
      {
        isRecord: (value): value is Record<string, unknown> =>
          value !== null && typeof value === 'object' && !Array.isArray(value),
        compact,
        resolveItemRef: () => undefined,
        resolveTraderRef: (value) => ({ id: String(value) }),
        resolveMapRef: (value) => ({ id: String(value) }),
      }
    ) as {
      traderUnlock: Array<{ id: string; name: string }>;
      locationUnlock: Array<{ id: string; name: string }>;
    };

    expect(result.traderUnlock).toEqual([{ id: 'missing-trader', name: 'Unknown trader' }]);
    expect(result.locationUnlock).toEqual([{ id: 'missing-map', name: 'Unknown map' }]);
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
