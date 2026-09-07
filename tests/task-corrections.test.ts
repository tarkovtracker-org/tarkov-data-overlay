import { describe, expect, it } from 'vitest';
import { join } from 'path';
import {
  getProjectPaths,
  loadJson5File,
  loadJsonFile,
  SUPPORTED_GAME_MODES,
  type TaskOverride,
} from '../src/lib/index.js';
import { applyTaskOverride, getTaskOverrideForMode } from '../examples/apply-overlay.js';

const TASK_IDS = {
  oldGlory: '639135b04ed9512be67647d7',
  mallCop: '64e7b99017ab941a6f7bf9d7',
  tickets: '64e7b9a4aac4cd0a726562cb',
  duplicateShooter: '5bc4826c86f774106d22d88b',
  theGuide: '5c0d4e61d09282029f53920e',
  tigrSafari: '5a27b7a786f774579c3eb376',
  goodTimes: '666314b4d7f171c4c20226c3',
  supplements: '5b478ff486f7744d184ecbbf',
  relentless: '60e71e8ed54b755a3b53eb67',
  flashDrive: '5979ed3886f77431307dc512',
  easyBreezy: '669fa3a40c828825de06d6a1',
} as const;

/**
 * Tasks upstream still serves in every mode even though the game removed them.
 * Each entry is a user report filed from a different game mode, which is exactly
 * why the corrections live in the shared section rather than a mode folder.
 */
const DISABLED_DUPLICATES = [
  { id: TASK_IDS.oldGlory, label: 'Glory to CPSU - Part 1', issues: [302, 350] },
  { id: TASK_IDS.mallCop, label: 'Gendarmerie - Mall Cop', issues: [325] },
  { id: TASK_IDS.tickets, label: 'Gendarmerie - Tickets, Please', issues: [349] },
  { id: TASK_IDS.duplicateShooter, label: 'The Tarkov Shooter - Part 5', issues: [322] },
] as const;

const paths = getProjectPaths();

function loadTaskOverrides(): Record<string, TaskOverride> {
  return loadJson5File(join(paths.srcDir, 'overrides', 'tasks.json5'));
}

function loadSuppressions(): Record<string, Record<string, unknown>> {
  return loadJson5File(join(paths.srcDir, 'suppressions', 'tasks.json5'));
}

describe('task correction data', () => {
  const overrides = loadTaskOverrides();

  it('disables obsolete tasks while retaining the duplicate comparison suppression', () => {
    for (const { id, label } of DISABLED_DUPLICATES) {
      expect(overrides[id], label).toMatchObject({ disabled: true });
    }

    expect(loadSuppressions()[TASK_IDS.duplicateShooter]).toMatchObject({ name: true });
  });

  it('keeps every disabled duplicate in the shared section so no mode is missed', () => {
    // A correction placed under src/overrides/modes/<mode>/ would only fix the
    // one mode that reported it, leaving the duplicate visible elsewhere. These
    // IDs must therefore never move out of the shared file, and no mode file may
    // re-enable them.
    for (const mode of SUPPORTED_GAME_MODES) {
      const modeOverrides = loadJson5File<Record<string, TaskOverride>>(
        join(paths.srcDir, 'overrides', 'modes', mode, 'tasks.json5')
      );
      for (const { id, label } of DISABLED_DUPLICATES) {
        expect(modeOverrides[id]?.disabled, `${label} must not be re-enabled in ${mode}`).not.toBe(
          false
        );
      }
    }
  });

  /**
   * Faction locking is a property of the override that nothing else asserts, so
   * it is pinned here (issues #288, #291).
   *
   * Prerequisite edges are deliberately NOT pinned in this file. An assertion
   * that simply restates whatever `taskRequirements` currently says verifies
   * nothing about correctness while making a genuine correction look like a
   * regression - that is how a wrong Survivalist chain stayed green through two
   * pull requests. Prerequisite correctness is adjudicated against the game
   * client's own `AvailableForStart` conditions by `npm run eft:audit`
   * (local-only, needs the quest reference), and the structural properties that
   * can be checked offline - no cycles, no self-references, consistent id/name
   * pairs - live in `tests/task-graph.test.ts`.
   */
  it('keeps the faction lock on faction-restricted tasks', () => {
    expect(overrides[TASK_IDS.tigrSafari]).toMatchObject({ factionName: 'USEC' });
  });

  it('applies the level, map, name, and objective corrections', () => {
    expect(overrides[TASK_IDS.goodTimes]).toMatchObject({ minPlayerLevel: 27 });
    expect(overrides[TASK_IDS.supplements]).toMatchObject({
      objectives: {
        '6a5ab1920a2a6d86771ee14a': {
          maps: [{ id: '56f40101d2720b2a4d8b45d6', name: 'Customs' }],
          possibleLocations: [],
        },
      },
    });
    expect(overrides[TASK_IDS.relentless]).toMatchObject({
      minPlayerLevel: 0,
      traderRequirements: [
        { trader: { id: '5c0647fdd443bc2504c2d371', name: 'Jaeger' }, value: 4 },
      ],
    });
    expect(overrides[TASK_IDS.flashDrive]?.name).toBe("What's on the Flash Drive?");
  });

  /**
   * The Guide's start condition in the client is a single loyalty variable, so
   * upstream's minPlayerLevel 32 is a stale pre-S1 gate (cleared to 0) and the
   * real gate is Peacekeeper LL4, which upstream only serves as an opaque
   * `otherRequirements` globalVariable entry. The one thing that must NOT be here
   * is a `taskRequirements` edge: the wiki's `previous = Wet Job - Part 6` is
   * narrative order, and the client carries no Quest condition for this task.
   */
  it('gates The Guide on Peacekeeper LL4 rather than a player level or a quest', () => {
    const guide = overrides[TASK_IDS.theGuide];
    expect(guide).toMatchObject({
      minPlayerLevel: 0,
      traderRequirements: [
        { trader: { id: '5935c25fb3acc3127c3d8cd9', name: 'Peacekeeper' }, value: 4 },
      ],
    });
    expect(guide?.taskRequirements).toBeUndefined();
  });
});

