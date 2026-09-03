import { describe, expect, it } from 'vitest';
import { join, relative, sep } from 'path';
import { existsSync, readdirSync } from 'fs';
import {
  getProjectPaths,
  loadJson5File,
  loadJsonFile,
  TARKOV_MAP_NAMES_BY_ID,
  TARKOV_TRADER_NAMES_BY_ID,
} from '../src/lib/index.js';

/**
 * Guards `{ id, name }` entity references in overlay data.
 *
 * Consumers resolve these by `id`; the schemas only type-check `id` and `name`
 * as strings, so a correct-looking name beside another entity's ID is silently
 * wrong and passes validate, build and every other test. That is how two map
 * references shipped pointing at the wrong maps.
 */

interface EntityReference {
  id: string;
  /** Absent for bare-ID collections such as `traderIds`. */
  name?: string;
  location: string;
}

interface Registry {
  /** Human label used in failure messages, e.g. "map". */
  label: string;
  namesById: Map<string, string>;
  idsByName: Map<string, string>;
  /** Keys whose values hold `{ id, name }` references. */
  pairKeys: Set<string>;
  /** Keys whose values hold bare ID strings. */
  idOnlyKeys: Set<string>;
  /** Files expected to contain at least one reference. */
  expectedFiles: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Registry lookups go through Maps, not index access: reference IDs come from
 * data files, and a key like `constructor` would resolve to a prototype value on
 * a plain object.
 */
function toMaps(source: Readonly<Partial<Record<string, string>>>): {
  namesById: Map<string, string>;
  idsByName: Map<string, string>;
} {
  const namesById = new Map<string, string>(
    Object.entries(source).flatMap(([id, name]) =>
      name === undefined ? [] : [[id, name] as [string, string]]
    )
  );
  return {
    namesById,
    idsByName: new Map([...namesById].map(([id, name]) => [name, id])),
  };
}

const MAPS: Registry = {
  label: 'map',
  ...toMaps(TARKOV_MAP_NAMES_BY_ID),
  pairKeys: new Set(['map', 'maps', 'mapUnlocks']),
  idOnlyKeys: new Set(),
  expectedFiles: [
    join('src', 'overrides', 'tasks.json5'),
    join('src', 'additions', 'storyChapters.json5'),
    join('src', 'additions', 'tasksAdd.json5'),
    join('src', 'overrides', 'modes', 'regular', 'tasks.json5'),
  ],
};

const TRADERS: Registry = {
  label: 'trader',
  ...toMaps(TARKOV_TRADER_NAMES_BY_ID),
  // Nested `trader` keys inside `traderRequirements` are reached by the walk.
  pairKeys: new Set(['trader', 'traderUnlocks']),
  idOnlyKeys: new Set(['traderIds']),
  expectedFiles: [
    join('src', 'overrides', 'tasks.json5'),
    join('src', 'additions', 'storyChapters.json5'),
    join('src', 'additions', 'seasonalPerks.json5'),
  ],
};

const REGISTRIES = [MAPS, TRADERS];

/** Collect a pair, keeping `{ id }` alone so an unknown ID is still reported. */
function collectPair(value: unknown, location: string, into: EntityReference[]): void {
  if (!isRecord(value)) return;
  const { id, name } = value;
  if (typeof id !== 'string') return;
  into.push(typeof name === 'string' ? { id, name, location } : { id, location });
}

/**
 * Walk a parsed tree collecting references for one registry, recording a
 * JSON-path-ish location for diagnostics.
 */
function collectReferences(
  node: unknown,
  path: string,
  registry: Registry,
  into: EntityReference[]
): void {
  if (Array.isArray(node)) {
    node.forEach((entry, index) => collectReferences(entry, `${path}[${index}]`, registry, into));
    return;
  }
  if (!isRecord(node)) return;

  for (const [key, value] of Object.entries(node)) {
    const childPath = `${path}.${key}`;
    if (registry.pairKeys.has(key)) {
      if (Array.isArray(value)) {
        value.forEach((entry, index) => collectPair(entry, `${childPath}[${index}]`, into));
      } else {
        collectPair(value, childPath, into);
      }
    }
    if (registry.idOnlyKeys.has(key) && Array.isArray(value)) {
      value.forEach((entry, index) => {
        if (typeof entry === 'string') into.push({ id: entry, location: `${childPath}[${index}]` });
      });
    }
    collectReferences(value, childPath, registry, into);
  }
}

/**
 * Locale data legitimately carries translated names ("Zollhof" for Customs), so
 * a locale reference's ID must still be canonical while its name must not be
 * compared. Covers both `src/overrides/locales/` and the overlay's `locales`
 * section.
 */
function isLocalized(location: string): boolean {
  return (
    location.includes(`${sep}locales${sep}`) ||
    location.includes('/locales/') ||
    location.startsWith('locales.') ||
    location.includes('.locales.')
  );
}

/** A known ID carrying the wrong name. Skipped for localized names. */
function findNameMismatches(references: EntityReference[], registry: Registry): string[] {
  return references
    .filter(({ id, name, location }) => {
      if (name === undefined || isLocalized(location)) return false;
      const canonical = registry.namesById.get(id);
      return canonical !== undefined && canonical !== name;
    })
    .map(
      ({ id, name, location }) =>
        `${location}: ${registry.label} id ${id} is ${registry.namesById.get(id)}, labelled ${name}`
    );
}

/** A known name carried by an ID belonging to a different entity. */
function findWrongIds(references: EntityReference[], registry: Registry): string[] {
  return references
    .filter(({ id, name, location }) => {
      if (name === undefined || isLocalized(location)) return false;
      const expectedId = registry.idsByName.get(name);
      return expectedId !== undefined && expectedId !== id;
    })
    .map(
      ({ id, name, location }) =>
        `${location}: ${registry.label} ${name} is ${registry.idsByName.get(name as string)}, referenced as ${id}`
    );
}

/** An ID absent from the registry. Applies to localized references too. */
function findUnknownIds(references: EntityReference[], registry: Registry): string[] {
  return references
    .filter(({ id }) => !registry.namesById.has(id))
    .map(
      ({ id, name, location }) =>
        `${location}: unknown ${registry.label} id ${id}${name ? ` (${name})` : ''}`
    );
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
const parsedSources = json5SourceFiles().map((entry) => ({
  file: relative(rootDir, join(srcDir, entry)),
  data: loadJson5File(join(srcDir, entry)) as unknown,
}));

function scan(registry: Registry): { file: string; references: EntityReference[] }[] {
  return parsedSources.map(({ file, data }) => {
    const references: EntityReference[] = [];
    collectReferences(data, file, registry, references);
    return { file, references };
  });
}

describe.each(REGISTRIES)('$label registry', (registry) => {
  it('maps every ID to a distinct name', () => {
    // The reverse lookup is only sound while names are unique; a duplicate would
    // silently drop an ID and flag correct references as wrong.
    expect(registry.idsByName.size).toBe(registry.namesById.size);
  });

  it('keys every entry by a tarkov.dev object ID', () => {
    const malformed = [...registry.namesById.keys()].filter((id) => !/^[0-9a-f]{24}$/.test(id));
    expect(malformed).toEqual([]);
  });
});

describe.each(REGISTRIES)('$label reference validation', (registry) => {
  // Exercises the rules directly, including the localized-name exemption that no
  // committed data triggers yet. Without this, adding the first localized
  // reference would be the moment that exemption is first executed.
  const [firstId, firstName] = [...registry.namesById][0] as [string, string];
  const [secondId] = [...registry.namesById][1] as [string, string];

  it('flags a canonical name carried by another entity\u2019s ID', () => {
    const refs = [{ id: secondId, name: firstName, location: 'src/overrides/tasks.json5' }];
    const secondName = registry.namesById.get(secondId);
    // Pinned to the exact text, not just the count: these strings are the only
    // thing a contributor sees when the guard fires, so a silent format change
    // that drops the ID or the label would still "pass" a length assertion.
    expect(findNameMismatches(refs, registry)).toEqual([
      `src/overrides/tasks.json5: ${registry.label} id ${secondId} is ${secondName}, labelled ${firstName}`,
    ]);
    expect(findWrongIds(refs, registry)).toEqual([
      `src/overrides/tasks.json5: ${registry.label} ${firstName} is ${firstId}, referenced as ${secondId}`,
    ]);
  });

  it('accepts a translated name on a canonical ID in locale data', () => {
    const refs = [
      {
        id: firstId,
        name: 'Uebersetzt',
        location: join('src', 'overrides', 'locales', 'de.json5'),
      },
      { id: firstId, name: 'Uebersetzt', location: 'dist/overlay.json.locales.de.tasks' },
    ];
    expect(findNameMismatches(refs, registry)).toEqual([]);
    expect(findWrongIds(refs, registry)).toEqual([]);
    expect(findUnknownIds(refs, registry)).toEqual([]);
  });

  it('still rejects an unknown ID in locale data', () => {
    const refs = [
      {
        id: 'cafebabecafebabecafebabe',
        name: 'Uebersetzt',
        location: join('src', 'overrides', 'locales', 'de.json5'),
      },
    ];
    expect(findUnknownIds(refs, registry)).toEqual([
      `${join('src', 'overrides', 'locales', 'de.json5')}: unknown ${registry.label} id cafebabecafebabecafebabe (Uebersetzt)`,
    ]);
  });

  it('reports an unknown ID on a reference with no name', () => {
    const refs = [{ id: 'deadbeefdeadbeefdeadbeef', location: 'src/overrides/tasks.json5' }];
    expect(findUnknownIds(refs, registry)).toEqual([
      `src/overrides/tasks.json5: unknown ${registry.label} id deadbeefdeadbeefdeadbeef`,
    ]);
  });

  it('accepts every canonical pairing', () => {
    const refs = [...registry.namesById].map(([id, name]) => ({
      id,
      name,
      location: 'src/overrides/tasks.json5',
    }));
    expect([
      ...findNameMismatches(refs, registry),
      ...findWrongIds(refs, registry),
      ...findUnknownIds(refs, registry),
    ]).toEqual([]);
  });
});

describe('reference collection', () => {
  it('ignores map: null and the map: true suppression flag', () => {
    const collected: EntityReference[] = [];
    collectReferences(
      { a: { map: null }, b: { map: true }, c: { maps: [] } },
      'probe',
      MAPS,
      collected
    );
    expect(collected).toEqual([]);
  });

  it('reaches trader references nested inside traderRequirements', () => {
    const collected: EntityReference[] = [];
    collectReferences(
      { traderRequirements: [{ trader: { id: '54cb50c76803fa8b248b4571', name: 'Prapor' } }] },
      'probe',
      TRADERS,
      collected
    );
    expect(collected).toEqual([
      {
        id: '54cb50c76803fa8b248b4571',
        name: 'Prapor',
        location: 'probe.traderRequirements[0].trader',
      },
    ]);
  });

  it('collects bare IDs from traderIds', () => {
    const collected: EntityReference[] = [];
    collectReferences({ traderIds: ['54cb50c76803fa8b248b4571'] }, 'probe', TRADERS, collected);
    expect(collected).toEqual([{ id: '54cb50c76803fa8b248b4571', location: 'probe.traderIds[0]' }]);
  });

  it('reaches nested source directories', () => {
    // Guards the recursive walk: these live one and two levels below src/, which
    // a flat readdir (the original implementation) missed entirely.
    const files = parsedSources.map(({ file }) => file);

    expect(files).toEqual(
      expect.arrayContaining([
        join('src', 'overrides', 'tasks.json5'),
        join('src', 'overrides', 'locales', 'de.json5'),
        join('src', 'overrides', 'modes', 'regular', 'tasks.json5'),
        join('src', 'divergences', 'tasks.json5'),
        join('src', 'suppressions', 'tasks.json5'),
      ])
    );
    expect(files.length).toBeGreaterThanOrEqual(19);
  });
});

describe.each(REGISTRIES)('$label references in source data', (registry) => {
  const scanned = scan(registry);
  const references = scanned.flatMap(({ references: refs }) => refs);

  it('finds the references it is meant to validate', () => {
    // Every file known to carry references must still contribute some, so a file
    // dropping out of scope cannot hide behind a global non-zero count.
    const withReferences = scanned
      .filter(({ references: refs }) => refs.length > 0)
      .map(({ file }) => file);

    expect(withReferences).toEqual(expect.arrayContaining(registry.expectedFiles));
  });

  it('pairs every ID with that entity\u2019s canonical name', () => {
    expect(findNameMismatches(references, registry)).toEqual([]);
  });

  it('uses the canonical ID for every name', () => {
    expect(findWrongIds(references, registry)).toEqual([]);
  });

  it('references only known tarkov.dev IDs', () => {
    // An unknown ID is a typo or a genuinely new upstream entity - verify against
    // json.tarkov.dev and add it to the registry.
    expect(findUnknownIds(references, registry)).toEqual([]);
  });
});

describe.each(REGISTRIES)('$label references in the built overlay', (registry) => {
  it('keeps the published artifact consistent with the registry', () => {
    // The artifact is what consumers read, so assert it directly rather than
    // trusting that the build faithfully copied the sources.
    const overlayPath = join(distDir, 'overlay.json');
    expect(existsSync(overlayPath), 'dist/overlay.json must be built before this runs').toBe(true);

    const built: EntityReference[] = [];
    collectReferences(loadJsonFile(overlayPath), 'dist/overlay.json', registry, built);
    expect(built.length).toBeGreaterThan(0);

    expect([
      ...findNameMismatches(built, registry),
      ...findWrongIds(built, registry),
      ...findUnknownIds(built, registry),
    ]).toEqual([]);
  });
});
