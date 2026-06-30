#!/usr/bin/env tsx
/**
 * Cross-reference reference-vs-tarkov.dev discrepancies against the EFT wiki.
 *
 * `eft:compare` already finds where the local quest reference file (authoritative
 * for numeric quest fields) disagrees with the tarkov.dev API. For each such
 * discrepancy this script pulls the matching wiki page and shows what the wiki
 * says, so you can see whether the wiki backs the reference (eft), the API, or
 * neither. The wiki is largely PVP/regular data, so a wiki match against a PVE
 * reference value is not guaranteed — that's exactly what we're checking.
 *
 * Only the two fields the wiki exposes cleanly are cross-checked:
 *   - minPlayerLevel (wiki "Requirements" level line)
 *   - experience     (wiki "Rewards" EXP line)
 *
 * Usage:
 *   tsx scripts/eft-wiki-crosscheck.ts [eftDir] [--mode pve|regular] [--json out.json]
 *
 * eftDir defaults to ./eft. Reuses the wiki fetch/parse from wiki-compare and
 * the reference parser from eft-compare; both are pure imports here.
 */

import { writeFileSync } from 'fs';
import { isAbsolute, join } from 'path';
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
  type GameMode,
  type TaskData,
} from '../src/lib/index.js';
import { loadEftTasks, type EftTask } from './eft-compare.js';
import { parseWikiTask, buildMapAliasMap } from './wiki-compare.js';

const WIKI_API = 'https://escapefromtarkov.fandom.com/api.php';
const RATE_LIMIT_MS = 500;

type Field = 'minPlayerLevel' | 'experience';

interface Row {
  taskId: string;
  taskName: string;
  field: Field;
  api: number | undefined;
  eft: number;
  wiki: number | undefined;
  /** which source(s) the wiki value agrees with */
  wikiAgreesWith: 'eft' | 'api' | 'both' | 'neither' | 'no-wiki-value';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** tarkov.dev wikiLink -> wiki page title. */
function wikiTitleFor(task: TaskData): string {
  if (task.wikiLink) {
    const match = task.wikiLink.match(/\/wiki\/(.+)$/);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  return task.name;
}

async function fetchWikitext(title: string): Promise<string | undefined> {
  const params = new URLSearchParams({
    action: 'parse',
    page: title,
    prop: 'wikitext',
    format: 'json',
  });
  const res = await fetch(`${WIKI_API}?${params.toString()}`);
  if (!res.ok) return undefined;
  const data = (await res.json()) as {
    parse?: { wikitext?: { '*': string } };
    error?: unknown;
  };
  return data.parse?.wikitext?.['*'];
}

/** Build the discrepant (field, eft, api) rows the same way eft:compare does. */
function buildDiscrepancies(
  eftTasks: Map<string, EftTask>,
  apiTasks: TaskData[],
): Array<{ task: TaskData; field: Field; api: number; eft: number }> {
  const out: Array<{ task: TaskData; field: Field; api: number; eft: number }> = [];
  for (const eft of eftTasks.values()) {
    const api = findTaskById(apiTasks, eft.id);
    if (!api) continue;
    if (
      eft.experience !== undefined &&
      api.experience !== undefined &&
      eft.experience !== api.experience
    ) {
      out.push({ task: api, field: 'experience', api: api.experience, eft: eft.experience });
    }
    if (
      eft.minPlayerLevel !== undefined &&
      api.minPlayerLevel !== undefined &&
      eft.minPlayerLevel !== api.minPlayerLevel
    ) {
      out.push({
        task: api,
        field: 'minPlayerLevel',
        api: api.minPlayerLevel,
        eft: eft.minPlayerLevel,
      });
    }
  }
  return out;
}

function agreement(
  api: number | undefined,
  eft: number,
  wiki: number | undefined,
): Row['wikiAgreesWith'] {
  if (wiki === undefined) return 'no-wiki-value';
  const matchesEft = wiki === eft;
  const matchesApi = api !== undefined && wiki === api;
  if (matchesEft && matchesApi) return 'both';
  if (matchesEft) return 'eft';
  if (matchesApi) return 'api';
  return 'neither';
}

interface Options {
  eftDir: string;
  mode: GameMode;
  jsonOut?: string;
}

function parseArgs(argv: string[]): Options {
  let eftDir = 'eft';
  let mode: GameMode = 'pve';
  let jsonOut: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--mode') {
      const v = argv[(i += 1)];
      if (v !== 'pve' && v !== 'regular') throw new Error(`--mode must be 'pve' or 'regular'`);
      mode = v;
    } else if (arg === '--json') {
      jsonOut = argv[(i += 1)];
    } else if (!arg.startsWith('--')) {
      eftDir = arg;
    }
  }
  return { eftDir: isAbsolute(eftDir) ? eftDir : join(process.cwd(), eftDir), mode, jsonOut };
}

