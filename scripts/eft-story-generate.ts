#!/usr/bin/env tsx
/**
 * Generate story-chapter data from the local quest reference, applying
 * wiki-verified optional/required flags.
 *
 * Sources (by authority):
 * - Local quest reference (pinned by scripts/story-reference.lock.json; see
 *   loadReference): objective existence, text, order, and stable ids. A chapter
 *   is a named storyline quest on the narrator trader
 *   (67f7af56c117b6140af2a607); its objective conditions are ordered sub-quest
 *   refs whose own conditions carry the text. The objective condition id is used
 *   as the stable objective id so consumers that persist completion per id are
 *   not broken by wording/order changes on regeneration.
 * - EFT wiki (data/eft/story-wiki-objectives.json via scripts/eft-story-wiki.ts):
 *   the player-facing optional/required distinction, matched by fuzzy text.
 * - Curated (scripts/story-chapter-meta.json): chapter id/name/order/wikiLink/
 *   activation/requirements the reference lacks. Objectives are NOT curated -
 *   every chapter is derived from the reference so that no objective ships a
 *   fabricated id.
 *
 * Generation is local-only: the capture lives under the gitignored eft/, so CI
 * and contributors without it cannot regenerate. What makes the committed output
 * auditable anyway is the lock file, which pins the exact capture by SHA-256
 * (plus client version, mode, capture time and resolution counts). A different
 * capture cannot silently take over: it either fails the hash check or shows up
 * as a lock diff in the same commit.
 *
 * Emits final storyChapters JSON to stdout. Deterministic given the inputs.
 */

import { createHash } from 'crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { dirname, join } from 'path';
import Ajv from 'ajv';
import { isDirectExecution, STORY_ENDINGS } from '../src/lib/index.js';
import { modeFromRequestUrl } from './eft-compare.js';
import { sequenceRatio } from './lib/sequence-matcher.js';

const META = 'scripts/story-chapter-meta.json';
const WIKI = 'data/eft/story-wiki-objectives.json';
const LOCK = 'scripts/story-reference.lock.json';
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
 * "use the real source objective id" rule exists to prevent. The fabricated ids
 * also anchored `mutuallyExclusiveWith` and `endingId`, so the branching data
 * was self-referential rather than tied to game data.
 *
 * Deriving The Ticket from the reference instead loses nothing real, but it does
 * change what the branch model can claim, so the branch structure is emitted
 * from game data too:
 * - `endings` restates all four `client/ending_list` endings at chapter level
 *   with their real ids and gate sub-quests, each carrying how many objectives
 *   the capture attributes to it.
 * - `referenceCoverage` reports referenced vs resolved sub-quests, because the
 *   client only returns a story sub-quest template once the player has reached
 *   it (The Ticket resolves 35 of its 88 sub-quest references).
 * - `mutuallyExclusiveQuestPairs` is derived from the capture's own condition
 *   graph (see `exclusiveCounterparts`), not from curated slugs. These exclude
 *   quest completions, not partial progress on individual objectives.
 */

/** Quest status codes used by the client's conditions (see eft-normalize.ts). */
const STATUS_STARTED = 2;
const STATUS_COMPLETE = 4;
const STATUS_FAIL = 5;

/**
 * Sub-quests that cannot both be completed alongside `quest`, as the capture
 * states it. Two condition shapes prove exclusivity:
 *
 * - `Fail` / `Quest` with the counterpart's `complete` (or `started`) status:
 *   completing that quest fails this one.
 * - `AvailableForStart` / `Quest` with only the counterpart's `fail` status:
 *   this quest is reachable only after that one failed.
 *
 * A `Fail` condition on the counterpart's *fail* status is cascade failure, not
 * exclusivity, so it is excluded - a chain that dies with its predecessor is not
 * an alternative to it.
 */
export function exclusiveCounterparts(quest: JsonRecord | undefined): string[] {
  const out: string[] = [];
  const conditions = quest?.conditions ?? {};
  const add = (condition: JsonRecord, statuses: number[]): void => {
    if (condition?.conditionType !== 'Quest') return;
    const status: number[] = Array.isArray(condition.status) ? condition.status : [];
    if (!statuses.some((wanted) => status.includes(wanted))) return;
    let target = condition.target;
    if (Array.isArray(target)) target = target.length > 0 ? target[0] : undefined;
    const id = bareId(target);
    if (id && !out.includes(id)) out.push(id);
  };
  for (const condition of conditions.Fail ?? []) {
    add(condition, [STATUS_COMPLETE, STATUS_STARTED]);
  }
  for (const condition of conditions.AvailableForStart ?? []) {
    const status: number[] = Array.isArray(condition?.status) ? condition.status : [];
    // Failure must be the only accepted state. Accepting started (or any other
    // state) also permits progress without the counterpart having failed.
    if (status.length === 0 || !status.every((value) => value === STATUS_FAIL)) continue;
    add(condition, [STATUS_FAIL]);
  }
  return out;
}

