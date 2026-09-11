import { describe, expect, it } from 'vitest';
import {
  buildMapAliasMap,
  compareTasks,
  getPriority,
  normalizeItemName,
  normalizeMapName,
  itemsMatch,
  type ExtendedTaskData,
  type WikiTaskData,
} from '../scripts/wiki-compare.js';
import {
  isObjectiveSuppressed,
  isTaskFieldSuppressed,
  type TaskSuppressionEntry,
} from '../scripts/wiki-compare/overlay.js';
import { normalizeTaskName, resolveTask } from '../scripts/wiki-compare/api.js';
import {
  extractCount,
  MAX_LINK_PATTERN_COUNT,
  parseFactionRequirement,
  parseMinLevel,
  parseObjectives,
  parseScavKarma,
  parseTraderLoyalty,
} from '../scripts/wiki-compare/wiki.js';
import type { TaskData } from '../src/lib/types.js';

const EMPTY_ALIASES = new Map<string, string>();

function makeWiki(overrides: Partial<WikiTaskData> = {}): WikiTaskData {
  return {
    pageTitle: 'Test Task',
    requirements: [],
    objectives: [],
    rewards: { reputations: [], items: [], raw: [] },
    traderLoyalty: [],
    previousTasks: [],
    nextTasks: [],
    maps: [],
    relatedItems: [],
    relatedRequiredItems: [],
    relatedHandoverItems: [],
    ...overrides,
  };
}

describe('getPriority', () => {
  it('classifies progression-blocking fields as high', () => {
    expect(getPriority('minPlayerLevel')).toBe('high');
    expect(getPriority('taskRequirements')).toBe('high');
    expect(getPriority('objectives.description')).toBe('high');
  });

  it('classifies trader-specific reputation as medium', () => {
    expect(getPriority('reputation.Prapor')).toBe('medium');
    expect(getPriority('map')).toBe('medium');
  });

  it('falls back to low for non-blocking fields', () => {
    expect(getPriority('experience')).toBe('low');
    expect(getPriority('money')).toBe('low');
    expect(getPriority('unknown')).toBe('low');
  });
});

describe('normalizers', () => {
  it('normalizeItemName is case/space insensitive', () => {
    expect(normalizeItemName('  Salewa First Aid Kit ')).toBe(
      normalizeItemName('salewa first aid kit')
    );
  });

  it('normalizeMapName collapses casing', () => {
    expect(normalizeMapName('Customs')).toBe(normalizeMapName('customs'));
  });

  it('itemsMatch intersects api/wiki item references', () => {
    const apiItems = [{ name: 'Bottle of vodka "Tarkovskaya"' }];
    expect(itemsMatch(apiItems, ['Bottle of vodka "Tarkovskaya"'])).toBe(true);
    expect(itemsMatch(apiItems, ['Bottle of beer'])).toBe(false);
  });
});

describe('task suppressions', () => {
  const suppressions = new Map<string, TaskSuppressionEntry>([
    [
      'task-1',
      {
        minPlayerLevel: true,
        objectives: {
          o1: { fields: { count: true } },
          o2: { fields: { 'objectives.maps': true } },
          o3: true,
        },
      },
    ],
  ]);

  it('supports task-level boolean suppressions', () => {
    expect(isTaskFieldSuppressed(suppressions, 'task-1', 'minPlayerLevel')).toBe(true);
    expect(isTaskFieldSuppressed(suppressions, 'task-1', 'experience')).toBe(false);
  });

  it('supports both objective boolean and nested fields suppressions', () => {
    expect(isObjectiveSuppressed(suppressions, 'task-1', 'o1', 'objectives.count')).toBe(true);
    expect(isObjectiveSuppressed(suppressions, 'task-1', 'o2', 'objectives.maps')).toBe(true);
    expect(isObjectiveSuppressed(suppressions, 'task-1', 'o1', 'objectives.items')).toBe(false);
    expect(isObjectiveSuppressed(suppressions, 'task-1', 'o3', 'objectives.items')).toBe(true);
  });
});

