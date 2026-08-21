/**
 * Tests for file-loader module
 */

import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import {
  getProjectPaths,
  loadJson5File,
  loadJsonFile,
  listJson5Files,
  loadAllJson5FromDir,
} from '../src/lib/index.js';

describe('getProjectPaths', () => {
  it('returns valid project paths', () => {
    const paths = getProjectPaths();

    // Identify the root by the manifest it holds, not by the checkout
    // directory name: a fork or a renamed clone changes the directory but
    // not the project.
    const pkg = loadJsonFile(join(paths.rootDir, 'package.json')) as { name?: string };
    expect(pkg.name).toBe('tarkov-data-overlay');
    expect(paths.srcDir).toContain('src');
    expect(paths.distDir).toContain('dist');
    expect(paths.schemasDir).toContain('schemas');
  });
});

describe('loadJson5File', () => {
  it('loads and parses JSON5 files', () => {
    const paths = getProjectPaths();
    const editionsPath = join(paths.srcDir, 'additions', 'editions.json5');

    const data = loadJson5File(editionsPath);

    expect(data).toBeDefined();
    expect(typeof data).toBe('object');
  });

  it('handles JSON5 comments', () => {
    const paths = getProjectPaths();
    const tasksPath = join(paths.srcDir, 'overrides', 'tasks.json5');

    const data = loadJson5File(tasksPath);

    expect(data).toBeDefined();
    // JSON5 should strip comments and parse successfully
  });

  it('throws on non-existent file', () => {
    expect(() => loadJson5File('/non/existent/file.json5')).toThrow();
  });

  it('includes the source file path when JSON5 parsing fails', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'overlay-json5-'));
    const filePath = join(tempDir, 'broken.json5');
    writeFileSync(filePath, '{ invalid: }', 'utf-8');

    try {
      expect(() => loadJson5File(filePath)).toThrow(`Failed to parse JSON5 file '${filePath}':`);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('loadJsonFile', () => {
  it('loads and parses JSON files', () => {
    const paths = getProjectPaths();
    const schemaPath = join(paths.schemasDir, 'edition.schema.json');

    const schema = loadJsonFile(schemaPath);

    expect(schema).toBeDefined();
    expect(typeof schema).toBe('object');
  });
});

describe('listJson5Files', () => {
  it('lists JSON5 files in overrides directory', () => {
    const paths = getProjectPaths();
    const overridesDir = join(paths.srcDir, 'overrides');

    const files = listJson5Files(overridesDir);

    expect(files).toContain('tasks.json5');
    expect(files.every((f) => f.endsWith('.json5'))).toBe(true);
  });

  it('lists JSON5 files in additions directory', () => {
    const paths = getProjectPaths();
    const additionsDir = join(paths.srcDir, 'additions');

    const files = listJson5Files(additionsDir);

    expect(files).toContain('editions.json5');
  });

  it('returns empty array for non-existent directory', () => {
    const files = listJson5Files('/non/existent/dir');

    expect(files).toEqual([]);
  });
});

describe('loadAllJson5FromDir', () => {
  it('loads all JSON5 files from a directory', () => {
    const paths = getProjectPaths();
    const additionsDir = join(paths.srcDir, 'additions');

    const data = loadAllJson5FromDir(additionsDir, false);

    expect(data).toHaveProperty('editions');
    expect(typeof data.editions).toBe('object');
  });

  it('skips empty files when skipEmpty is true', () => {
    const paths = getProjectPaths();
    const overridesDir = join(paths.srcDir, 'overrides');

    const data = loadAllJson5FromDir(overridesDir, true);

    // All returned entries should have content
    for (const value of Object.values(data)) {
      expect(Object.keys(value).length).toBeGreaterThan(0);
    }
  });

  it('returns empty object for non-existent directory', () => {
    const data = loadAllJson5FromDir('/non/existent/dir');

    expect(data).toEqual({});
  });

  it('includes the source file path when a JSON5 file root type is invalid', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'overlay-json5-'));
    const filePath = join(tempDir, 'invalid-root.json5');
    writeFileSync(filePath, '[1, 2, 3]', 'utf-8');

    try {
      expect(() => loadAllJson5FromDir(tempDir, false)).toThrow(
        `Invalid JSON5 root type in '${filePath}': expected object, got array`
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
