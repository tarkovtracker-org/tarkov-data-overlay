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
import { isDirectExecution, MAX_RESPONSE_BYTES, readResponseJson } from '../src/lib/index.js';

const WIKI_API = 'https://escapefromtarkov.fandom.com/api.php';
const WIKI_MAX_RESPONSE_BYTES = Math.min(MAX_RESPONSE_BYTES, 8 * 1024 * 1024);

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
  const params = new URLSearchParams({
    action: 'parse',
    page: title,
    prop: 'wikitext',
    format: 'json',
  });
  const response = await fetch(WIKI_API, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'User-Agent': 'tarkov-data-overlay story extractor',
    },
    body: params,
    // Match the original Python port's urlopen(req, timeout=30) so a hung
    // wiki request fails loudly instead of blocking the pipeline forever.
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`${title}: HTTP ${response.status}`);
  }
  const data = (await readResponseJson(response, WIKI_API, WIKI_MAX_RESPONSE_BYTES, 'wiki')) as {
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
    // TAG_RE only matches a bracket pair, so markup hiding the delimiter
    // survives it and the italic pass can then rebuild a tag: `<''script`
    // becomes `<script`. Drop leftover brackets individually and last, since
    // single characters cannot recombine into a tag.
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ');
  text = text
    .replace(/^[ *:]+/, '')
    .replace(/[ *:]+$/, '')
    .trim();
  return { text, optional };
}

/**
 * A header opening a mutually exclusive branch, e.g.
 * `'''If the [[Armored case]] was given to [[Prapor]]'''` or
 * `===If you accept Mr. Kerman's offer===`.
 *
 * Distinguished from an unconditional sequencing header like
 * `'''Once you have the case'''` or `'''After completing [[Stick to It]]'''`,
 * which apply to every player and therefore close the branch before them.
 */
const CONDITIONAL_HEADER = /^(?:only\s+)?if\b/i;

/** `<hr/>` closes a group of branch alternatives and resumes the trunk. */
const RULE_LINE = /^<hr\s*\/?>/i;

