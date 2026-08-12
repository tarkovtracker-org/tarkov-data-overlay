#!/usr/bin/env tsx
/**
 * Compare a local EFT quest reference file against tarkov.dev API data.
 *
 * The reference file is the authoritative source for the *structured / numeric*
 * quest fields:
 *   - experience reward
 *   - minPlayerLevel (Level start condition)
 *   - objective counts (condition `value`, keyed by condition id == tarkov.dev
 *     objective id)
 *
 * Objective *description wording* is normally synthesized by tarkov.dev / the
 * wiki. An enriched reference variant (filename contains `rollinglatest.modified`)
 * additionally embeds a per-quest `localization.en` block that carries the
 * canonical objective text (keyed by condition id). When present,
 * `--descriptions` compares that canonical text against tarkov.dev. This is
 * noisier than the numeric checks (tarkov.dev intentionally rephrases some
 * objectives) so it is opt-in and best used to audit existing description
 * overrides rather than as a fix list.
 *
 * The reference file is per game-mode, so compare against the matching
 * tarkov.dev mode.
 *
 * Usage:
 *   tsx scripts/eft-compare.ts [eftDir] [--mode pve|regular] [--descriptions] [--json out.json]
 *
 * eftDir defaults to ./eft. The reference file is auto-detected by the
 * `quest_list` filename fragment (the enriched variant is preferred).
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { join, isAbsolute } from 'path';
import {
  isDirectExecution,
  fetchTasks,
  findTaskById,
  printHeader,
  printProgress,
  printSuccess,
  printError,
  bold,
  dim,
  colors,
  icons,
  type TaskData,
  type GameMode,
} from '../src/lib/index.js';

// ---------------------------------------------------------------------------
// Reference-file parsing
// ---------------------------------------------------------------------------

/** Condition types whose `value` is the objective count tarkov.dev exposes. */
const COUNTABLE_CONDITIONS = new Set([
  'CounterCreator',
  'FindItem',
  'HandoverItem',
  'LeaveItemAtLocation',
  'PlaceBeacon',
  'SellItemToTrader',
]);

interface EftCondition {
  id: string;
  conditionType?: string;
  value?: unknown;
  target?: unknown;
  status?: number[];
}

interface EftQuest {
  _id: string;
  name?: string;
  conditions?: {
    AvailableForStart?: EftCondition[];
    AvailableForFinish?: EftCondition[];
  };
  rewards?: { Success?: Array<{ type?: string; value?: unknown }> };
  /**
   * Per-language localized strings. Keyed by language code (`en`, `ru`, ...).
   * Each value maps either `<questId> <suffix>` (name/description/messages) or a
   * bare `<conditionId>` (objective text) to its localized string. Only present
   * in the enriched ("rollinglatest.modified") reference variant.
   */
  localization?: Record<string, Record<string, string>>;
}

/** Hex object id, optionally wrapped as `[<id>]` or `[<id> name]` by the
 * enriched reference variant. */
const ID_PATTERN = /[0-9a-f]{24}/;
const HEX_ID_KEY = /^[0-9a-f]{24}$/;

/** Unwrap a possibly-bracketed id (`[60e7... name] Long Line` -> `60e7...`). */
function unwrapId(value: string): string {
  const match = ID_PATTERN.exec(value);
  return match ? match[0] : value;
}

/** Normalized authoritative values for a single quest from the reference file. */
interface EftTask {
  id: string;
  experience?: number;
  minPlayerLevel?: number;
  /** objective id -> required count */
  counts: Map<string, number>;
  /** objective (condition) id -> canonical English objective text, when the
   * reference file carries a `localization.en` block. Empty otherwise. */
  descriptions: Map<string, string>;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Recursively collect quest-reference files (name matches `quest_list` /
 * `quest-list`, `.json`) under `dir`, including subdirectories so versioned
 * captures like `eft/eft-1.1-pve/` are discovered.
 */
function findQuestListFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...findQuestListFiles(full));
    } else if (
      entry.isFile() &&
      /quest[_-]list/i.test(entry.name) &&
      entry.name.endsWith('.json')
    ) {
      out.push(full);
    }
  }
  return out;
}

