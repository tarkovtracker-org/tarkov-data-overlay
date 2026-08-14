/**
 * Tests for scripts/validate.ts helpers
 */

import { describe, expect, it } from 'vitest';
import { join } from 'path';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import {
  getProjectPaths,
  listJson5Files,
  SCHEMA_CONFIGS,
  SUPPORTED_GAME_MODES,
} from '../src/lib/index.js';
import {
  buildLocalLocaleEntityIdIndex,
  getValidator,
  initializeValidators,
  validateFile,
  validateLocaleEntityIds,
  validateSourceFiles,
  validateTraderRequirementIds,
} from '../scripts/validate.js';

describe('scripts/validate helpers', () => {
  it('initializes validators for configured schema patterns', () => {
    const validators = initializeValidators();

    for (const config of SCHEMA_CONFIGS) {
      expect(getValidator(config.pattern, validators)).not.toBeNull();
    }
    expect(getValidator('unknown.json5', validators)).toBeNull();
  });

  it('validates all source files used by overlay data', async () => {
    const { srcDir } = getProjectPaths();
    const expectedFiles = [
      ...listJson5Files(join(srcDir, 'overrides')).map((file) => `overrides/${file}`),
      ...listJson5Files(join(srcDir, 'additions')).map((file) => `additions/${file}`),
      ...listJson5Files(join(srcDir, 'overrides', 'locales')).map(
        (file) => `overrides/locales/${file}`
      ),
      'suppressions/tasks.json5',
      'divergences/tasks.json5',
      ...SUPPORTED_GAME_MODES.flatMap((mode) => [
        ...listJson5Files(join(srcDir, 'overrides', 'modes', mode)).map(
          (file) => `overrides/modes/${mode}/${file}`
        ),
        ...listJson5Files(join(srcDir, 'additions', 'modes', mode)).map(
          (file) => `additions/modes/${mode}/${file}`
        ),
      ]),
    ].sort();

    const results = await validateSourceFiles();
    const files = results.map((result) => result.file).sort();

    expect(files).toEqual(expectedFiles);
    expect(results.every((result) => result.valid)).toBe(true);
  });

  it('returns an invalid result when JSON5 parsing fails', () => {
    const validators = initializeValidators();
    const tempDir = mkdtempSync(join(tmpdir(), 'validate-json5-'));
    const filePath = join(tempDir, 'tasks.json5');
    writeFileSync(filePath, '{ invalid: }', 'utf-8');

    try {
      const result = validateFile(filePath, 'overrides/tasks.json5', validators);

      expect(result.valid).toBe(false);
      expect(result.errors?.[0]).toContain('Failed to parse JSON5 file');
      expect(result.errors?.[0]).toContain(filePath);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('returns schema errors when parsed data does not satisfy schema', () => {
    const validators = initializeValidators();
    const tempDir = mkdtempSync(join(tmpdir(), 'validate-json5-'));
    const filePath = join(tempDir, 'tasks.json5');
    writeFileSync(filePath, '[1]', 'utf-8');

    try {
      const result = validateFile(filePath, 'overrides/tasks.json5', validators);

      expect(result.valid).toBe(false);
      expect(result.errors?.some((error) => error.includes('must be object'))).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects ambiguous trader requirements missing the semantic discriminator', () => {
    const validators = initializeValidators();
    const tempDir = mkdtempSync(join(tmpdir(), 'validate-json5-'));
    const filePath = join(tempDir, 'tasks.json5');
    // Pre-#274 reduced shape: trader + value, no id/requirementType/compareMethod.
    writeFileSync(
      filePath,
      `{
        'task-id': {
          traderRequirements: [
            { trader: { id: 'prapor', name: 'Prapor' }, value: 1 }
          ]
        }
      }`,
      'utf-8'
    );

    try {
      const result = validateFile(filePath, 'overrides/tasks.json5', validators);

      expect(result.valid).toBe(false);
      expect(
        result.errors?.some(
          (error) =>
            error.includes("must have required property 'requirementType'") ||
            error.includes("must have required property 'compareMethod'") ||
            error.includes("must have required property 'id'")
        )
      ).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects trader requirement ids that match neither the upstream nor the synthetic shape', () => {
    const validators = initializeValidators();
    const tempDir = mkdtempSync(join(tmpdir(), 'validate-json5-'));
    const filePath = join(tempDir, 'tasks.json5');
    // Missing the 'overlay.' prefix, so consumers merging patch-by-id would
    // treat it as an upstream id that does not exist.
    writeFileSync(
      filePath,
      `{
        'task-id': {
          traderRequirements: [
            {
              id: '657315e1dccd301f1301416a.54cb50c76803fa8b248b4571.level.>=.1',
              requirementType: 'level',
              compareMethod: '>=',
              value: 1,
              trader: { id: '54cb50c76803fa8b248b4571', name: 'Prapor' }
            }
          ]
        }
      }`,
      'utf-8'
    );

    try {
      const result = validateFile(filePath, 'overrides/tasks.json5', validators);

      expect(result.valid).toBe(false);
      expect(result.errors?.some((error) => error.includes('must match pattern'))).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('accepts upstream, composite upstream, and synthetic trader requirement ids', () => {
    const validators = initializeValidators();
    const tempDir = mkdtempSync(join(tmpdir(), 'validate-json5-'));
    const filePath = join(tempDir, 'tasks.json5');
    // Upstream serves both '<24-hex>' and composite '<taskId>-<traderId>' ids;
    // overlay-authored entries use the synthetic 'overlay.' form.
    writeFileSync(
      filePath,
      `{
        'task-id': {
          traderRequirements: [
            {
              id: '6a5672392ee61bd094c49e28',
              requirementType: 'level',
              compareMethod: '>=',
              value: 2,
              trader: { id: '54cb57776803fa99248b456e', name: 'Therapist' }
            },
            {
              id: '61e6e60c5ca3b3783662be27-579dc571d53a0658a154fbec',
              requirementType: 'reputation',
              compareMethod: '<=',
              value: -3,
              trader: { id: '579dc571d53a0658a154fbec', name: 'Fence' }
            },
            {
              id: 'overlay.657315e1dccd301f1301416a.54cb50c76803fa8b248b4571.level.>=.1',
              requirementType: 'level',
              compareMethod: '>=',
              value: 1,
              trader: { id: '54cb50c76803fa8b248b4571', name: 'Prapor' }
            }
          ]
        }
      }`,
      'utf-8'
    );

    try {
      const result = validateFile(filePath, 'overrides/tasks.json5', validators);

      expect(result.errors).toBeUndefined();
      expect(result.valid).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects Loyalty Level zero', () => {
    const validators = initializeValidators();
    const tempDir = mkdtempSync(join(tmpdir(), 'validate-json5-'));
    const filePath = join(tempDir, 'tasks.json5');
    writeFileSync(
      filePath,
      `{
        'task-id': {
          traderRequirements: [
            {
              id: '6a5672392ee61bd094c49e28',
              requirementType: 'level',
              compareMethod: '>=',
              value: 0,
              trader: { id: '54cb50c76803fa8b248b4571', name: 'Prapor' }
            }
          ]
        }
      }`,
      'utf-8'
    );

    try {
      const result = validateFile(filePath, 'overrides/tasks.json5', validators);

      expect(result.valid).toBe(false);
      expect(result.errors?.some((error) => error.includes('must be >= 1'))).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('accepts reputation zero', () => {
    const validators = initializeValidators();
    const tempDir = mkdtempSync(join(tmpdir(), 'validate-json5-'));
    const filePath = join(tempDir, 'tasks.json5');
    writeFileSync(
      filePath,
      `{
        'task-id': {
          traderRequirements: [
            {
              id: '66dace4d03b34844877a50fc',
              requirementType: 'reputation',
              compareMethod: '>=',
              value: 0,
              trader: { id: '579dc571d53a0658a154fbec', name: 'Fence' }
            }
          ]
        }
      }`,
      'utf-8'
    );

    try {
      const result = validateFile(filePath, 'overrides/tasks.json5', validators);

      expect(result.valid).toBe(true);
      expect(result.errors).toBeUndefined();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects synthetic ids whose embedded discriminator disagrees with the entry', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'validate-req-id-'));
    const filePath = join(tempDir, 'tasks.json5');
    // id says 'level >= 2' for task 657315e1...; the entry declares reputation >= 1
    // under a different task key.
    writeFileSync(
      filePath,
      `{
        '59674cd986f7744ab26e32f2': {
          traderRequirements: [
            {
              id: 'overlay.657315e1dccd301f1301416a.54cb50c76803fa8b248b4571.level.>=.2',
              requirementType: 'reputation',
              compareMethod: '>=',
              value: 1,
              trader: { id: '579dc571d53a0658a154fbec', name: 'Fence' }
            }
          ]
        }
      }`,
      'utf-8'
    );

    try {
      const result = validateTraderRequirementIds(filePath, 'overrides/tasks.json5');

      expect(result.valid).toBe(false);
      // compareMethod is the only segment that agrees, so four fields mismatch.
      expect(result.errors).toHaveLength(4);
      for (const field of ['task id', 'trader.id', 'requirementType', 'value']) {
        expect(result.errors?.some((error) => error.includes(field))).toBe(true);
      }
      expect(result.errors?.some((error) => error.includes('compareMethod'))).toBe(false);
      expect(
        result.errors?.[0].startsWith('/59674cd986f7744ab26e32f2/traderRequirements/0/id:')
      ).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects duplicate trader requirement ids within one task', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'validate-req-id-'));
    const filePath = join(tempDir, 'tasks.json5');
    // Patch-by-id would collapse these two entries into one.
    writeFileSync(
      filePath,
      `{
        '59674cd986f7744ab26e32f2': {
          traderRequirements: [
            {
              id: '6a5672392ee61bd094c49e28',
              requirementType: 'level',
              compareMethod: '>=',
              value: 2,
              trader: { id: '54cb50c76803fa8b248b4571', name: 'Prapor' }
            },
            {
              id: '6a5672392ee61bd094c49e28',
              requirementType: 'level',
              compareMethod: '>=',
              value: 3,
              trader: { id: '54cb50c76803fa8b248b4571', name: 'Prapor' }
            }
          ]
        }
      }`,
      'utf-8'
    );

    try {
      const result = validateTraderRequirementIds(filePath, 'overrides/tasks.json5');

      expect(result.valid).toBe(false);
      expect(result.errors).toEqual([
        "/59674cd986f7744ab26e32f2/traderRequirements/1/id: duplicate requirement id '6a5672392ee61bd094c49e28' within the same task",
      ]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('accepts synthetic ids derived from the entry they label', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'validate-req-id-'));
    const filePath = join(tempDir, 'tasks.json5');
    writeFileSync(
      filePath,
      `{
        '657315e1dccd301f1301416a': {
          traderRequirements: [
            {
              id: 'overlay.657315e1dccd301f1301416a.54cb50c76803fa8b248b4571.level.>=.1',
              requirementType: 'level',
              compareMethod: '>=',
              value: 1,
              trader: { id: '54cb50c76803fa8b248b4571', name: 'Prapor' }
            },
            {
              id: 'overlay.657315e1dccd301f1301416a.579dc571d53a0658a154fbec.reputation.<=.-3',
              requirementType: 'reputation',
              compareMethod: '<=',
              value: -3,
              trader: { id: '579dc571d53a0658a154fbec', name: 'Fence' }
            }
          ]
        }
      }`,
      'utf-8'
    );

    try {
      const result = validateTraderRequirementIds(filePath, 'overrides/tasks.json5');

      expect(result.errors).toBeUndefined();
      expect(result.valid).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects locale patches for unknown local entity IDs', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'validate-locale-'));
    const filePath = join(tempDir, 'en.json5');
    writeFileSync(filePath, '{ tasks: { missing: { name: "Ghost" } } }', 'utf-8');

    try {
      const result = validateLocaleEntityIds(
        filePath,
        'overrides/locales/en.json5',
        buildLocalLocaleEntityIdIndex()
      );

      expect(result.valid).toBe(false);
      expect(result.errors?.[0]).toContain('/tasks/missing');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does not treat empty arrays as valid empty objects', () => {
    const validators = initializeValidators();
    const tempDir = mkdtempSync(join(tmpdir(), 'validate-json5-'));
    const filePath = join(tempDir, 'tasks.json5');
    writeFileSync(filePath, '[]', 'utf-8');

    try {
      const result = validateFile(filePath, 'overrides/tasks.json5', validators);

      expect(result.valid).toBe(false);
      expect(result.errors?.some((error) => error.includes('must be object'))).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