/** Header text without its bold/heading delimiters. */
function headerText(line: string): string {
  return line
    .replace(/^[='\s]+/, '')
    .replace(/[='\s]+$/, '')
    .trim();
}

export function parseObjectives(wikitext: string): WikiStoryObjective[] {
  const match = /==\s*Objectives\s*==([\s\S]*?)(\n==[^=]|$)/.exec(wikitext);
  if (!match) return [];

  // Objectives under an "If ..." header only apply to players who took that
  // branch, so they are not universally required. The page marks individually
  // optional items inline, but says nothing per-bullet about branch membership -
  // it is carried by the header - so without tracking it every branch objective
  // reads as required and consumers block players who chose the other path.
  //
  // Two nesting levels are tracked because the pages mix them: `===If ...===`
  // wraps a whole ending, and `'''...'''` sub-headers appear inside it. A bold
  // sub-header must not be able to close the heading-level branch containing it,
  // which would leak that ending's objectives out as universally required.
  type Entry = WikiStoryObjective & {
    group: number;
    alt: number;
    inline: boolean;
    /** A conditional context encloses this entry's alternative. */
    ancestor: boolean;
  };
  const entries: Entry[] = [];
  let headingBranch = false;
  let boldBranch = false;
  // Consecutive alternatives share a group; `alt` identifies one alternative.
  let group = 0;
  let alt = 0;
  let inGroup = false;
  // Which header level owns the current alternative. A bold group nested inside a
  // conditional heading has that heading as a conditional ancestor, so convergence
  // within the group must not promote a step to universally required.
  let altLevel: 'heading' | 'bold' | null = null;
  const endGroup = () => {
    if (inGroup) group += 1;
    inGroup = false;
  };

  for (const raw of match[1].split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (!line.startsWith('*')) {
      if (RULE_LINE.test(line)) {
        // A rule ends the alternatives it follows and the universal storyline
        // resumes after it. That holds whether the alternatives were opened by a
        // bold sub-header (Boreas) or a conditional heading, so every branch
        // level resets here; leaving a heading branch open would mark post-rule
        // trunk objectives optional. No current chapter mixes the two forms, and
        // this keeps both readings of a rule consistent.
        boldBranch = false;
        headingBranch = false;
        endGroup();
        altLevel = null;
      } else if (line.startsWith('=')) {
        headingBranch = CONDITIONAL_HEADER.test(headerText(line));
        boldBranch = false;
        if (headingBranch) {
          // Consecutive conditional headings are alternatives of one group, so the
          // group must not be closed between them - otherwise each ending lands in
          // its own group and convergence can never be detected.
          inGroup = true;
          alt += 1;
          altLevel = 'heading';
        } else {
          endGroup();
          altLevel = null;
        }
      } else if (line.startsWith("'''")) {
        boldBranch = CONDITIONAL_HEADER.test(headerText(line));
        if (boldBranch) {
          inGroup = true;
          alt += 1;
          altLevel = 'bold';
        } else {
          endGroup();
          altLevel = null;
        }
      }
      // Anything else (stray markup) leaves the current branch state alone.
      continue;
    }
    const { text, optional } = cleanObjectiveLine(line);
    if (text) {
      entries.push({
        text,
        optional: optional || headingBranch || boldBranch,
        inline: optional,
        group,
        alt: headingBranch || boldBranch ? alt : 0,
        // Nothing encloses a heading-level alternative; a bold one inherits the
        // conditionality of the heading it sits under.
        ancestor: altLevel === 'bold' && headingBranch,
      });
    }
  }

  // Branch alternatives often converge: the same closing step is repeated under
  // every variant ("Tell Mechanic that you found transport", "Hand over the AMG-10
  // fluid"). Something every alternative requires is not branch-specific, so it
  // stays required rather than being published optional to everyone.
  const altsByGroup = new Map<number, Set<number>>();
  for (const entry of entries) {
    if (entry.alt === 0) continue;
    const alts = altsByGroup.get(entry.group) ?? new Set<number>();
    alts.add(entry.alt);
    altsByGroup.set(entry.group, alts);
  }
  const seenAlts = new Map<string, Set<number>>();
  for (const entry of entries) {
    if (entry.alt === 0) continue;
    const key = `${entry.group}\u0000${entry.text.toLowerCase()}`;
    const alts = seenAlts.get(key) ?? new Set<number>();
    alts.add(entry.alt);
    seenAlts.set(key, alts);
  }

  // An objective stated outside any branch is required for everyone, so other
  // occurrences of the same step inside a branch cannot make it optional.
  const trunk = new Set(
    entries.filter((entry) => entry.alt === 0 && !entry.optional).map((e) => e.text.toLowerCase())
  );

  return entries.map(({ text, optional, inline, ancestor, group: g, alt: a }) => {
    if (!optional) return { text, optional };
    // An explicit `(''Optional'')` marker is direct evidence from the page, so
    // neither inference below may override it. The same wording can appear as an
    // optional hint under one step and as a required step later (Boreas "Reach the
    // engine room"), and only the marker distinguishes them.
    if (inline) return { text, optional: true };
    if (trunk.has(text.toLowerCase())) return { text, optional: false };
    // Convergence across nested alternatives only proves the step is unavoidable
    // *within* the enclosing branch. If that branch is itself conditional, players
    // who never enter it never see the step, so it must stay optional.
    if (a !== 0 && !ancestor) {
      const groupAlts = altsByGroup.get(g);
      const textAlts = seenAlts.get(`${g}\u0000${text.toLowerCase()}`);
      // Present in every alternative of its group, so no choice avoids it.
      if (groupAlts && textAlts && groupAlts.size > 1 && textAlts.size === groupAlts.size) {
        return { text, optional: false };
      }
    }
    return { text, optional };
  });
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