/** Locate the quest reference file under the eft directory. Prefers the most
 * recently captured reference: the capture timestamp in each file's envelope
 * (`request.timestamp`) is authoritative, with the filesystem mtime as a
 * deterministic fallback for files that lack one (e.g. after copying/editing,
 * where mtime reflects the copy time rather than the capture). The enriched
 * ("rollinglatest.modified") variant breaks ties since it additionally carries
 * `localization.en` objective text.
 * When `mode` is given, candidates whose capture URL identifies that mode are
 * preferred (still newest-first), so a directory holding captures for several
 * modes (e.g. `eft/eft-1.1-{regular,pve}/`) selects the capture matching the
 * requested mode instead of rejecting the directory. Candidates whose mode
 * cannot be detected stay in the pool. */
export function findReferenceFile(eftDir: string, mode?: GameMode): string {
  const candidates = findQuestListFiles(eftDir);
  if (candidates.length === 0) {
    throw new Error(`No quest reference file found in ${eftDir}`);
  }
  // Precompute the capture rank (envelope timestamp, else mtime) and the
  // enriched tie-break once: reading+parsing each multi-MB dump inside the
  // comparator would redo the work O(n log n) times.
  const ranked = candidates
    .map((file) => ({
      file,
      ts: captureTimestamp(file) ?? statSync(file).mtimeMs,
      enriched: file.includes('rollinglatest.modified') ? 1 : 0,
    }))
    .sort((a, b) => b.ts - a.ts || b.enriched - a.enriched)
    .map((entry) => entry.file);
  if (mode) {
    for (const candidate of ranked) {
      const candidateMode = modeFromReferenceFile(candidate);
      // An unparseable capture cannot be used for comparison, so skip it; a
      // valid capture with an inconclusive URL stays plausible (callers then
      // trust --mode).
      if (candidateMode === null || candidateMode === mode) {
        return candidate;
      }
    }
  }
  return ranked[0];
}

/** Infer the game mode from a reference file's captured request URL metadata.
 * Returns 'unusable' when the file cannot be parsed at all (so mode selection
 * can ignore malformed captures instead of treating them as unknown-mode), and
 * null when the file is valid but its capture URL is inconclusive. */
function modeFromReferenceFile(file: string): GameMode | null | 'unusable' {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as {
      request?: { url?: string };
    };
    return modeFromRequestUrl(raw?.request?.url);
  } catch {
    return 'unusable';
  }
}

/** The capture time from the reference envelope, or null when absent/parsing fails. */
function captureTimestamp(file: string): number | null {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as {
      request?: { timestamp?: string };
    };
    const ts = raw?.request?.timestamp;
    if (typeof ts === 'string') {
      const ms = Date.parse(ts);
      if (!Number.isNaN(ms)) return ms;
    }
    return null;
  } catch {
    return null;
  }
}

/** Read the quest array out of the reference-file envelope. */
function readQuestArray(file: string): EftQuest[] {
  const raw = JSON.parse(readFileSync(file, 'utf-8')) as unknown;
  // The reference format is { request, response: { decoded_response: { data: [...] } } }.
  const decoded = (raw as any)?.response?.decoded_response;
  const data = decoded?.data ?? (raw as any)?.data ?? raw;
  if (!Array.isArray(data)) {
    throw new Error(`Unexpected quest reference shape in ${file}: expected an array of quests`);
  }
  return data as EftQuest[];
}

