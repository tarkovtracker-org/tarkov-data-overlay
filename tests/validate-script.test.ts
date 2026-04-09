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
} from '../src/lib/index.js';
import {
  getValidator,
  initializeValidators,
  validateFile,
  validateSourceFiles,
} from '../scripts/validate.js';

describe('scripts/validate helpers', () => {
  it('initializes validators for configured schema patterns', () => {
    const validators = initializeValidators();

    for (const config of SCHEMA_CONFIGS) {
      expect(getValidator(config.pattern, validators)).not.toBeNull();
    }
    expect(getValidator('unknown.json5', validators)).toBeNull();
  });

  it('validates all source files used by overlay data', () => {
    const { srcDir } = getProjectPaths();
    const expectedFiles = [
      ...listJson5Files(join(srcDir, 'overrides')).map((file) => `overrides/${file}`),
      ...listJson5Files(join(srcDir, 'additions')).map((file) => `additions/${file}`),
      'suppressions/tasks.json5',
      ...['regular', 'pve'].flatMap((mode) => [
        ...listJson5Files(join(srcDir, 'overrides', 'modes', mode)).map(
          (file) => `overrides/modes/${mode}/${file}`
        ),
        ...listJson5Files(join(srcDir, 'additions', 'modes', mode)).map(
          (file) => `additions/modes/${mode}/${file}`
        ),
      ]),
    ].sort();

    const results = validateSourceFiles();
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
      const result = validateFile(filePath, 'temp/tasks.json5', validators);

      expect(result.valid).toBe(false);
      expect(result.errors?.[0]).toContain("Failed to parse JSON5 file");
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
      const result = validateFile(filePath, 'temp/tasks.json5', validators);

      expect(result.valid).toBe(false);
      expect(result.errors?.some((error) => error.includes('must be object'))).toBe(true);
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
      const result = validateFile(filePath, 'temp/tasks.json5', validators);

      expect(result.valid).toBe(false);
      expect(result.errors?.some((error) => error.includes('must be object'))).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
