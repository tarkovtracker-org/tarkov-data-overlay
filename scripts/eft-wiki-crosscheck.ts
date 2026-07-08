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

import {
  isDirectExecution,
  sleep,
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
} from '../src/lib/index.js';
import {
  loadEftTasks,
  parseModeArgs,
  requireMatchingReferenceMode,
  type EftTask,
} from './eft-compare.js';
import { parseWikiTask, buildMapAliasMap } from './wiki-compare.js';

const WIKI_API = 'https://escapefromtarkov.fandom.com/api.php';
const RATE_LIMIT_MS = 500;
const FETCH_TIMEOUT_MS = 15000;

type Field = 'minPlayerLevel' | 'experience';

interface Row {
  taskId: string;
  taskName: string;
  field: Field;
  api: number | undefined;
  eft: number;
  wiki: number | undefined;
  /** which source(s) the wiki value agrees with. 'fetch-failed' means the wiki
   * request itself failed (timeout/HTTP error) - distinct from 'no-wiki-value',
   * where the page loaded but didn't carry the field. */
  wikiAgreesWith: 'eft' | 'api' | 'both' | 'neither' | 'no-wiki-value' | 'fetch-failed';
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
  // Bound the request so a hung connection can't stall the whole run.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${WIKI_API}?${params.toString()}`, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
  // A non-OK HTTP status is a fetch failure, not a "page has no wikitext";
  // surface it so the caller can tell the two apart.
  if (!res.ok) {
    throw new Error(`wiki request for "${title}" failed: HTTP ${res.status}`);
  }
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

/** Final wiki verdict for a row: a failed fetch is its own state, kept distinct
 * from a page that loaded but lacked the field ('no-wiki-value'). */
export function classifyWiki(
  api: number | undefined,
  eft: number,
  wiki: number | undefined,
  fetchFailed: boolean,
): Row['wikiAgreesWith'] {
  return fetchFailed ? 'fetch-failed' : agreement(api, eft, wiki);
}


function colorFor(verdict: Row['wikiAgreesWith']): string {
  switch (verdict) {
    case 'eft':
      return colors.green;
    case 'api':
      return colors.red;
    case 'both':
      return colors.cyan;
    case 'fetch-failed':
      return colors.red;
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
        r.wikiAgreesWith === 'fetch-failed'
          ? `${colors.red}(fetch failed)${colors.reset}`
          : r.wiki === undefined
            ? dim('(no wiki value)')
            : `${colorFor(r.wikiAgreesWith)}${r.wiki}${colors.reset}`;
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
  console.log(`  Wiki fetch failed:           ${tally('fetch-failed')}`);
  console.log();
}

async function main(): Promise<void> {
  try {
    const opts = parseModeArgs(process.argv.slice(2));

    printProgress(`Parsing quest reference file from ${opts.eftDir}...`);
    const eftTasks = loadEftTasks(opts.eftDir);
    if (!eftTasks) throw new Error(`No quest reference file found in ${opts.eftDir}`);

    // The reference file is mode-specific; refuse a mismatch so wiki rows
    // aren't built from cross-mode data.
    requireMatchingReferenceMode(opts.eftDir, opts.mode);
    printSuccess(`Parsed ${eftTasks.size} quests from reference file`);

    printProgress(`Fetching ${opts.mode} tasks from tarkov.dev...`);
    const apiTasks = await fetchTasks(opts.mode);
    printSuccess(`Fetched ${apiTasks.length} ${opts.mode} tasks from API`);

    const discrepancies = buildDiscrepancies(eftTasks, apiTasks);
    printSuccess(`Found ${discrepancies.length} numeric discrepancies to cross-check\n`);

    // One wiki page per task (a task may have both fields discrepant); cache by id.
    const mapAliasMap = buildMapAliasMap([]);
    const wikitextCache = new Map<string, string | undefined>();
    const fetchFailed = new Set<string>(); // task ids whose wiki request failed
    const rows: Row[] = [];

    for (const d of discrepancies) {
      const title = wikiTitleFor(d.task);
      if (!wikitextCache.has(d.task.id)) {
        printProgress(`Fetching wiki: ${title}...`);
        try {
          wikitextCache.set(d.task.id, await fetchWikitext(title));
        } catch (err) {
          // A failed fetch is NOT "wiki has no value" - track it separately so
          // the report/JSON don't conflate a timeout/HTTP error with a page
          // that genuinely lacks the field. Keep going rather than aborting.
          printError(`  wiki fetch failed for ${title}`, err as Error);
          wikitextCache.set(d.task.id, undefined);
          fetchFailed.add(d.task.id);
        }
        await sleep(RATE_LIMIT_MS);
      }
      const failed = fetchFailed.has(d.task.id);
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
        wikiAgreesWith: classifyWiki(d.api, d.eft, wiki, failed),
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

if (isDirectExecution(import.meta.url)) {
  main();
}
