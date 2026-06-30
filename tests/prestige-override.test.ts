/**
 * Tests for the prestige override capability (issue #207)
 *
 * tarkov.dev does not carry New Beginning (Prestige 5/6), so its `prestige`
 * array points the Prestige 5/6 taskStatus requirement at Collector
 * (5c51aac186f77432ea65c552). The overlay supplies the missing quests via
 * tasksAdd and repoints the prestige requirement at them.
 */

import { describe, expect, it } from 'vitest';
import Ajv from 'ajv';
import { join } from 'path';
import {
  getProjectPaths,
  loadAllJson5FromDir,
  loadJsonFile,
} from '../src/lib/index.js';
import { initializeValidators, getValidator } from '../scripts/validate.js';

const COLLECTOR_ID = '5c51aac186f77432ea65c552';

function loadPrestigeOverride(): Record<string, any> {
  const { srcDir } = getProjectPaths();
  const overrides = loadAllJson5FromDir(join(srcDir, 'overrides'));
  return (overrides.prestige ?? {}) as Record<string, any>;
}

describe('prestige override (issue #207)', () => {
  it('is registered with a schema validator', () => {
    const validators = initializeValidators();
    expect(getValidator('overrides/prestige.json5', validators)).not.toBeNull();
  });

  it('repoints Prestige 5 and 6 storyline requirement off Collector', () => {
    const prestige = loadPrestigeOverride();

    const p5 = prestige['68d3ddb4fc101237e601d774'];
    const p6 = prestige['68d3e6f46a7ba36646713fa6'];
    expect(p5?.prestigeLevel).toBe(5);
    expect(p6?.prestigeLevel).toBe(6);

    const p5cond = p5.conditions['68d3ddb415034199b86b8d68'];
    const p6cond = p6.conditions['68d3e6f40b976d94f72dde5e'];

    // Corrected to the overlay-added New Beginning quests...
    expect(p5cond.task).toBe('new_beginning_prestige_5');
    expect(p6cond.task).toBe('new_beginning_prestige_6');
    // ...and no longer the Collector stand-in.
    expect(p5cond.task).not.toBe(COLLECTOR_ID);
    expect(p6cond.task).not.toBe(COLLECTOR_ID);
  });

  it('points each prestige condition at a quest the overlay actually provides', () => {
    const { srcDir } = getProjectPaths();
    const prestige = loadPrestigeOverride();
    const additions = loadAllJson5FromDir(join(srcDir, 'additions'), false);
    const addedTaskIds = new Set(Object.keys(additions.tasksAdd ?? {}));

    for (const entry of Object.values(prestige)) {
      for (const cond of Object.values(entry.conditions ?? {}) as any[]) {
        if (cond.type === 'taskStatus' && cond.task?.startsWith('new_beginning_prestige_')) {
          expect(addedTaskIds.has(cond.task)).toBe(true);
        }
      }
    }
  });

  it('rejects an unknown field via the prestige schema', () => {
    const { schemasDir } = getProjectPaths();
    const ajv = new Ajv({ allErrors: true, strict: false });
    const schema = loadJsonFile(join(schemasDir, 'prestige-override.schema.json'));
    const validate = ajv.compile(schema as object);

    expect(validate({ abc: { bogusField: true } })).toBe(false);
    expect(
      validate({ abc: { conditions: { def: { task: 'new_beginning_prestige_5' } } } })
    ).toBe(true);
  });
});
