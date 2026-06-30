#!/usr/bin/env tsx
/**
 * Normalize a raw EFT quest reference file into clean, minimal local files.
 *
 * The raw reference is a deeply nested response envelope full of fields
 * irrelevant to data validation (mail settings, UI flags, raw reward item
 * trees, per-language localization, etc). This script distills it into one tidy
 * `quests.json` keyed by tarkov.dev-compatible quest id, keeping only the
 * fields useful for cross-checking the overlay:
 *
 *   id, name, trader, map, type, side, flags, minPlayerLevel, experience,
 *   prerequisite quests, and objectives (id, type, text, count).
 *
 * The enriched reference variant (`rollinglatest.modified`) inlines names as
 * `[id] Name` and embeds a `localization.en` block; this script handles both
 * the enriched and plain variants, preferring the enriched one.
 *
 * IMPORTANT: input reference files and this normalized output are LOCAL-ONLY.
 * Both `eft/` and the default output dir are gitignored. Nothing here should be
 * committed.
 *
 * Usage:
 *   tsx scripts/eft-normalize.ts [eftDir] [--out data/eft] [--lang ru,fr,all]
 *
 * eftDir defaults to ./eft; output defaults to ./data/eft (both gitignored).
 * --lang attaches localized quest names + objective text for the given
 * language codes (comma-separated, or `all`). Codes are normalized to BCP47
 * (the source's `ge`->`de`, `ch`->`zh`, etc). English is always the base.
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'fs';
import { join, isAbsolute } from 'path';
import { pathToFileURL } from 'url';
import { printProgress, printSuccess, printError } from '../src/lib/index.js';

/** Quest prereq status codes. */
const STATUS_NAMES: Record<number, string> = {
  2: 'started',
  4: 'complete',
  5: 'fail',
};

/**
 * Map the source's localization language codes to standard BCP47 codes.
 * The source uses a few nonstandard codes (`ge` for German, `ch` for Chinese,
 * `po` for Portuguese, `kr` for Korean, etc). Codes not listed pass through
 * unchanged.
 */
const LANG_CODE_MAP: Record<string, string> = {
  ge: 'de', // German
  ch: 'zh', // Chinese
  cz: 'cs', // Czech
  po: 'pt', // Portuguese
  kr: 'ko', // Korean
  jp: 'ja', // Japanese
  in: 'id', // Indonesian
  tu: 'tr', // Turkish
  vi: 'vi', // Vietnamese
  'es-mx': 'es-MX',
};

/** Normalize a source language code to BCP47. */
function toBcp47(code: string): string {
  return LANG_CODE_MAP[code] ?? code;
}

/** Finish-condition types that carry a player-facing objective with text. */
const OBJECTIVE_CONDITIONS = new Set([
  'CounterCreator',
  'FindItem',
  'HandoverItem',
  'LeaveItemAtLocation',
  'PlaceBeacon',
  'SellItemToTrader',
  'WeaponAssembly',
  'Skill',
  'TraderLoyalty',
  'TraderStanding',
  'LocationTrigger',
  'VisitPlace',
  'HasItem',
  'CompletableItem',
  'Quest',
]);

const ID_PATTERN = /[0-9a-f]{24}/;

/** Extract a bare 24-hex id from a value that may be wrapped as `[id] Name`. */
function bareId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = ID_PATTERN.exec(value);
  return match ? match[0] : undefined;
}

/** Strip a leading `[id] ` / `[id name] ` wrapper, returning just the label. */
function inlineLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const stripped = value.replace(/^\[[^\]]*\]\s*/, '').trim();
  return stripped.length > 0 ? stripped : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

interface CleanRef {
  id?: string;
  name?: string;
}

interface CleanObjective {
  id: string;
  type: string;
  description?: string;
  count?: number;
  /** Localized objective text, keyed by BCP47 language code. Only present when
   * languages are requested via --lang. */
  locale?: Record<string, string>;
}

interface CleanQuestRequirement {
  id?: string;
  status?: string[];
}

interface CleanQuest {
  id: string;
  name?: string;
  /** Localized quest name, keyed by BCP47 language code. Only present when
   * languages are requested via --lang. */
  nameLocale?: Record<string, string>;
  type?: string;
  side?: string;
  trader?: CleanRef;
  map?: CleanRef;
  minPlayerLevel?: number;
  experience?: number;
  isKey?: boolean;
  restartable?: boolean;
  secretQuest?: boolean;
  isStoryQuest?: boolean;
  requires?: CleanQuestRequirement[];
  objectives: CleanObjective[];
}

