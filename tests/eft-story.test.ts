/**
 * Tests for the TypeScript story pipeline
 * (scripts/eft-story-wiki.ts, scripts/eft-story-generate.ts,
 * scripts/eft-story-write.ts, scripts/lib/sequence-matcher.ts)
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import JSON5 from 'json5';
import { sequenceRatio } from '../scripts/lib/sequence-matcher.js';
import { cleanObjectiveLine, parseObjectives } from '../scripts/eft-story-wiki.js';
import {
  bareId,
  exclusiveCounterparts,
  expandChapterObjectives,
  indexQuests,
  matchOptional,
  normalizeStoryText,
  storyReferenceCandidates,
  unwrapAnnotatedText,
} from '../scripts/eft-story-generate.js';
import { renderStoryChaptersJson5 } from '../scripts/eft-story-write.js';
import { getProjectPaths, STORY_ENDINGS } from '../src/lib/index.js';

describe('story reference provenance enforcement', () => {
  it('requires a lock, verifies relocated bytes, and refreshes request provenance only on opt-in', () => {
    const dir = mkdtempSync(join(tmpdir(), 'story-pin-'));
    const capture = JSON.stringify({
      request: {
        timestamp: '2026-06-30T12:00:00Z',
        url: 'https://gw-pve.example/client/quest_list',
        headers: { 'App-Version': 'test-client' },
      },
      response: {
        timestamp: 'wrong-response-time',
        body_response: { data: [{ _id: '68cbd33676fe74b1e80bfd91' }] },
      },
    });
    const file = join(dir, 'quest_list.json');
    const lockFile = join(dir, 'scripts/story-reference.lock.json');
    const run = (update = '0') =>
      execFileSync(
        process.execPath,
        [
          '--import',
          import.meta.resolve('tsx'),
          '--input-type=module',
          '-e',
          `import { loadReference } from ${JSON.stringify(new URL('../scripts/eft-story-generate.ts', import.meta.url).href)}; loadReference();`,
        ],
        {
          cwd: dir,
          env: { ...process.env, STORY_REFERENCE: file, STORY_REFERENCE_UPDATE_LOCK: update },
          stdio: 'pipe',
        }
      );
    try {
      mkdirSync(join(dir, 'scripts'));
      writeFileSync(file, capture);
      expect(() => run()).toThrow(/no scripts\/story-reference.lock.json/);
      run('1');
      const lock = JSON.parse(readFileSync(lockFile, 'utf-8'));
      expect(lock).toMatchObject({
        capturedAt: '2026-06-30T12:00:00Z',
        clientVersion: 'test-client',
        gameMode: 'pve',
        sha256: createHash('sha256').update(capture).digest('hex'),
      });
      writeFileSync(lockFile, JSON.stringify({ ...lock, file: 'moved/original.json' }));
      expect(() => run()).not.toThrow();
      writeFileSync(file, `${capture}\n`);
      expect(() => run()).toThrow(/does not match/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

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

  it('does not let quote stripping rebuild a tag the tag pass missed', () => {
    // `<''script` has no closing bracket, so the tag pass leaves it alone and
    // removing the italic markers would otherwise yield `<script`.
    for (const line of ["<''script", "<'''script", "<''script alert(1)", "<''img src=x"]) {
      const { text } = cleanObjectiveLine(line);
      expect(text).not.toMatch(/[<>]/);
      expect(text.toLowerCase()).not.toContain('<script');
    }
    expect(cleanObjectiveLine("<''script").text).toBe('script');
  });

  it('keeps objective wording intact when brackets are unbalanced', () => {
    expect(cleanObjectiveLine('* Survive the raid <3').text).toBe('Survive the raid 3');
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

describe('unwrapAnnotatedText', () => {
  it('recovers the client value from the enrichment wrapper', () => {
    // The enriched capture rewrites values as `[<original>] <resolved>`; the
    // plain 1.1 capture gives this objective id exactly "Escape from Tarkov".
    expect(unwrapAnnotatedText('[Escape from Tarkov] ESCAPE FROM TARKOV')).toBe(
      'Escape from Tarkov'
    );
    expect(unwrapAnnotatedText('[68da33fe00868edcb6025ac4 name] The Ticket')).toBe(
      '68da33fe00868edcb6025ac4 name'
    );
  });

  it('leaves plain text and unresolvable markers alone', () => {
    expect(unwrapAnnotatedText('Pass the security check')).toBe('Pass the security check');
    // Empty brackets are the tool's "could not resolve" marker: there is no
    // original to recover, and the tail is an unrelated string.
    expect(unwrapAnnotatedText('[] Experience bonus {0}')).toBe('[] Experience bonus {0}');
  });
});

describe('expandChapterObjectives', () => {
  const capture = [
    {
      _id: '[68da33fe00868edcb6025ac4] Chapter',
      conditions: {
        AvailableForFinish: [
          { conditionType: 'Quest', target: ['[aaaaaaaaaaaaaaaaaaaaaaaa] sub'] },
          { conditionType: 'Quest', target: '[aaaaaaaaaaaaaaaaaaaaaaaa] sub' }, // duplicate ref
          { conditionType: 'Quest', target: '67bdf8c066ca1d79a202463a' }, // ending gate
          { conditionType: 'Quest', target: 'cccccccccccccccccccccccc' }, // unresolved
          { conditionType: 'CounterCreator' }, // not a sub-quest ref
        ],
      },
    },
    {
      _id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      localization: { en: { o1: 'First objective', o3: 'Third objective' } },
      conditions: {
        AvailableForFinish: [
          { id: 'o1' },
          { id: 'o2' }, // no localized text -> skipped
          {}, // no id -> skipped
          { id: 'o3' },
        ],
      },
    },
    {
      _id: '67bdf8c066ca1d79a202463a',
      localization: { en: { g1: 'Reach the evacuation area' } },
      conditions: {
        AvailableForFinish: [{ id: 'g1' }],
        // Only startable if the other resolved sub-quest failed -> exclusive.
        AvailableForStart: [
          { conditionType: 'Quest', target: 'aaaaaaaaaaaaaaaaaaaaaaaa', status: [5] },
        ],
        // The counterpart is not a resolved sub-quest of this chapter, so it
        // is outside the chapter-local completion-pair model.
        Fail: [{ conditionType: 'Quest', target: '67460662d0fbbc74ca0f7229', status: [4] }],
      },
    },
  ];

  it('collects objectives once per referenced sub-quest and tags ending gates', () => {
    const expansion = expandChapterObjectives(
      '68da33fe00868edcb6025ac4',
      indexQuests(capture as never)
    );
    expect(expansion.objectives.map((o) => o.id)).toEqual(['o1', 'o3', 'g1']);
    expect(expansion.objectives[0]).toEqual({
      id: 'o1',
      text: 'First objective',
      sourceQuestId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    });
    // The gate sub-quest's objective carries the real ending id.
    expect(expansion.objectives[2].endingId).toBe(STORY_ENDINGS[0].id);
  });

  it('reports referenced vs resolved sub-quests for coverage', () => {
    const expansion = expandChapterObjectives(
      '68da33fe00868edcb6025ac4',
      indexQuests(capture as never)
    );
    // Three distinct refs (the duplicate collapses), one of which is missing.
    expect(expansion.referencedSubquests).toEqual([
      'aaaaaaaaaaaaaaaaaaaaaaaa',
      '67bdf8c066ca1d79a202463a',
      'cccccccccccccccccccccccc',
    ]);
    expect(expansion.resolvedSubquests).toEqual([
      'aaaaaaaaaaaaaaaaaaaaaaaa',
      '67bdf8c066ca1d79a202463a',
    ]);
  });

  it('returns nothing for a chapter quest the capture lacks', () => {
    const expansion = expandChapterObjectives('ffffffffffffffffffffffff', indexQuests([]));
    expect(expansion.objectives).toEqual([]);
    expect(expansion.referencedSubquests).toEqual([]);
    expect(expansion.resolvedSubquests).toEqual([]);
    expect(expansion.exclusivePairs).toEqual([]);
  });

  it('keeps exclusive pairs only between resolved sub-quests of the chapter', () => {
    const expansion = expandChapterObjectives(
      '68da33fe00868edcb6025ac4',
      indexQuests(capture as never)
    );
    expect(expansion.exclusivePairs).toEqual([
      ['67bdf8c066ca1d79a202463a', 'aaaaaaaaaaaaaaaaaaaaaaaa'],
    ]);
  });
});

describe('exclusiveCounterparts', () => {
  it('reads a fail-on-completion condition as exclusivity', () => {
    expect(
      exclusiveCounterparts({
        conditions: {
          Fail: [{ conditionType: 'Quest', target: 'aaaaaaaaaaaaaaaaaaaaaaaa', status: [4] }],
        },
      })
    ).toEqual(['aaaaaaaaaaaaaaaaaaaaaaaa']);
    // "fails once the other is even started" is stronger exclusivity, not weaker.
    expect(
      exclusiveCounterparts({
        conditions: {
          Fail: [{ conditionType: 'Quest', target: 'bbbbbbbbbbbbbbbbbbbbbbbb', status: [2, 4] }],
        },
      })
    ).toEqual(['bbbbbbbbbbbbbbbbbbbbbbbb']);
  });

  it('reads a start-only-if-failed condition as exclusivity', () => {
    expect(
      exclusiveCounterparts({
        conditions: {
          AvailableForStart: [
            { conditionType: 'Quest', target: '[cccccccccccccccccccccccc] Other', status: [5] },
          ],
        },
      })
    ).toEqual(['cccccccccccccccccccccccc']);
  });

  it.each([
    { status: [2, 5] },
    { status: [1, 5] },
    { status: [4, 5] },
    { status: [] },
    { status: [2] },
  ])(
    'does not infer exclusivity when failure is not the only accepted state: $status',
    ({ status }) => {
      expect(
        exclusiveCounterparts({
          conditions: {
            AvailableForStart: [
              { conditionType: 'Quest', target: 'aaaaaaaaaaaaaaaaaaaaaaaa', status },
            ],
          },
        })
      ).toEqual([]);
    }
  );

  it('does not treat cascade failure or ordinary prerequisites as exclusivity', () => {
    // Fails because its predecessor failed - the chain dies together, it is not
    // an alternative branch.
    expect(
      exclusiveCounterparts({
        conditions: {
          Fail: [{ conditionType: 'Quest', target: 'dddddddddddddddddddddddd', status: [5] }],
        },
      })
    ).toEqual([]);
    // Ordinary unlock edge.
    expect(
      exclusiveCounterparts({
        conditions: {
          AvailableForStart: [
            { conditionType: 'Quest', target: 'eeeeeeeeeeeeeeeeeeeeeeee', status: [4] },
          ],
        },
      })
    ).toEqual([]);
    // "completed or failed" accepts success, so it excludes nothing.
    expect(
      exclusiveCounterparts({
        conditions: {
          AvailableForStart: [
            { conditionType: 'Quest', target: 'ffffffffffffffffffffffff', status: [4, 5] },
          ],
        },
      })
    ).toEqual([]);
    // Non-Quest conditions and missing quests contribute nothing.
    expect(
      exclusiveCounterparts({
        conditions: { Fail: [{ conditionType: 'CounterCreator', status: [4] }] },
      })
    ).toEqual([]);
    expect(exclusiveCounterparts(undefined)).toEqual([]);
  });
});

describe('storyReferenceCandidates', () => {
  it('discovers captures in a filesystem-independent order', () => {
    // readdirSync order is not portable, so discovery sorts; enriched captures
    // still rank first because they carry the localization block.
    const root = mkdtempSync(join(tmpdir(), 'story-candidates-'));
    try {
      mkdirSync(join(root, 'zdir'));
      mkdirSync(join(root, 'adir'));
      for (const file of [
        'quest_list.b.json',
        'quest_list.a.json',
        'quest_list.rollinglatest.modified.json',
        'not-a-capture.json',
        'quest_list.txt',
      ]) {
        writeFileSync(join(root, file), '{}');
      }
      writeFileSync(join(root, 'zdir', 'quest-list.z.json'), '{}');
      writeFileSync(join(root, 'adir', 'quest_list.nested.json'), '{}');

      expect(storyReferenceCandidates(root)).toEqual([
        join(root, 'quest_list.rollinglatest.modified.json'),
        join(root, 'adir', 'quest_list.nested.json'),
        join(root, 'quest_list.a.json'),
        join(root, 'quest_list.b.json'),
        join(root, 'zdir', 'quest-list.z.json'),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
