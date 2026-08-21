/**
 * Duplicate keys in the override sources, and the scanner that finds them.
 *
 * JSON5 keeps the last of two identical keys and nothing warns, so a repeated
 * key silently drops the earlier entry. Three task blocks lost a name and
 * thirteen objectives that way while every check stayed green.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { findDuplicateKeys, getProjectPaths } from '../src/lib/index.js';

const { srcDir } = getProjectPaths();

function json5Files(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return json5Files(full);
    return entry.endsWith('.json5') ? [full] : [];
  });
}

const lines = (...rows: string[]) => rows.join('\n');
const keys = (source: string) => findDuplicateKeys(source).map((d) => `${d.key} (${d.count}x)`);

describe('override sources', () => {
  const files = json5Files(srcDir);

  it('finds files to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files.map((f) => [f.slice(srcDir.length + 1), f]))(
    '%s has no duplicate keys',
    (_, file) => {
      expect(findDuplicateKeys(readFileSync(file, 'utf-8'))).toEqual([]);
    }
  );
});

describe('findDuplicateKeys', () => {
  it('reports a repeated single-quoted key', () => {
    expect(
      keys(lines('{', '  tasks: {', "    'a': { x: 1 },", "    'a': { y: 2 },", '  },', '}'))
    ).toEqual(['a (2x)']);
  });

  it('reports a repeated unquoted key — the form most keys in this repo use', () => {
    expect(
      keys(lines('{', '  task: {', "    name: 'one',", "    name: 'two',", '  },', '}'))
    ).toEqual(['name (2x)']);
  });

  it('reports a repeated double-quoted key', () => {
    expect(
      keys(lines('{', '  tasks: {', '    "a": { x: 1 },', '    "a": { y: 2 },', '  },', '}'))
    ).toEqual(['a (2x)']);
  });

  it('treats the three quoting styles as the same key', () => {
    expect(
      keys(
        lines(
          '{',
          '  tasks: {',
          "    'a': { x: 1 },",
          '    "a": { y: 2 },',
          '    a: { z: 3 },',
          '  },',
          '}'
        )
      )
    ).toEqual(['a (3x)']);
  });

  it('leaves the same key under different parents alone', () => {
    expect(
      keys(
        lines(
          '{',
          '  tasks: {',
          "    'a': { objectives: { 'x': { d: 1 } } },",
          "    'b': { objectives: { 'x': { d: 2 } } },",
          '  },',
          '}'
        )
      )
    ).toEqual([]);
  });

  it('reports the full path so a duplicate can be located', () => {
    const found = findDuplicateKeys(
      lines(
        '{',
        '  tasks: {',
        "    'a': {",
        '      objectives: {',
        "        'x': { d: 1 },",
        "        'x': { e: 2 },",
        '      },',
        '    },',
        '  },',
        '}'
      )
    );
    expect(found).toEqual([{ path: 'tasks/a/objectives/x', key: 'x', count: 2 }]);
  });

  it('ignores a key inside a line comment', () => {
    expect(
      keys(lines('{', '  tasks: {', "    'a': { x: 1 },", "    // 'a': { x: 2 },", '  },', '}'))
    ).toEqual([]);
  });

  it('ignores a key inside a block comment, including across lines', () => {
    expect(
      keys(
        lines(
          '{',
          '  tasks: {',
          "    'a': { x: 1 },",
          '    /*',
          "      'a': { x: 2 },",
          '    */',
          '  },',
          '}'
        )
      )
    ).toEqual([]);
  });

  it('is not fooled by a value containing //', () => {
    // wikiLink values hold "https://", which a naive comment strip would cut,
    // taking the closing brace on that line with it.
    expect(
      keys(
        lines(
          '{',
          '  tasks: {',
          "    'a': { wikiLink: 'https://example.com/wiki/X' },",
          "    'b': { wikiLink: 'https://example.com/wiki/Y' },",
          '  },',
          '}'
        )
      )
    ).toEqual([]);
  });

  it('is not fooled by a brace inside a value', () => {
    expect(
      keys(
        lines(
          '{',
          '  tasks: {',
          "    'a': { d: 'a { brace' },",
          "    'b': { d: 'and } another' },",
          '  },',
          '}'
        )
      )
    ).toEqual([]);
  });

  it('is not fooled by a quote inside a value', () => {
    expect(
      keys(
        lines(
          '{',
          '  tasks: {',
          "    'a': { d: 'it\\'s fine' },",
          "    'b': { d: 'so is this' },",
          '  },',
          '}'
        )
      )
    ).toEqual([]);
  });

  it('leaves repeated keys in separate array elements alone', () => {
    // storyRequirements is a list of objects that each carry a type and a
    // name. They are siblings in the text but not in the data, so the path
    // has to include the element index.
    expect(
      keys(
        lines(
          '{',
          '  prestige: {',
          "    'p1': {",
          '      storyRequirements: [',
          "        { type: 'chapter', name: 'one' },",
          "        { type: 'chapter', name: 'two' },",
          '      ],',
          '    },',
          '  },',
          '}'
        )
      )
    ).toEqual([]);
  });

  it('still reports a repeated key inside one array element', () => {
    expect(keys(lines('{', '  list: [', "    { type: 'a', type: 'b' },", '  ],', '}'))).toEqual([
      'type (2x)',
    ]);
  });
});
