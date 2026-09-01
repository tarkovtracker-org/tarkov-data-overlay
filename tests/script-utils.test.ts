import { afterEach, describe, expect, it, vi } from 'vitest';
import { pathToFileURL } from 'node:url';
import { isDirectExecution, runDirectly, sleep } from '../src/lib/script-utils.js';

const originalArgv = [...process.argv];

afterEach(() => {
  process.argv = [...originalArgv];
  vi.useRealTimers();
});

describe('isDirectExecution', () => {
  it('returns true when importMetaUrl matches argv[1]', () => {
    process.argv[1] = '/tmp/example.ts';

    expect(isDirectExecution(pathToFileURL(process.argv[1]).href)).toBe(true);
  });

  it('returns false for a mismatched URL', () => {
    process.argv[1] = '/tmp/example.ts';

    expect(isDirectExecution(pathToFileURL('/tmp/other.ts').href)).toBe(false);
  });

  it('returns false when argv[1] is missing', () => {
    process.argv = [process.argv[0]];

    expect(isDirectExecution('file:///tmp/example.ts')).toBe(false);
  });
});

describe('sleep', () => {
  it('resolves after the requested delay', async () => {
    vi.useFakeTimers();
    let resolved = false;

    const promise = sleep(100).then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(99);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await promise;
    expect(resolved).toBe(true);
  });
});

describe('runDirectly', () => {
  it('does not invoke the entry point when the module is imported', () => {
    process.argv[1] = '/tmp/entry.ts';
    const main = vi.fn(async () => {});

    runDirectly(pathToFileURL('/tmp/imported.ts').href, main);

    expect(main).not.toHaveBeenCalled();
  });
});
