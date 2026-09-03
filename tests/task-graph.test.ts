import { describe, expect, it } from 'vitest';
import { join, relative } from 'path';
import { existsSync } from 'fs';
import {
  getProjectPaths,
  loadJson5File,
  loadJsonFile,
  SUPPORTED_GAME_MODES,
} from '../src/lib/index.js';

/**
 * Guards the shape of the prerequisite graph the overlay declares.
 *
 * `taskRequirements` edges are what consumers walk to decide whether a task is
 * reachable, and a wrong edge is invisible to `validate` (the schema only
 * type-checks `task.id` as a string), to `build`, and to `check-overrides`
 * (which compares fields against upstream but never traverses the graph).
 *
 * These checks are deliberately offline and upstream-independent, so they run in
 * CI: a cycle or a self-reference is wrong no matter what tarkov.dev serves.
 * Agreement between an overlay edge and the game client's own
 * `AvailableForStart` conditions is a separate question that needs the local
 * quest reference - that is `npm run eft:audit`, which cannot run in CI because
 * the reference is intentionally not committed.
 *
 * Each rule is a pure function checked twice: against fixtures, so the rule is
 * exercised even when no committed data triggers it, and against the real
 * sources. The overlay legitimately carries zero prerequisite edges at times
 * (patch 1.1.0.0 moved most gating onto trader loyalty), and a guard that only
 * ran over live data would then pass vacuously.
 */

interface TaskReference {
  id: string;
  name?: string;
  location: string;
}

