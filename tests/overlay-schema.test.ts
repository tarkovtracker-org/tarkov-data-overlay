/**
 * Tests for root overlay schema contract
 */

import { describe, it, expect } from 'vitest';
import Ajv from 'ajv';
import { join } from 'path';
import {
  getProjectPaths,
  loadAllJson5FromDir,
  loadJsonFile,
  SUPPORTED_GAME_MODES,
  type OverlayOutput,
} from '../src/lib/index.js';

function buildOverlayFixture(): OverlayOutput {
  const { srcDir } = getProjectPaths();
  const overrides = loadAllJson5FromDir(join(srcDir, 'overrides'));
  const additions = loadAllJson5FromDir(join(srcDir, 'additions'), false);
  const modes = {} as OverlayOutput['modes'];

  for (const mode of SUPPORTED_GAME_MODES) {
    const modeData = {
      ...loadAllJson5FromDir(join(srcDir, 'overrides', 'modes', mode)),
      ...loadAllJson5FromDir(join(srcDir, 'additions', 'modes', mode), false),
    } as NonNullable<OverlayOutput['modes']>[typeof mode];

    modes[mode] = modeData ?? {};
  }

  const output: OverlayOutput = {
    ...overrides,
    ...additions,
    modes,
    $meta: {
      version: 'test',
      generated: new Date(0).toISOString(),
    },
  };

  const locales = loadAllJson5FromDir(join(srcDir, 'overrides', 'locales'));
  if (Object.keys(locales).length > 0) {
    output.locales = locales;
  }

  return output;
}

describe('overlay.schema.json', () => {
  it('includes storyChapters in root properties', () => {
    const { schemasDir } = getProjectPaths();
    const rootSchema = loadJsonFile(join(schemasDir, 'overlay.schema.json')) as {
      properties?: Record<string, unknown>;
    };

    expect(rootSchema.properties).toHaveProperty('storyChapters');
  });

  it('always includes every game mode advertised by tarkov.dev', () => {
    const output = buildOverlayFixture();

    expect(Object.keys(output.modes)).toEqual([...SUPPORTED_GAME_MODES]);
    for (const mode of SUPPORTED_GAME_MODES) {
      expect(output.modes[mode]).toBeDefined();
    }
  });

  it('validates generated overlay output', () => {
    const { schemasDir } = getProjectPaths();
    const ajv = new Ajv({
      allErrors: true,
      strict: false,
      validateFormats: false,
    });

    const referencedSchemas = [
      'edition.schema.json',
      'item-additions.schema.json',
      'prestige-override.schema.json',
      'task-override.schema.json',
      'task-additions.schema.json',
      'trader-requirement.schema.json',
      'story-chapter.schema.json',
      'locale-override.schema.json',
      'seasonal-perk.schema.json',
      'craft-additions.schema.json',
    ];

    for (const schemaFile of referencedSchemas) {
      const schema = loadJsonFile(join(schemasDir, schemaFile));
      ajv.addSchema(schema as object, schemaFile);
    }

    const rootSchema = loadJsonFile(join(schemasDir, 'overlay.schema.json'));
    const validate = ajv.compile(rootSchema as object);
    const output = buildOverlayFixture();
    const valid = validate(output) as boolean;

    if (!valid) {
      const errors = (validate.errors || [])
        .map((error) => `${error.instancePath || '/'}: ${error.message}`)
        .join('\n');
      throw new Error(`overlay schema validation failed:\n${errors}`);
    }

    expect(valid).toBe(true);
  });
});
