/**
 * Tests for the prestige override capability (issue #207)
 *
 * tarkov.dev omits the story-chapter requirements shown in the in-game prestige
 * screen. It also omits New Beginning (Prestige 5/6), so its Prestige 5/6
 * task condition only points at Collector. The overlay provides an authoritative
 * storyRequirements list and synthetic New Beginning task conditions.
 */

import { describe, expect, it } from 'vitest';
import Ajv from 'ajv';
import { join } from 'path';
import {
  getProjectPaths,
  loadAllJson5FromDir,
  loadJsonFile,
  type PrestigeOverride,
  type StoryChapter,
} from '../src/lib/index.js';
import { initializeValidators, getValidator } from '../scripts/validate.js';

const P5_COLLECTOR_CONDITION_ID = '68d3ddb415034199b86b8d68';
const P6_COLLECTOR_CONDITION_ID = '68d3e6f40b976d94f72dde5e';

const PRESTIGE_IDS = {
  p1: '672df12f97f0469cea52f55e',
  p2: '672df4281ab8d9c8849a0c88',
  p3: '683da91d6f472cfa738c52f2',
  p4: '6842f121000d98ce33b9a60f',
  p5: '68d3ddb4fc101237e601d774',
  p6: '68d3e6f46a7ba36646713fa6',
} as const;

function loadPrestigeOverride(): Record<string, PrestigeOverride> {
  const { srcDir } = getProjectPaths();
  const overrides = loadAllJson5FromDir(join(srcDir, 'overrides'));
  return (overrides.prestige ?? {}) as Record<string, PrestigeOverride>;
}

function storyNames(entry: PrestigeOverride | undefined): string[] {
  expect(entry).toBeDefined();
  return (entry?.storyRequirements ?? []).map((req) => req.name);
}

describe('prestige override (issue #207)', () => {
  it('is registered with a schema validator', () => {
    const validators = initializeValidators();
    expect(getValidator('overrides/prestige.json5', validators)).not.toBeNull();
  });

  it('records the in-game story requirements for each prestige level', () => {
    const prestige = loadPrestigeOverride();

    expect(storyNames(prestige[PRESTIGE_IDS.p1])).toEqual([]);
    expect(storyNames(prestige[PRESTIGE_IDS.p2])).toEqual(['Tour']);
    expect(storyNames(prestige[PRESTIGE_IDS.p3])).toEqual(['Tour', 'Falling Skies']);
    expect(storyNames(prestige[PRESTIGE_IDS.p4])).toEqual([
      'Tour',
      'Obtain the Ticket from Tarkov',
    ]);
    expect(storyNames(prestige[PRESTIGE_IDS.p5])).toEqual([
      'Tour',
      'They Are Already Here',
      'Obtain the Ticket from Tarkov',
    ]);
    expect(storyNames(prestige[PRESTIGE_IDS.p6])).toEqual(['The Ticket']);
  });

  it('uses synthetic Prestige 5 and 6 New Beginning condition keys instead of patching Collector', () => {
    const prestige = loadPrestigeOverride();

    const p5Entry = prestige[PRESTIGE_IDS.p5];
    const p6Entry = prestige[PRESTIGE_IDS.p6];
    expect(p5Entry).toBeDefined();
    expect(p6Entry).toBeDefined();
    const p5Conditions = p5Entry?.conditions ?? {};
    const p6Conditions = p6Entry?.conditions ?? {};

    expect(p5Conditions[P5_COLLECTOR_CONDITION_ID]).toBeUndefined();
    expect(p6Conditions[P6_COLLECTOR_CONDITION_ID]).toBeUndefined();
    expect(p5Conditions.overlay_new_beginning_prestige_5.task).toBe(
      'new_beginning_prestige_5'
    );
    expect(p6Conditions.overlay_new_beginning_prestige_6.task).toBe(
      'new_beginning_prestige_6'
    );
  });

  it('points synthetic task conditions at quests the overlay actually provides', () => {
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

  it('points story requirements at known story chapters and objectives', () => {
    const { srcDir } = getProjectPaths();
    const prestige = loadPrestigeOverride();
    const additions = loadAllJson5FromDir(join(srcDir, 'additions'), false);
    const storyChapters = (additions.storyChapters ?? {}) as Record<string, StoryChapter>;

    for (const entry of Object.values(prestige)) {
      for (const req of entry.storyRequirements ?? []) {
        const chapter = storyChapters[req.storyChapter];
        expect(chapter).toBeDefined();
        if (req.type === 'storyObjectiveStatus') {
          expect(chapter.objectives?.some((objective) => objective.id === req.objective)).toBe(
            true
          );
        }
      }
    }
  });

  it('rejects unknown fields via the prestige schema', () => {
    const { schemasDir } = getProjectPaths();
    const ajv = new Ajv({ allErrors: true, strict: false });
    const schema = loadJsonFile(join(schemasDir, 'prestige-override.schema.json'));
    const validate = ajv.compile(schema as object);

    expect(validate({ abc: { bogusField: true } })).toBe(false);
    expect(
      validate({
        abc: {
          storyRequirements: [
            {
              type: 'storyChapterStatus',
              storyChapter: 'tour',
              name: 'Tour',
              status: ['complete'],
            },
          ],
        },
      })
    ).toBe(true);
    expect(
      validate({
        abc: {
          storyRequirements: [
            {
              type: 'storyObjectiveStatus',
              storyChapter: 'the-ticket',
              name: 'Obtain the Ticket from Tarkov',
              status: ['complete'],
            },
          ],
        },
      })
    ).toBe(false);
    expect(
      validate({
        abc: {
          storyRequirements: [
            {
              type: 'storyChapterStatus',
              storyChapter: 'tour',
              objective: 'the-ticket-main-10',
              name: 'Tour',
              status: ['complete'],
            },
          ],
        },
      })
    ).toBe(false);
  });
});