describe('compareTasks', () => {
  const baseApi: ExtendedTaskData = {
    id: 'task-1',
    name: 'Test Task',
    minPlayerLevel: 10,
    objectives: [
      { id: 'o1', type: 'shoot', description: 'Eliminate 5 Scavs on Customs', count: 5 },
    ],
  };

  it('returns no discrepancies when api and wiki agree', () => {
    const wiki = makeWiki({
      minPlayerLevel: 10,
      objectives: [{ text: 'Eliminate 5 Scavs on Customs', count: 5 }],
    });
    const result = compareTasks(baseApi, wiki, EMPTY_ALIASES, false);
    expect(result.find((d) => d.field === 'minPlayerLevel')).toBeUndefined();
  });

  it('flags a minPlayerLevel mismatch as high priority', () => {
    const wiki = makeWiki({
      minPlayerLevel: 15,
      objectives: [{ text: 'Eliminate 5 Scavs on Customs', count: 5 }],
    });
    const result = compareTasks(baseApi, wiki, EMPTY_ALIASES, false);
    const level = result.find((d) => d.field === 'minPlayerLevel');
    expect(level).toBeDefined();
    expect(level?.apiValue).toBe(10);
    expect(level?.wikiValue).toBe(15);
    expect(level?.priority).toBe('high');
  });

  it('detects an objective count mismatch', () => {
    const wiki = makeWiki({
      minPlayerLevel: 10,
      objectives: [{ text: 'Eliminate 5 Scavs on Customs', count: 8 }],
    });
    const result = compareTasks(baseApi, wiki, EMPTY_ALIASES, false);
    expect(result.some((d) => d.field === 'objectives.count')).toBe(true);
  });

  it('does not interpret an omitted wiki loyalty gate as contradicting the API', () => {
    const api = {
      ...baseApi,
      traderRequirements: [
        {
          id: 'p',
          trader: { id: 'p', name: 'Prapor' },
          requirementType: 'level',
          compareMethod: '>=',
          value: 2,
        },
        {
          id: 't',
          trader: { id: 't', name: 'Therapist' },
          requirementType: 'level',
          compareMethod: '>=',
          value: 2,
        },
      ],
    } as ExtendedTaskData;
    expect(
      compareTasks(
        api,
        makeWiki({ traderLoyalty: [{ trader: 'Prapor', level: 2 }] }),
        EMPTY_ALIASES,
        false
      ).some((entry) => entry.field === 'traderRequirements')
    ).toBe(false);
  });

  it('does not trust inferred trader attribution as a verified gate', () => {
    const wiki = makeWiki({
      traderLoyalty: [{ trader: 'Prapor', level: 2, inferredTrader: true }],
    });
    const discrepancy = compareTasks(baseApi, wiki, EMPTY_ALIASES, false).find(
      (entry) => entry.field === 'traderRequirements'
    );
    expect(discrepancy?.trustsWiki).toBe(false);
    expect(discrepancy?.wikiValue).toContain('trader inferred');
  });

  it('compares a wiki Scav karma gate against the API Fence reputation entry', () => {
    // json.tarkov.dev models Scav karma as a Fence `reputation` requirement, so
    // a wiki karma sentence is comparable rather than merely informational.
    const wiki = makeWiki({ minPlayerLevel: 10, scavKarma: { value: 3, compareMethod: '>=' } });
    const matching = compareTasks(
      {
        ...baseApi,
        traderRequirements: [
          {
            id: 'r1',
            trader: { id: '579dc571d53a0658a154fbec', name: 'Fence' },
            requirementType: 'reputation',
            compareMethod: '>=',
            value: 3,
          },
        ],
      } as ExtendedTaskData,
      wiki,
      EMPTY_ALIASES,
      false
    );
    expect(matching.some((d) => d.field === 'scavKarma')).toBe(false);
    const unspecified = compareTasks(
      baseApi,
      makeWiki({ scavKarma: { value: -6 } }),
      EMPTY_ALIASES,
      false
    ).find((entry) => entry.field === 'scavKarma');
    expect(unspecified?.wikiValue).toContain('direction unspecified');
    expect(unspecified?.trustsWiki).toBe(false);

    const missing = compareTasks(baseApi, wiki, EMPTY_ALIASES, false);
    const karma = missing.find((d) => d.field === 'scavKarma');
    expect(karma).toBeDefined();
    expect(karma?.apiValue).toBe('(none)');
    expect(karma?.wikiValue).toBe('>= 3');
    expect(karma?.priority).toBe('high');
  });

  it('reports opposite directions even with an equal karma threshold', () => {
    const wiki = makeWiki({ minPlayerLevel: 10, scavKarma: { value: 3, compareMethod: '>=' } });
    const result = compareTasks(
      {
        ...baseApi,
        traderRequirements: [
          {
            id: 'r1',
            trader: { id: '579dc571d53a0658a154fbec', name: 'Fence' },
            requirementType: 'reputation',
            compareMethod: '<=',
            value: 3,
          },
        ],
      } as ExtendedTaskData,
      wiki,
      EMPTY_ALIASES,
      false
    );
    expect(result.find((d) => d.field === 'scavKarma')?.apiValue).toBe('<= 3');
  });

  it('does not read another trader\u2019s reputation as Scav karma', () => {
    // Only Fence reputation is karma; Prapor reputation is trader rep.
    const wiki = makeWiki({ minPlayerLevel: 10, scavKarma: { value: 3, compareMethod: '>=' } });
    const result = compareTasks(
      {
        ...baseApi,
        traderRequirements: [
          {
            id: 'r1',
            trader: { id: '54cb50c76803fa8b248b4571', name: 'Prapor' },
            requirementType: 'reputation',
            compareMethod: '>=',
            value: 3,
          },
        ],
      } as ExtendedTaskData,
      wiki,
      EMPTY_ALIASES,
      false
    );
    expect(result.some((d) => d.field === 'scavKarma')).toBe(true);
  });

  it('does not read a Fence loyalty tier as a karma gate', () => {
    // A `level` requirement is a loyalty tier; only `reputation` carries karma.
    const wiki = makeWiki({ minPlayerLevel: 10, scavKarma: { value: 6, compareMethod: '>=' } });
    const result = compareTasks(
      {
        ...baseApi,
        traderRequirements: [
          {
            id: 'r1',
            trader: { id: '579dc571d53a0658a154fbec', name: 'Fence' },
            requirementType: 'level',
            compareMethod: '>=',
            value: 4,
          },
        ],
      } as ExtendedTaskData,
      wiki,
      EMPTY_ALIASES,
      false
    );
    expect(result.some((d) => d.field === 'scavKarma')).toBe(true);
  });

  it('honors nested objective field suppressions', () => {
    const wiki = makeWiki({
      minPlayerLevel: 10,
      objectives: [{ text: 'Eliminate 8 Scavs on Customs', count: 8, maps: ['Customs'] }],
    });
    const suppressions = new Map<string, TaskSuppressionEntry>([
      ['task-1', { objectives: { o1: { fields: { count: true } } } }],
    ]);

    const result = compareTasks(baseApi, wiki, EMPTY_ALIASES, false, undefined, suppressions);

    expect(result.some((d) => d.field === 'objectives.count')).toBe(false);
  });

  // Regression: a handover objective whose description says "(not found in raid)"
  // is an explicit non-FiR exception and must not suppress an unmatched wiki
  // find objective as redundant. Previously the positive-only /found in raid/i
  // test matched the negation, hiding a real discrepancy.
  it('does not treat "not found in raid" objectives as FiR for redundant-find suppression', () => {
    const api: ExtendedTaskData = {
      id: 'task-1',
      name: 'Test Task',
      minPlayerLevel: 10,
      objectives: [
        {
          id: 'o1',
          type: 'handOver',
          description: 'Hand over the flash drive (not found in raid)',
          items: [{ id: 'item-1', name: 'Flash drive' }],
        },
        // A second objective so the both-sides-single-objective shortcut does
        // not kick in and force-match the objectives.
        { id: 'o2', type: 'shoot', description: 'Eliminate 5 Scavs on Customs', count: 5 },
      ],
    };
    const wiki = makeWiki({
      minPlayerLevel: 10,
      // The verb is derived from the text by getObjectiveVerbKey ("Find" -> find).
      objectives: [{ text: 'Find the flash drive', items: ['Flash drive'] }],
    });

    const result = compareTasks(api, wiki, EMPTY_ALIASES, false);

    // The wiki find objective is not redundant, so it stays unmatched and is
    // reported as missing from the API.
    expect(
      result.some((d) => d.field === 'objectives.description' && d.apiValue === 'not found')
    ).toBe(true);
  });

  it('does not print when verbose is false', () => {
    const logs: unknown[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => logs.push(args);
    try {
      compareTasks(baseApi, makeWiki({ minPlayerLevel: 10 }), EMPTY_ALIASES, false);
    } finally {
      console.log = original;
    }
    expect(logs).toHaveLength(0);
  });
});

describe('normalizeTaskName', () => {
  it('strips the [PVP ZONE] suffix', () => {
    expect(normalizeTaskName('Task Name [PVP ZONE]')).toBe('task name');
    expect(normalizeTaskName('Task Name [pvp zone]')).toBe('task name');
  });

  it('strips the (quest) disambiguation suffix', () => {
    expect(normalizeTaskName('Task Name (quest)')).toBe('task name');
    expect(normalizeTaskName('Task Name (Quest)')).toBe('task name');
  });

  it('normalizes hyphens and collapses repeated whitespace', () => {
    expect(normalizeTaskName('Multi-Word-Task')).toBe('multi word task');
    expect(normalizeTaskName('Task   Multiple   Spaces')).toBe('task multiple spaces');
  });

  it('strips stacked suffixes', () => {
    expect(normalizeTaskName('Task [PVP ZONE] (quest)')).toBe('task');
    expect(normalizeTaskName('Task (quest) [PVP ZONE]')).toBe('task');
  });

  it('combines every normalization', () => {
    expect(normalizeTaskName('Complex-Name  (quest)')).toBe('complex name');
  });
});

describe('resolveTask', () => {
  const tasks: TaskData[] = [
    { id: '1', name: 'Simple Task' },
    { id: '2', name: 'Multi-Word Task [PVP ZONE]' },
    { id: '3', name: 'Quest-Task (quest)' },
  ];

  it('resolves by id when one is supplied', () => {
    expect(resolveTask(tasks, { id: '2' })?.id).toBe('2');
  });

  // Regression: resolveTask previously used a trim/lowercase-only normalizer, so
  // a name carrying a [PVP ZONE]/(quest) suffix or hyphens never matched.
  it('resolves names whose upstream form carries a suffix or hyphens', () => {
    expect(resolveTask(tasks, { name: 'Simple  Task' })?.id).toBe('1');
    expect(resolveTask(tasks, { name: 'multi word task' })?.id).toBe('2');
    expect(resolveTask(tasks, { name: 'Quest Task' })?.id).toBe('3');
  });
});

describe('extractCount', () => {
  it('parses counts from count-word patterns', () => {
    expect(extractCount('Eliminate 5 Scavs on Customs')).toBe(5);
    expect(extractCount('Find 3 dogtags')).toBe(3);
  });

  it('removes every linked item name and fails closed for unsafe matcher input', () => {
    expect(extractCount('Find [[Item 7]]', ['Item 7'])).toBeUndefined();

    const links = Array.from({ length: 300 }, (_, index) => `Item ${index}`);
    expect(extractCount('Find 5 Scavs', links)).toBe(5);

    const lateNumericLink = Array.from({ length: 256 }, (_, index) => `Item ${index + 100}`);
    lateNumericLink.push('Item 7');
    expect(extractCount('Find [[Item 7]]', lateNumericLink)).toBeUndefined();

    const tooManyLinks = Array.from(
      { length: MAX_LINK_PATTERN_COUNT + 1 },
      (_, index) => `Item ${index}`
    );
    expect(extractCount('Find 5 Scavs', tooManyLinks)).toBeUndefined();

    const oversizedLink = `7 ${'x'.repeat(256)}`;
    expect(extractCount(`Find [[${oversizedLink}]]`, [oversizedLink])).toBeUndefined();
  });

  it('parses counts from the verb fallback', () => {
    expect(extractCount('Reach 15 Strength skill level')).toBe(15);
    expect(extractCount('Visit 4 locations on Woods')).toBe(4);
  });

  it.each(['items', 'pieces', 'packs', 'bottles', 'units'])(
    'parses counts followed by the %s unit',
    (unit) => {
      expect(extractCount(`Required: 12 ${unit}`)).toBe(12);
    }
  );

  // Regression: the verb fallback used to treat any nearby number as the count,
  // so a duration qualifier like "for 5 minutes" produced a false count of 5.
  it('ignores numbers that belong to time/distance qualifiers', () => {
    expect(extractCount('Survive for 5 minutes while suffering from dehydration')).toBeUndefined();
    expect(extractCount('Visit the pier within 20 minutes of the raid start')).toBeUndefined();
    expect(extractCount('Eliminate Scavs from over 40 meters away')).toBeUndefined();
  });
});

describe('1.1 Requirements-section parsing', () => {
  const TRADERS = ['Prapor', 'Therapist', 'Skier', 'Peacekeeper', 'Mechanic', 'Ragman', 'Jaeger'];

  describe('parseMinLevel', () => {
    it('reads a player-level gate', () => {
      expect(parseMinLevel(['Must be level 25 to start this quest.'])).toBe(25);
    });

    // Regression: patch 1.1.0.0 rewrote most gates as trader loyalty tiers, and
    // a bare /level (\d+)/ returned the TIER as a player level on 90 of the 286
    // pages carrying a Requirements section. Both wiki:compare and eft:wiki
    // consumed that number as the wiki's minPlayerLevel witness.
    it.each([
      'Must reach Loyalty Level 3 with [[Ragman]] to obtain this quest.',
      'Must be Loyalty Level 3 to start this quest',
      'Obtain level 3 loyalty with [[Peacekeeper]]',
      'Loyalty Level II with Prapor.',
      'Reach Loyalty Level 4 with [[Prapor]], [[Therapist]] and [[Jaeger]]',
    ])('never reports a loyalty tier as a player level: %s', (line) => {
      expect(parseMinLevel([line])).toBeUndefined();
    });

    it('ignores incidental "level N" that is not a player gate', () => {
      // Stick to It: these are building floors, not requirements on the player.
      expect(parseMinLevel(['Talk to the scientist on level 1 via the intercom.'])).toBeUndefined();
      expect(parseMinLevel(['Reach the damaged door on level 3.'])).toBeUndefined();
    });

    it('still finds the player level when a loyalty line comes first', () => {
      expect(
        parseMinLevel([
          'Must reach Loyalty Level 2 with [[Skier]] to obtain this quest.',
          'Must be level 20 to start this quest.',
        ])
      ).toBe(20);
    });
  });

  describe('parseTraderLoyalty', () => {
    it('parses the "Must reach Loyalty Level N with X" form', () => {
      expect(
        parseTraderLoyalty(
          ['Must reach Loyalty Level 3 with [[Ragman]] to obtain this quest.'],
          TRADERS
        )
      ).toEqual([{ trader: 'Ragman', level: 3 }]);
    });

    it('parses the "Obtain level N loyalty with X" form', () => {
      expect(parseTraderLoyalty(['Obtain level 2 loyalty with [[Prapor]].'], TRADERS)).toEqual([
        { trader: 'Prapor', level: 2 },
      ]);
    });

    it('parses roman-numeral tiers', () => {
      expect(parseTraderLoyalty(['Loyalty Level II with Prapor.'], TRADERS)).toEqual([
        { trader: 'Prapor', level: 2 },
      ]);
    });

    it('parses a multi-trader gate', () => {
      const got = parseTraderLoyalty(
        ['Reach Loyalty Level 4 with [[Prapor]], [[Therapist]] and [[Jaeger]]'],
        TRADERS
      );
      expect(got).toHaveLength(3);
      expect(got.map((x) => x.trader).sort()).toEqual(['Jaeger', 'Prapor', 'Therapist']);
      expect(new Set(got.map((x) => x.level))).toEqual(new Set([4]));
    });

    it('falls back to the quest giver when the line names no trader, marking it inferred', () => {
      expect(
        parseTraderLoyalty(['Must be Loyalty Level 2 to start this quest'], TRADERS, 'Peacekeeper')
      ).toEqual([{ trader: 'Peacekeeper', level: 2, inferredTrader: true }]);
    });

    it('returns nothing rather than guessing when no trader is available', () => {
      expect(parseTraderLoyalty(['Must be Loyalty Level 2 to start this quest'], TRADERS)).toEqual(
        []
      );
    });

    it('keeps a cross-trader gate rather than assuming the quest giver', () => {
      // Pyramid Scheme is given by Skier but gated on Peacekeeper LL3.
      expect(
        parseTraderLoyalty(['Obtain level 3 loyalty with [[Peacekeeper]]'], TRADERS, 'Skier')
      ).toEqual([{ trader: 'Peacekeeper', level: 3 }]);
    });

    it('does not mark a named trader as inferred', () => {
      const [gate] = parseTraderLoyalty(['Obtain level 2 loyalty with [[Prapor]].'], TRADERS);
      expect(gate.inferredTrader).toBeUndefined();
    });

    it('ignores non-loyalty requirement lines', () => {
      expect(
        parseTraderLoyalty(
          [
            'Must be level 25 to start this quest.',
            'This quest is only obtainable by [[USEC]] PMCs.',
          ],
          TRADERS
        )
      ).toEqual([]);
    });
  });

  describe('parseFactionRequirement', () => {
    it('reads USEC and BEAR gates', () => {
      expect(parseFactionRequirement(['This quest is only obtainable by [[USEC]] PMCs.'])).toBe(
        'USEC'
      );
      expect(parseFactionRequirement(['This quest is only obtainable by [[BEAR]] PMCs'])).toBe(
        'BEAR'
      );
    });

    it('does not invent a faction from unrelated prose', () => {
      expect(parseFactionRequirement(['Must be level 25 to start this quest.'])).toBeUndefined();
    });
  });

  it('recognizes multi-word trader names without matching partial names', () => {
    expect(parseTraderLoyalty(['Loyalty Level 2 with [[BTR Driver]]'], ['BTR Driver'])).toEqual([
      { trader: 'BTR Driver', level: 2 },
    ]);
    expect(parseTraderLoyalty(['Loyalty Level 2 with NotBTR Driver'], ['BTR Driver'])).toEqual([]);
  });

  it('separates player and loyalty levels on the same requirements line', () => {
    const requirements = [
      'Must be level 20 and Loyalty Level 3 with [[Prapor]] to obtain this quest.',
    ];
    expect(parseMinLevel(requirements)).toBe(20);
    expect(parseTraderLoyalty(requirements, ['Prapor'])).toEqual([{ trader: 'Prapor', level: 3 }]);
    expect(
      parseTraderLoyalty(['Obtain level 2 loyalty with [[Peacekeeper]]'], ['Peacekeeper'])
    ).toEqual([{ trader: 'Peacekeeper', level: 2 }]);
    expect(parseTraderLoyalty(['Loyalty Level 3 with NotPrapor'], ['Prapor'])).toEqual([]);
  });

  describe('parseScavKarma', () => {
    it('reads positive and negative karma gates', () => {
      expect(parseScavKarma(['[[Scavs#Scav karma|Scav karma]] of at least +3'])).toEqual({
        value: 3,
        compareMethod: '>=',
      });
      expect(parseScavKarma(['[[Scavs#Scav karma|Scav karma]] of -6'])).toEqual({ value: -6 });
      expect(parseScavKarma(['Scav karma of at most 3'])).toEqual({
        value: 3,
        compareMethod: '<=',
      });
    });

    it('ignores lines without a karma mention', () => {
      expect(parseScavKarma(['Must be level 25 to start this quest.'])).toBeUndefined();
    });
  });
});

describe('parseObjectives map extraction', () => {
  const aliasMap = buildMapAliasMap(['Customs', 'Factory', 'Streets of Tarkov']);

  it('keeps text-only map mentions when an objective also links a map', () => {
    const [objective] = parseObjectives(
      ['Eliminate 5 Scavs on [[Customs]] and 5 on Factory'],
      aliasMap
    );
    expect(objective.maps).toEqual(expect.arrayContaining(['Customs', 'Factory']));
  });

  it('does not double-report a map that is both linked and named in text', () => {
    const [objective] = parseObjectives(['Eliminate 5 Scavs on [[Customs]]'], aliasMap);
    expect(objective.maps).toEqual(['Customs']);
  });
});
