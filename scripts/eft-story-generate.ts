#!/usr/bin/env tsx
/**
 * Generate story-chapter data from the local quest reference, applying
 * wiki-verified optional/required flags.
 *
 * Sources (by authority):
 * - Local quest reference (auto-selected from eft/; see loadReference): objective
 *   existence, text, order, and stable ids. A chapter is a named storyline quest
 *   on the narrator trader (67f7af56c117b6140af2a607); its objective conditions
 *   are ordered sub-quest refs whose own conditions carry the text. The objective
 *   condition id is used as the stable objective id so consumers that persist
 *   completion per id are not broken by wording/order changes on regeneration.
 * - EFT wiki (data/eft/story-wiki-objectives.json via scripts/eft-story-wiki.ts):
 *   the player-facing optional/required distinction, matched by fuzzy text.
 * - Curated (scripts/story-chapter-meta.json): chapter id/name/order/wikiLink/
 *   activation/requirements the reference lacks. Objectives are NOT curated -
 *   every chapter is derived from the reference so that no objective ships a
 *   fabricated id.
 *
 * Emits final storyChapters JSON to stdout. Deterministic given the inputs.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { isDirectExecution } from '../src/lib/index.js';
import { sequenceRatio } from './lib/sequence-matcher.js';

const META = 'scripts/story-chapter-meta.json';
const WIKI = 'data/eft/story-wiki-objectives.json';
export const NARRATOR_TRADER = '67f7af56c117b6140af2a607';
const ID_RE = /[0-9a-fA-F]{24}/;
const MATCH_THRESHOLD = 0.6;
const MIN_MATCH_PCT = 75; // fail generation if a chapter's wiki match drops below this

const CHAPTER_QUEST_ID: Record<string, string> = {
  tour: '68cbd33676fe74b1e80bfd91',
  'falling-skies': '68cbcdc4c964ab83cc0c928e',
  batya: '68da36cf7cff54fc6109874a',
  'the-unheard': '6900927ab7d28358f80b9421',
  'blue-fire': '68e784b7fa3f1fa3770094ba',
  'they-are-already-here': '6903d779fdfc4078740a4bd0',
  'accidental-witness': '69052e18e680c2d3e3034d3a',
  'the-labyrinth': '68e3a35002661eb2d30ce387',
  'the-ticket': '68da33fe00868edcb6025ac4',
  boreas: '69d38381cea4b428690ea1d9',
};
/**
 * Every chapter's objectives are derived from the reference, so every objective
 * id in the output is a real client condition id.
 *
 * The Ticket used to be exempt (its objectives were kept verbatim from
 * `story-chapter-meta.json`) so that hand-written branching notes could be
 * preserved. That cost 44 fabricated ids of the form `the-ticket-main-1`, which
 * a consumer cannot align to anything in its database - the exact failure the
 * "use the real source objective id" rule below exists to prevent. The
 * fabricated ids also anchored `mutuallyExclusiveWith` and `endingId`, so the
 * branching data was self-referential rather than tied to game data.
 *
 * Re-deriving The Ticket from the reference yields real ids for the sub-quests
 * the capture resolves. Note this is a deliberate trade: the client only returns
 * a story sub-quest template once the player has reached it, so a chapter's
 * coverage is bounded by how far the captured character progressed (The Ticket
 * resolves 35 of its 88 sub-quest references). Real ids for what we can see beat
 * invented ids for a hand-written summary.
 */
const PRESERVE_OBJECTIVES = new Set<string>();

/**
 * Real ending ids, keyed by the sub-quest that gates each ending.
 *
 * Source: `client/ending_list` in the local captures, which returns exactly four
 * endings, each with a `systemName` and a single `Quest` condition naming its
 * gate sub-quest. All four gate quests are sub-quests of The Ticket, so an
 * objective belonging to one of them can be tagged with its ending.
 *
 * Only the gate quests the reference actually resolves can be tagged; the others
 * contribute no objectives, so they are simply absent rather than guessed.
 */
