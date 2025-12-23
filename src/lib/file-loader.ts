/**
 * Shared file loading utilities
 *
 * Eliminates duplicate file loading logic across scripts.
 */

import JSON5 from 'json5';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

/**
 * Get project paths relative to this library module
 *
 * Uses the library location as anchor to find project root,
 * regardless of which script imports it.
 */
export function getProjectPaths(_importMetaUrl?: string) {
  // Use this file's location as the anchor - it's always in src/lib/
  const libDir = dirname(fileURLToPath(import.meta.url));
  const srcDir = join(libDir, '..');
  const rootDir = join(srcDir, '..');
  const distDir = join(rootDir, 'dist');
  const schemasDir = join(srcDir, 'schemas');

  return { libDir, rootDir, srcDir, distDir, schemasDir };
}

/**
 * Load and parse a JSON5 file
 */
export function loadJson5File<T = Record<string, unknown>>(filePath: string): T {
  const content = readFileSync(filePath, 'utf-8');
  return JSON5.parse(content) as T;
}

/**
 * Load and parse a JSON file
 */
export function loadJsonFile<T = unknown>(filePath: string): T {
  const content = readFileSync(filePath, 'utf-8');
  return JSON.parse(content) as T;
}

/**
 * List JSON5 files in a directory
 */
export function listJson5Files(dirPath: string): string[] {
  if (!existsSync(dirPath)) return [];
  return readdirSync(dirPath).filter(f => f.endsWith('.json5'));
}

/**
 * Load all JSON5 files from a directory as a keyed object
 *
 * @param dirPath - Directory containing JSON5 files
 * @param skipEmpty - Skip files with empty objects (default: true)
 * @returns Object with filename (without extension) as key and parsed content as value
 */
export function loadAllJson5FromDir(
  dirPath: string,
  skipEmpty = true
): Record<string, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = {};

  for (const file of listJson5Files(dirPath)) {
    const filePath = join(dirPath, file);
    const data = loadJson5File(filePath);

    if (skipEmpty && Object.keys(data).length === 0) continue;

    const key = file.replace('.json5', '');
    result[key] = data;
  }

  return result;
}

/**
 * Get package.json version
 */
export function getPackageVersion(rootDir: string): string {
  const packageJson = loadJsonFile<{ version: string }>(join(rootDir, 'package.json'));
  return packageJson.version;
}
