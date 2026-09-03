import { describe, expect, it } from 'vitest';
import { join, relative, sep } from 'path';
import { existsSync, readdirSync } from 'fs';
import {
  getProjectPaths,
  loadJson5File,
  loadJsonFile,
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
  /** Absent when upstream shipped a bare ID with no sibling name. */
  name?: string;
  location: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Collect a map reference, keeping `{ id }` without a name so an unknown ID is
 * still reported. Ignores `map: null` and the `map: true` suppression flag.
 */
function collectPair(value: unknown, location: string, into: MapReference[]): void {
  if (!isRecord(value)) return;
  const { id, name } = value;
  if (typeof id !== 'string') return;
  into.push(typeof name === 'string' ? { id, name, location } : { id, location });
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

/**
 * Every JSON5 source file, found recursively so a new data directory is covered
 * by default rather than needing to be remembered here. `src/overrides/modes/`
 * already nests one level, so a hardcoded list is a standing coverage gap.
 */
function sourceFiles(): string[] {
  const { srcDir } = getProjectPaths();
  return readdirSync(srcDir, { recursive: true })
    .map((entry) => String(entry))
    .filter((entry) => entry.endsWith('.json5'))
    .map((entry) => join(srcDir, entry))
    .sort();
}

/**
 * Locale files legitimately carry translated names ("Zollhof" for Customs), so
 * their map IDs must still be canonical while their names must not be compared.
 */
function isLocaleFile(location: string): boolean {
  return location.includes(`${sep}locales${sep}`) || location.includes('/locales/');
}

function referencesFromSources(): { file: string; references: MapReference[] }[] {
  const { rootDir } = getProjectPaths();
  return sourceFiles().map((file) => {
    const references: MapReference[] = [];
    const location = relative(rootDir, file);
    collectMapReferences(loadJson5File(file), location, references);
    return { file: location, references };
  });
}

const scanned = referencesFromSources();
const allReferences = scanned.flatMap(({ references }) => references);
const nameCheckable = allReferences.filter(({ location }) => !isLocaleFile(location));

const canonicalIdsByName = new Map(
  Object.entries(TARKOV_MAP_NAMES_BY_ID).map(([id, name]) => [name, id])
);

describe('map reference registry', () => {
  it('maps every ID to a distinct name', () => {
    // The reverse lookup below is only sound while names are unique; a duplicate
    // would silently drop an ID and flag correct references as wrong.
    expect(canonicalIdsByName.size).toBe(Object.keys(TARKOV_MAP_NAMES_BY_ID).length);
  });

  it('keys every entry by a tarkov.dev object ID', () => {
    const malformed = Object.keys(TARKOV_MAP_NAMES_BY_ID).filter(
      (id) => !/^[0-9a-f]{24}$/.test(id)
    );
    expect(malformed).toEqual([]);
  });
});

describe('map references', () => {
  it('scans every JSON5 source file', () => {
    // Guards against the walker going blind after a refactor or a moved file.
    const { srcDir, rootDir } = getProjectPaths();
    const onDisk = readdirSync(srcDir, { recursive: true })
      .map((entry) => String(entry))
      .filter((entry) => entry.endsWith('.json5')).length;

    expect(scanned).toHaveLength(onDisk);
    expect(scanned.some(({ file }) => file === join('src', 'overrides', 'tasks.json5'))).toBe(true);
    expect(relative(rootDir, srcDir)).toBe('src');
  });

  it('finds the map references it is meant to validate', () => {
    // Every file known to carry map references must still contribute some, so a
    // file dropping out of scope cannot hide behind a global non-zero count.
    const withReferences = scanned
      .filter(({ references }) => references.length > 0)
      .map(({ file }) => file);

    expect(withReferences).toEqual(
      expect.arrayContaining([
        join('src', 'overrides', 'tasks.json5'),
        join('src', 'additions', 'storyChapters.json5'),
        join('src', 'additions', 'tasksAdd.json5'),
        join('src', 'overrides', 'modes', 'regular', 'tasks.json5'),
      ])
    );
  });

  it('pairs every map ID with that map\u2019s canonical name', () => {
    // A map reference resolves by `id`, so a correct-looking `name` beside the
    // wrong `id` renders the objective on the wrong map. The schema only
    // type-checks both as strings; this is the only guard for that mismatch.
    const mismatched = nameCheckable
      .filter(({ id, name }) => {
        const canonical = TARKOV_MAP_NAMES_BY_ID[id];
        return name !== undefined && canonical !== undefined && canonical !== name;
      })
      .map(
        ({ id, name, location }) =>
          `${location}: id ${id} is ${TARKOV_MAP_NAMES_BY_ID[id]}, labelled ${name}`
      );

    expect(mismatched).toEqual([]);
  });

  it('uses the canonical ID for every map name', () => {
    // Catches the inverse slip: the right name carried by an ID belonging to a
    // different map, or to no known map at all.
    const wrongId = nameCheckable
      .filter(({ id, name }) => {
        const expectedId = name === undefined ? undefined : canonicalIdsByName.get(name);
        return expectedId !== undefined && expectedId !== id;
      })
      .map(
        ({ id, name, location }) =>
          `${location}: ${name} is ${canonicalIdsByName.get(name as string)}, referenced as ${id}`
      );

    expect(wrongId).toEqual([]);
  });

  it('references only known tarkov.dev map IDs, including in locale files', () => {
    // Applies to locale files too: names there are translated, but the ID is the
    // join key and must still be canonical. An unknown ID is a typo or a new
    // upstream map - verify against json.tarkov.dev/regular/maps and add it.
    const unknown = allReferences
      .filter(({ id }) => TARKOV_MAP_NAMES_BY_ID[id] === undefined)
      .map(({ id, name, location }) => `${location}: ${id}${name ? ` (${name})` : ''}`);

    expect(unknown).toEqual([]);
  });

  it('keeps the built overlay consistent with the registry', () => {
    // The published artifact is what consumers read, so assert it directly
    // rather than trusting that the build faithfully copied the sources.
    const { distDir } = getProjectPaths();
    const overlayPath = join(distDir, 'overlay.json');
    expect(existsSync(overlayPath), 'dist/overlay.json must be built before this runs').toBe(true);

    const overlay = loadJsonFile<Record<string, unknown>>(overlayPath);
    const { locales, ...localeNeutral } = overlay;

    const built: MapReference[] = [];
    collectMapReferences(localeNeutral, 'dist/overlay.json', built);
    const localized: MapReference[] = [];
    collectMapReferences(locales, 'dist/overlay.json.locales', localized);

    const problems = built
      .filter(({ id, name }) => name !== undefined && TARKOV_MAP_NAMES_BY_ID[id] !== name)
      .map(
        ({ id, name, location }) =>
          `${location}: id ${id} is ${TARKOV_MAP_NAMES_BY_ID[id] ?? 'unknown'}, labelled ${name}`
      );
    const unknownIds = [...built, ...localized]
      .filter(({ id }) => TARKOV_MAP_NAMES_BY_ID[id] === undefined)
      .map(({ id, location }) => `${location}: unknown map id ${id}`);

    expect([...problems, ...unknownIds]).toEqual([]);
  });
});
