import { describe, expect, it } from 'vitest';
import { join } from 'path';
import { getProjectPaths, loadJson5File, type TaskOverride } from '../src/lib/index.js';
import { applyTaskOverride, getTaskOverrideForMode } from '../examples/apply-overlay.js';

const TASK_IDS = {
  oldGlory: '639135b04ed9512be67647d7',
  mallCop: '64e7b99017ab941a6f7bf9d7',
  tickets: '64e7b9a4aac4cd0a726562cb',
  duplicateShooter: '5bc4826c86f774106d22d88b',
  shooterPart1: '5bc4776586f774512d07cf05',
  unprotected: '5d25aed386f77442734d25d2',
  walls: '669fa39c64ea11e84c0642a6',
  tigrSafari: '5a27b7a786f774579c3eb376',
  trophy: '5d25e2c386f77443e7549029',
  goodTimes: '666314b4d7f171c4c20226c3',
  supplements: '5b478ff486f7744d184ecbbf',
  relentless: '60e71e8ed54b755a3b53eb67',
  flashDrive: '5979ed3886f77431307dc512',
  easyBreezy: '669fa3a40c828825de06d6a1',
} as const;

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
    for (const id of [
      TASK_IDS.oldGlory,
      TASK_IDS.mallCop,
      TASK_IDS.tickets,
      TASK_IDS.duplicateShooter,
    ]) {
      expect(overrides[id]).toMatchObject({ disabled: true });
    }

    expect(loadSuppressions()[TASK_IDS.duplicateShooter]).toMatchObject({ name: true });
  });

  it('restores the documented prerequisite chains', () => {
    expect(overrides[TASK_IDS.shooterPart1]).toMatchObject({
      taskRequirements: [{ task: { id: '5d24b81486f77439c92d6ba8', name: 'Acquaintance' } }],
    });
    expect(overrides[TASK_IDS.unprotected]).toMatchObject({
      taskRequirements: [{ task: { id: '5d24b81486f77439c92d6ba8', name: 'Acquaintance' } }],
      objectives: {
        '5d25af3c86f77443ff46b9e7': {
          maps: [{ id: '5704e554d2720bac5b8b456e', name: 'Woods' }],
        },
      },
    });
    expect(overrides[TASK_IDS.walls]).toMatchObject({
      taskRequirements: [{ task: { id: '669fa395c4c5c04798002497', name: 'Exit Here' } }],
    });
    expect(overrides[TASK_IDS.tigrSafari]).toMatchObject({
      taskRequirements: [{ task: { id: '5a27b75b86f7742e97191958', name: 'Fishing Gear' } }],
    });
    expect(overrides[TASK_IDS.trophy]).toMatchObject({
      taskRequirements: [
        {
          task: {
            id: '5d25e2b486f77409de05bba0',
            name: 'The Huntsman Path - Secured Perimeter',
          },
        },
      ],
    });
  });

  it('applies the level, map, name, and objective corrections', () => {
    expect(overrides[TASK_IDS.goodTimes]).toMatchObject({
      minPlayerLevel: 27,
      taskRequirements: [{ task: { id: '657315df034d76585f032e01', name: 'Shooting Cans' } }],
    });
    expect(overrides[TASK_IDS.supplements]).toMatchObject({
      objectives: {
        '6a5ab1920a2a6d86771ee14a': {
          maps: [{ id: '5704e4dad2720bb55b8b4567', name: 'Customs' }],
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
});

describe('mode-specific task correction consumption', () => {
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
            { id: '54490bb74bdc2d5f4b8b4567', name: 'Reserve' },
            { id: '5b0bc9b5e7f0fa3f5c0b4567', name: 'Lighthouse' },
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