interface NormalizedOutput {
  $meta: {
    source: string;
    mode: 'pve' | 'regular' | 'unknown';
    appVersion?: string;
    capturedAt?: string;
    generated: string;
    questCount: number;
    /** BCP47 language codes included beyond English, when --lang is used. */
    languages?: string[];
  };
  quests: Record<string, CleanQuest>;
}

/** Pull the quest array out of the reference-file envelope. */
function readEnvelope(file: string): {
  quests: Record<string, unknown>[];
  url?: string;
  appVersion?: string;
  capturedAt?: string;
} {
  const raw = JSON.parse(readFileSync(file, 'utf-8')) as any;
  const decoded = raw?.response?.decoded_response;
  const data = decoded?.data ?? raw?.data ?? raw;
  if (!Array.isArray(data)) {
    throw new Error(`Unexpected quest reference shape in ${file}: expected an array of quests`);
  }
  return {
    quests: data as Record<string, unknown>[],
    url: raw?.request?.url,
    appVersion: raw?.request?.headers?.['App-Version'],
    capturedAt: raw?.request?.timestamp,
  };
}

function normalizeStatus(status: unknown): string[] | undefined {
  if (!Array.isArray(status) || status.length === 0) return undefined;
  const names = status
    .map((s) => STATUS_NAMES[Number(s)] ?? String(s))
    .filter((s, i, arr) => arr.indexOf(s) === i);
  return names.length > 0 ? names : undefined;
}

function normalizeQuest(raw: Record<string, any>, langs: string[] = []): CleanQuest | undefined {
  const id = bareId(raw._id);
  if (!id) return undefined;

  const localization: Record<string, Record<string, string>> = raw.localization ?? {};
  const en: Record<string, string> = localization.en ?? {};
  const start: any[] = raw.conditions?.AvailableForStart ?? [];
  const finish: any[] = raw.conditions?.AvailableForFinish ?? [];

  // Only request languages the reference actually carries for this quest.
  const extraLangs = langs.filter((lg) => lg !== 'en' && localization[lg]);

  // name: prefer inline label, fall back to localized `<id> name`.
  const name = inlineLabel(raw.name) ?? en[`${id} name`];
  const nameLocale: Record<string, string> = {};
  for (const lg of extraLangs) {
    const localizedName = localization[lg]?.[`${id} name`];
    if (typeof localizedName === 'string' && localizedName.trim()) {
      nameLocale[toBcp47(lg)] = localizedName;
    }
  }

  const minPlayerLevel = start
    .filter((c) => c?.conditionType === 'Level')
    .map((c) => asNumber(c.value))
    .find((v) => v !== undefined);

  const experience = (raw.rewards?.Success ?? [])
    .filter((r: any) => r?.type === 'Experience')
    .map((r: any) => asNumber(r.value))
    .find((v: number | undefined) => v !== undefined);

  const requires: CleanQuestRequirement[] = start
    .filter((c) => c?.conditionType === 'Quest')
    .map((c): CleanQuestRequirement | undefined => {
      const reqId = bareId(c.target);
      if (!reqId) return undefined;
      const status = normalizeStatus(c.status);
      return status ? { id: reqId, status } : { id: reqId };
    })
    .filter((r): r is CleanQuestRequirement => Boolean(r));

  const objectives: CleanObjective[] = finish
    .filter((c) => c?.conditionType && OBJECTIVE_CONDITIONS.has(c.conditionType))
    .map((c) => {
      const oid = bareId(c.id);
      if (!oid) return undefined;
      const obj: CleanObjective = { id: oid, type: c.conditionType };
      const text = en[oid];
      if (typeof text === 'string') obj.description = text;
      const count = asNumber(c.value);
      if (count !== undefined) obj.count = count;
      const locale: Record<string, string> = {};
      for (const lg of extraLangs) {
        const localized = localization[lg]?.[oid];
        if (typeof localized === 'string' && localized.trim()) {
          locale[toBcp47(lg)] = localized;
        }
      }
      if (Object.keys(locale).length > 0) obj.locale = locale;
      return obj;
    })
    .filter((o): o is CleanObjective => Boolean(o));

  const trader: CleanRef = {
    id: bareId(raw.traderId),
    name: inlineLabel(raw.traderId),
  };
  const map: CleanRef = {
    id: bareId(raw.location),
    name: inlineLabel(raw.location),
  };

  const quest: CleanQuest = { id, objectives };
  if (name) quest.name = name;
  if (Object.keys(nameLocale).length > 0) quest.nameLocale = nameLocale;
  if (typeof raw.type === 'string') quest.type = raw.type;
  const side = inlineLabel(raw.side);
  if (side) quest.side = side;
  if (trader.id || trader.name) quest.trader = compactRef(trader);
  if (map.id || map.name) quest.map = compactRef(map);
  if (minPlayerLevel !== undefined) quest.minPlayerLevel = minPlayerLevel;
  if (experience !== undefined) quest.experience = experience;
  if (raw.isKey === true) quest.isKey = true;
  if (raw.restartable === true) quest.restartable = true;
  if (raw.secretQuest === true) quest.secretQuest = true;
  if (raw.isStoryQuest === true) quest.isStoryQuest = true;
  if (requires.length > 0) quest.requires = requires;

  return quest;
}

