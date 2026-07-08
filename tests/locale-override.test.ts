/**
 * Tests for the per-locale override system
 *
 * Covers the locale-override schema contract (valid/invalid cases), the
 * seeded en.json5 corrections, and inclusion of the locales section in the
 * compiled overlay output.
 */

import { describe, it, expect } from 'vitest';
import Ajv from 'ajv';
import { join } from 'path';
import {
  getProjectPaths,
  loadAllJson5FromDir,
  loadJson5File,
  loadJsonFile,
  SCHEMA_CONFIGS,
  type LocaleOverlay,
} from '../src/lib/index.js';
import { getValidator, initializeValidators } from '../scripts/validate.js';

const { srcDir, schemasDir } = getProjectPaths();

function compileLocaleSchema() {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const schema = loadJsonFile(join(schemasDir, 'locale-override.schema.json'));
  return ajv.compile(schema as object);
}

const NEW_BEGINNING_TASK_IDS = [
  '6761f28a022f60bb320f3e95',
  '6761ff17cdc36bd66102e9d0',
  '6848100b00afffa81f09e365',
  '68481881f43abfdda2058369',
];

describe('locale-override.schema.json', () => {
  it('accepts task name, wikiLink, and objective description patches', () => {
    const validate = compileLocaleSchema();
    const valid = validate({
      tasks: {
        'task-id-1': {
          name: 'New Beginning',
          wikiLink: 'https://escapefromtarkov.fandom.com/wiki/New_Beginning_(Prestige_1)',
          objectives: {
            'objective-id-1': { description: 'Eliminate 50 Scavs' },
          },
        },
      },
    });

    expect(validate.errors).toBeNull();
    expect(valid).toBe(true);
  });

  it('accepts item, trader, map, prestige, and storyChapter patches', () => {
    const validate = compileLocaleSchema();
    const valid = validate({
      items: {
        'item-id-1': {
          name: 'Roubles',
          shortName: 'RUB',
          description: 'Russian roubles.',
          wikiLink: 'https://escapefromtarkov.fandom.com/wiki/Roubles',
        },
      },
      traders: { 'trader-id-1': { name: 'Prapor', description: 'Warrant officer.' } },
      maps: { 'map-id-1': { name: 'Factory', description: 'Industrial complex.' } },
      prestige: { 'prestige-id-1': { name: 'New Beginning' } },
      storyChapters: {
        tour: {
          name: 'Tour',
          description: 'First story chapter.',
          objectives: { 'tour-main-1': { description: 'Visit the terminal' } },
        },
      },
    });

    expect(validate.errors).toBeNull();
    expect(valid).toBe(true);
  });

  it('accepts an empty per-locale object (sparse by design)', () => {
    const validate = compileLocaleSchema();
    expect(validate({})).toBe(true);
  });

  it('rejects unknown entity types', () => {
    const validate = compileLocaleSchema();
    expect(validate({ hideout: { 'station-id-1': { name: 'Workbench' } } })).toBe(false);
  });

  it('rejects non-locale-sensitive fields on entities', () => {
    const validate = compileLocaleSchema();

    // Numeric/data fields belong in regular overrides, not locale overrides
    expect(validate({ tasks: { 'task-id-1': { minPlayerLevel: 10 } } })).toBe(false);
    expect(validate({ items: { 'item-id-1': { basePrice: 100 } } })).toBe(false);
    expect(validate({ prestige: { 'prestige-id-1': { prestigeLevel: 2 } } })).toBe(false);
  });

  it('rejects unknown fields on objective patches', () => {
    const validate = compileLocaleSchema();
    const invalid = validate({
      tasks: {
        'task-id-1': {
          objectives: { 'objective-id-1': { count: 5 } },
        },
      },
    });

    expect(invalid).toBe(false);
  });

  it('rejects non-string values for string fields', () => {
    const validate = compileLocaleSchema();
    expect(validate({ tasks: { 'task-id-1': { name: 42 } } })).toBe(false);
    expect(validate({ tasks: { 'task-id-1': { name: null } } })).toBe(false);
  });

  it('rejects non-object roots', () => {
    const validate = compileLocaleSchema();
    expect(validate([])).toBe(false);
    expect(validate('en')).toBe(false);
  });
});

describe('locale source files', () => {
  it('registers a wildcard schema config for locale files', () => {
    const config = SCHEMA_CONFIGS.find(
      (entry) => entry.pattern === 'overrides/locales/*.json5'
    );

    expect(config).toBeDefined();
    expect(config?.schemaFile).toBe('locale-override.schema.json');
  });

  it('resolves the locale validator for any locale filename', () => {
    const validators = initializeValidators();

    expect(getValidator('overrides/locales/en.json5', validators)).not.toBeNull();
    expect(getValidator('overrides/locales/de.json5', validators)).not.toBeNull();
  });

  it('validates every locale file against the locale schema', () => {
    const validate = compileLocaleSchema();
    const locales = loadAllJson5FromDir(join(srcDir, 'overrides', 'locales'));

    expect(Object.keys(locales).length).toBeGreaterThan(0);

    for (const [locale, data] of Object.entries(locales)) {
      const valid = validate(data);
      if (!valid) {
        const errors = (validate.errors || [])
          .map((error) => `${error.instancePath || '/'}: ${error.message}`)
          .join('\n');
        throw new Error(`locale file '${locale}.json5' failed validation:\n${errors}`);
      }
      expect(valid).toBe(true);
    }
  });

  it('seeds en.json5 with the four New Beginning corrections', () => {
    const en = loadJson5File<LocaleOverlay>(
      join(srcDir, 'overrides', 'locales', 'en.json5')
    );

    expect(en.tasks).toBeDefined();
    expect(Object.keys(en.tasks ?? {}).sort()).toEqual([...NEW_BEGINNING_TASK_IDS].sort());

    for (const taskId of NEW_BEGINNING_TASK_IDS) {
      const patch = en.tasks?.[taskId];
      expect(patch?.name).toBe('New Beginning');
      expect(patch?.wikiLink).toMatch(
        /^https:\/\/escapefromtarkov\.fandom\.com\/wiki\/New_Beginning_\(Prestige_[1-4]\)$/
      );
    }

    // Each prestige quest links to a distinct wiki page
    const wikiLinks = NEW_BEGINNING_TASK_IDS.map((id) => en.tasks?.[id]?.wikiLink);
    expect(new Set(wikiLinks).size).toBe(NEW_BEGINNING_TASK_IDS.length);
  });
});

describe('build output locales section', () => {
  it('includes locales in the compiled output when locale files exist', () => {
    // Mirror scripts/build.ts loadSourceFiles for the locales section
    const locales = loadAllJson5FromDir(join(srcDir, 'overrides', 'locales'));

    expect(locales.en).toBeDefined();

    const en = locales.en as LocaleOverlay;
    for (const taskId of NEW_BEGINNING_TASK_IDS) {
      expect(en.tasks?.[taskId]?.name).toBe('New Beginning');
    }
  });
});
