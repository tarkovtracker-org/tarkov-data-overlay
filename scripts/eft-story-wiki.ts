#!/usr/bin/env tsx
/**
 * Fetch story-chapter Objectives sections from the EFT wiki (MediaWiki api.php)
 * and parse each line into {text, optional}. Used to overlay player-facing
 * optional/required flags onto the story-chapter objective text.
 *
 * Writes data/eft/story-wiki-objectives.json: { chapterId: [ {text, optional}, ... ] }
 * (derived output, gitignored). Exits non-zero if any chapter fails to parse.
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { isDirectExecution } from '../src/lib/index.js';

const WIKI_API = 'https://escapefromtarkov.fandom.com/api.php';

/** chapterId -> wiki page title */
const PAGES: Record<string, string> = {
  tour: 'Tour',
  'falling-skies': 'Falling_Skies',
  batya: 'Batya',
  'the-unheard': 'The_Unheard',
  'blue-fire': 'Blue_Fire',
  'they-are-already-here': 'They_Are_Already_Here',
  'accidental-witness': 'Accidental_Witness',
  'the-labyrinth': 'The_Labyrinth_(story_chapter)',
  'the-ticket': 'The_Ticket',
  boreas: 'Boreas',
};

const LINK_RE = /\[\[(?:[^\]|]*\|)?([^\]]+)\]\]/g; // [[A|B]] -> B, [[A]] -> A
const TAG_RE = /<[^>]+>/g; // drop <font>...</font> etc
const OPT_RE = /\(\s*'{2,}\s*optional\s*'{2,}\s*\)/gi;

export interface WikiStoryObjective {
  text: string;
  optional: boolean;
}

export async function fetchWikitext(title: string): Promise<string> {
  const url = `${WIKI_API}?action=parse&page=${title}&prop=wikitext&format=json`;
  const response = await fetch(url, {
    headers: { 'User-Agent': 'tarkov-data-overlay story extractor' },
  });
  if (!response.ok) {
    throw new Error(`${title}: HTTP ${response.status}`);
  }
  const data = (await response.json()) as {
    parse?: { wikitext?: { '*': string } };
    error?: { info?: string };
  };
  if (data.error) {
    throw new Error(`${title}: ${data.error.info}`);
  }
  const wikitext = data.parse?.wikitext?.['*'];
  if (typeof wikitext !== 'string') {
    throw new Error(`${title}: no wikitext in response`);
  }
  return wikitext;
}

/** Strip wiki markup to plain text, and report whether it's optional. */
export function cleanObjectiveLine(line: string): WikiStoryObjective {
  const optional = OPT_RE.test(line);
  OPT_RE.lastIndex = 0;
  let text = line
    .replace(OPT_RE, '')
    .replace(LINK_RE, '$1')
    .replace(TAG_RE, '')
    .replaceAll("'''", '')
    .replaceAll("''", '')
    .replace(/\s+/g, ' ');
  text = text.replace(/^[ *:]+/, '').replace(/[ *:]+$/, '').trim();
  return { text, optional };
}

export function parseObjectives(wikitext: string): WikiStoryObjective[] {
  const match = /==\s*Objectives\s*==([\s\S]*?)(\n==[^=]|$)/.exec(wikitext);
  if (!match) return [];
  const out: WikiStoryObjective[] = [];
  for (const raw of match[1].split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('*')) continue; // skip conditional headers ('''If...'''), <hr/>, blanks
    const { text, optional } = cleanObjectiveLine(line);
    if (text) out.push({ text, optional });
  }
  return out;
}

async function main(): Promise<void> {
  const outDir = join('data', 'eft');
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, 'story-wiki-objectives.json');

  const result: Record<string, WikiStoryObjective[]> = {};
  const failures: string[] = [];

  for (const [chapterId, title] of Object.entries(PAGES)) {
    try {
      const wikitext = await fetchWikitext(title);
      const objectives = parseObjectives(wikitext);
      if (objectives.length === 0) {
        throw new Error('no objectives parsed from Objectives section');
      }
      result[chapterId] = objectives;
      const optionalCount = objectives.filter((o) => o.optional).length;
      console.error(
        `  ${chapterId.padEnd(22)} ${String(objectives.length).padStart(3)} objectives (${optionalCount} optional)`
      );
    } catch (error) {
      console.error(`  ${chapterId.padEnd(22)} FAILED: ${(error as Error).message}`);
      failures.push(chapterId);
    }
  }

  writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.error(`wrote ${outPath}`);

  if (failures.length > 0) {
    // Fail loud: an empty/partial wiki set silently mislabels optionals
    // downstream, so do not let the pipeline continue on a clean exit.
    console.error(`error: ${failures.length} chapter(s) failed: ${failures.join(', ')}`);
    process.exit(1);
  }
}

if (isDirectExecution(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
