/**
 * Tests for the story-chapter data generated from the local quest reference.
 *
 * Guards the invariants of the extraction/merge pipeline (scripts/eft-story-*):
 * chapter -> source quest traceability, objective id/source integrity (every
 * chapter, including The Ticket, must use real 24-hex client ids), the required
 * Boreas chapter (issue #233), real ending ids, and that no chapter unlocks a
 * task the overlay disables.
 */

import { describe, expect, it } from 'vitest';
import { join } from 'path';
import { getProjectPaths, loadAllJson5FromDir, type StoryChapter } from '../src/lib/index.js';

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
        expect(
          seen.has(obj.id),
          `duplicate objective id ${obj.id} (${seen.get(obj.id)} & ${cid})`
        ).toBe(false);
        seen.set(obj.id, cid);
        expect(['main', 'optional']).toContain(obj.type);
        // Every chapter is generated straight from the quest reference, where the
        // objective id IS the stable source objective id (24-hex) plus a
        // sourceQuestId linking it to its sub-quest. No chapter is exempt: a
        // fabricated id cannot be aligned to game data by a consumer, so The
        // Ticket's former `the-ticket-main-n` ids are not allowed back in.
        expect(obj.id, `${cid} objective id`).toMatch(/^[0-9a-f]{24}$/);
        expect(obj.sourceQuestId, `${cid}/${obj.id} sourceQuestId`).toMatch(/^[0-9a-f]{24}$/);
      }
    }
  });

  it('ties The Ticket endings to real client ending ids', () => {
    // The four endings come from `client/ending_list`; each is gated by one of
    // The Ticket's sub-quests, so objectives of a gate sub-quest carry that
    // ending's real id. Slugs (savior/fallen/survivor/debtor) are gone - they
    // could not be aligned to anything a consumer stores.
    const REAL_ENDING_IDS = new Set([
      '68a6e8f1a7455e5e23099ad8', // EscapedFromTarkovForHumanity
      '68a6e8c834a37e244710d516', // EscapedFromTarkovAndSurvived
      '68a6e8e4a8d0bee0b5324d96', // EscapedFromTarkovToFallInTheDarkness
      '68a6028ef4c23ebbbc49da4b', // YouDidntEscapeFromYourself
    ]);
    const ticket = chapters['the-ticket'];
    expect(ticket).toBeDefined();
    const tagged = (ticket.objectives ?? []).filter((o) => o.endingId);
    expect(tagged.length).toBeGreaterThan(0);
    for (const objective of tagged) {
      expect(REAL_ENDING_IDS, `${objective.id} endingId`).toContain(objective.endingId);
    }
  });

  it('never points a chapter unlock at a task the overlay disables', () => {
    // A story chapter claiming to unlock a retired quest is dead information;
    // the pre-1.1 Lightkeeper access chain was removed this way.
    const { srcDir } = getProjectPaths();
    const overrides = loadAllJson5FromDir(join(srcDir, 'overrides'), false);
    const baseTasks = (overrides.tasks ?? {}) as Record<string, { disabled?: boolean }>;
    const disabled = new Set(
      Object.entries(baseTasks)
        .filter(([, task]) => task?.disabled === true)
        .map(([id]) => id)
    );
    expect(disabled.size).toBeGreaterThan(0);
    for (const [cid, ch] of Object.entries(chapters)) {
      for (const unlock of ch.questUnlocks ?? []) {
        expect(disabled.has(unlock.id), `${cid} unlocks disabled task ${unlock.id}`).toBe(false);
      }
    }
  });
});