function compactRef(ref: CleanRef): CleanRef {
  const out: CleanRef = {};
  if (ref.id) out.id = ref.id;
  if (ref.name) out.name = ref.name;
  return out;
}

/** Locate the quest reference file, preferring the enriched variant. */
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

function detectMode(url?: string): 'pve' | 'regular' | 'unknown' {
  if (!url) return 'unknown';
  if (url.includes('gw-pve')) return 'pve';
  if (url.includes('gw-pvp')) return 'regular';
  return 'unknown';
}

/** Collect the set of language codes present across all quests. */
function collectLanguages(rawQuests: Record<string, unknown>[]): string[] {
  const langs = new Set<string>();
  for (const raw of rawQuests) {
    const loc = (raw as any)?.localization;
    if (loc && typeof loc === 'object') {
      for (const lg of Object.keys(loc)) langs.add(lg);
    }
  }
  return [...langs];
}

export function normalizeQuestData(file: string, langs: string[] = []): NormalizedOutput {
  const { quests: rawQuests, url, appVersion, capturedAt } = readEnvelope(file);

  // 'all' expands to every language the reference carries (minus English, the base).
  const available = collectLanguages(rawQuests).filter((lg) => lg !== 'en');
  const requested = langs.includes('all')
    ? available
    : langs.filter((lg) => lg !== 'en' && available.includes(lg));

  const quests: Record<string, CleanQuest> = {};
  for (const raw of rawQuests) {
    const clean = normalizeQuest(raw as Record<string, any>, requested);
    if (clean) quests[clean.id] = clean;
  }

  const includedLanguages = [...new Set(requested.map(toBcp47))].sort();

  return {
    $meta: {
      source: 'eft-quest-reference',
      mode: detectMode(url),
      appVersion,
      capturedAt,
      generated: new Date().toISOString(),
      questCount: Object.keys(quests).length,
      ...(includedLanguages.length > 0 ? { languages: includedLanguages } : {}),
    },
    quests,
  };
}

interface Options {
  eftDir: string;
  outDir: string;
  langs: string[];
}

function parseArgs(argv: string[]): Options {
  let eftDir = 'eft';
  let outDir = 'data/eft';
  let langs: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') {
      const value = argv[(i += 1)];
      if (value === undefined) throw new Error('--out requires a directory path');
      outDir = value;
    } else if (arg === '--lang') {
      langs = (argv[(i += 1)] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (!arg.startsWith('--')) eftDir = arg;
  }
  const resolve = (p: string) => (isAbsolute(p) ? p : join(process.cwd(), p));
  return { eftDir: resolve(eftDir), outDir: resolve(outDir), langs };
}

async function main(): Promise<void> {
  try {
    const opts = parseArgs(process.argv.slice(2));

    printProgress(`Reading quest reference file from ${opts.eftDir}...`);
    const refFile = findReferenceFile(opts.eftDir);
    const output = normalizeQuestData(refFile, opts.langs);
    const langNote = output.$meta.languages?.length
      ? ` + ${output.$meta.languages.length} language(s)`
      : '';
    printSuccess(
      `Normalized ${output.$meta.questCount} quests (mode: ${output.$meta.mode})${langNote}`
    );

    mkdirSync(opts.outDir, { recursive: true });
    const outFile = join(opts.outDir, `quests.${output.$meta.mode}.json`);
    writeFileSync(outFile, `${JSON.stringify(output, null, 2)}\n`);
    printSuccess(`Wrote ${outFile}`);

    process.exit(0);
  } catch (error) {
    printError('Error normalizing quest reference file:', error as Error);
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

export type { CleanQuest, CleanObjective, NormalizedOutput };
