import { describe, it, expect, afterAll } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { normalizeQuestData } from '../scripts/eft-normalize.js';

// Minimal enriched reference fixture: wrapped ids + localization.en objective text.
const FIXTURE = {
  request: {
    url: 'gw-pve',
    headers: { 'App-Version': '1.0.5.0.45581' },
    timestamp: '2026-06-30T00:02:34.289061',
  },
  response: {
    decoded_response: {
      data: [
        {
          _id: '[60e71dc0a94be721b065bbfc] Long Line',
          traderId: '[5ac3b934156ae10c4430e83c] Ragman',
          location: '[5714dbc024597771384a510d] Interchange',
          type: 'Elimination',
          side: '[Pmc] PMC',
          isKey: false,
          rewards: { Success: [{ type: 'Experience', value: 84000 }] },
          conditions: {
            AvailableForStart: [
              { conditionType: 'Level', compareMethod: '>=', value: 45 },
              {
                conditionType: 'Quest',
                target: '[5ae449d986f774453a54a7e1] Prereq',
                status: [4],
              },
            ],
            AvailableForFinish: [
              { id: '60e73ee8b567ff641b129570', conditionType: 'CounterCreator', value: 20, isNecessary: false },
              { id: 'aaaaaaaaaaaaaaaaaaaaaaaa', conditionType: 'Bonus', value: 1 },
            ],
          },
          localization: {
            en: {
              '60e71dc0a94be721b065bbfc name': 'Long Line',
              '60e73ee8b567ff641b129570': 'Eliminate PMC operatives inside the ULTRA mall on Interchange',
            },
            ru: {
              '60e71dc0a94be721b065bbfc name': 'Длинная очередь',
              '60e73ee8b567ff641b129570': 'Убить бойцов ЧВК в торговом центре',
            },
            ge: {
              '60e71dc0a94be721b065bbfc name': 'Lange Leine',
              '60e73ee8b567ff641b129570': 'Eliminiere PMCs im Einkaufszentrum',
            },
          },
        },
      ],
    },
  },
};

const dir = mkdtempSync(join(tmpdir(), 'eft-norm-'));
const file = join(dir, 'quests.json');
writeFileSync(file, JSON.stringify(FIXTURE));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('eft-normalize', () => {
  const out = normalizeQuestData(file);
  const quest = out.quests['60e71dc0a94be721b065bbfc'];

  it('records provenance metadata', () => {
    expect(out.$meta.mode).toBe('pve');
    expect(out.$meta.appVersion).toContain('1.0.5.0');
    expect(out.$meta.questCount).toBe(1);
  });

  it('unwraps ids and inline names', () => {
    expect(quest.id).toBe('60e71dc0a94be721b065bbfc');
    expect(quest.name).toBe('Long Line');
    expect(quest.trader).toEqual({ id: '5ac3b934156ae10c4430e83c', name: 'Ragman' });
    expect(quest.map).toEqual({ id: '5714dbc024597771384a510d', name: 'Interchange' });
    expect(quest.side).toBe('PMC');
  });

  it('extracts level, experience and prerequisites', () => {
    expect(quest.minPlayerLevel).toBe(45);
    expect(quest.experience).toBe(84000);
    expect(quest.requires).toEqual([{ id: '5ae449d986f774453a54a7e1', status: ['complete'] }]);
  });

  it('extracts objective text/count and does not emit a bogus optional flag', () => {
    expect(quest.objectives).toHaveLength(1); // 'Bonus' condition type is excluded
    const obj = quest.objectives[0];
    expect(obj).toEqual({
      id: '60e73ee8b567ff641b129570',
      type: 'CounterCreator',
      description: 'Eliminate PMC operatives inside the ULTRA mall on Interchange',
      count: 20,
    });
    expect('optional' in obj).toBe(false);
  });
});

describe('eft-normalize --lang', () => {
  it('omits locale fields by default', () => {
    const out = normalizeQuestData(file);
    const quest = out.quests['60e71dc0a94be721b065bbfc'];
    expect(out.$meta.languages).toBeUndefined();
    expect(quest.nameLocale).toBeUndefined();
    expect(quest.objectives[0].locale).toBeUndefined();
  });

  it('attaches localized name + objective text and maps codes to BCP47', () => {
    const out = normalizeQuestData(file, ['ru', 'ge']);
    const quest = out.quests['60e71dc0a94be721b065bbfc'];
    // 'ge' (client) maps to 'de' (BCP47); english stays the base.
    expect(out.$meta.languages).toEqual(['de', 'ru']);
    expect(quest.nameLocale).toEqual({ ru: 'Длинная очередь', de: 'Lange Leine' });
    expect(quest.objectives[0].locale).toEqual({
      ru: 'Убить бойцов ЧВК в торговом центре',
      de: 'Eliminiere PMCs im Einkaufszentrum',
    });
  });

  it('expands `all` to every reference language except english', () => {
    const out = normalizeQuestData(file, ['all']);
    expect(out.$meta.languages).toEqual(['de', 'ru']);
  });

  it('accepts BCP47 codes and resolves them to the source key (de -> ge)', () => {
    const out = normalizeQuestData(file, ['de']);
    const quest = out.quests['60e71dc0a94be721b065bbfc'];
    // fixture carries `ge`; requesting `de` must still pick it up
    expect(out.$meta.languages).toEqual(['de']);
    expect(quest.nameLocale).toEqual({ de: 'Lange Leine' });
  });

  it('ignores requested languages the reference does not carry', () => {
    const out = normalizeQuestData(file, ['ru', 'kr']);
    const quest = out.quests['60e71dc0a94be721b065bbfc'];
    expect(out.$meta.languages).toEqual(['ru']); // 'kr' absent from fixture
    expect(quest.nameLocale).toEqual({ ru: 'Длинная очередь' });
  });
});
