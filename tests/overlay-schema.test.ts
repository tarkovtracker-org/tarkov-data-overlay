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
  type OverlayOutput,
} from '../src/lib/index.js';

function buildOverlayFixture(): OverlayOutput {
  const { srcDir } = getProjectPaths();
  const overrides = loadAllJson5FromDir(join(srcDir, 'overrides'));
  const additions = loadAllJson5FromDir(join(srcDir, 'additions'), false);
  const modes: NonNullable<OverlayOutput['modes']> = {};

  for (const mode of ['regular', 'pve'] as const) {
    const modeData = {
      ...loadAllJson5FromDir(join(srcDir, 'overrides', 'modes', mode)),
      ...loadAllJson5FromDir(join(srcDir, 'additions', 'modes', mode), false),
    } as NonNullable<OverlayOutput['modes']>[typeof mode];

    if (modeData && Object.keys(modeData).length > 0) {
      modes[mode] = modeData;
    }
  }

  const output: OverlayOutput = {
    ...overrides,
    ...additions,
    $meta: {
      version: 'test',
      generated: new Date(0).toISOString(),
    },
  };

  if (Object.keys(modes).length > 0) {
    output.modes = modes;
  }

  return output;
}

describe('overlay.schema.json', () => {
  it('includes storyChapters in root properties', () => {
    const { schemasDir } = getProjectPaths();
    const rootSchema = loadJsonFile(
      join(schemasDir, 'overlay.schema.json')
    ) as { properties?: Record<string, unknown> };

    expect(rootSchema.properties).toHaveProperty('storyChapters');
  });

  it('includes mode-specific payload when mode files are present', () => {
    const { srcDir } = getProjectPaths();
    const regularSource = {
      ...loadAllJson5FromDir(join(srcDir, 'overrides', 'modes', 'regular')),
      ...loadAllJson5FromDir(join(srcDir, 'additions', 'modes', 'regular'), false),
    };
    const pveSource = {
      ...loadAllJson5FromDir(join(srcDir, 'overrides', 'modes', 'pve')),
      ...loadAllJson5FromDir(join(srcDir, 'additions', 'modes', 'pve'), false),
    };
    const output = buildOverlayFixture();

    if (Object.keys(regularSource).length > 0) {
      expect(output.modes?.regular).toBeDefined();
    } else {
      expect(output.modes?.regular).toBeUndefined();
    }

    if (Object.keys(pveSource).length > 0) {
      expect(output.modes?.pve).toBeDefined();
    } else {
      expect(output.modes?.pve).toBeUndefined();
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
      'task-override.schema.json',
      'task-additions.schema.json',
      'story-chapter.schema.json',
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