describe('mode-specific task correction consumption', () => {
  it('filters every obsolete duplicate out of every game mode', () => {
    // End-to-end proof over the shipped artifact: a consumer following
    // docs/INTEGRATION.md must get `null` (task hidden) for each removed
    // duplicate in regular, pve AND pvp-season. Issues #302 (pve) and #350
    // (seasonal) are the same Glory to CPSU - Part 1 duplicate reported from two
    // modes, so per-mode coverage is the actual acceptance criterion.
    const overlay = loadJsonFile<Record<string, unknown>>(
      join(paths.distDir, 'overlay.json')
    ) as never;

    for (const mode of SUPPORTED_GAME_MODES) {
      for (const { id, label, issues } of DISABLED_DUPLICATES) {
        const upstreamTask = {
          id,
          name: label,
          minPlayerLevel: 17,
          objectives: [],
        };
        const override = getTaskOverrideForMode(id, overlay, mode);
        const reason = `${label} (${issues.map((n) => `#${n}`).join(', ')}) in ${mode}`;

        expect(override?.disabled, reason).toBe(true);
        expect(applyTaskOverride(upstreamTask, override), reason).toBeNull();
      }
    }
  });

  it('applies regular Easy-Breezy data without leaking it into PvE', () => {
    const regularOverrides = loadJson5File<Record<string, TaskOverride>>(
      join(paths.srcDir, 'overrides', 'modes', 'regular', 'tasks.json5')
    );
    const overlay = {
      tasks: {},
      modes: { regular: { tasks: regularOverrides } },
      $meta: { version: '1.0', generated: '2026-01-01T00:00:00.000Z', sha256: '' },
    };
    const upstreamTask = {
      id: TASK_IDS.easyBreezy,
      name: 'Easy-Breezy',
      minPlayerLevel: 1,
      objectives: [
        {
          id: '66a0f5a7f9eae6761253114c',
          description: 'PvE objective',
          count: 30,
          maps: [
            { id: '5704e5fad2720bc05b8b4567', name: 'Reserve' },
            { id: '5704e4dad2720bb55b8b4567', name: 'Lighthouse' },
          ],
        },
      ],
    };

    const regularOverride = getTaskOverrideForMode(
      TASK_IDS.easyBreezy,
      overlay as never,
      'regular'
    );
    const pveOverride = getTaskOverrideForMode(TASK_IDS.easyBreezy, overlay as never, 'pve');
    const regularTask = applyTaskOverride(upstreamTask, regularOverride);
    const pveTask = applyTaskOverride(upstreamTask, pveOverride);

    expect(regularTask?.objectives[0]).toMatchObject({
      count: 50,
      maps: [{ id: '55f2d3fd4bdc2d5f408b4567', name: 'Factory' }],
    });
    expect(pveOverride).toBeUndefined();
    expect(pveTask?.objectives[0]).toMatchObject({
      count: 30,
      maps: upstreamTask.objectives[0].maps,
    });
  });
});
