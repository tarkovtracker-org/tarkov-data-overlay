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

import { readFileSync, readdirSync, writeFileSync } from 'fs';
import { join, isAbsolute } from 'path';
import { pathToFileURL } from 'url';
import {
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

/** Locate the quest reference file inside the eft directory. Prefers the
 * enriched ("rollinglatest.modified") variant since it additionally carries
 * `localization.en` objective text. */
function findReferenceFile(eftDir: string): string {
  const candidates = readdirSync(eftDir).filter(
    (f) => /quest[_-]list/i.test(f) && f.endsWith('.json'),
  );
  if (candidates.length === 0) {
    throw new Error(`No quest reference file found in ${eftDir}`);
  }
  const enriched = candidates.find((f) => f.includes('rollinglatest.modified'));
  return join(eftDir, enriched ?? candidates[0]);
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
  options: { descriptions?: boolean } = {},
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

    if (eft.experience !== undefined && api.experience !== undefined && eft.experience !== api.experience) {
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
  eftTasks: Map<string, EftTask>,
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

interface Options {
  eftDir: string;
  mode: GameMode;
  jsonOut?: string;
  descriptions: boolean;
}

function parseArgs(argv: string[]): Options {
  let eftDir = 'eft';
  let mode: GameMode = 'pve';
  let jsonOut: string | undefined;
  let descriptions = false;

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
    } else if (arg === '--descriptions') {
      descriptions = true;
    } else if (!arg.startsWith('--')) {
      eftDir = arg;
    }
  }

  return {
    eftDir: isAbsolute(eftDir) ? eftDir : join(process.cwd(), eftDir),
    mode,
    jsonOut,
    descriptions,
  };
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
          `  ${icons.warning} ${d.taskName} ${dim(`(${d.taskId})`)} ${dim(objId)}\n` +
            `     api: ${colors.red}${d.api}${colors.reset}\n` +
            `     eft: ${colors.green}${d.eft}${colors.reset}`,
        );
      } else {
        console.log(
          `  ${icons.warning} ${d.taskName} ${dim(`(${d.taskId})`)}\n` +
            `     api: ${colors.red}${d.api}${colors.reset}  ` +
            `eft: ${colors.green}${d.eft}${colors.reset}` +
            (isCount(d) ? `  ${dim(d.field)}` : ''),
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
    const opts = parseArgs(process.argv.slice(2));

    printProgress(`Parsing quest reference file from ${opts.eftDir}...`);
    const refFile = findReferenceFile(opts.eftDir);

    // The reference file is mode-specific. Comparing it against a different
    // tarkov.dev mode yields false discrepancies, so refuse a mismatch (same
    // guard the audit uses).
    const refMode = detectReferenceMode(opts.eftDir);
    if (refMode && refMode !== opts.mode) {
      throw new Error(
        `The reference file in ${opts.eftDir} is a ${refMode} file, but --mode is ${opts.mode}. ` +
          `Re-run with --mode ${refMode}, or supply a ${opts.mode} reference file.`,
      );
    }

    const eftTasks = parseEftTasks(readQuestArray(refFile));
    printSuccess(`Parsed ${eftTasks.size} quests from reference file`);

    printProgress(`Fetching ${opts.mode} tasks from tarkov.dev...`);
    const apiTasks = await fetchTasks(opts.mode);
    printSuccess(`Fetched ${apiTasks.length} ${opts.mode} tasks from API\n`);

    const { discrepancies, matched, apiMissing } = compare(eftTasks, apiTasks, {
      descriptions: opts.descriptions,
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

function isDirectExecution(): boolean {
  const entryFile = process.argv[1];
  if (!entryFile) return false;
  return import.meta.url === pathToFileURL(entryFile).href;
}

if (isDirectExecution()) {
  main();
}

/**
 * Convenience loader: find the quest reference file in `eftDir`, parse it, and
 * return the normalized task map. Returns null when no reference file is present
 * so callers can skip the cross-check cleanly instead of throwing.
 */
export function loadEftTasks(eftDir: string): Map<string, EftTask> | null {
  let refFile: string;
  try {
    refFile = findReferenceFile(eftDir);
  } catch {
    return null;
  }
  return parseEftTasks(readQuestArray(refFile));
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
  const raw = JSON.parse(readFileSync(refFile, 'utf-8')) as any;
  const url: string = raw?.request?.url ?? '';
  if (url.includes('gw-pve')) return 'pve';
  if (url.includes('gw-pvp')) return 'regular';
  return null;
}

export { parseEftTasks, compare, readQuestArray, type EftTask, type Discrepancy };
