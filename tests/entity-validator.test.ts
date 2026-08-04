/**
 * Tests for entity-validator module
 *
 * Covers the entity types that previously had no validator at all: prestige,
 * items, traders, hideout, itemsAdd, story chapters and suppressions.
 */

import { describe, it, expect } from 'vitest';
import {
  validateEntityOverrides,
  validateEntityAdditions,
  categorizeEntityResults,
  checkStoryChapterIntegrity,
  checkTaskSuppressionStaleness,
  type TaskData,
} from '../src/lib/index.js';

const apiMap = (
  entries: Record<string, Record<string, unknown>>
): Map<string, Record<string, unknown>> => new Map(Object.entries(entries));

describe('validateEntityOverrides', () => {
  it('reports REMOVED_FROM_API when the entity id is unknown upstream', () => {
    const results = validateEntityOverrides({ missing: { foo: 1 } }, apiMap({}));

    expect(results[0].status).toBe('REMOVED_FROM_API');
    expect(results[0].stillNeeded).toBe(false);
  });

  it('marks a field FIXED once upstream matches', () => {
    const results = validateEntityOverrides(
      { a: { name: 'Same' } },
      apiMap({ a: { name: 'Same' } })
    );

    expect(results[0].status).toBe('FIXED');
    expect(results[0].details[0].status).toBe('fixed');
  });

  it('keeps a field NEEDED while upstream disagrees', () => {
    const results = validateEntityOverrides(
      { a: { name: 'Correct' } },
      apiMap({ a: { name: 'Wrong' } })
    );

    expect(results[0].status).toBe('NEEDED');
    expect(results[0].details[0].status).toBe('needed');
  });

  it('compares only the keys the override specifies', () => {
    const results = validateEntityOverrides(
      { a: { nested: { patched: 1 } } },
      apiMap({ a: { nested: { patched: 1, untouched: 'other' } } })
    );

    expect(results[0].status).toBe('FIXED');
  });

  describe('identity fields', () => {
    it('does not treat a matching identity field as a correction', () => {
      const results = validateEntityOverrides(
        { a: { prestigeLevel: 1 } },
        apiMap({ a: { prestigeLevel: 1 } }),
        { identityFields: ['prestigeLevel'] }
      );

      expect(results[0].details).toHaveLength(0);
      expect(results[0].stillNeeded).toBe(false);
    });

    it('errors when an identity field disagrees with upstream', () => {
      const results = validateEntityOverrides(
        { a: { prestigeLevel: 2 } },
        apiMap({ a: { prestigeLevel: 1 } }),
        { identityFields: ['prestigeLevel'] }
      );

      expect(results[0].details[0].status).toBe('error');
      expect(results[0].stillNeeded).toBe(true);
    });

    it('errors when an identity field is absent upstream', () => {
      const results = validateEntityOverrides(
        { a: { prestigeLevel: 1 } },
        apiMap({ a: { name: 'present but no prestigeLevel' } }),
        { identityFields: ['prestigeLevel'] }
      );

      expect(results[0].details[0].status).toBe('error');
      expect(results[0].details[0].message).toContain('absent from API');
      expect(results[0].stillNeeded).toBe(true);
    });
  });

  describe('additive fields', () => {
    it('stays needed while the field is absent upstream', () => {
      const results = validateEntityOverrides({ a: { storyRequirements: [] } }, apiMap({ a: {} }), {
        additiveFields: ['storyRequirements'],
      });

      expect(results[0].details[0].status).toBe('needed');
      expect(results[0].details[0].message).toContain('absent from API');
    });

    it('flags for retirement once upstream ships the field', () => {
      const results = validateEntityOverrides(
        { a: { storyRequirements: [] } },
        apiMap({ a: { storyRequirements: [] } }),
        { additiveFields: ['storyRequirements'] }
      );

      expect(results[0].details[0].status).toBe('fixed');
      expect(results[0].details[0].message).toContain('NOW PRESENT IN API');
    });
  });

  describe('keyed fields', () => {
    it('treats overlay-only keys as synthetic additions rather than errors', () => {
      const results = validateEntityOverrides(
        { a: { conditions: { overlay_extra: { type: 'taskStatus' } } } },
        apiMap({ a: { conditions: [{ id: 'upstream_one' }] } }),
        { keyedFields: ['conditions'] }
      );

      expect(results[0].details[0].status).toBe('synthetic');
      expect(results[0].stillNeeded).toBe(true);
    });

    it('compares keys that do exist upstream', () => {
      const results = validateEntityOverrides(
        { a: { conditions: { up1: { value: 5 } } } },
        apiMap({ a: { conditions: [{ id: 'up1', value: 5 }] } }),
        { keyedFields: ['conditions'] }
      );

      expect(results[0].details[0].status).toBe('fixed');
    });
  });
});

