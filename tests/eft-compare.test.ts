import { describe, it, expect } from 'vitest';
import { parseEftTasks, compare, crossCheckOverrides } from '../scripts/eft-compare.js';
import type { TaskData } from '../src/lib/index.js';

describe('eft-compare', () => {
  const quests = [
    {
      _id: 'task1',
      name: 'task1 name',
      rewards: { Success: [{ type: 'Experience', value: 13000 }] },
      conditions: {
        AvailableForStart: [{ id: 'l1', conditionType: 'Level', value: 23 }],
        AvailableForFinish: [{ id: 'obj1', conditionType: 'CounterCreator', value: 7 }],
      },
    },
  ];

  it('parses authoritative numeric fields from the reference file', () => {
    const parsed = parseEftTasks(quests as never);
    const t = parsed.get('task1')!;
    expect(t.experience).toBe(13000);
    expect(t.minPlayerLevel).toBe(23);
    expect(t.counts.get('obj1')).toBe(7);
  });

  it('flags experience, minPlayerLevel and objective count discrepancies', () => {
    const eft = parseEftTasks(quests as never);
    const api: TaskData[] = [
      {
        id: 'task1',
        name: 'Task One',
        experience: 8500, // wrong upstream
        minPlayerLevel: 24, // wrong upstream
        objectives: [{ id: 'obj1', count: 5 }], // wrong upstream
      },
    ];
    const { discrepancies, matched } = compare(eft, api);
    expect(matched).toBe(1);
    const fields = discrepancies.map((d) => d.field.replace(/\[.*\]/, '[]'));
    expect(fields).toContain('experience');
    expect(fields).toContain('minPlayerLevel');
    expect(fields).toContain('objective[].count');
    const exp = discrepancies.find((d) => d.field === 'experience')!;
    expect(exp.api).toBe('8500');
    expect(exp.eft).toBe('13000');
  });

  it('reports no discrepancies when values agree', () => {
    const eft = parseEftTasks(quests as never);
    const api: TaskData[] = [
      {
        id: 'task1',
        name: 'Task One',
        experience: 13000,
        minPlayerLevel: 23,
        objectives: [{ id: 'obj1', count: 7 }],
      },
    ];
    expect(compare(eft, api).discrepancies).toHaveLength(0);
  });
});

describe('crossCheckOverrides', () => {
  // Enriched reference variant: wrapped `_id` + localization.en objective text.
  // Uses realistic 24-hex ids (unwrapId only recognizes hex object ids).
  const TASK = '5ae449c386f7744bde357697';
  const OBJ = '5bb60cbc88a45011a8235cc5';
  const enrichedQuests = [
    {
      _id: `[${TASK}] Sales Night`,
      conditions: {
        AvailableForStart: [],
        AvailableForFinish: [{ id: OBJ, conditionType: 'CounterCreator', value: 7 }],
      },
      rewards: { Success: [] },
      localization: {
        en: {
          [`${TASK} name`]: 'Sales Night',
          [OBJ]: 'Survive and extract from Interchange',
        },
      },
    },
  ];

  it('resolves the wrapped _id and extracts localized objective text', () => {
    const eft = parseEftTasks(enrichedQuests as never);
    const t = eft.get(TASK)!;
    expect(t).toBeDefined();
    expect(t.descriptions.get(OBJ)).toBe('Survive and extract from Interchange');
    expect(t.counts.get(OBJ)).toBe(7);
  });

  it('classifies overrides against the reference file', () => {
    const eft = parseEftTasks(enrichedQuests as never);
    const overrides = {
      [TASK]: {
        objectives: {
          // conflicts: client says "...from Interchange" with no count
          [OBJ]: { description: 'Survive and extract on Interchange 7 times', count: 5 },
        },
      },
    };
    const entries = crossCheckOverrides(overrides, eft);
    const desc = entries.find((e) => e.field === 'description')!;
    const count = entries.find((e) => e.field === 'count')!;
    expect(desc.verdict).toBe('CONFLICTS_REFERENCE');
    expect(desc.reference).toBe('Survive and extract from Interchange');
    expect(count.verdict).toBe('CONFLICTS_REFERENCE');
    expect(count.reference).toBe('7');
  });

  it('marks overrides that equal the client as MATCHES_REFERENCE (ignoring punctuation/case)', () => {
    const eft = parseEftTasks(enrichedQuests as never);
    const overrides = {
      [TASK]: {
        objectives: {
          [OBJ]: { description: 'survive and extract from interchange.', count: 7 },
        },
      },
    };
    const entries = crossCheckOverrides(overrides, eft);
    expect(entries.every((e) => e.verdict === 'MATCHES_REFERENCE')).toBe(true);
  });

  it('reports NO_REFERENCE_DATA when the client has no value for the objective', () => {
    const eft = parseEftTasks(enrichedQuests as never);
    const overrides = {
      [TASK]: { objectives: { ['666733e7430c8972d6a5f438']: { description: 'anything' } } },
    };
    const entries = crossCheckOverrides(overrides, eft);
    expect(entries).toHaveLength(1);
    expect(entries[0].verdict).toBe('NO_REFERENCE_DATA');
  });
});