function colorFor(verdict: Row['wikiAgreesWith']): string {
  switch (verdict) {
    case 'eft':
      return colors.green;
    case 'api':
      return colors.red;
    case 'both':
      return colors.cyan;
    default:
      return colors.yellow;
  }
}

function printReport(rows: Row[]): void {
  printHeader('REFERENCE vs TARKOV.DEV — WIKI CROSS-CHECK');

  const byField = new Map<Field, Row[]>();
  for (const r of rows) (byField.get(r.field) ?? byField.set(r.field, []).get(r.field)!).push(r);

  for (const [field, items] of byField) {
    console.log(bold(`\n${field} (${items.length})`));
    for (const r of items) {
      const wikiStr =
        r.wiki === undefined ? dim('(no wiki value)') : `${colorFor(r.wikiAgreesWith)}${r.wiki}${colors.reset}`;
      console.log(
        `  ${icons.warning} ${r.taskName} ${dim(`(${r.taskId})`)}\n` +
          `     api: ${colors.red}${r.api}${colors.reset}  ` +
          `eft: ${colors.green}${r.eft}${colors.reset}  ` +
          `wiki: ${wikiStr}  ${dim(`→ wiki backs ${r.wikiAgreesWith}`)}`,
      );
    }
  }

  const tally = (v: Row['wikiAgreesWith']) => rows.filter((r) => r.wikiAgreesWith === v).length;
  printHeader('SUMMARY');
  console.log(`  Discrepancies cross-checked: ${rows.length}`);
  console.log(`  Wiki backs reference:        ${bold(String(tally('eft')))}`);
  console.log(`  Wiki backs tarkov.dev API:   ${bold(String(tally('api')))}`);
  console.log(`  Wiki agrees with both:       ${tally('both')} ${dim('(api==eft, not a real conflict)')}`);
  console.log(`  Wiki agrees with neither:    ${tally('neither')}`);
  console.log(`  No usable wiki value:        ${tally('no-wiki-value')}`);
  console.log();
}

async function main(): Promise<void> {
  try {
    const opts = parseArgs(process.argv.slice(2));

    printProgress(`Parsing quest reference file from ${opts.eftDir}...`);
    const eftTasks = loadEftTasks(opts.eftDir);
    if (!eftTasks) throw new Error(`No quest reference file found in ${opts.eftDir}`);
    printSuccess(`Parsed ${eftTasks.size} quests from reference file`);

    printProgress(`Fetching ${opts.mode} tasks from tarkov.dev...`);
    const apiTasks = await fetchTasks(opts.mode);
    printSuccess(`Fetched ${apiTasks.length} ${opts.mode} tasks from API`);

    const discrepancies = buildDiscrepancies(eftTasks, apiTasks);
    printSuccess(`Found ${discrepancies.length} numeric discrepancies to cross-check\n`);

    // One wiki page per task (a task may have both fields discrepant); cache by id.
    const mapAliasMap = buildMapAliasMap([]);
    const wikitextCache = new Map<string, string | undefined>();
    const rows: Row[] = [];

    for (const d of discrepancies) {
      const title = wikiTitleFor(d.task);
      if (!wikitextCache.has(d.task.id)) {
        printProgress(`Fetching wiki: ${title}...`);
        wikitextCache.set(d.task.id, await fetchWikitext(title));
        await sleep(RATE_LIMIT_MS);
      }
      const wikitext = wikitextCache.get(d.task.id);
      let wiki: number | undefined;
      if (wikitext) {
        const parsed = parseWikiTask(title, wikitext, mapAliasMap);
        wiki = d.field === 'minPlayerLevel' ? parsed.minPlayerLevel : parsed.rewards.xp;
      }
      rows.push({
        taskId: d.task.id,
        taskName: d.task.name,
        field: d.field,
        api: d.api,
        eft: d.eft,
        wiki,
        wikiAgreesWith: agreement(d.api, d.eft, wiki),
      });
    }

    printReport(rows);

    if (opts.jsonOut) {
      writeFileSync(opts.jsonOut, JSON.stringify(rows, null, 2));
      printSuccess(`Wrote ${rows.length} cross-checked rows to ${opts.jsonOut}`);
    }

    process.exit(0);
  } catch (error) {
    printError('Error during EFT/wiki cross-check:', error as Error);
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