function parseEftTasks(quests: EftQuest[]): Map<string, EftTask> {
  const out = new Map<string, EftTask>();
  for (const q of quests) {
    if (!q?._id) continue;
    const id = unwrapId(q._id);
    const start = q.conditions?.AvailableForStart ?? [];
    const finish = q.conditions?.AvailableForFinish ?? [];

    const experience = q.rewards?.Success?.filter((r) => r.type === 'Experience')
      .map((r) => asNumber(r.value))
      .find((v) => v !== undefined);

    const minPlayerLevel = start
      .filter((c) => c.conditionType === 'Level')
      .map((c) => asNumber(c.value))
      .find((v) => v !== undefined);

    const counts = new Map<string, number>();
    for (const c of finish) {
      if (c.conditionType && COUNTABLE_CONDITIONS.has(c.conditionType)) {
        const v = asNumber(c.value);
        if (v !== undefined) counts.set(unwrapId(c.id), v);
      }
    }

    const descriptions = new Map<string, string>();
    const en = q.localization?.en;
    if (en) {
      for (const [key, value] of Object.entries(en)) {
        // Bare 24-hex keys are objective (condition) text; `<id> <suffix>`
        // keys are quest name/description/messages which we don't compare here.
        if (HEX_ID_KEY.test(key) && typeof value === 'string') {
          descriptions.set(key, value);
        }
      }
    }

    out.set(id, { id, experience, minPlayerLevel, counts, descriptions });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

interface Discrepancy {
  taskId: string;
  taskName: string;
  field: string;
  /** what tarkov.dev currently has */
  api: string;
  /** what the reference file says (authoritative) */
  eft: string;
}

function compare(
  eftTasks: Map<string, EftTask>,
  apiTasks: TaskData[],
  options: { descriptions?: boolean } = {}
): {
  discrepancies: Discrepancy[];
  matched: number;
  apiMissing: number;
} {
  const discrepancies: Discrepancy[] = [];
  let matched = 0;
  let apiMissing = 0;

  for (const eft of eftTasks.values()) {
    const api = findTaskById(apiTasks, eft.id);
    if (!api) {
      apiMissing += 1;
      continue;
    }
    matched += 1;
    const name = api.name;

    if (
      eft.experience !== undefined &&
      api.experience !== undefined &&
      eft.experience !== api.experience
    ) {
      discrepancies.push({
        taskId: eft.id,
        taskName: name,
        field: 'experience',
        api: String(api.experience),
        eft: String(eft.experience),
      });
    }

    if (
      eft.minPlayerLevel !== undefined &&
      api.minPlayerLevel !== undefined &&
      eft.minPlayerLevel !== api.minPlayerLevel
    ) {
      discrepancies.push({
        taskId: eft.id,
        taskName: name,
        field: 'minPlayerLevel',
        api: String(api.minPlayerLevel),
        eft: String(eft.minPlayerLevel),
      });
    }

    const apiObjectives = new Map((api.objectives ?? []).map((o) => [o.id, o]));
    for (const [objId, eftCount] of eft.counts) {
      const obj = apiObjectives.get(objId);
      if (!obj || typeof obj.count !== 'number') continue;
      if (obj.count !== eftCount) {
        discrepancies.push({
          taskId: eft.id,
          taskName: name,
          field: `objective[${objId}].count`,
          api: String(obj.count),
          eft: String(eftCount),
        });
      }
    }

    if (options.descriptions) {
      for (const [objId, eftText] of eft.descriptions) {
        const obj = apiObjectives.get(objId);
        if (!obj || typeof obj.description !== 'string') continue;
        if (normalizeDescription(obj.description) !== normalizeDescription(eftText)) {
          discrepancies.push({
            taskId: eft.id,
            taskName: name,
            field: `objective[${objId}].description`,
            api: obj.description,
            eft: eftText,
          });
        }
      }
    }
  }

  return { discrepancies, matched, apiMissing };
}

/**
 * Normalize objective text before comparison so we only flag genuine wording
 * differences, not whitespace / punctuation / case noise.
 */
function normalizeDescription(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ') // fold all punctuation/symbols to a space
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Override cross-check (against the reference file)
// ---------------------------------------------------------------------------

/**
 * The tarkov.dev-only validator can only tell whether an override differs from
 * the API; it reads "override != API" as "keep the override". That hides the
 * case where the override itself is wrong. With the reference file as a third,
 * authoritative source we can classify each objective-level override:
 *
 *   MATCHES_REFERENCE   - override equals the reference (a genuine correction)
 *   CONFLICTS_REFERENCE - override disagrees with the reference (override is wrong)
 *   NO_REFERENCE_DATA   - reference has no value for this objective (can't judge)
 */
export type CrossCheckVerdict = 'MATCHES_REFERENCE' | 'CONFLICTS_REFERENCE' | 'NO_REFERENCE_DATA';

export interface CrossCheckEntry {
  taskId: string;
  objectiveId: string;
  field: 'description' | 'count';
  verdict: CrossCheckVerdict;
  override: string;
  reference?: string;
}

/** Minimal shape of a task override's objective patch we cross-check. */
interface OverrideObjectivePatch {
  description?: unknown;
  count?: unknown;
}
interface OverrideLike {
  objectives?: Record<string, OverrideObjectivePatch>;
}

/**
 * Cross-check objective `description`/`count` overrides against the reference
 * file. Objectives the reference doesn't cover are reported as
 * NO_REFERENCE_DATA so callers can surface "can't verify" honestly.
 */
export function crossCheckOverrides(
  overrides: Record<string, OverrideLike>,
  eftTasks: Map<string, EftTask>
): CrossCheckEntry[] {
  const entries: CrossCheckEntry[] = [];

  for (const [taskId, override] of Object.entries(overrides)) {
    if (!override?.objectives) continue;
    const eft = eftTasks.get(taskId);

    for (const [objectiveId, patch] of Object.entries(override.objectives)) {
      if (typeof patch?.description === 'string') {
        const reference = eft?.descriptions.get(objectiveId);
        entries.push({
          taskId,
          objectiveId,
          field: 'description',
          verdict:
            reference === undefined
              ? 'NO_REFERENCE_DATA'
              : normalizeDescription(reference) === normalizeDescription(patch.description)
                ? 'MATCHES_REFERENCE'
                : 'CONFLICTS_REFERENCE',
          override: patch.description,
          reference,
        });
      }

      if (typeof patch?.count === 'number') {
        const reference = eft?.counts.get(objectiveId);
        entries.push({
          taskId,
          objectiveId,
          field: 'count',
          verdict:
            reference === undefined
              ? 'NO_REFERENCE_DATA'
              : reference === patch.count
                ? 'MATCHES_REFERENCE'
                : 'CONFLICTS_REFERENCE',
          override: String(patch.count),
          reference: reference === undefined ? undefined : String(reference),
        });
      }
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** Options shared by the eft:* CLI tools. */
export interface ModeCliOptions {
  eftDir: string;
  mode: GameMode;
  jsonOut?: string;
  /** Boolean flags (from `booleanFlags`) present on the CLI. */
  flags: Set<string>;
}

/**
 * Parse the common `[eftDir] [--mode pve|regular] [--json out.json]` CLI shape
 * shared by eft:compare / eft:audit / eft:wiki. Extra boolean flags can be
 * declared via `booleanFlags` and are surfaced in `flags`.
 */
export function parseModeArgs(argv: string[], booleanFlags: string[] = []): ModeCliOptions {
  let eftDir = 'eft';
  let mode: GameMode = 'pve';
  let jsonOut: string | undefined;
  const flags = new Set<string>();

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--mode') {
      const value = argv[(i += 1)];
      if (value !== 'pve' && value !== 'regular') {
        throw new Error(`--mode must be 'pve' or 'regular', got '${value}'`);
      }
      mode = value;
    } else if (arg === '--json') {
      jsonOut = argv[(i += 1)];
    } else if (booleanFlags.includes(arg)) {
      flags.add(arg);
    } else if (!arg.startsWith('--')) {
      eftDir = arg;
    }
  }

  return {
    eftDir: isAbsolute(eftDir) ? eftDir : join(process.cwd(), eftDir),
    mode,
    jsonOut,
    flags,
  };
}

/**
 * Detect the reference file's mode and refuse a mismatch with the requested
 * mode: comparing a mode-specific reference against a different tarkov.dev
 * mode produces false discrepancies. Returns the detected mode (null when
 * undetectable, in which case the caller's `--mode` is trusted).
 */
export function requireMatchingReferenceMode(eftDir: string, mode: GameMode): GameMode | null {
  const refMode = detectReferenceMode(eftDir);
  if (refMode && refMode !== mode) {
    // The newest capture belongs to another mode. That is only an error when no
    // usable capture for the requested mode exists at all - findReferenceFile(
    // eftDir, mode) picks the newest matching capture (treating a candidate
    // whose mode cannot be detected as plausible, so callers then trust --mode),
    // and this guard mirrors that same plausibility rule.
    const hasMatching = findQuestListFiles(eftDir).some((f) => {
      const candidateMode = modeFromReferenceFile(f);
      // Mirror findReferenceFile: a valid capture whose mode cannot be detected
      // is plausible for any requested mode (callers then trust --mode); an
      // unparseable capture is not usable and never counts.
      return candidateMode === null || candidateMode === mode;
    });
    if (!hasMatching) {
      throw new Error(
        `No ${mode} reference file found in ${eftDir}: the newest capture is ${refMode}. ` +
          `Re-run with --mode ${refMode}, or supply a ${mode} reference file.`
      );
    }
  }
  return refMode;
}

function printReport(discrepancies: Discrepancy[], matched: number, apiMissing: number): void {
  printHeader('REFERENCE vs TARKOV.DEV');

  const isDescription = (d: Discrepancy) => d.field.endsWith('.description');
  const isCount = (d: Discrepancy) => d.field.endsWith('.count');

  const byField = new Map<string, Discrepancy[]>();
  for (const d of discrepancies) {
    const key = isCount(d)
      ? 'objective.count'
      : isDescription(d)
        ? 'objective.description'
        : d.field;
    (byField.get(key) ?? byField.set(key, []).get(key)!).push(d);
  }

  for (const [field, items] of byField) {
    console.log(bold(`\n${field} (${items.length})`));
    for (const d of items) {
      if (field === 'objective.description') {
        const objId = d.field.replace(/^objective\[(.*)\]\.description$/, '$1');
        console.log(
          `  ${d.taskName} ${dim(`(${d.taskId})`)} ${dim(objId)} : ${icons.warning}\n` +
            `     api: ${colors.red}${d.api}${colors.reset}\n` +
            `     eft: ${colors.green}${d.eft}${colors.reset}`
        );
      } else {
        console.log(
          `  ${d.taskName} ${dim(`(${d.taskId})`)} : ${icons.warning}\n` +
            `     api: ${colors.red}${d.api}${colors.reset}  ` +
            `eft: ${colors.green}${d.eft}${colors.reset}` +
            (isCount(d) ? `  ${dim(d.field)}` : '')
        );
      }
    }
  }

  printHeader('SUMMARY');
  console.log(`  Matched tasks (reference ∩ api): ${matched}`);
  console.log(`  In reference but not in api:     ${apiMissing}`);
  console.log(`  Discrepancies:              ${bold(String(discrepancies.length))}`);
  console.log();
}

async function main(): Promise<void> {
  try {
    const opts = parseModeArgs(process.argv.slice(2), ['--descriptions']);

    printProgress(`Parsing quest reference file from ${opts.eftDir}...`);
    const refFile = findReferenceFile(opts.eftDir, opts.mode);

    // The reference file is mode-specific; refuse a mismatch.
    requireMatchingReferenceMode(opts.eftDir, opts.mode);

    const eftTasks = parseEftTasks(readQuestArray(refFile));
    printSuccess(`Parsed ${eftTasks.size} quests from reference file`);

    printProgress(`Fetching ${opts.mode} tasks from tarkov.dev...`);
    const apiTasks = await fetchTasks(opts.mode);
    printSuccess(`Fetched ${apiTasks.length} ${opts.mode} tasks from API\n`);

    const { discrepancies, matched, apiMissing } = compare(eftTasks, apiTasks, {
      descriptions: opts.flags.has('--descriptions'),
    });
    printReport(discrepancies, matched, apiMissing);

    if (opts.jsonOut) {
      writeFileSync(opts.jsonOut, JSON.stringify(discrepancies, null, 2));
      printSuccess(`Wrote ${discrepancies.length} discrepancies to ${opts.jsonOut}`);
    }

    process.exit(0);
  } catch (error) {
    printError('Error during EFT comparison:', error as Error);
    process.exit(1);
  }
}

if (isDirectExecution(import.meta.url)) {
  main();
}

/**
 * Convenience loader: find the quest reference file in `eftDir`, parse it, and
 * return the normalized task map. Returns null when no reference file is present
 * so callers can skip the cross-check cleanly instead of throwing.
 */
export function loadEftTasks(eftDir: string, mode?: GameMode): Map<string, EftTask> | null {
  let refFile: string;
  try {
    refFile = findReferenceFile(eftDir, mode);
  } catch {
    return null;
  }

  // The reference is an optional local-only input, so a present-but-unusable
  // file (broken symlink, truncated download, unexpected shape) must degrade to
  // "no reference" rather than aborting the whole maintenance run.
  try {
    return parseEftTasks(readQuestArray(refFile));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`Warning: ignoring unusable quest reference '${refFile}': ${reason}`);
    return null;
  }
}

/**
 * Infer the game mode from a reference file's captured request URL
 * (`gw-pve` / `gw-pvp` gateway hosts). Null when the URL is inconclusive.
 */
export function modeFromRequestUrl(url: string | undefined): GameMode | null {
  if (!url) return null;
  if (url.includes('gw-pve')) return 'pve';
  if (url.includes('gw-pvp')) return 'regular';
  return null;
}

/**
 * Detect which game mode a reference file represents from its request URL
 * metadata. Returns null when no reference file is present or the mode can't be
 * determined, so callers can decide how strict to be.
 */
export function detectReferenceMode(eftDir: string): GameMode | null {
  let refFile: string;
  try {
    refFile = findReferenceFile(eftDir);
  } catch {
    return null;
  }
  const mode = modeFromReferenceFile(refFile);
  return mode === 'unusable' ? null : mode;
}

export { parseEftTasks, compare, readQuestArray, type EftTask, type Discrepancy };
