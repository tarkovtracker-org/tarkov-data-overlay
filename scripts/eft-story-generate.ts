#!/usr/bin/env tsx
/**
 * Generate story-chapter data from the local quest reference, applying
 * wiki-verified optional/required flags.
 *
 * Sources (by authority):
 * - Local quest reference (eft/quest-list.json): objective existence, text,
 *   order, and stable ids. A chapter is a named storyline quest on the narrator
 *   trader (67f7af56c117b6140af2a607); its objective conditions are ordered
 *   sub-quest refs whose own conditions carry the text. The objective condition
 *   id is used as the stable objective id so consumers that persist completion
 *   per id are not broken by wording/order changes on regeneration.
 * - EFT wiki (data/eft/story-wiki-objectives.json via scripts/eft-story-wiki.ts):
 *   the player-facing optional/required distinction, matched by fuzzy text.
 * - Curated (scripts/story-chapter-meta.json): chapter id/name/order/wikiLink/
 *   activation/requirements the reference lacks, plus The Ticket's branching
 *   objectives (endings + mutual exclusion), preserved verbatim.
 *
 * Emits final storyChapters JSON to stdout. Deterministic given the inputs.
 */

import { existsSync, readFileSync } from 'fs';
import { isDirectExecution } from '../src/lib/index.js';
import { sequenceRatio } from './lib/sequence-matcher.js';

const REF = 'eft/quest-list.json';
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
const PRESERVE_OBJECTIVES = new Set(['the-ticket']); // keep curated branching/endings verbatim

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
 * Load the quest list from the local reference file.
 *
 * The reference is wrapped in a nested envelope; unwrap to the quest array,
 * tolerating either the enveloped shape or an already-unwrapped `{data: [...]}`.
 */
function loadReference(): JsonRecord[] {
  const raw = JSON.parse(readFileSync(REF, 'utf-8'));
  const node = raw?.response ?? raw;
  const decoded = node?.decoded_response ?? node;
  return decoded?.data ?? decoded;
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
        objectives.push({
          id: objectiveId,
          type: optional ? 'optional' : 'main',
          description: text,
          sourceQuestId: subId,
        });
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