const ENDING_BY_GATE_QUEST: Record<string, { id: string; systemName: string }> = {
  '67bdf8c066ca1d79a202463a': {
    id: '68a6e8f1a7455e5e23099ad8',
    systemName: 'EscapedFromTarkovForHumanity',
  },
  '67c08f0268e50a07b10d25a6': {
    id: '68a6e8c834a37e244710d516',
    systemName: 'EscapedFromTarkovAndSurvived',
  },
  '67c862bd9f9b7ef9090651d8': {
    id: '68a6e8e4a8d0bee0b5324d96',
    systemName: 'EscapedFromTarkovToFallInTheDarkness',
  },
  '67c9877aff0329206209cb67': {
    id: '68a6028ef4c23ebbbc49da4b',
    systemName: 'YouDidntEscapeFromYourself',
  },
};

interface WikiObjective {
  text: string;
  optional: boolean;
}

type JsonRecord = Record<string, any>;

/** Extract a bare 24-hex id from a value that may be wrapped as `[id] Name`. */
export function bareId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = ID_RE.exec(value);
  return match ? match[0] : null;
}

/** Normalize objective text for fuzzy matching: collapse numbers, keep letters. */
export function normalizeStoryText(text: string): string {
  let out = text.toLowerCase();
  out = out.replace(/\b\d[\d,]*\b/g, '#'); // collapse numbers
  out = out.replace(/[^a-z# ]/g, ' ');
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * Return {optional, ratio} for the closest wiki match.
 *
 * When the best match is below MATCH_THRESHOLD the objective is treated as
 * required, returning {optional: false, ratio} so the caller can log match
 * quality.
 */
export function matchOptional(
  text: string,
  wikiObjectives: WikiObjective[]
): { optional: boolean; ratio: number } {
  const normalized = normalizeStoryText(text);
  let bestRatio = 0.0;
  let best: WikiObjective | undefined;
  for (const wiki of wikiObjectives) {
    const ratio = sequenceRatio(normalized, normalizeStoryText(wiki.text));
    if (ratio > bestRatio) {
      bestRatio = ratio;
      best = wiki;
    }
  }
  if (best && bestRatio >= MATCH_THRESHOLD) {
    return { optional: Boolean(best.optional), ratio: bestRatio };
  }
  return { optional: false, ratio: bestRatio };
}

/**
 * Pick and load the quest reference to generate from.
 *
 * Story chapters are not served like ordinary quests: the client returns a
 * chapter's sub-quest templates only once the player has reached them, so the
 * *newest* capture is not automatically the most useful one here - a fresh
 * capture from an early character resolves far fewer sub-quests than an older
 * capture from an advanced one. Selecting by "newest" (what `findReferenceFile`
 * does for the numeric `eft:*` tools) would silently shrink the storyline.
 *
 * Candidates are therefore scored by how much of the storyline each can actually
 * resolve: chapter quests present first, then objective conditions that carry
 * `localization.en` text. Set `STORY_REFERENCE` to pin one explicitly.
 */
function loadReference(): JsonRecord[] {
  const explicit = process.env.STORY_REFERENCE;
  const candidates = explicit ? [explicit] : storyReferenceCandidates();
  let best: { file: string; quests: JsonRecord[]; chapters: number; texts: number } | null = null;

  for (const file of candidates) {
    let quests: JsonRecord[];
    try {
      quests = readReferenceFile(file);
    } catch {
      continue;
    }
    const byId = new Map<string, JsonRecord>();
    for (const quest of quests) {
      const id = bareId(quest._id);
      if (id) byId.set(id, quest);
    }
    let chapters = 0;
    let texts = 0;
    for (const chapterQuestId of Object.values(CHAPTER_QUEST_ID)) {
      const chapterQuest = byId.get(chapterQuestId) as any;
      if (!chapterQuest) continue;
      chapters += 1;
      for (const condition of chapterQuest?.conditions?.AvailableForFinish ?? []) {
        if (condition?.conditionType !== 'Quest') continue;
        let target = condition.target;
        if (Array.isArray(target)) target = target.length > 0 ? target[0] : undefined;
        const sub = byId.get(bareId(target) ?? '') as any;
        if (!sub) continue;
        const en: Record<string, string> = sub?.localization?.en ?? {};
        for (const objective of sub?.conditions?.AvailableForFinish ?? []) {
          if (objective?.id && (en[objective.id] ?? '').trim()) texts += 1;
        }
      }
    }
    if (!best || chapters > best.chapters || (chapters === best.chapters && texts > best.texts)) {
      best = { file, quests, chapters, texts };
    }
  }

  if (!best || best.chapters === 0) {
    throw new Error(
      `No usable story reference found (checked: ${candidates.join(', ') || 'nothing'}). ` +
        'Place a quest capture under eft/, or set STORY_REFERENCE to one.'
    );
  }
  console.error(
    `story reference: ${best.file} ` +
      `(${best.chapters}/${Object.keys(CHAPTER_QUEST_ID).length} chapter quests, ${best.texts} objective texts)`
  );
  return best.quests;
}

/** Quest-capture files under eft/, enriched variants first. */
function storyReferenceCandidates(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(dir, name);
      let stats;
      try {
        stats = statSync(full);
      } catch {
        continue;
      }
      if (stats.isDirectory()) walk(full);
      else if (stats.isFile() && /quest[_-]list/i.test(name) && name.endsWith('.json'))
        found.push(full);
    }
  };
  walk('eft');
  // Enriched captures carry the localization.en block that supplies objective
  // text, so prefer them; otherwise keep discovery order for determinism.
  return found.sort(
    (a, b) =>
      (a.includes('rollinglatest.modified') ? 0 : 1) -
      (b.includes('rollinglatest.modified') ? 0 : 1)
  );
}

/**
 * Unwrap a capture envelope to the quest array, tolerating the older
 * `decoded_response`, the newer `body_response`, an already-unwrapped
 * `{data: [...]}`, or a bare array.
 */
function readReferenceFile(file: string): JsonRecord[] {
  const raw = JSON.parse(readFileSync(file, 'utf-8'));
  const node = raw?.response ?? raw;
  const decoded = node?.decoded_response ?? node?.body_response ?? node;
  const data = decoded?.data ?? decoded;
  if (!Array.isArray(data)) throw new Error(`unexpected quest reference shape in ${file}`);
  return data as JsonRecord[];
}

function main(): void {
  const quests = loadReference();
  const byId = new Map<string, JsonRecord>();
  for (const quest of quests) {
    const id = bareId(quest._id);
    if (id) byId.set(id, quest);
  }

  const curated: Record<string, JsonRecord> = JSON.parse(readFileSync(META, 'utf-8'));
  const wiki: Record<string, WikiObjective[]> = existsSync(WIKI)
    ? JSON.parse(readFileSync(WIKI, 'utf-8'))
    : {};
  if (Object.keys(wiki).length === 0) {
    console.error(
      'warning: data/eft/story-wiki-objectives.json missing; run scripts/eft-story-wiki.ts ' +
        "first (all objectives will be 'main')"
    );
  }

  const en = (quest: JsonRecord): Record<string, string> => quest?.localization?.en ?? {};

  const stats: Record<
    string,
    { objectives: number; matched: number; optional: number; wiki: number }
  > = {};

  const expand = (chapterId: string): JsonRecord[] => {
    const chapterQuest = byId.get(CHAPTER_QUEST_ID[chapterId]);
    if (!chapterQuest) {
      stats[chapterId] = { objectives: 0, matched: 0, optional: 0, wiki: 0 };
      return [];
    }
    const wikiObjectives = wiki[chapterId] ?? [];
    const objectives: JsonRecord[] = [];
    let optionalCount = 0;
    let matched = 0;

    for (const condition of chapterQuest?.conditions?.AvailableForFinish ?? []) {
      if (condition?.conditionType !== 'Quest') continue;
      let target = condition.target;
      if (Array.isArray(target)) target = target.length > 0 ? target[0] : undefined;
      const subQuest = byId.get(bareId(target) ?? '');
      if (!subQuest) continue;
      const subId = bareId(subQuest._id);
      const subEn = en(subQuest);
      for (const objective of subQuest?.conditions?.AvailableForFinish ?? []) {
        const objectiveId = objective?.id;
        if (!objectiveId) continue; // skip conditions without an id
        const text = (subEn[objectiveId] ?? '').trim();
        if (!text) continue;
        const { optional, ratio } = matchOptional(text, wikiObjectives);
        if (ratio >= MATCH_THRESHOLD) matched += 1;
        if (optional) optionalCount += 1;
        // Use the real source objective id as the stable id. Positional ids
        // ({chapter}-main-n) shift whenever wording/order changes, which
        // silently corrupts consumers that persist completion per objective
        // id. The source id is unique and stable across regens.
        const emitted: JsonRecord = {
          id: objectiveId,
          type: optional ? 'optional' : 'main',
          description: text,
          sourceQuestId: subId,
        };
        // Objectives belonging to an ending's gate sub-quest carry that ending's
        // real id, so consumers can attribute a branch without a slug lookup.
        const ending = subId ? ENDING_BY_GATE_QUEST[subId] : undefined;
        if (ending) emitted.endingId = ending.id;
        objectives.push(emitted);
      }
    }

    stats[chapterId] = {
      objectives: objectives.length,
      matched,
      optional: optionalCount,
      wiki: wikiObjectives.length,
    };
    return objectives;
  };

  const out: Record<string, JsonRecord> = {};
  const chapterIds = Object.keys(curated).sort((a, b) => curated[a].order - curated[b].order);
  for (const chapterId of chapterIds) {
    const meta = curated[chapterId];
    const chapter: JsonRecord = {
      id: meta.id,
      name: meta.name,
      normalizedName: meta.normalizedName,
      wikiLink: meta.wikiLink,
      order: meta.order,
      chapterQuestId: CHAPTER_QUEST_ID[chapterId],
      autoStart: meta.autoStart ?? false,
      chapterRequirements: meta.chapterRequirements ?? [],
    };
    if (meta.activation) {
      chapter.activation = meta.activation;
    }
    chapter.description = meta.description ?? null;
    chapter.notes = meta.notes ?? null;
    if (PRESERVE_OBJECTIVES.has(chapterId) && meta.objectives) {
      chapter.objectives = meta.objectives;
    } else {
      chapter.objectives = expand(chapterId);
    }
    chapter.rewards = meta.rewards ?? null;
    chapter.mapUnlocks = meta.mapUnlocks ?? [];
    chapter.traderUnlocks = meta.traderUnlocks ?? [];
    if (meta.questUnlocks) {
      chapter.questUnlocks = meta.questUnlocks;
    }
    out[chapterId] = chapter;
  }

  console.error('chapter match stats (eft objs / wiki-matched / optional):');
  const low: Array<[string, number]> = [];
  for (const [chapterId, s] of Object.entries(stats)) {
    const pct = Math.floor((100 * s.matched) / Math.max(s.objectives, 1));
    console.error(
      `  ${chapterId.padEnd(22)} objs=${String(s.objectives).padStart(3)} ` +
        `matched=${String(pct).padStart(3)}% optional=${String(s.optional).padStart(2)} ` +
        `wiki=${s.wiki}`
    );
    // A chapter that no longer matches the wiki means wording drift has
    // degraded optional/required accuracy; fail generation so it is caught
    // now rather than shipped silently. Zero resolvable objectives (e.g. a
    // broken CHAPTER_QUEST_ID mapping) is an even harder failure. Current
    // expanded chapters match >=86%. (The Ticket is preserved, not in stats.)
    if (s.objectives === 0 || pct < MIN_MATCH_PCT) {
      low.push([chapterId, pct]);
    }
  }

  if (low.length > 0) {
    const detail = low.map(([chapterId, pct]) => `${chapterId} (${pct}%)`).join(', ');
    console.error(`error: wiki match below ${MIN_MATCH_PCT}% for: ${detail}`);
    process.exit(1);
  }

  process.stdout.write(JSON.stringify(out, null, 2));
}

if (isDirectExecution(import.meta.url)) {
  main();
}
