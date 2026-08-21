/**
 * Duplicate keys in the override sources.
 *
 * JSON5 accepts a repeated key and keeps the last one. Nothing warns: the
 * file parses, validate passes, the build succeeds, and the earlier entry is
 * gone. That is how three task blocks lost a name and thirteen objectives
 * while every check stayed green.
 *
 * The scan is textual on purpose. Parsing first would collapse the duplicate
 * before it could be seen.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { getProjectPaths } from '../src/lib/index.js';

const { srcDir } = getProjectPaths();

function json5Files(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return json5Files(full);
    return entry.endsWith('.json5') ? [full] : [];
  });
}

/**
 * Every quoted key by its full path. Depth alone is not enough: the same key
 * under two different parents sits at the same depth and is not a duplicate —
 * `pvp-season` legitimately appears once per task in the divergences file.
 */
function duplicateKeys(source: string): string[] {
  const counts = new Map<string, number>();
  const stack: { key: string; depth: number }[] = [];
  let depth = 0;
  for (const raw of source.split('\n')) {
    const line = raw.replace(/\/\/.*$/, '');
    const key = line.match(/^\s*'([^']+)'\s*:/);
    const delta = (line.match(/[{[]/g) ?? []).length - (line.match(/[}\]]/g) ?? []).length;
    if (key) {
      const path = [...stack.map((s) => s.key), key[1]].join('/');
      counts.set(path, (counts.get(path) ?? 0) + 1);
      if (delta > 0) stack.push({ key: key[1], depth });
    }
    depth += delta;
    while (stack.length && stack[stack.length - 1]!.depth >= depth) stack.pop();
  }
  return [...counts]
    .filter(([, n]) => n > 1)
    .map(([path, n]) => `${path.split('/').pop()} (${n}x)`);
}

describe('override sources', () => {
  const files = json5Files(srcDir);

  it('finds files to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map((f) => [f.slice(srcDir.length + 1), f]))(
    '%s has no duplicate keys',
    (_, file) => {
      expect(duplicateKeys(readFileSync(file, 'utf-8'))).toEqual([]);
    }
  );
});

describe('the duplicate scan itself', () => {
  it('sees a repeated key at the same level', () => {
    const source = [
      '{',
      '  tasks: {',
      "    'a': { x: 1 },",
      "    'a': { x: 2 },",
      '  },',
      '}',
    ].join('\n');
    expect(duplicateKeys(source)).toEqual(['a (2x)']);
  });

  it('leaves the same key under different parents alone', () => {
    const source = [
      '{',
      '  tasks: {',
      "    'a': {",
      '      objectives: {',
      "        'x': { d: 1 },",
      '      },',
      '    },',
      "    'b': {",
      '      objectives: {',
      "        'x': { d: 2 },",
      '      },',
      '    },',
      '  },',
      '}',
    ].join('\n');
    expect(duplicateKeys(source)).toEqual([]);
  });

  it('ignores a key that only appears inside a comment', () => {
    const source = [
      '{',
      '  tasks: {',
      "    'a': { x: 1 },",
      "    // 'a': { x: 2 },",
      '  },',
      '}',
    ].join('\n');
    expect(duplicateKeys(source)).toEqual([]);
  });
});