interface ExpandedObjective {
  id: string;
  text: string;
  sourceQuestId: string;
  endingId?: string;
}

interface ChapterExpansion {
  objectives: ExpandedObjective[];
  missingObjectiveTexts: number;
  /** Distinct sub-quest ids the chapter quest references. */
  referencedSubquests: string[];
  /** Referenced sub-quests whose templates the capture resolved. */
  resolvedSubquests: string[];
  /**
   * Sub-quest pairs the capture proves cannot both be completed, as sorted
   * `[a, b]` tuples. Only pairs where both sides are resolved sub-quests of this
   * chapter are kept, bounding the model to resolved chapter sub-quests. The
   * capture also states exclusivity against ordinary tasks (The Ticket's
   * "Choose Your Friends Wisely", Boreas' "Hangover"), which remains outside this
   * chapter-local model. Pairs exclude completed quests, not their individual
   * objectives: partial progress can exist on both sides.
   */
  exclusivePairs: Array<[string, string]>;
}

interface WikiObjective {
  text: string;
  optional: boolean;
}

/** Provenance for the capture that produced the committed output. */
interface ReferenceLock {
  file: string;
  sha256: string;
  bytes: number;
  clientVersion: string | null;
  gameMode: string | null;
  capturedAt: string | null;
  quests: number;
  chapterQuests: number;
  objectiveTexts: number;
}

type JsonRecord = Record<string, any>;

const ENDING_BY_GATE_QUEST = new Map<string, (typeof STORY_ENDINGS)[number]>(
  STORY_ENDINGS.map((ending) => [ending.gateQuestId, ending])
);

/** Extract a bare 24-hex id from a value that may be wrapped as `[id] Name`. */
export function bareId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = ID_RE.exec(value);
  return match ? match[0] : null;
}

/**
 * Codepoint ordering, used wherever output order must not vary.
 * `String.localeCompare` depends on the runtime's locale/ICU data, so it cannot
 * back a reproducibility guarantee.
 */
