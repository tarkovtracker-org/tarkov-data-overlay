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
  /** Absent when a reference ships a bare ID with no sibling name. */
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
 * Walk a parsed tree and collect every map reference under a
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
 * Locale data legitimately carries translated names ("Zollhof" for Customs), so
 * a locale reference's ID must still be canonical while its name must not be
 * compared. Covers both the `src/overrides/locales/` sources and the built
 * overlay's `locales` section.
 */
function isLocalized(location: string): boolean {
  return (
    location.includes(`${sep}locales${sep}`) ||
    location.includes('/locales/') ||
    location.startsWith('locales.') ||
    location.includes('.locales.')
  );
}

const canonicalIdsByName = new Map(
  Object.entries(TARKOV_MAP_NAMES_BY_ID).map(([id, name]) => [name, id])
);

/** An ID that is known but carries the wrong name. Skipped for localized names. */
function findNameMismatches(references: MapReference[]): string[] {
  return references
    .filter(({ id, name, location }) => {
      if (name === undefined || isLocalized(location)) return false;
      const canonical = TARKOV_MAP_NAMES_BY_ID[id];
      return canonical !== undefined && canonical !== name;
    })
    .map(
      ({ id, name, location }) =>
        `${location}: id ${id} is ${TARKOV_MAP_NAMES_BY_ID[id]}, labelled ${name}`
    );
}

/** A known name carried by an ID that belongs to a different map. */
function findWrongIds(references: MapReference[]): string[] {
  return references
    .filter(({ id, name, location }) => {
      if (name === undefined || isLocalized(location)) return false;
      const expectedId = canonicalIdsByName.get(name);
      return expectedId !== undefined && expectedId !== id;
    })
    .map(
      ({ id, name, location }) =>
        `${location}: ${name} is ${canonicalIdsByName.get(name as string)}, referenced as ${id}`
    );
}

/** An ID absent from the registry. Applies to localized references too. */
function findUnknownIds(references: MapReference[]): string[] {
  return references
    .filter(({ id }) => TARKOV_MAP_NAMES_BY_ID[id] === undefined)
    .map(({ id, name, location }) => `${location}: ${id}${name ? ` (${name})` : ''}`);
}

/**
 * Every JSON5 source file, found recursively so a new data directory is covered
 * by default rather than needing to be remembered here. `src/overrides/modes/`
 * already nests one level, so a hardcoded list is a standing coverage gap.
 */
function json5SourceFiles(): string[] {
  const { srcDir } = getProjectPaths();
  return readdirSync(srcDir, { recursive: true })
    .map((entry) => String(entry))
    .filter((entry) => entry.endsWith('.json5'))
    .sort();
}

const { srcDir, rootDir, distDir } = getProjectPaths();
const scanned = json5SourceFiles().map((entry) => {
  const references: MapReference[] = [];
  const file = relative(rootDir, join(srcDir, entry));
  collectMapReferences(loadJson5File(join(srcDir, entry)), file, references);
  return { file, references };
});
const sourceReferences = scanned.flatMap(({ references }) => references);

describe('map reference registry', () => {
  it('maps every ID to a distinct name', () => {
    // The reverse lookup is only sound while names are unique; a duplicate would
    // silently drop an ID and flag correct references as wrong.
    expect(canonicalIdsByName.size).toBe(Object.keys(TARKOV_MAP_NAMES_BY_ID).length);
  });

  it('keys every entry by a tarkov.dev object ID', () => {
    const malformed = Object.keys(TARKOV_MAP_NAMES_BY_ID).filter(
      (id) => !/^[0-9a-f]{24}$/.test(id)
    );
    expect(malformed).toEqual([]);
  });
});

describe('map reference validation', () => {
  // Exercises the rules directly, including the localized-name exemption that
  // no committed data triggers yet. Without this, adding the first localized map
  // reference would be the moment the exemption is first executed.
  const customs = '56f40101d2720b2a4d8b45d6';
  const lighthouse = '5704e4dad2720bb55b8b4567';

  it('flags a canonical name carried by another map\u2019s ID', () => {
    const refs = [{ id: lighthouse, name: 'Customs', location: 'src/overrides/tasks.json5' }];
    expect(findNameMismatches(refs)).toEqual([
      'src/overrides/tasks.json5: id 5704e4dad2720bb55b8b4567 is Lighthouse, labelled Customs',
    ]);
    expect(findWrongIds(refs)).toHaveLength(1);
  });

  it('accepts a translated name on a canonical ID in locale data', () => {
    const refs = [
      { id: customs, name: 'Zollhof', location: join('src', 'overrides', 'locales', 'de.json5') },
      { id: customs, name: 'Zollhof', location: 'dist/overlay.json.locales.de.tasks' },
    ];
    expect(findNameMismatches(refs)).toEqual([]);
    expect(findWrongIds(refs)).toEqual([]);
    expect(findUnknownIds(refs)).toEqual([]);
  });

  it('still rejects an unknown ID in locale data', () => {
    const refs = [
      {
        id: 'cafebabecafebabecafebabe',
        name: 'Zollhof',
        location: join('src', 'overrides', 'locales', 'de.json5'),
      },
    ];
    expect(findUnknownIds(refs)).toHaveLength(1);
  });

  it('reports an unknown ID on a reference with no name', () => {
    const refs = [{ id: 'deadbeefdeadbeefdeadbeef', location: 'src/overrides/tasks.json5' }];
    expect(findUnknownIds(refs)).toEqual(['src/overrides/tasks.json5: deadbeefdeadbeefdeadbeef']);
  });

  it('ignores map: null and the map: true suppression flag', () => {
    const collected: MapReference[] = [];
    collectMapReferences(
      { a: { map: null }, b: { map: true }, c: { maps: [] } },
      'probe',
      collected
    );
    expect(collected).toEqual([]);
  });
});

describe('map references in source data', () => {
  it('scans every JSON5 source file', () => {
    // Guards against the walker going blind after a refactor or a moved file.
    expect(scanned).toHaveLength(json5SourceFiles().length);
    expect(scanned.length).toBeGreaterThanOrEqual(19);
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
    expect(findNameMismatches(sourceReferences)).toEqual([]);
  });

  it('uses the canonical ID for every map name', () => {
    expect(findWrongIds(sourceReferences)).toEqual([]);
  });

  it('references only known tarkov.dev map IDs', () => {
    // An unknown ID is a typo or a genuinely new upstream map - verify it against
    // json.tarkov.dev/regular/maps and add it to the registry.
    expect(findUnknownIds(sourceReferences)).toEqual([]);
  });
});

describe('map references in the built overlay', () => {
  it('keeps the published artifact consistent with the registry', () => {
    // The artifact is what consumers read, so assert it directly rather than
    // trusting that the build faithfully copied the sources.
    const overlayPath = join(distDir, 'overlay.json');
    expect(existsSync(overlayPath), 'dist/overlay.json must be built before this runs').toBe(true);

    const built: MapReference[] = [];
    collectMapReferences(loadJsonFile(overlayPath), 'dist/overlay.json', built);
    expect(built.length).toBeGreaterThan(0);

    expect([
      ...findNameMismatches(built),
      ...findWrongIds(built),
      ...findUnknownIds(built),
    ]).toEqual([]);
  });
});
