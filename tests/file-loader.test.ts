/**
 * Tests for file-loader module
 */

import { describe, it, expect } from 'vitest';
import { join } from 'path';
import {
  getProjectPaths,
  loadJson5File,
  loadJsonFile,
  listJson5Files,
  loadAllJson5FromDir,
} from '../src/lib/index.js';

describe('getProjectPaths', () => {
  it('returns valid project paths', () => {
    const paths = getProjectPaths(import.meta.url);

    expect(paths.rootDir).toContain('tarkov-data-overlay');
    expect(paths.srcDir).toContain('src');
    expect(paths.distDir).toContain('dist');
    expect(paths.schemasDir).toContain('schemas');
  });
});

describe('loadJson5File', () => {
  it('loads and parses JSON5 files', () => {
    const paths = getProjectPaths(import.meta.url);
    const editionsPath = join(paths.srcDir, 'additions', 'editions.json5');

    const data = loadJson5File(editionsPath);

    expect(data).toBeDefined();
    expect(typeof data).toBe('object');
  });

  it('handles JSON5 comments', () => {
    const paths = getProjectPaths(import.meta.url);
    const tasksPath = join(paths.srcDir, 'overrides', 'tasks.json5');

    const data = loadJson5File(tasksPath);

    expect(data).toBeDefined();
    // JSON5 should strip comments and parse successfully
  });

  it('throws on non-existent file', () => {
    expect(() => loadJson5File('/non/existent/file.json5')).toThrow();
  });
});

describe('loadJsonFile', () => {
  it('loads and parses JSON files', () => {
    const paths = getProjectPaths(import.meta.url);
    const schemaPath = join(paths.schemasDir, 'edition.schema.json');

    const schema = loadJsonFile(schemaPath);

    expect(schema).toBeDefined();
    expect(typeof schema).toBe('object');
  });
});

describe('listJson5Files', () => {
  it('lists JSON5 files in overrides directory', () => {
    const paths = getProjectPaths(import.meta.url);
    const overridesDir = join(paths.srcDir, 'overrides');

    const files = listJson5Files(overridesDir);

    expect(files).toContain('tasks.json5');
    expect(files.every(f => f.endsWith('.json5'))).toBe(true);
  });

  it('lists JSON5 files in additions directory', () => {
    const paths = getProjectPaths(import.meta.url);
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
    const paths = getProjectPaths(import.meta.url);
    const additionsDir = join(paths.srcDir, 'additions');

    const data = loadAllJson5FromDir(additionsDir, false);

    expect(data).toHaveProperty('editions');
    expect(typeof data.editions).toBe('object');
  });

  it('skips empty files when skipEmpty is true', () => {
    const paths = getProjectPaths(import.meta.url);
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
});
