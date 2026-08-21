/**
 * The "// Was:" pairing in scripts/status-de.ts.
 *
 * This is the part that matters: it found a translation still promising "15
 * Ziele" after the English objective had dropped the fixed count. An earlier
 * version of the pairing missed exactly that entry and reported a different
 * one instead, because the file uses two comment placements and the scan only
 * understood one.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readCoverage, readWasComments } from '../scripts/status-locale.js';

let dir: string;
const write = (body: string) => {
  const file = join(dir, 'de.json5');
  writeFileSync(file, body, 'utf-8');
  return file;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'status-de-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const A = 'a'.repeat(24);
const B = 'b'.repeat(24);

describe('readWasComments', () => {
  it('pairs a comment placed above the objective id', () => {
    const file = write(
      [
        '{',
        '  tasks: {',
        `    '${A}': {`,
        '      objectives: {',
        '        // Was: Eliminate any target',
        `        '${B}': {`,
        "          description: 'Eliminiere ein beliebiges Ziel',",
        '        },',
        '      },',
        '    },',
        '  },',
        '}',
      ].join('\n')
    );
    expect(readWasComments(file)).toEqual([{ id: B, was: 'Eliminate any target' }]);
  });

  it('pairs a comment placed inside the entry, above description', () => {
    const file = write(
      [
        '{',
        '  tasks: {',
        `    '${A}': {`,
        '      objectives: {',
        `        '${B}': {`,
        '          // Was: Eliminate any target',
        "          description: 'Eliminiere ein beliebiges Ziel',",
        '        },',
        '      },',
        '    },',
        '  },',
        '}',
      ].join('\n')
    );
    expect(readWasComments(file)).toEqual([{ id: B, was: 'Eliminate any target' }]);
  });

  it('pairs a name comment with the task, not with the objective below it', () => {
    const file = write(
      [
        '{',
        '  tasks: {',
        '    // Was: The Punisher - Part 1',
        `    '${A}': {`,
        "      name: 'Der Peiniger – Teil 1',",
        '      objectives: {',
        '        // Was: Eliminate Scavs',
        `        '${B}': {`,
        "          description: 'Eliminiere Scavs',",
        '        },',
        '      },',
        '    },',
        '  },',
        '}',
      ].join('\n')
    );
    expect(readWasComments(file)).toEqual([
      { id: `${A} name`, was: 'The Punisher - Part 1' },
      { id: B, was: 'Eliminate Scavs' },
    ]);
  });
});

describe('readCoverage', () => {
  it('keys entries the way the translation bundle keys them', () => {
    const file = write(
      [
        '{',
        '  tasks: {',
        `    '${A}': {`,
        "      name: 'Neuanfang',",
        '      objectives: {',
        `        '${B}': { description: 'Eliminiere Scavs' },`,
        '      },',
        '    },',
        '  },',
        '}',
      ].join('\n')
    );
    expect([...readCoverage(file)]).toEqual([
      [`${A} name`, 'Neuanfang'],
      [B, 'Eliminiere Scavs'],
    ]);
  });
});
