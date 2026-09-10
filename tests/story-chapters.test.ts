/**
 * Tests for the story-chapter data generated from the local quest reference.
 *
 * Guards the invariants of the extraction/merge pipeline (scripts/eft-story-*):
 * chapter -> source quest traceability, objective id/source integrity (every
 * chapter, including The Ticket, must use real 24-hex client ids), the required
 * Boreas chapter (issue #233), the four real endings and their coverage, the
 * pinned source capture, and that no chapter unlocks a task the overlay
 * disables.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import JSON5 from 'json5';
import {
  getProjectPaths,
  loadAllJson5FromDir,
  STORY_ENDINGS,
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
    // Slugs (savior/fallen/survivor/debtor) are gone - they could not be aligned
    // to anything a consumer stores.
    const REAL_ENDING_IDS = new Set(STORY_ENDINGS.map((ending) => ending.id));
    const ticket = chapters['the-ticket'];
    expect(ticket).toBeDefined();
    const tagged = (ticket.objectives ?? []).filter((o) => o.endingId);
    expect(tagged.length).toBeGreaterThan(0);
    for (const objective of tagged) {
      expect(REAL_ENDING_IDS, `${objective.id} endingId`).toContain(objective.endingId);
    }
  });

  it('models every client ending on The Ticket, with real ids and honest coverage', () => {
    // The four endings come from `client/ending_list`; each is gated by one of
    // The Ticket's sub-quests. The whole branch set is restated at chapter level
    // so the chapter cannot claim four endings in prose while modelling one, and
    // an ending the capture could not resolve reports 0 objectives instead of
    // vanishing (which is how three of them were silently dropped before).
    const ticket = chapters['the-ticket'];
    expect(ticket).toBeDefined();
    const endings = ticket.endings ?? [];
    expect(endings.length).toBe(STORY_ENDINGS.length);
    for (const ending of STORY_ENDINGS) {
      const modelled = endings.find((candidate) => candidate.id === ending.id);
      expect(modelled, `ending ${ending.systemName} missing`).toBeDefined();
      expect(modelled!.systemName).toBe(ending.systemName);
      expect(modelled!.gateQuestId).toBe(ending.gateQuestId);
      // Objectives can only be attributed when the gate sub-quest resolved, and
      // a resolved gate that contributes objectives must report them.
      expect(modelled!.resolvedInReference).toBe(modelled!.objectiveCount > 0);
    }
    // Exactly one branch has objective-level evidence in the pinned capture; if a
    // future capture resolves more gates this must be revisited deliberately
    // rather than drift.
    expect(endings.filter((ending) => ending.objectiveCount > 0).length).toBe(1);
    expect(endings.find((ending) => ending.objectiveCount > 0)?.systemName).toBe(
      'EscapedFromTarkovForHumanity'
    );
  });

  it('ties every tagged objective to an ending its chapter declares', () => {
    for (const [cid, ch] of Object.entries(chapters)) {
      const declared = new Map((ch.endings ?? []).map((ending) => [ending.id, ending]));
      const tallies = new Map<string, number>();
      for (const objective of ch.objectives ?? []) {
        if (!objective.endingId) continue;
        const ending = declared.get(objective.endingId);
        expect(ending, `${cid}/${objective.id} endingId not declared by chapter`).toBeDefined();
        // The objective must belong to that ending's gate sub-quest - the only
        // evidence that links the two.
        expect(objective.sourceQuestId, `${cid}/${objective.id} sourceQuestId`).toBe(
          ending!.gateQuestId
        );
        tallies.set(objective.endingId, (tallies.get(objective.endingId) ?? 0) + 1);
      }
      for (const ending of ch.endings ?? []) {
        expect(ending.objectiveCount, `${cid} ${ending.systemName} objectiveCount`).toBe(
          tallies.get(ending.id) ?? 0
        );
      }
    }
  });

  it('reports reference coverage on every chapter', () => {
    // Coverage is the guard against reading a chapter as complete: the client
    // only returns a story sub-quest template once the player has reached it.
    for (const [cid, ch] of Object.entries(chapters)) {
      const coverage = ch.referenceCoverage;
      expect(coverage, `${cid} referenceCoverage`).toBeDefined();
      expect(coverage!.referencedSubquests).toBeGreaterThan(0);
      expect(coverage!.resolvedSubquests).toBeGreaterThan(0);
      expect(coverage!.resolvedSubquests).toBeLessThanOrEqual(coverage!.referencedSubquests);
      expect(coverage!.partial).toBe(coverage!.resolvedSubquests < coverage!.referencedSubquests);
      const sources = new Set((ch.objectives ?? []).map((objective) => objective.sourceQuestId));
      expect(sources.size, `${cid} distinct sourceQuestIds`).toBeLessThanOrEqual(
        coverage!.resolvedSubquests
      );
    }
    // The Ticket's coverage is partial today (35 of 88 sub-quests); asserting it
    // keeps the fact machine-checked rather than prose.
    expect(chapters['the-ticket'].referenceCoverage?.partial).toBe(true);
  });

  it('keeps the schema ending enums in sync with STORY_ENDINGS', () => {
    // The schema hardcodes the ending ids on purpose (it is what stops slugs
    // coming back), which only stays correct while it matches the exported
    // registry consumers compile against.
    const { schemasDir } = getProjectPaths();
    const schema = JSON5.parse(
      readFileSync(join(schemasDir, 'story-chapter.schema.json'), 'utf8')
    ) as any;
    const chapterSchema = schema.additionalProperties.properties;
    const expected = STORY_ENDINGS.map((ending) => ending.id);
    expect(chapterSchema.endings.items.properties.id.enum.slice().sort()).toEqual(
      expected.slice().sort()
    );
    expect(chapterSchema.objectives.items.properties.endingId.enum.slice().sort()).toEqual(
      expected.slice().sort()
    );
  });

  it('keeps the objective the prestige overrides depend on', () => {
    // src/overrides/modes/*/prestige.json5 point storyObjectiveStatus at this
    // real objective id; regeneration must not drop or renumber it.
    const ticket = chapters['the-ticket'];
    const anchor = (ticket.objectives ?? []).find((o) => o.id === '68e2ecfeb88d405a420774f8');
    expect(anchor, 'prestige anchor objective missing').toBeDefined();
    expect(anchor!.description).toBe('Obtain the "Ticket"');
  });

  it('pins the source capture that produced the committed chapters', () => {
    // Generation is local-only (eft/ is gitignored), so the lock is the only
    // thing that makes the committed output auditable: it records which capture
    // was used, not any of its field values.
    const lock = JSON.parse(readFileSync(join('scripts', 'story-reference.lock.json'), 'utf8')) as {
      file: string;
      sha256: string;
      bytes: number;
      clientVersion: string | null;
      gameMode: string | null;
      capturedAt: string | null;
      quests: number;
      chapterQuests: number;
      objectiveTexts: number;
    };
    expect(lock.file).toMatch(/^eft\/.+\.json$/);
    expect(lock.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(lock.bytes).toBeGreaterThan(0);
    expect(lock.quests).toBeGreaterThan(0);
    // Provenance a reviewer needs to judge the source: which client build, which
    // mode, and when. A lock that cannot answer those is not auditable.
    expect(lock.clientVersion, 'lock clientVersion').toMatch(/\d+\.\d+\.\d+/);
    expect(['regular', 'pve', 'pvp-season']).toContain(lock.gameMode);
    expect(Number.isNaN(Date.parse(lock.capturedAt ?? '')), 'lock capturedAt').toBe(false);
    expect(lock.chapterQuests).toBe(Object.keys(chapters).length);
    // Every objective in the committed data came from that capture's texts.
    const objectives = Object.values(chapters).reduce(
      (total, ch) => total + (ch.objectives ?? []).length,
      0
    );
    expect(lock.objectiveTexts).toBe(objectives);
    // Sub-quest coverage has to add up to the capture too, so a hand-edited lock
    // or hand-edited chapters disagree.
    const resolved = Object.values(chapters).reduce(
      (total, ch) => total + (ch.referenceCoverage?.resolvedSubquests ?? 0),
      0
    );
    expect(resolved).toBeLessThanOrEqual(lock.quests);
  });

  it('keeps canonical chapter-local quest completion exclusions', () => {
    let count = 0;
    for (const [cid, chapter] of Object.entries(chapters)) {
      const sources = new Set(chapter.objectives?.map((objective) => objective.sourceQuestId));
      const pairs = chapter.mutuallyExclusiveQuestPairs ?? [];
      const seen = new Set<string>();
      for (const [left, right] of pairs) {
        expect(left, cid).toMatch(/^[0-9a-f]{24}$/);
        expect(right, cid).toMatch(/^[0-9a-f]{24}$/);
        expect(left < right, `${cid}: pair must be sorted and distinct`).toBe(true);
        expect(sources, cid).toContain(left);
        expect(sources, cid).toContain(right);
        expect(seen.has(`${left}:${right}`), `${cid}: duplicate pair`).toBe(false);
        seen.add(`${left}:${right}`);
        count += 1;
      }
    }
    expect(count).toBeGreaterThan(0);
    expect(chapters['the-ticket'].mutuallyExclusiveQuestPairs).toContainEqual([
      '67bc9d70adb794ecb40f5755',
      '67bc9e3e7801bf5c41017b82',
    ]);
  });

  it('allows retrieving the armored case before choosing to keep it', () => {
    const chapter = chapters['falling-skies'];
    const retrieve = chapter.objectives?.find((o) => o.id === '679cdee4ce3a208fee0ad65a');
    const keep = chapter.objectives?.find((o) => o.id === '690177dcaaed5ef80cdcd1ef');
    expect(retrieve?.description).toBe('Retrieve the armored case');
    expect(keep?.description).toBe('Keep the armored case for yourself');
    expect(chapter.mutuallyExclusiveQuestPairs).toContainEqual([
      '679cdee4ce3a208fee0ad657',
      '68cd7d6d9510d63fdb05a76a',
    ]);
    expect(retrieve?.mutuallyExclusiveWith ?? []).not.toContain(keep!.id);
    expect(keep?.mutuallyExclusiveWith ?? []).not.toContain(retrieve!.id);
    // No quest-completion exclusion is promoted into an objective constraint.
    for (const chapter of Object.values(chapters)) {
      for (const objective of chapter.objectives ?? []) {
        expect(objective.mutuallyExclusiveWith).toBeUndefined();
      }
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