interface TaskSource {
  /** Repo-relative path, used in failure messages. */
  file: string;
  /**
   * Task ID -> prerequisite references declared by this source.
   *
   * `undefined` means the entry does not declare `taskRequirements` at all,
   * which is distinct from declaring it empty. `mergeTaskOverride` spreads
   * fields, so an absent key leaves the base entry's edges intact while an
   * explicit `[]` clears them.
   */
  tasks: Map<string, TaskReference[] | undefined>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Collect the `task: { id, name }` references inside one task entry's
 * `taskRequirements`, tolerating shapes the schema would reject (schema
 * validation owns shape enforcement; this test owns graph semantics).
 *
 * Returns `undefined` when the entry declares no `taskRequirements` key, so the
 * caller can tell "inherits the base edges" from "declares no edges".
 */
function collectPrerequisites(entry: unknown, location: string): TaskReference[] | undefined {
  if (!isRecord(entry)) return undefined;
  if (!('taskRequirements' in entry)) return undefined;

  const requirements = entry.taskRequirements;
  // A declared but malformed value still replaces the base value on merge, so it
  // reports as "declared, no usable edges" rather than as absent.
  if (!Array.isArray(requirements)) return [];

  const refs: TaskReference[] = [];
  requirements.forEach((requirement, index) => {
    if (!isRecord(requirement)) return;
    const task = requirement.task;
    if (!isRecord(task)) return;
    const id = task.id;
    if (typeof id !== 'string') return;
    refs.push({
      id,
      name: typeof task.name === 'string' ? task.name : undefined,
      location: `${location}.taskRequirements[${index}]`,
    });
  });
  return refs;
}

/** A task listed as its own prerequisite. */
export function findSelfReferences(sources: readonly TaskSource[]): string[] {
  return sources.flatMap((source) =>
    [...source.tasks].flatMap(([taskId, refs]) =>
      (refs ?? [])
        .filter((ref) => ref.id === taskId)
        .map((ref) => `${source.file}: ${ref.location} requires its own task ${taskId}`)
    )
  );
}

/** The same prerequisite listed twice for one task. */
export function findDuplicatePrerequisites(sources: readonly TaskSource[]): string[] {
  return sources.flatMap((source) =>
    [...source.tasks].flatMap(([taskId, refs]) => {
      const seen = new Set<string>();
      return (refs ?? []).flatMap((ref) => {
        if (seen.has(ref.id)) {
          return [`${source.file}: ${taskId} lists prerequisite ${ref.id} more than once`];
        }
        seen.add(ref.id);
        return [];
      });
    })
  );
}

/**
 * Cycles among the edges a single source declares.
 *
 * A ring wholly inside the overlay's own edges is unreachable in game and makes
 * every task in it permanently locked for consumers that resolve prerequisites
 * transitively. Upstream edges are not available offline, so only edges whose
 * target the same source also redefines are followed; anything else resolves
 * from upstream data at merge time.
 */
export function findCycles(sources: readonly TaskSource[]): string[] {
  const cycles: string[] = [];

  for (const source of sources) {
    const edges = new Map(
      [...source.tasks].map(([id, refs]) => [id, (refs ?? []).map((r) => r.id)])
    );
    const state = new Map<string, 'visiting' | 'done'>();

    const walk = (taskId: string, path: string[]): void => {
      if (state.get(taskId) === 'done') return;
      if (state.get(taskId) === 'visiting') {
        const start = path.indexOf(taskId);
        cycles.push(`${source.file}: ${[...path.slice(start), taskId].join(' -> ')}`);
        return;
      }
      state.set(taskId, 'visiting');
      for (const next of edges.get(taskId) ?? []) {
        if (edges.has(next)) walk(next, [...path, taskId]);
      }
      state.set(taskId, 'done');
    };

    for (const taskId of edges.keys()) walk(taskId, []);
  }

  return cycles;
}

/**
 * One ID under two names, or one name under two IDs.
 *
 * The same hazard `tests/entity-references.test.ts` guards for maps and traders.
 * There is no committed registry of task names (there are 500+ and they change
 * every patch), so this enforces internal consistency instead.
 */
export function findInconsistentReferences(sources: readonly TaskSource[]): string[] {
  const namesById = new Map<string, { name: string; location: string }>();
  const idsByName = new Map<string, { id: string; location: string }>();
  const conflicts: string[] = [];

  for (const source of sources) {
    for (const refs of source.tasks.values()) {
      for (const ref of refs ?? []) {
        if (ref.name === undefined) continue;
        const where = `${source.file}: ${ref.location}`;

        const seenName = namesById.get(ref.id);
        if (seenName === undefined) {
          namesById.set(ref.id, { name: ref.name, location: where });
        } else if (seenName.name !== ref.name) {
          conflicts.push(
            `${where} labels task ${ref.id} "${ref.name}", but ${seenName.location} labels it "${seenName.name}"`
          );
        }

        const seenId = idsByName.get(ref.name);
        if (seenId === undefined) {
          idsByName.set(ref.name, { id: ref.id, location: where });
        } else if (seenId.id !== ref.id) {
          conflicts.push(
            `${where} maps "${ref.name}" to ${ref.id}, but ${seenId.location} maps it to ${seenId.id}`
          );
        }
      }
    }
  }

  return conflicts;
}

/** Build a source from a plain object, as the JSON5 loaders produce. */
function toSource(file: string, entries: Record<string, unknown>): TaskSource {
  const tasks = new Map<string, TaskReference[] | undefined>();
  for (const [taskId, entry] of Object.entries(entries)) {
    if (taskId.startsWith('$')) continue;
    tasks.set(taskId, collectPrerequisites(entry, taskId));
  }
  return { file, tasks };
}

/**
 * Compose the graph a consumer actually resolves for one mode.
 *
 * `mergeTaskOverride` merges shared and mode-specific patches with
 * `{ ...shared, ...modeSpecific }`, so a mode entry replaces the base entry's
 * `taskRequirements` wholesale rather than adding to it. Checking each file
 * separately would miss a ring that only exists once they are combined - a base
 * edge `a -> b` beside a regular-mode edge `b -> a` is a cycle in regular mode
 * while neither file contains one on its own.
 */
export function buildEffectiveSource(
  label: string,
  base: readonly TaskSource[],
  modeSpecific?: TaskSource
): TaskSource {
  const tasks = new Map<string, TaskReference[] | undefined>();
  for (const source of base) {
    for (const [taskId, refs] of source.tasks) tasks.set(taskId, refs);
  }

  if (modeSpecific) {
    for (const [taskId, refs] of modeSpecific.tasks) {
      // Merge per field, not per task. A mode entry that only patches, say,
      // `minPlayerLevel` carries no `taskRequirements` key, and
      // `{ ...shared, ...modeSpecific }` leaves the base edges in place. Taking
      // the mode entry wholesale would silently delete those edges and could
      // hide the very cross-mode cycle this composition exists to find.
      if (refs === undefined && tasks.has(taskId)) continue;
      tasks.set(taskId, refs);
    }
  }
  return { file: label, tasks };
}

function loadTaskSource(absolutePath: string, rootDir: string): TaskSource | undefined {
  if (!existsSync(absolutePath)) return undefined;
  const parsed = absolutePath.endsWith('.json5')
    ? loadJson5File<Record<string, unknown>>(absolutePath)
    : loadJsonFile<Record<string, unknown>>(absolutePath);
  return toSource(relative(rootDir, absolutePath), parsed);
}

const { rootDir, srcDir, distDir } = getProjectPaths();

/** Sources that apply to every mode. */
const BASE_FILES = [
  join(srcDir, 'overrides', 'tasks.json5'),
  join(srcDir, 'additions', 'tasksAdd.json5'),
];

/** Mode-specific sources, which win per task over the base files. */
const MODE_FILES = SUPPORTED_GAME_MODES.map(
  (mode) => [mode, join(srcDir, 'overrides', 'modes', mode, 'tasks.json5')] as const
);

const load = (file: string) => loadTaskSource(file, rootDir);
const isSource = (source: TaskSource | undefined): source is TaskSource => source !== undefined;

const baseSources = BASE_FILES.map(load).filter(isSource);
const modeSources = MODE_FILES.map(([mode, file]) => [mode, load(file)] as const);

/** Every committed source, for the per-entry and cross-file rules. */
const sources = [...baseSources, ...modeSources.flatMap(([, s]) => (s ? [s] : []))];

/** One composed graph per mode, for the cycle rule. */
const effectiveSources = modeSources.map(([mode, source]) =>
  buildEffectiveSource(`effective:${mode}`, baseSources, source)
);

const edge = (id: string, name?: string) => ({ task: name === undefined ? { id } : { id, name } });

describe('task prerequisite graph rules', () => {
  it('detects a task listed as its own prerequisite', () => {
    const fixture = [toSource('fixture.json5', { a: { taskRequirements: [edge('a', 'A')] } })];
    expect(findSelfReferences(fixture)).toEqual([
      'fixture.json5: a.taskRequirements[0] requires its own task a',
    ]);
    expect(findSelfReferences([toSource('fixture.json5', { a: {} })])).toEqual([]);
  });

  it('detects a repeated prerequisite', () => {
    const fixture = [
      toSource('fixture.json5', { a: { taskRequirements: [edge('b', 'B'), edge('b', 'B')] } }),
    ];
    expect(findDuplicatePrerequisites(fixture)).toEqual([
      'fixture.json5: a lists prerequisite b more than once',
    ]);
  });

  it('detects a cycle and ignores edges resolved from upstream', () => {
    const ring = [
      toSource('fixture.json5', {
        a: { taskRequirements: [edge('b', 'B')] },
        b: { taskRequirements: [edge('a', 'A')] },
      }),
    ];
    expect(findCycles(ring)).toHaveLength(1);
    expect(findCycles(ring)[0]).toContain('a -> b -> a');

    // `b` is not redefined by this source, so the edge is not traversable here.
    const openChain = [toSource('fixture.json5', { a: { taskRequirements: [edge('b', 'B')] } })];
    expect(findCycles(openChain)).toEqual([]);
  });

  it('detects a longer cycle', () => {
    const ring = [
      toSource('fixture.json5', {
        a: { taskRequirements: [edge('b')] },
        b: { taskRequirements: [edge('c')] },
        c: { taskRequirements: [edge('a')] },
      }),
    ];
    expect(findCycles(ring)).toHaveLength(1);
  });

  it('detects one id under two names and one name under two ids', () => {
    const twoNames = [
      toSource('fixture.json5', {
        a: { taskRequirements: [edge('x', 'First')] },
        b: { taskRequirements: [edge('x', 'Second')] },
      }),
    ];
    expect(findInconsistentReferences(twoNames)).toEqual([
      'fixture.json5: b.taskRequirements[0] labels task x "Second", but fixture.json5: a.taskRequirements[0] labels it "First"',
    ]);

    const twoIds = [
      toSource('fixture.json5', {
        a: { taskRequirements: [edge('x', 'Same')] },
        b: { taskRequirements: [edge('y', 'Same')] },
      }),
    ];
    expect(findInconsistentReferences(twoIds)).toEqual([
      'fixture.json5: b.taskRequirements[0] maps "Same" to y, but fixture.json5: a.taskRequirements[0] maps it to x',
    ]);
  });

  it('detects a cycle spanning a base entry and a mode entry', () => {
    const base = [toSource('src/overrides/tasks.json5', { a: { taskRequirements: [edge('b')] } })];
    const mode = toSource('src/overrides/modes/regular/tasks.json5', {
      b: { taskRequirements: [edge('a')] },
    });

    // Neither file contains a ring on its own, so the per-file view is clean.
    expect(findCycles([...base, mode])).toEqual([]);

    // Composed for the mode a consumer resolves, the ring appears.
    const effective = buildEffectiveSource('effective:regular', base, mode);
    expect(findCycles([effective])).toHaveLength(1);
    expect(findCycles([effective])[0]).toContain('a -> b -> a');
  });

  it('lets a mode entry replace a base entry rather than adding to it', () => {
    const base = [
      toSource('base', { a: { taskRequirements: [edge('b')] }, b: { taskRequirements: [] } }),
    ];
    // Base says a -> b; regular repoints a at c, which breaks the b edge.
    const mode = toSource('mode', { a: { taskRequirements: [edge('c')] } });
    const effective = buildEffectiveSource('effective:regular', base, mode);

    expect(effective.tasks.get('a')?.map((r) => r.id)).toEqual(['c']);
    expect(findCycles([effective])).toEqual([]);
  });

  /**
   * A mode entry that patches an unrelated field carries no `taskRequirements`
   * key, and `mergeTaskOverride` leaves the base edges in place. Taking the mode
   * entry wholesale would delete them and hide the ring.
   */
  it('keeps base edges when a mode entry patches an unrelated field', () => {
    const base = [toSource('base', { a: { taskRequirements: [edge('b')] } })];
    const mode = toSource('mode', {
      a: { minPlayerLevel: 5 },
      b: { taskRequirements: [edge('a')] },
    });
    const effective = buildEffectiveSource('effective:regular', base, mode);

    expect(effective.tasks.get('a')?.map((r) => r.id)).toEqual(['b']);
    expect(findCycles([effective])).toHaveLength(1);
    expect(findCycles([effective])[0]).toContain('a -> b -> a');
  });

  it('lets a mode entry clear base edges with an explicit empty array', () => {
    const base = [toSource('base', { a: { taskRequirements: [edge('b')] } })];
    const mode = toSource('mode', {
      a: { taskRequirements: [] },
      b: { taskRequirements: [edge('a')] },
    });
    const effective = buildEffectiveSource('effective:regular', base, mode);

    expect(effective.tasks.get('a')).toEqual([]);
    expect(findCycles([effective])).toEqual([]);
  });

  it('accepts a consistent acyclic graph', () => {
    const ok = [
      toSource('fixture.json5', {
        a: { taskRequirements: [edge('b', 'B')] },
        b: { taskRequirements: [edge('c', 'C')] },
        c: {},
      }),
    ];
    expect([
      ...findSelfReferences(ok),
      ...findDuplicatePrerequisites(ok),
      ...findCycles(ok),
      ...findInconsistentReferences(ok),
    ]).toEqual([]);
  });

  it('ignores entries whose taskRequirements is absent or malformed', () => {
    const odd = [
      toSource('fixture.json5', {
        a: { taskRequirements: 'nope' },
        b: { taskRequirements: [null, {}, { task: {} }, { task: { id: 7 } }] },
        c: null,
        $meta: { taskRequirements: [edge('c', 'C')] },
      }),
    ];
    expect(findSelfReferences(odd)).toEqual([]);
    expect(findCycles(odd)).toEqual([]);
    expect(findInconsistentReferences(odd)).toEqual([]);
  });
});

describe('committed task prerequisite graph', () => {
  it('loads the task sources it is meant to guard', () => {
    expect(sources.map((source) => source.file)).toContain(join('src', 'overrides', 'tasks.json5'));
  });

  it('declares no task as its own prerequisite', () => {
    expect(findSelfReferences(sources)).toEqual([]);
  });

  it('declares no duplicate prerequisite for the same task', () => {
    expect(findDuplicatePrerequisites(sources)).toEqual([]);
  });

  /**
   * Checked on the composed per-mode graphs, not per file: base overrides apply
   * in every mode, so a ring can span a base entry and a mode entry.
   */
  it('declares no prerequisite cycle in any mode\u2019s effective graph', () => {
    expect(effectiveSources.map((s) => s.file)).toHaveLength(SUPPORTED_GAME_MODES.length);
    expect(findCycles(effectiveSources)).toEqual([]);
  });

  it('references each task under a single consistent id and name', () => {
    expect(findInconsistentReferences(sources)).toEqual([]);
  });

  /**
   * The built overlay is what consumers download, so it gets the same structural
   * checks: the build must not introduce a self-reference or a cycle the sources
   * do not have.
   */
  it('keeps the built overlay free of self-references and cycles', () => {
    const overlayPath = join(distDir, 'overlay.json');
    if (!existsSync(overlayPath)) {
      throw new Error('dist/overlay.json is missing; run "npm run build" before this test');
    }

    const overlay = loadJsonFile<Record<string, unknown>>(overlayPath);
    const builtSources: TaskSource[] = [];

    if (isRecord(overlay.tasks))
      builtSources.push(toSource('dist/overlay.json:tasks', overlay.tasks));
    if (isRecord(overlay.modes)) {
      for (const [mode, modeOverlay] of Object.entries(overlay.modes)) {
        if (isRecord(modeOverlay) && isRecord(modeOverlay.tasks)) {
          builtSources.push(toSource(`dist/overlay.json:modes.${mode}.tasks`, modeOverlay.tasks));
        }
      }
    }

    expect([...findSelfReferences(builtSources), ...findCycles(builtSources)]).toEqual([]);
  });
});
