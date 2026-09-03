import { describe, expect, it } from 'vitest';
import { join, relative } from 'path';
import { existsSync } from 'fs';
import {
  getProjectPaths,
  listJson5Files,
  loadJson5File,
  loadJsonFile,
  SUPPORTED_GAME_MODES,
  TARKOV_MAP_NAMES_BY_ID,
} from '../src/lib/index.js';

/**
 * Keys whose values carry tarkov.dev map references as `{ id, name }` pairs.
 * `map` is the single task-level reference, `maps` the objective-level array,
 * and `mapUnlocks` the story-chapter reward list.
 */
const MAP_REFERENCE_KEYS = new Set(['map', 'maps', 'mapUnlocks']);

interface MapReference {
  id: string;
  name: string;
  location: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Collect a `{ id, name }` pair, ignoring `map: null` and boolean suppressions. */
function collectPair(value: unknown, location: string, into: MapReference[]): void {
  if (!isRecord(value)) return;
  const { id, name } = value;
  if (typeof id !== 'string' || typeof name !== 'string') return;
  into.push({ id, name, location });
}

/**
 * Walk a parsed source tree and collect every map reference under a
 * `MAP_REFERENCE_KEYS` key, recording a JSON-path-ish location for diagnostics.
 */
function collectMapReferences(node: unknown, path: string, into: MapReference[]): void {
  if (Array.isArray(node)) {
    node.forEach((entry, index) => collectMapReferences(entry, `${path}[${index}]`, into));
    return;
  }
  if (!isRecord(node)) return;

  for (const [key, value] of Object.entries(node)) {
    const childPath = `${path}.${key}`;
    if (MAP_REFERENCE_KEYS.has(key)) {
      if (Array.isArray(value)) {
        value.forEach((entry, index) => collectPair(entry, `${childPath}[${index}]`, into));
      } else {
        collectPair(value, childPath, into);
      }
    }
    collectMapReferences(value, childPath, into);
  }
}

/** Every JSON5 source file that can carry map references. */
function sourceFiles(): string[] {
  const { srcDir } = getProjectPaths();
  const dirs = [
    join(srcDir, 'overrides'),
    join(srcDir, 'additions'),
    ...SUPPORTED_GAME_MODES.map((mode) => join(srcDir, 'overrides', 'modes', mode)),
  ];
  return dirs
    .filter((dir) => existsSync(dir))
    .flatMap((dir) => listJson5Files(dir).map((file) => join(dir, file)));
}

function referencesFromSources(): MapReference[] {
  const { rootDir } = getProjectPaths();
  const found: MapReference[] = [];
  for (const file of sourceFiles()) {
    collectMapReferences(loadJson5File(file), relative(rootDir, file), found);
  }
  return found;
}

describe('map references', () => {
  const references = referencesFromSources();

  it('finds map references to validate', () => {
    // Guards against the walker silently going blind after a refactor.
    expect(references.length).toBeGreaterThan(0);
  });

  it('pairs every map ID with that map\u2019s canonical name', () => {
    // A map reference resolves by `id`; a correct-looking `name` beside the wrong
    // `id` renders the objective on the wrong map. The schema only type-checks
    // both as strings, so this is the only guard for that mismatch.
    const mismatched = references
      .filter(({ id, name }) => {
        const canonical = TARKOV_MAP_NAMES_BY_ID[id];
        return canonical !== undefined && canonical !== name;
      })
      .map(
        ({ id, name, location }) =>
          `${location}: id ${id} is ${TARKOV_MAP_NAMES_BY_ID[id]}, labelled ${name}`
      );

    expect(mismatched).toEqual([]);
  });

  it('uses the canonical ID for every map name', () => {
    // Catches the inverse slip: the right name carried by an ID that belongs to
    // a different map, or to no known map at all.
    const canonicalIdsByName = new Map(
      Object.entries(TARKOV_MAP_NAMES_BY_ID).map(([id, name]) => [name, id])
    );

    const wrongId = references
      .filter(({ id, name }) => {
        const expectedId = canonicalIdsByName.get(name);
        return expectedId !== undefined && expectedId !== id;
      })
      .map(
        ({ id, name, location }) =>
          `${location}: ${name} is ${canonicalIdsByName.get(name)}, referenced as ${id}`
      );

    expect(wrongId).toEqual([]);
  });

  it('references only known tarkov.dev map IDs', () => {
    // An unknown ID means either a typo or a genuinely new upstream map. Verify
    // it against json.tarkov.dev/regular/maps and add it to the registry.
    const unknown = references
      .filter(({ id }) => TARKOV_MAP_NAMES_BY_ID[id] === undefined)
      .map(({ id, name, location }) => `${location}: ${id} (${name})`);

    expect(unknown).toEqual([]);
  });

  it('keeps the built overlay consistent with the registry', () => {
    // The published artifact is what consumers read, so assert it directly
    // rather than trusting that the build faithfully copied the sources.
    const { distDir } = getProjectPaths();
    const overlayPath = join(distDir, 'overlay.json');
    if (!existsSync(overlayPath)) return;

    const built: MapReference[] = [];
    collectMapReferences(loadJsonFile(overlayPath), 'dist/overlay.json', built);

    const problems = built
      .filter(({ id, name }) => TARKOV_MAP_NAMES_BY_ID[id] !== name)
      .map(
        ({ id, name, location }) =>
          `${location}: id ${id} is ${TARKOV_MAP_NAMES_BY_ID[id] ?? 'unknown'}, labelled ${name}`
      );

    expect(problems).toEqual([]);
  });
});
