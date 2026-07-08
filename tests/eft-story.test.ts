/**
 * Tests for the TypeScript story pipeline
 * (scripts/eft-story-wiki.ts, scripts/eft-story-generate.ts,
 * scripts/eft-story-write.ts, scripts/lib/sequence-matcher.ts)
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import JSON5 from 'json5';
import { sequenceRatio } from '../scripts/lib/sequence-matcher.js';
import { cleanObjectiveLine, parseObjectives } from '../scripts/eft-story-wiki.js';
import { bareId, normalizeStoryText, matchOptional } from '../scripts/eft-story-generate.js';
import { renderStoryChaptersJson5 } from '../scripts/eft-story-write.js';
import { getProjectPaths } from '../src/lib/index.js';

describe('sequenceRatio (difflib SequenceMatcher.ratio port)', () => {
  // Expected values computed with CPython difflib.SequenceMatcher(None, a, b).ratio()
  const vectors: Array<[string, string, number]> = [
    ['', '', 1.0],
    ['abc', '', 0.0],
    ['abc', 'abc', 1.0],
    [
      'locate the underground laboratory entrance',
      'locate the underground lab entrance',
      0.9090909090909091,
    ],
    ['hand over # golden neck chains', 'hand over # gp coins', 0.72],
    [
      'eliminate # pmc operatives',
      'eliminate # scav raiders while wearing a vest',
      0.5915492957746479,
    ],
    // long inputs exercise the autojunk (popular element) heuristic
    ['a'.repeat(250), 'a'.repeat(100) + 'b'.repeat(150), 0.4],
    [
      'survive and extract from the labyrinth '.repeat(8),
      'survive and extract from labyrinth '.repeat(8),
      0.08445945945945946,
    ],
  ];

  it('matches CPython difflib exactly', () => {
    for (const [a, b, expected] of vectors) {
      expect(sequenceRatio(a, b)).toBeCloseTo(expected, 12);
    }
  });

  it('is 1.0 for identical non-empty strings', () => {
    expect(sequenceRatio('tarkov', 'tarkov')).toBe(1.0);
  });
});

describe('cleanObjectiveLine', () => {
  it('strips wiki links, keeping the display text', () => {
    expect(cleanObjectiveLine('* Locate the [[Terminal|terminal entrance]]')).toEqual({
      text: 'Locate the terminal entrance',
      optional: false,
    });
    expect(cleanObjectiveLine('* Reach [[Streets of Tarkov]]')).toEqual({
      text: 'Reach Streets of Tarkov',
      optional: false,
    });
  });

  it('detects and strips the (optional) marker', () => {
    const result = cleanObjectiveLine("* Kill the boss (''Optional'')");
    expect(result.optional).toBe(true);
    expect(result.text).toBe('Kill the boss');
  });

  it('removes html tags and bold/italic quotes', () => {
    expect(cleanObjectiveLine("* <font color=red>'''Survive'''</font> the raid")).toEqual({
      text: 'Survive the raid',
      optional: false,
    });
  });
});

describe('parseObjectives', () => {
  const wikitext = [
    '== Description ==',
    'Some intro text',
    '== Objectives ==',
    '* First objective',
    "* Second objective (''optional'')",
    "'''If you side with them:'''",
    '* Third objective',
    '',
    '== Rewards ==',
    '* Not an objective',
  ].join('\n');

  it('parses only bullet lines inside the Objectives section', () => {
    const objectives = parseObjectives(wikitext);
    expect(objectives).toEqual([
      { text: 'First objective', optional: false },
      { text: 'Second objective', optional: true },
      { text: 'Third objective', optional: false },
    ]);
  });

  it('returns empty when no Objectives section exists', () => {
    expect(parseObjectives('== Rewards ==\n* something')).toEqual([]);
  });
});

describe('normalizeStoryText / matchOptional', () => {
  it('collapses numbers and punctuation', () => {
    expect(normalizeStoryText('Hand over 3,000 Roubles!')).toBe('hand over # roubles');
  });

  it('matches an objective to its wiki counterpart above the threshold', () => {
    const wiki = [
      { text: 'Hand over 5 golden neck chains', optional: true },
      { text: 'Eliminate 10 PMC operatives', optional: false },
    ];
    expect(matchOptional('Hand over 5 golden neck chains', wiki).optional).toBe(true);
    expect(matchOptional('Eliminate 10 PMC operatives on Customs', wiki).optional).toBe(false);
  });

  it('treats below-threshold matches as required', () => {
    const wiki = [{ text: 'Something entirely unrelated to anything', optional: true }];
    const result = matchOptional('Reach the safe room', wiki);
    expect(result.optional).toBe(false);
    expect(result.ratio).toBeLessThan(0.6);
  });
});

describe('bareId', () => {
  it('extracts a 24-hex id from wrapped values', () => {
    expect(bareId('[68cbd33676fe74b1e80bfd91] Tour')).toBe('68cbd33676fe74b1e80bfd91');
    expect(bareId('68cbd33676fe74b1e80bfd91')).toBe('68cbd33676fe74b1e80bfd91');
    expect(bareId('not an id')).toBeNull();
    expect(bareId(42)).toBeNull();
  });
});

describe('renderStoryChaptersJson5', () => {
  it('round-trips the committed storyChapters.json5 byte-for-byte', () => {
    const { srcDir } = getProjectPaths();
    const committedPath = join(srcDir, 'additions', 'storyChapters.json5');
    const committed = readFileSync(committedPath, 'utf8');
    const data = JSON5.parse(committed);
    expect(renderStoryChaptersJson5(data)).toBe(committed);
  });
});