function byCodePoint(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Normalize objective text for fuzzy matching: collapse numbers, keep letters. */
export function normalizeStoryText(text: string): string {
  let out = text.toLowerCase();
  out = out.replace(/\b\d[\d,]*\b/g, '#'); // collapse numbers
  out = out.replace(/[^a-z# ]/g, ' ');
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * Undo the enriched capture's annotation wrapper on a localized string.
 *
 * The enrichment tool rewrites values as `[<original>] <resolved>` - the same
 * convention `bareId` already unwraps for ids (`_id: '[68da33fe…] The Ticket'`).
 * It reaches objective text too: The Ticket's final objective arrives as
 * `[Escape from Tarkov] ESCAPE FROM TARKOV`, and the plain 1.1 PvE capture
 * (unannotated) gives that same objective id the text `Escape from Tarkov`, so
 * the bracketed half is the client's value and the tail is the tool's lookup.
 *
 * When the brackets are empty (`[] Experience bonus {0}`, the tool's marker for
 * a string it could not resolve) there is no original to recover, so the value
 * is returned untouched rather than replaced with the unrelated tail.
 */
export function unwrapAnnotatedText(text: string): string {
  const match = /^\[([^\]]*)\]\s*(.*)$/s.exec(text);
  if (!match) return text;
  const original = match[1].trim();
  return original.length > 0 ? original : text;
}

/**
 * True when a localized string is the enrichment tool's unresolved marker.
 *
 * `[] Experience bonus {0}` means the tool could not resolve the string, so the
 * bracketed original is absent and the tail is an unrelated lookup.
 * {@link unwrapAnnotatedText} deliberately returns such a value untouched
 * because there is nothing to recover - which means callers must not treat it as
 * usable objective text. Emitting it would ship the marker as an objective
 * description while still counting the objective as resolved, letting a chapter
 * report complete coverage over text the capture never actually provided.
 */
export function isUnresolvedAnnotation(text: string): boolean {
  const match = /^\[([^\]]*)\]/.exec(text);
  return match !== null && match[1].trim().length === 0;
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

/** Index a capture's quests by bare id. */
export function indexQuests(quests: JsonRecord[]): Map<string, JsonRecord> {
  const byId = new Map<string, JsonRecord>();
  for (const quest of quests) {
    const id = bareId(quest._id);
    if (id) byId.set(id, quest);
  }
  return byId;
}

/**
 * Walk a chapter quest's ordered sub-quest references and collect their
 * objectives.
 *
 * Single source of the expansion for both candidate scoring and output
 * generation: when the two disagreed, a capture could score well and then emit
 * something else.
 */
export function expandChapterObjectives(
  chapterQuestId: string | undefined,
  byId: Map<string, JsonRecord>
): ChapterExpansion {
  const objectives: ExpandedObjective[] = [];
  let missingObjectiveTexts = 0;
  const referenced: string[] = [];
  const resolved: string[] = [];
  const chapterQuest = chapterQuestId ? byId.get(chapterQuestId) : undefined;
  if (!chapterQuest)
    return {
      objectives,
      missingObjectiveTexts,
      referencedSubquests: referenced,
      resolvedSubquests: [],
      exclusivePairs: [],
    };

  const seenRef = new Set<string>();
  for (const condition of chapterQuest?.conditions?.AvailableForFinish ?? []) {
    if (condition?.conditionType !== 'Quest') continue;
    let target = condition.target;
    if (Array.isArray(target)) target = target.length > 0 ? target[0] : undefined;
    const subId = bareId(target);
    if (!subId || seenRef.has(subId)) continue;
    seenRef.add(subId);
    referenced.push(subId);

    const subQuest = byId.get(subId);
    if (!subQuest) continue;
    resolved.push(subId);

    const localized: Record<string, string> = subQuest?.localization?.en ?? {};
    for (const objective of subQuest?.conditions?.AvailableForFinish ?? []) {
      const objectiveId = objective?.id;
      if (!objectiveId) {
        // A finish condition with no id cannot become a stable objective. Count
        // it so coverage reports `partial` instead of silently claiming this
        // chapter was fully resolved.
        missingObjectiveTexts += 1;
        continue;
      }
      const raw = (localized[objectiveId] ?? '').trim();
      const text = unwrapAnnotatedText(raw).trim();
      // An unresolved `[]` marker is not usable text: emitting it would ship the
      // marker as the description AND count the objective as resolved.
      if (!text || isUnresolvedAnnotation(text)) {
        missingObjectiveTexts += 1;
        continue;
      }
      // Use the real source objective id as the stable id. Positional ids
      // ({chapter}-main-n) shift whenever wording/order changes, which silently
      // corrupts consumers that persist completion per objective id. The source
      // id is unique and stable across regens.
      const expanded: ExpandedObjective = { id: objectiveId, text, sourceQuestId: subId };
      // Objectives belonging to an ending's gate sub-quest carry that ending's
      // real id, so consumers can attribute a branch without a slug lookup.
      const ending = ENDING_BY_GATE_QUEST.get(subId);
      if (ending) expanded.endingId = ending.id;
      objectives.push(expanded);
    }
  }

  const resolvedSet = new Set(resolved);
  const pairs: Array<[string, string]> = [];
  const seenPair = new Set<string>();
  for (const subId of resolved) {
    for (const counterpart of exclusiveCounterparts(byId.get(subId))) {
      if (!resolvedSet.has(counterpart) || counterpart === subId) continue;
      const pair: [string, string] =
        subId < counterpart ? [subId, counterpart] : [counterpart, subId];
      const key = pair.join(':');
      if (seenPair.has(key)) continue;
      seenPair.add(key);
      pairs.push(pair);
    }
  }
  pairs.sort((a, b) => byCodePoint(a[0], b[0]) || byCodePoint(a[1], b[1]));

  return {
    objectives,
    missingObjectiveTexts,
    referencedSubquests: referenced,
    resolvedSubquests: resolved,
    exclusivePairs: pairs,
  };
}

/**
 * Parse a capture's bytes into its quest array plus the envelope provenance.
 *
 * The bytes are passed in rather than re-read so that the hash recorded in the
 * lock is taken over exactly the bytes that produced the quests (and so a 47 MB
 * capture is read once).
 */
function parseReferenceEnvelope(
  file: string,
  bytes: Buffer
): {
  quests: JsonRecord[];
  request?: { url?: string; headers?: Record<string, string> };
  capturedAt?: string;
} {
  const raw = JSON.parse(bytes.toString('utf-8'));
  const node = raw?.response ?? raw;
  const decoded = node?.decoded_response ?? node?.body_response ?? node;
  const data = decoded?.data ?? decoded;
  if (!Array.isArray(data)) throw new Error(`unexpected quest reference shape in ${file}`);
  return {
    quests: data as JsonRecord[],
    request: raw?.request,
    capturedAt: raw?.request?.timestamp,
  };
}

/** How much of the storyline a capture resolves. */
function scoreReference(quests: JsonRecord[]): { chapters: number; texts: number } {
  const byId = indexQuests(quests);
  let chapters = 0;
  let texts = 0;
  for (const chapterQuestId of Object.values(CHAPTER_QUEST_ID)) {
    if (!byId.has(chapterQuestId)) continue;
    chapters += 1;
    texts += expandChapterObjectives(chapterQuestId, byId).objectives.length;
  }
  return { chapters, texts };
}

/**
 * Quest-capture files under eft/, enriched variants first.
 *
 * Directory entries are sorted before walking: `readdirSync` order is
 * filesystem-dependent, so relying on it would make discovery - and therefore
 * the fallback candidate ranking - vary between machines.
 */
export function storyReferenceCandidates(root = 'eft'): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of [...names].sort()) {
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
  walk(root);
  // Enriched captures carry the localization.en block that supplies objective
  // text, so prefer them; ties fall back to the sorted discovery order.
  return found.sort(
    (a, b) =>
      (a.includes('rollinglatest.modified') ? 0 : 1) -
        (b.includes('rollinglatest.modified') ? 0 : 1) || byCodePoint(a, b)
  );
}

/**
 * Capture modes the committed storyline is allowed to come from.
 *
 * `eft-story-write.ts` stamps "The storyline is shared between PVP and PVE" onto
 * the generated addition, and consumers merge `storyChapters` for those modes.
 * `pvp-season` is a separate BSG character with independently divergent quest
 * data, so a seasonal capture must never become the shared storyline even when
 * an advanced Seasonal character would out-score every other capture on chapter
 * coverage.
 */
export const STORY_SHARED_MODES: readonly string[] = ['regular', 'pve'];

/**
 * Rank capture candidates for a lock refresh.
 *
 * Story chapters are not served like ordinary quests: the client returns a
 * chapter's sub-quest templates only once the player has reached them, so the
 * *newest* capture is not automatically the most useful one here - a fresh
 * capture from an early character resolves far fewer sub-quests than an older
 * capture from an advanced one. Selecting by "newest" (what `findReferenceFile`
 * does for the numeric `eft:*` tools) would silently shrink the storyline.
 *
 * Candidates are therefore ranked by how much of the storyline each can resolve:
 * chapter quests present first, then objective texts, then file path so equal
 * scores resolve to one deterministic winner instead of discovery order.
 *
 * Captures from modes outside {@link STORY_SHARED_MODES} are dropped before
 * ranking, so seasonal coverage cannot win the auto-selection.
 */
export function rankStoryReferences(
  candidates: string[]
): Array<{ file: string; chapters: number; texts: number; gameMode: string | null }> {
  const scored: Array<{ file: string; chapters: number; texts: number; gameMode: string | null }> =
    [];
  for (const file of candidates) {
    try {
      const envelope = parseReferenceEnvelope(file, readFileSync(file));
      const gameMode = modeFromRequestUrl(envelope.request?.url);
      // Unknown mode is dropped as well: a capture whose request URL does not
      // identify it cannot be shown to belong to the shared storyline's modes.
      if (gameMode === null || !STORY_SHARED_MODES.includes(gameMode)) continue;
      scored.push({ file, gameMode, ...scoreReference(envelope.quests) });
    } catch {
      continue; // unreadable or wrong-shaped capture
    }
  }
  return scored.sort(
    (a, b) => b.chapters - a.chapters || b.texts - a.texts || byCodePoint(a.file, b.file)
  );
}

function readLock(): ReferenceLock | null {
  if (!existsSync(LOCK)) return null;
  return JSON.parse(readFileSync(LOCK, 'utf-8')) as ReferenceLock;
}

/** Fingerprint a capture: content hash plus the provenance in its envelope. */
function fingerprint(file: string): { lock: ReferenceLock; quests: JsonRecord[] } {
  const bytes = readFileSync(file);
  const envelope = parseReferenceEnvelope(file, bytes);
  const { chapters, texts } = scoreReference(envelope.quests);
  return {
    quests: envelope.quests,
    lock: {
      file,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
      clientVersion: envelope.request?.headers?.['App-Version'] ?? null,
      gameMode: modeFromRequestUrl(envelope.request?.url),
      capturedAt: envelope.capturedAt ?? null,
      quests: envelope.quests.length,
      chapterQuests: chapters,
      objectiveTexts: texts,
    },
  };
}

/**
 * Load the pinned quest reference.
 *
 * Selection is explicit rather than heuristic, so that regenerating on a
 * workstation whose eft/ has since grown cannot quietly rewrite committed
 * objectives:
 * - by default the lock's capture is used and its SHA-256 must still match.
 * - `STORY_REFERENCE=<file>` reads the pinned capture from another path (a moved
 *   or renamed copy). The hash must still match the lock, so this cannot swap in
 *   a different capture - it only relaxes the path.
 * - `STORY_REFERENCE_UPDATE_LOCK=1` is the only mode that accepts a different
 *   capture: it ranks candidates (or takes `STORY_REFERENCE`) and rewrites the
 *   lock, so a source switch always lands as a reviewable diff.
 */
/**
 * Lock staged by {@link loadReference} under `STORY_REFERENCE_UPDATE_LOCK=1`.
 *
 * Held until {@link commitStoryReferenceLock} runs so a re-pin only lands when
 * generation actually produced the chapters it claims to describe.
 */
let pendingLock: ReferenceLock | undefined;

/**
 * Sidecar carrying a staged re-pin across the generate -> write process boundary.
 *
 * The generator only emits JSON on stdout; `eft-story-write.ts` is what persists
 * `src/additions/storyChapters.json5`. The lock's whole purpose is to record
 * which capture produced the *committed* data, so it must not land until that
 * write succeeds - otherwise a failed redirect or a writer error leaves the lock
 * describing an artifact that was never updated. Lives under the gitignored
 * data/ tree and is consumed and removed by the writer.
 */
export const PENDING_LOCK_SIDECAR = join('data', 'eft', 'story-reference.lock.pending.json');

/**
 * Stage a re-pin for the writer to promote. No-op unless
 * `STORY_REFERENCE_UPDATE_LOCK=1` staged one.
 *
 * `outputSha256` binds the staged pin to the exact generated payload, so a
 * sidecar left behind by a run whose write never happened cannot later be
 * promoted alongside different data.
 */
export function commitStoryReferenceLock(outputSha256?: string): void {
  if (!pendingLock) return;
  mkdirSync(dirname(PENDING_LOCK_SIDECAR), { recursive: true });
  writeFileSync(
    PENDING_LOCK_SIDECAR,
    `${JSON.stringify({ lock: pendingLock, outputSha256: outputSha256 ?? null }, null, 2)}\n`
  );
  console.error(
    `staged re-pin recorded at ${PENDING_LOCK_SIDECAR}; ` +
      `${LOCK} updates once the story artifact is written`
  );
  pendingLock = undefined;
}

/**
 * Result of examining the sidecar.
 *
 * A `lock` is present exactly for the statuses that carry one, so the committed
 * lock can never be written from an absent value - the compiler rejects it
 * rather than serializing `undefined`.
 */
export type StagedLockInspection =
  | { status: 'none' }
  | { status: 'unusable' }
  | { status: 'ready'; lock: ReferenceLock }
  | { status: 'mismatched'; lock: ReferenceLock };

/**
 * Validate the complete provenance record before it can replace the committed lock.
 *
 * The sidecar lives in the gitignored data/ tree and can be truncated by an
 * interrupted run or hand-edited, so its shape is not guaranteed by having
 * parsed as JSON. Without this check a payload that omits `lock` would make
 * `JSON.stringify(undefined)` write the literal `undefined` over the committed
 * lock, corrupting the provenance record that every later run parses.
 *
 * Every field is required, not just the two the write dereferences: the lock's
 * purpose is to record byte size, client version, game mode, capture timestamp
 * and coverage counts, so promoting a partial record would silently drop the
 * evidence that makes the committed chapters auditable.
 */
function isReferenceLock(value: unknown): value is ReferenceLock {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const lock = value as Partial<ReferenceLock>;
  const nonEmptyString = (field: unknown): boolean => typeof field === 'string' && field.length > 0;
  const stringOrNull = (field: unknown): boolean => typeof field === 'string' || field === null;
  const count = (field: unknown): boolean => typeof field === 'number' && Number.isFinite(field);
  return (
    nonEmptyString(lock.file) &&
    nonEmptyString(lock.sha256) &&
    count(lock.bytes) &&
    stringOrNull(lock.clientVersion) &&
    stringOrNull(lock.gameMode) &&
    stringOrNull(lock.capturedAt) &&
    count(lock.quests) &&
    count(lock.chapterQuests) &&
    count(lock.objectiveTexts)
  );
}

/**
 * Read and validate the staged sidecar without modifying anything on disk.
 *
 * Side-effect free so the writer can decide whether a re-pin will be refused
 * *before* it replaces the committed artifact, while the sidecar is still
 * available for {@link promoteStoryReferenceLock} to consume afterwards.
 *
 * Passing `outputSha256` asserts "this is the payload I am about to commit", so
 * the staged pin must be bound to it: an unbound sidecar (no `outputSha256`) is
 * refused rather than treated as a wildcard, since nothing then ties it to the
 * data being written. Omitting the argument skips the binding check entirely,
 * which is how callers that are not committing an artifact inspect a sidecar.
 */
export function inspectStagedReferenceLock(outputSha256?: string): StagedLockInspection {
  if (!existsSync(PENDING_LOCK_SIDECAR)) return { status: 'none' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(PENDING_LOCK_SIDECAR, 'utf-8'));
  } catch {
    return { status: 'unusable' };
  }
  if (typeof parsed !== 'object' || parsed === null) return { status: 'unusable' };

  const staged = parsed as { lock?: unknown; outputSha256?: unknown };
  const stagedOutput = staged.outputSha256 ?? null;
  if (stagedOutput !== null && typeof stagedOutput !== 'string') return { status: 'unusable' };
  if (!isReferenceLock(staged.lock)) return { status: 'unusable' };

  if (outputSha256 !== undefined && stagedOutput !== outputSha256) {
    return { status: 'mismatched', lock: staged.lock };
  }
  return { status: 'ready', lock: staged.lock };
}

/**
 * Promote a staged re-pin to the committed lock. Returns true when one was
 * applied.
 *
 * Called by `eft-story-write.ts` after it has written
 * `src/additions/storyChapters.json5`, so the lock and the artifact it describes
 * move together. When `outputSha256` is supplied it must match what the
 * generator staged; a mismatch means the sidecar belongs to a different
 * generation, so it is discarded rather than applied. An unusable sidecar is
 * likewise discarded, leaving the committed lock untouched.
 */
export function promoteStoryReferenceLock(outputSha256?: string): boolean {
  const staged = inspectStagedReferenceLock(outputSha256);
  if (staged.status === 'none') return false;

  if (staged.status === 'unusable' || staged.status === 'mismatched') {
    const reason =
      staged.status === 'unusable'
        ? 'it is not a complete provenance record'
        : 'it is not bound to the artifact just written';
    rmSync(PENDING_LOCK_SIDECAR, { force: true });
    console.error(
      `warning: discarded a staged re-pin at ${PENDING_LOCK_SIDECAR}; ${reason}, so ${LOCK} was ` +
        'left unchanged. Re-run the generator with STORY_REFERENCE_UPDATE_LOCK=1 to re-pin.'
    );
    return false;
  }

  const { lock } = staged;
  writeFileSync(LOCK, `${JSON.stringify(lock, null, 2)}\n`);
  rmSync(PENDING_LOCK_SIDECAR, { force: true });
  console.error(`re-pinned ${LOCK} -> ${lock.file} (sha256=${lock.sha256.slice(0, 12)}…)`);
  return true;
}

export function loadReference(): JsonRecord[] {
  const explicit = process.env.STORY_REFERENCE;
  const updating = process.env.STORY_REFERENCE_UPDATE_LOCK === '1';
  const lock = readLock();

  if (!lock && !updating && explicit) {
    throw new Error(
      `no ${LOCK} to pin the story reference; re-pin with STORY_REFERENCE_UPDATE_LOCK=1.`
    );
  }

  let file: string | undefined = explicit;
  if (!file && lock && !updating) {
    if (!existsSync(lock.file)) {
      throw new Error(
        `pinned story reference is missing: ${lock.file} (${LOCK}). Restore that capture, ` +
          'or point STORY_REFERENCE at a copy of it, or re-pin with ' +
          'STORY_REFERENCE_UPDATE_LOCK=1.'
      );
    }
    file = lock.file;
  }
  if (!file) {
    const ranked = rankStoryReferences(storyReferenceCandidates());
    if (ranked.length === 0 || ranked[0].chapters === 0) {
      throw new Error(
        'No usable story reference found under eft/. Place a quest capture there, or set ' +
          'STORY_REFERENCE to one.'
      );
    }
    if (!updating) {
      throw new Error(
        `no ${LOCK} to pin the story reference. Regenerating without a pin cannot be reviewed; ` +
          `re-pin with STORY_REFERENCE_UPDATE_LOCK=1 (best candidate: ${ranked[0].file}).`
      );
    }
    file = ranked[0].file;
  }

  const { lock: current, quests } = fingerprint(file);
  if (current.chapterQuests === 0 || current.objectiveTexts === 0) {
    throw new Error(`story reference ${file} resolves no chapter quests or objective texts`);
  }
  // Enforced for explicit replacements too, not just auto-discovery: the
  // committed addition is declared shared between PVP and PvE, so pinning a
  // seasonal capture would publish independently divergent data as the shared
  // storyline. An unidentifiable mode is refused rather than allowed through -
  // a capture with no recognizable request URL cannot be shown to be in scope,
  // and treating "unknown" as acceptable would reopen the same hole. Only
  // checked when re-pinning - an already-pinned capture is identified by hash
  // and must keep validating even if this list later changes.
  if (updating && !(current.gameMode !== null && STORY_SHARED_MODES.includes(current.gameMode))) {
    throw new Error(
      `story reference ${file} reports game mode '${current.gameMode ?? 'unknown'}'; the ` +
        `committed storyline is shared between ${STORY_SHARED_MODES.join(' and ')} only. Pin a ` +
        'capture whose request URL identifies it as one of those modes.'
    );
  }

  if (lock && !updating) {
    // The hash is the identity; the path may differ when STORY_REFERENCE points
    // at a copy of the pinned capture.
    if (current.sha256 !== lock.sha256) {
      throw new Error(
        `story reference does not match ${LOCK}\n` +
          `  pinned:   ${lock.file} sha256=${lock.sha256}\n` +
          `  selected: ${current.file} sha256=${current.sha256}\n` +
          'Re-verify the capture, then re-pin with STORY_REFERENCE_UPDATE_LOCK=1.'
      );
    }
    for (const key of Object.keys(current) as Array<keyof ReferenceLock>) {
      if (key !== 'file' && current[key] !== lock[key]) {
        throw new Error(
          `story reference provenance mismatch for ${key} in ${LOCK}; re-pin with STORY_REFERENCE_UPDATE_LOCK=1.`
        );
      }
    }
    if (current.file !== lock.file) {
      console.error(`note: reading the pinned capture from ${current.file} (lock: ${lock.file})`);
    }
  }

  if (updating) {
    // Staged, not written: re-pinning must not outlive a failed generation.
    // `main()` commits only after every chapter validation passes, so a capture
    // that resolves some data but leaves a chapter empty (or drops wiki matching
    // below MIN_MATCH_PCT) cannot leave the committed lock pointing at a capture
    // that never produced the committed chapters.
    pendingLock = current;
    console.error(
      `staged re-pin of ${LOCK} -> ${current.file} (sha256=${current.sha256.slice(0, 12)}…); ` +
        'writes after generation succeeds'
    );
  }

  console.error(
    `story reference: ${current.file} ` +
      `(${current.clientVersion ?? 'unknown client'}, ${current.gameMode ?? 'unknown mode'}, ` +
      `captured ${current.capturedAt ?? 'unknown'}; ` +
      `${current.chapterQuests}/${Object.keys(CHAPTER_QUEST_ID).length} chapter quests, ` +
      `${current.objectiveTexts} objective texts)`
  );
  return quests;
}

function main(): void {
  const quests = loadReference();
  const byId = indexQuests(quests);

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

  const stats: Record<
    string,
    { objectives: number; matched: number; optional: number; wiki: number }
  > = {};

  const out: Record<string, JsonRecord> = {};
  const chapterIds = Object.keys(curated).sort((a, b) => curated[a].order - curated[b].order);
  for (const chapterId of chapterIds) {
    const meta = curated[chapterId];
    const expansion = expandChapterObjectives(CHAPTER_QUEST_ID[chapterId], byId);
    const wikiObjectives = wiki[chapterId] ?? [];

    let matched = 0;
    let optionalCount = 0;
    const objectives = expansion.objectives.map((objective) => {
      const { optional, ratio } = matchOptional(objective.text, wikiObjectives);
      if (ratio >= MATCH_THRESHOLD) matched += 1;
      if (optional) optionalCount += 1;
      const emitted: JsonRecord = {
        id: objective.id,
        type: optional ? 'optional' : 'main',
        description: objective.text,
        sourceQuestId: objective.sourceQuestId,
      };
      if (objective.endingId) emitted.endingId = objective.endingId;
      return emitted;
    });
    stats[chapterId] = {
      objectives: objectives.length,
      matched,
      optional: optionalCount,
      wiki: wikiObjectives.length,
    };

    const chapter: JsonRecord = {
      id: meta.id,
      name: meta.name,
      normalizedName: meta.normalizedName,
      wikiLink: meta.wikiLink,
      order: meta.order,
      chapterQuestId: CHAPTER_QUEST_ID[chapterId],
      // Coverage is emitted for every chapter, not just partial ones: a consumer
      // must be able to tell "this chapter is complete" from "this is what the
      // capture could see" without comparing counts against something else.
      referenceCoverage: {
        referencedSubquests: expansion.referencedSubquests.length,
        resolvedSubquests: expansion.resolvedSubquests.length,
        ...(expansion.missingObjectiveTexts > 0
          ? { missingObjectiveTexts: expansion.missingObjectiveTexts }
          : {}),
        partial:
          expansion.resolvedSubquests.length < expansion.referencedSubquests.length ||
          expansion.missingObjectiveTexts > 0,
      },
      autoStart: meta.autoStart ?? false,
      chapterRequirements: meta.chapterRequirements ?? [],
    };
    if (meta.activation) {
      chapter.activation = meta.activation;
    }
    chapter.description = meta.description ?? null;
    chapter.notes = meta.notes ?? null;
    chapter.objectives = objectives;
    if (expansion.exclusivePairs.length > 0) {
      chapter.mutuallyExclusiveQuestPairs = expansion.exclusivePairs;
    }

    // A chapter that references ending gate sub-quests owns those endings, so
    // restate the whole branch set from client/ending_list with the real ids -
    // including the gates this capture could not resolve, which report zero
    // objectives instead of disappearing.
    const referenced = new Set(expansion.referencedSubquests);
    const resolved = new Set(expansion.resolvedSubquests);
    const endings = STORY_ENDINGS.filter((ending) => referenced.has(ending.gateQuestId)).map(
      (ending) => ({
        id: ending.id,
        systemName: ending.systemName,
        gateQuestId: ending.gateQuestId,
        objectiveCount: objectives.filter((objective) => objective.endingId === ending.id).length,
        resolvedInReference: resolved.has(ending.gateQuestId),
      })
    );
    if (endings.length > 0) chapter.endings = endings;

    chapter.rewards = meta.rewards ?? null;
    chapter.mapUnlocks = meta.mapUnlocks ?? [];
    chapter.traderUnlocks = meta.traderUnlocks ?? [];
    if (meta.questUnlocks) {
      chapter.questUnlocks = meta.questUnlocks;
    }
    out[chapterId] = chapter;
  }

  console.error('chapter match stats (eft objs / wiki-matched / optional / sub-quest coverage):');
  const low: Array<[string, number]> = [];
  for (const [chapterId, s] of Object.entries(stats)) {
    const pct = Math.floor((100 * s.matched) / Math.max(s.objectives, 1));
    const coverage = out[chapterId]?.referenceCoverage;
    console.error(
      `  ${chapterId.padEnd(22)} objs=${String(s.objectives).padStart(3)} ` +
        `matched=${String(pct).padStart(3)}% optional=${String(s.optional).padStart(2)} ` +
        `wiki=${String(s.wiki).padStart(3)} ` +
        `subquests=${coverage?.resolvedSubquests}/${coverage?.referencedSubquests}`
    );
    // A chapter that no longer matches the wiki means wording drift has
    // degraded optional/required accuracy; fail generation so it is caught
    // now rather than shipped silently. Zero resolvable objectives (e.g. a
    // broken CHAPTER_QUEST_ID mapping) is an even harder failure. Current
    // chapters match >=86%.
    if (s.objectives === 0 || pct < MIN_MATCH_PCT) {
      low.push([chapterId, pct]);
    }
  }

  if (low.length > 0) {
    const detail = low.map(([chapterId, pct]) => `${chapterId} (${pct}%)`).join(', ');
    console.error(`error: wiki match below ${MIN_MATCH_PCT}% for: ${detail}`);
    process.exit(1);
  }

  // Validate against the same schema `eft-story-write.ts` enforces before it
  // persists the artifact. Without this the lock could be pinned here and the
  // downstream writer still reject the data, leaving the committed lock pointing
  // at a capture whose output never landed.
  const schema = JSON.parse(
    readFileSync(join('src', 'schemas', 'story-chapter.schema.json'), 'utf-8')
  );
  const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
  if (!validate(out)) {
    console.error('error: generated story chapters fail story-chapter.schema.json:');
    for (const error of (validate.errors ?? []).slice(0, 20)) {
      console.error(`  ${error.instancePath} ${error.message}`);
    }
    process.exit(1);
  }

  const payload = JSON.stringify(out, null, 2);

  // Every chapter validated and the output satisfies the schema the writer
  // applies, so a staged re-pin is now safe to record. It is bound to this exact
  // payload and only applied by the writer once the artifact is on disk.
  commitStoryReferenceLock(createHash('sha256').update(payload).digest('hex'));

  process.stdout.write(payload);
}

if (isDirectExecution(import.meta.url)) {
  main();
}
