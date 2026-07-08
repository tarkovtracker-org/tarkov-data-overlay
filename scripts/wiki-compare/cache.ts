/**
 * Local cache handling (tarkov.dev API cache, per-task wiki cache) and
 * results-file path resolution. Everything lives under gitignored data/.
 *
 * Extracted from the former single-file scripts/wiki-compare.ts.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ExtendedTaskData,
} from './types.js';

// Cache directories
export const CACHE_DIR = path.join(process.cwd(), 'data', 'cache');
export const WIKI_CACHE_DIR = path.join(CACHE_DIR, 'wiki');
export const RESULTS_DIR = path.join(process.cwd(), 'data', 'results');
export const API_CACHE_FILE = path.join(CACHE_DIR, 'tarkov-api-tasks.json');
export const SAFE_CACHE_FILE_STEM = /^[A-Za-z0-9_-]{1,128}$/;

export function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function assertSafeCacheFileStem(value: string): string {
  if (!SAFE_CACHE_FILE_STEM.test(value)) {
    throw new Error(`Unsafe cache file name: ${value}`);
  }
  return value;
}

export function getTimestamp(): string {
  const now = new Date();
  return now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

export function resolveOutputFilePath(output?: string): string | undefined {
  if (output === undefined) return undefined;
  const trimmed = output.trim();
  if (trimmed.length === 0) {
    return path.join(RESULTS_DIR, `comparison-${getTimestamp()}.json`);
  }
  return trimmed;
}

export type CacheMetadata = {
  fetchedAt: string;
  taskCount: number;
  gameMode: 'regular' | 'pve' | 'both';
};

export type ApiCache = {
  meta: CacheMetadata;
  tasks: ExtendedTaskData[];
};

export function loadApiCache(): ApiCache | null {
  if (!fs.existsSync(API_CACHE_FILE)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(API_CACHE_FILE, 'utf-8'));
    return data as ApiCache;
  } catch {
    return null;
  }
}

export function saveApiCache(
  tasks: ExtendedTaskData[],
  gameMode: 'regular' | 'pve' | 'both'
): void {
  ensureDir(CACHE_DIR);
  const cache: ApiCache = {
    meta: {
      fetchedAt: new Date().toISOString(),
      taskCount: tasks.length,
      gameMode,
    },
    tasks,
  };
  // Safe write: API response intentionally cached as JSON to a fixed,
  // gitignored path under data/cache (local-only research CLI, not in CI).
  fs.writeFileSync(API_CACHE_FILE, JSON.stringify(cache, null, 2));
}

export type WikiCache = {
  fetchedAt: string;
  title: string;
  wikitext: string;
  lastRevision?: {
    timestamp: string;
    user: string;
    comment: string;
  };
};

export function getWikiCachePath(taskId: string): string {
  return path.join(WIKI_CACHE_DIR, `${assertSafeCacheFileStem(taskId)}.json`);
}

export function loadWikiCache(taskId: string): WikiCache | null {
  const cachePath = getWikiCachePath(taskId);
  if (!fs.existsSync(cachePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as WikiCache;
  } catch {
    return null;
  }
}

export function saveWikiCache(
  taskId: string,
  title: string,
  wikitext: string,
  lastRevision?: WikiCache['lastRevision']
): void {
  ensureDir(WIKI_CACHE_DIR);
  const cache: WikiCache = {
    fetchedAt: new Date().toISOString(),
    title,
    wikitext,
    lastRevision,
  };
  // Safe write: wiki page cached as JSON under data/cache/wiki; filename is a
  // regex-validated task id (assertSafeCacheFileStem), so no path traversal.
  fs.writeFileSync(getWikiCachePath(taskId), JSON.stringify(cache, null, 2));
}
