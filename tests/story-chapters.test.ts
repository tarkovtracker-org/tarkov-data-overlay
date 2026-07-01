/**
 * Tests for the story-chapter data generated from the local quest reference.
 *
 * Guards the invariants of the extraction/merge pipeline (scripts/eft-story-*):
 * chapter -> source quest traceability, objective id/source integrity, the
 * required Boreas chapter (issue #233), and the preserved branching for The Ticket.
 */

import { describe, expect, it } from 'vitest';
import { join } from 'path';
import {
  getProjectPaths,
  loadAllJson5FromDir,
  type StoryChapter,
} from '../src/lib/index.js';

function loadStoryChapters(): Record<string, StoryChapter> {
  const { srcDir } = getProjectPaths();
  const additions = loadAllJson5FromDir(join(srcDir, 'additions'), false);
  return (additions.storyChapters ?? {}) as Record<string, StoryChapter>;
}

describe('story chapters (EFT-sourced)', () => {
  const chapters = loadStoryChapters();

  it('includes the Boreas chapter with real objectives (issue #233)', () => {
    const boreas = chapters.boreas;
    expect(boreas).toBeDefined();
    expect(boreas.chapterQuestId).toBe('69d38381cea4b428690ea1d9');
    expect((boreas.objectives ?? []).length).toBeGreaterThan(20);
    // The AMG-10 hand-in that Oil Change (#233) depends on is part of this chapter.
    const texts = (boreas.objectives ?? []).map((o) => o.description.toLowerCase());
    expect(texts.some((t) => t.includes('amg-10'))).toBe(true);
  });

  it('maps every chapter to its source story quest id', () => {
    const entries = Object.values(chapters);
    expect(entries.length).toBeGreaterThanOrEqual(10);
    for (const ch of entries) {
      expect(ch.chapterQuestId, `${ch.id} chapterQuestId`).toMatch(/^[0-9a-f]{24}$/);
    }
  });

  it('keeps EFT-sourced objectives traceable and globally uniquely keyed', () => {
    const seen = new Map<string, string>();
    for (const [cid, ch] of Object.entries(chapters)) {
      for (const obj of ch.objectives ?? []) {
        expect(seen.has(obj.id), `duplicate objective id ${obj.id} (${seen.get(obj.id)} & ${cid})`).toBe(
          false
        );
        seen.set(obj.id, cid);
        expect(['main', 'optional']).toContain(obj.type);
        // The Ticket keeps curated branching objectives (no source ids); every
        // other chapter is generated straight from the quest reference, where the
        // objective id IS the stable source objective id (24-hex) plus a
        // sourceQuestId linking it to its sub-quest.
        if (cid !== 'the-ticket') {
          expect(obj.id, `${cid} objective id`).toMatch(/^[0-9a-f]{24}$/);
          expect(obj.sourceQuestId, `${cid}/${obj.id} sourceQuestId`).toMatch(/^[0-9a-f]{24}$/);
        }
      }
    }
  });

  it('preserves The Ticket branching (endings + mutual exclusion)', () => {
    const ticket = chapters['the-ticket'];
    expect(ticket).toBeDefined();
    const objs = ticket.objectives ?? [];
    expect(objs.some((o) => o.endingId)).toBe(true);
    expect(objs.some((o) => (o.mutuallyExclusiveWith?.length ?? 0) > 0)).toBe(true);
  });
});