describe('validateEntityAdditions', () => {
  it('stays needed while the entity is missing upstream', () => {
    const results = validateEntityAdditions({ new_thing: { id: 'new_thing' } }, apiMap({}));

    expect(results[0].stillNeeded).toBe(true);
  });

  it('resolves once upstream ships the entity under the same id', () => {
    const results = validateEntityAdditions(
      { new_thing: { id: 'new_thing' } },
      apiMap({ new_thing: {} })
    );

    expect(results[0].status).toBe('FIXED');
  });
});

describe('checkStoryChapterIntegrity', () => {
  const chapters = {
    tour: {
      id: 'tour',
      order: 1,
      chapterQuestId: 'q1',
      objectives: [{ id: 'o1', sourceQuestId: 'q2' }],
    },
  };

  it('skips quest resolution when no reference is available', () => {
    // Story quests are absent from tarkov.dev, so without the local reference
    // every reference would otherwise look broken.
    expect(checkStoryChapterIntegrity(chapters)).toHaveLength(0);
  });

  it('resolves quest ids against the supplied reference set', () => {
    expect(checkStoryChapterIntegrity(chapters, new Set(['q1', 'q2']))).toHaveLength(0);
  });

  it('reports unresolvable chapter and objective quest ids', () => {
    const issues = checkStoryChapterIntegrity(chapters, new Set(['unrelated']));
    const kinds = issues.map((i) => i.kind);

    expect(kinds).toContain('MISSING_CHAPTER_QUEST');
    expect(kinds).toContain('MISSING_SOURCE_QUEST');
  });

  it('detects a key/id mismatch', () => {
    const issues = checkStoryChapterIntegrity({ tour: { id: 'other' } });

    expect(issues[0].kind).toBe('ID_MISMATCH');
  });

  it('detects duplicate order values', () => {
    const issues = checkStoryChapterIntegrity({
      a: { id: 'a', order: 1 },
      b: { id: 'b', order: 1 },
    });

    expect(issues[0].kind).toBe('DUPLICATE_ORDER');
  });

  it('detects objective ids reused across chapters', () => {
    const issues = checkStoryChapterIntegrity({
      a: { id: 'a', objectives: [{ id: 'dup' }] },
      b: { id: 'b', objectives: [{ id: 'dup' }] },
    });

    expect(issues[0].kind).toBe('DUPLICATE_OBJECTIVE_ID');
  });

  it('detects requirements naming a chapter that does not exist', () => {
    const issues = checkStoryChapterIntegrity({
      a: { id: 'a', chapterRequirements: [{ storyChapter: 'ghost' }] },
    });

    expect(issues[0].kind).toBe('UNKNOWN_CHAPTER_REF');
  });
});

describe('checkTaskSuppressionStaleness', () => {
  const task = {
    id: 't1',
    name: 'Escort',
    minPlayerLevel: 1,
    objectives: [{ id: 'dup1' }, { id: 'dup2' }],
  } as unknown as TaskData;

  it('keeps a suppression whose objective still exists upstream', () => {
    const results = checkTaskSuppressionStaleness({ t1: { objectives: { dup1: true } } }, [task]);

    expect(results[0].stale).toBe(false);
  });

  it('flags a suppression whose objective is gone upstream', () => {
    const results = checkTaskSuppressionStaleness({ t1: { objectives: { vanished: true } } }, [
      task,
    ]);

    expect(results[0].stale).toBe(true);
  });

  it('flags a suppression for a task removed upstream', () => {
    const results = checkTaskSuppressionStaleness({ gone: { objectives: { x: true } } }, [task]);

    expect(results[0].stale).toBe(true);
  });

  it('marks a task-level suppression (no objectives) for manual review, not stale', () => {
    const results = checkTaskSuppressionStaleness({ t1: { experience: true } }, [task]);

    expect(results[0].stale).toBe(false);
    expect(results[0].objectiveId).toBeUndefined();
    expect(results[0].message).toContain('verify manually');
  });
});

describe('categorizeEntityResults', () => {
  it('groups results by status', () => {
    const results = validateEntityOverrides(
      { a: { name: 'Wrong' }, b: { name: 'Same' }, c: { name: 'x' } },
      apiMap({ a: { name: 'Other' }, b: { name: 'Same' } })
    );

    const grouped = categorizeEntityResults(results);

    expect(grouped.stillNeeded).toHaveLength(1);
    expect(grouped.fixed).toHaveLength(1);
    expect(grouped.removedFromApi).toHaveLength(1);
  });
});
