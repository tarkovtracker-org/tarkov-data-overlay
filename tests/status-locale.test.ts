/**
 * The English-source pairing in scripts/status-locale.ts.
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
import {
  analyse,
  readCoverage,
  readDataCorrections,
  readWasComments,
} from '../scripts/status-locale.js';

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

const TASK_ID = 't'.repeat(24);
const OBJ_ID = 'o'.repeat(24);
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

describe('analyse', () => {
  const EN = 'Eliminate Scavs';
  const DE = 'Eliminiere Scavs';
  const TASK = 't'.repeat(24);
  const OBJ = 'o'.repeat(24);

  const run = (over: Partial<Parameters<typeof analyse>[0]> = {}) =>
    analyse({
      tasksById: new Map([[TASK, { trader: 'x', objectives: [{ id: OBJ }] }]]),
      english: { [`${TASK} name`]: 'A Task', [OBJ]: EN },
      englishRaw: { [`${TASK} name`]: 'A Task', [OBJ]: EN },
      translated: { [`${TASK} name`]: 'A Task', [OBJ]: EN },
      coverage: new Map(),
      wasComments: [],
      traderOf: () => 'Prapor',
      ...over,
    });

  it('counts an entry the bundle leaves in English, and that we do not patch, as open', () => {
    const row = run().rows.get('Prapor');
    expect(row).toMatchObject({ openNames: 1, openObjectives: 1, covered: 0 });
  });

  it('counts an entry we patch as covered, not open', () => {
    const row = run({ coverage: new Map([[OBJ, DE]]) }).rows.get('Prapor');
    expect(row).toMatchObject({ openObjectives: 0, covered: 1 });
  });

  it('does not count a translated entry as open just because we do not patch it', () => {
    const row = run({ translated: { [`${TASK} name`]: 'A Task', [OBJ]: DE } }).rows.get('Prapor');
    expect(row).toMatchObject({ openObjectives: 0, covered: 0 });
  });

  it('reports an override the bundle now matches verbatim as a no-op', () => {
    const { noop } = run({ coverage: new Map([[OBJ, DE]]), translated: { [OBJ]: DE } });
    expect(noop).toEqual([`${OBJ} — bundle now says exactly this`]);
  });

  it('does not call an override a no-op merely because the bundle differs from English', () => {
    // The bundle has German, but the wrong German — which is exactly what a
    // locale override is for. Reporting this as removable would delete the fix.
    const { noop } = run({
      coverage: new Map([[OBJ, DE]]),
      translated: { [OBJ]: 'Eliminiere Skavs' },
    });
    expect(noop).toEqual([]);
  });

  it('reports an entry whose English source has changed', () => {
    const { drifted } = run({ wasComments: [{ id: OBJ, was: 'Eliminate 15 Scavs' }] });
    expect(drifted).toEqual([{ id: OBJ, was: 'Eliminate 15 Scavs', now: EN }]);
  });

  it('measures drift against the corrected English, not the raw bundle', () => {
    // The English bundle carries the German string for the New Beginning
    // quests; en.json5 corrects that. Without applying it first, those entries
    // report as drift on every run.
    const { drifted } = run({
      english: { [`${TASK} name`]: 'New Beginning' },
      englishRaw: { [`${TASK} name`]: 'Neuanfang' },
      wasComments: [{ id: `${TASK} name`, was: 'New Beginning' }],
    });
    expect(drifted).toEqual([]);
  });

  it('reports nothing to act on when everything is patched and current', () => {
    const { noop, drifted } = run({
      coverage: new Map([[OBJ, DE]]),
      wasComments: [{ id: OBJ, was: EN }],
    });
    expect({ noop, drifted }).toEqual({ noop: [], drifted: [] });
  });
});

describe('readDataCorrections', () => {
  it('reads the English that overrides/tasks.json5 replaces outright', () => {
    const file = join(dir, 'tasks.json5');
    writeFileSync(
      file,
      [
        '{',
        `  '${A}': {`,
        "    name: 'Corrected Name',",
        '    objectives: {',
        `      '${B}': { description: 'Eliminate 15 targets' },`,
        '    },',
        '  },',
        '}',
      ].join('\n'),
      'utf-8'
    );
    expect([...readDataCorrections(file)]).toEqual([
      [`${A} name`, 'Corrected Name'],
      [B, 'Eliminate 15 targets'],
    ]);
  });

  it('ignores entries that correct something other than the text', () => {
    const file = join(dir, 'tasks.json5');
    writeFileSync(
      file,
      [
        '{',
        `  '${A}': {`,
        '    experience: 65000,',
        '    objectives: {',
        `      '${B}': { count: 2 },`,
        '    },',
        '  },',
        '}',
      ].join('\n'),
      'utf-8'
    );
    expect([...readDataCorrections(file)]).toEqual([]);
  });
});

describe('drift against corrected English', () => {
  // The regression this guards: One-Way Ticket. The API says "any target",
  // overrides/tasks.json5 corrects it to "15 targets", and the German follows
  // the correction. Measuring drift against the raw bundle reported it as
  // stale and invited "fixing" the German back to the uncorrected wording.
  it('does not report drift when the translation follows a corrected English text', () => {
    const corrected = 'Eliminate 15 targets with headshots while using an AUG on Factory';
    const raw = 'Eliminate any target with headshots using a Steyr AUG on Factory';
    const { drifted } = analyse({
      tasksById: new Map([[TASK_ID, { trader: 'x', objectives: [{ id: OBJ_ID }] }]]),
      english: { [OBJ_ID]: corrected },
      englishRaw: { [OBJ_ID]: raw },
      translated: { [OBJ_ID]: raw },
      coverage: new Map([[OBJ_ID, 'Eliminiere 15 Ziele']]),
      wasComments: [{ id: OBJ_ID, was: corrected }],
      traderOf: () => 'Peacekeeper',
    });
    expect(drifted).toEqual([]);
  });
});
