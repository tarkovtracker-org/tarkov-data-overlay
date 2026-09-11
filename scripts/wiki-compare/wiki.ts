/**
 * EFT wiki fetching and wikitext parsing into structured task data.
 *
 * Extracted from the former single-file scripts/wiki-compare.ts.
 */

import {
  FETCH_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  bold,
  colorize,
  dim,
  printHeader,
  readResponseJson,
} from '../../src/lib/index.js';
import {
  TARKOV_1_0_LAUNCH,
  TraderReputation,
  WikiObjective,
  WikiRelatedItem,
  WikiRewards,
  WikiTaskData,
} from './types.js';
import {
  escapeRegExp,
  extractMapsFromText,
  extractSectionLines,
  extractWikiLinkData,
  extractWikiLinks,
  filterWikiItems,
  isExcludedMapMention,
  normalizeMapName,
  selectWikiItemLabel,
  stripWikiMarkup,
  uniqueList,
} from './normalize.js';
import { TARKOV_TRADER_NAMES_BY_ID } from '../../src/lib/index.js';

export type WikiFetchResult = {
  title: string;
  wikitext: string;
  lastRevision?: {
    timestamp: string;
    user: string;
    comment: string;
  };
};

const WIKI_MAX_RESPONSE_BYTES = Math.min(MAX_RESPONSE_BYTES, 8 * 1024 * 1024);
const WIKI_API_URL = 'https://escapefromtarkov.fandom.com/api.php';
const MAX_LINK_PATTERN_LENGTH = 256;
export const MAX_LINK_PATTERN_COUNT = 4096;
const MAX_LINK_MATCHER_NODES = 1_000_000;

async function fetchWikiJson(params: URLSearchParams): Promise<unknown> {
  const response = await fetch(WIKI_API_URL, {
    method: 'POST',
    headers: { Accept: 'application/json' },
    body: params,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Wiki request failed: ${response.status} ${response.statusText}`);
  }
  return readResponseJson(response, WIKI_API_URL, WIKI_MAX_RESPONSE_BYTES, 'wiki');
}

export async function fetchWikiWikitext(pageTitle: string): Promise<WikiFetchResult> {
  // Fetch wikitext
  const parseParams = new URLSearchParams({
    action: 'parse',
    page: pageTitle,
    prop: 'wikitext',
    format: 'json',
  });

  const parseData = (await fetchWikiJson(parseParams)) as {
    parse?: {
      title?: string;
      wikitext?: { '*': string };
    };
    error?: { info?: string };
  };

  if (parseData.error?.info) {
    throw new Error(`Wiki error: ${parseData.error.info}`);
  }

  const wikitext = parseData.parse?.wikitext?.['*'];
  if (!wikitext) {
    throw new Error('Wiki response missing wikitext');
  }

  const title = parseData.parse?.title ?? pageTitle;

  // Fetch last revision info
  const revParams = new URLSearchParams({
    action: 'query',
    titles: title,
    prop: 'revisions',
    rvprop: 'timestamp|user|comment',
    rvlimit: '1',
    format: 'json',
  });

  let lastRevision: WikiFetchResult['lastRevision'];
  try {
    const revData = (await fetchWikiJson(revParams)) as {
      query?: {
        pages?: Record<
          string,
          {
            revisions?: Array<{
              timestamp?: string;
              user?: string;
              comment?: string;
            }>;
          }
        >;
      };
    };

    const pages = revData.query?.pages;
    if (pages) {
      const page = Object.values(pages)[0];
      const rev = page?.revisions?.[0];
      if (rev?.timestamp) {
        lastRevision = {
          timestamp: rev.timestamp,
          user: rev.user ?? 'unknown',
          comment: rev.comment ?? '',
        };
      }
    }
  } catch {
    // Revision fetch failed, continue without it
  }

  return { title, wikitext, lastRevision };
}

/**
 * The player-level gate from a wiki Requirements section.
 *
 * Patch 1.1.0.0 moved most quest gates from a player level onto a trader
 * loyalty tier, and the wiki writes those as "Must reach Loyalty **Level 3**
 * with Ragman". A bare `/level (\d+)/` therefore reported the *loyalty tier* as
 * a player level on 90 of the 286 pages that carry a Requirements section, and
 * both `wiki:compare` and `eft:wiki` consumed that number as the wiki's witness
 * for `minPlayerLevel`. Loyalty phrases are excluded first, and the
 * remaining match must look like a player-level sentence rather than any
 * incidental "level N" (e.g. Stick to It's "Talk to the scientist on level 1
 * via the intercom", or "Reach the damaged door on level 3", which are building
 * floors).
 */
const LOYALTY_MENTION = /loyalt/i;
const PLAYER_LEVEL_PATTERNS = [
  /\bmust\s+be\s+(?:at\s+least\s+)?level\s+(\d+)\b/i,
  /\bmust\s+reach\s+level\s+(\d+)\b/i,
  /\brequires?\s+(?:player\s+)?level\s+(\d+)\b/i,
  /\bplayer\s+level\s+(\d+)\b/i,
  /\blevel\s+(\d+)\s+to\s+start\b/i,
];

export function parseMinLevel(requirements: string[]): number | undefined {
  for (const line of requirements) {
    const text = stripWikiMarkup(line).replace(
      /\bloyalty\s+level\s*(?:\d+|iv|i{1,3})\b|\blevel\s*(?:\d+|iv|i{1,3})\s+loyalty\b/gi,
      ''
    );
    for (const pattern of PLAYER_LEVEL_PATTERNS) {
      const match = pattern.exec(text);
      if (match?.[1]) return Number(match[1]);
    }
  }
  return undefined;
}

/** Roman numerals the wiki uses for loyalty tiers ("Loyalty Level II with Prapor"). */
const ROMAN_TIERS = new Map([
  ['i', 1],
  ['ii', 2],
  ['iii', 3],
  ['iv', 4],
]);

/**
 * Trader loyalty gates from a wiki Requirements section.
 *
 * Every phrasing observed across the corpus is handled:
 *   - "Must reach Loyalty Level 3 with [[Ragman]] to obtain this quest."
 *   - "Obtain level 2 loyalty with [[Peacekeeper]]"
 *   - "Reach Loyalty Level 4 with [[Prapor]], [[Therapist]] and [[Jaeger]]"
 *   - "Loyalty Level II with Prapor."
 *   - "Must be Loyalty Level 2 to start this quest" - names no trader, so the
 *     quest giver from the infobox `given by` field is used instead. Callers
 *     that cannot supply it get no entry rather than a guessed trader.
 *
 * `traderNames` restricts which words count as traders so prose cannot invent
 * one; pass the canonical tarkov.dev trader names.
 */
export function parseTraderLoyalty(
  requirements: string[],
  traderNames: Iterable<string>,
  questGiver?: string
): Array<{ trader: string; level: number; inferredTrader?: boolean }> {
  const known = new Map<string, string>();
  for (const name of traderNames) known.set(name.toLowerCase(), name);

  const out: Array<{ trader: string; level: number; inferredTrader?: boolean }> = [];
  const seen = new Set<string>();
  const add = (trader: string, level: number, inferredTrader = false) => {
    const key = `${trader}:${level}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(inferredTrader ? { trader, level, inferredTrader } : { trader, level });
  };

  for (const line of requirements) {
    const text = stripWikiMarkup(line);
    if (!LOYALTY_MENTION.test(text)) continue;

    // Match the tier paired with loyalty, not a player level or building floor.
    // A line can carry more than one gate ("Loyalty Level 3 with Prapor and
    // Loyalty Level 2 with Skier"), so collect every tier with its position
    // rather than taking the first and applying it to the whole line.
    const tiers: Array<{ index: number; level: number }> = [];
    for (const match of text.matchAll(
      /\bloyalty\s+level\s*(\d+|iv|i{1,3})\b|\blevel\s*(\d+|iv|i{1,3})\s+loyalty\b/gi
    )) {
      const value = match[1] ?? match[2];
      if (!value) continue;
      const level = ROMAN_TIERS.get(value.toLowerCase()) ?? Number(value);
      if (!Number.isInteger(level) || level < 1 || level > 4) continue;
      tiers.push({ index: match.index, level });
    }
    if (tiers.length === 0) continue;

    // Tokenized per span: punctuation and wiki markup collapse to single spaces, so
    // a known name matches only on whole-word boundaries and "NotBTR Driver" cannot
    // match "BTR Driver". Token equality is used rather than a constructed pattern,
    // so no regular expression is ever built from wiki text.
    const namedInOrder = (span: string): string[] => {
      const words = span
        .toLowerCase()
        .split(/[^a-z0-9_]+/)
        .filter(Boolean);
      const found: Array<{ trader: string; at: number }> = [];
      for (const [lower, canonical] of known) {
        const parts = lower.split(/[^a-z0-9_]+/).filter(Boolean);
        if (parts.length === 0) continue;
        for (let i = 0; i + parts.length <= words.length; i += 1) {
          if (parts.every((part, j) => words[i + j] === part)) {
            found.push({ trader: canonical, at: i });
            break;
          }
        }
      }
      return found.sort((a, b) => a.at - b.at).map((entry) => entry.trader);
    };

    const named = namedInOrder(text);

    if (named.length > 0) {
      if (tiers.length === 1) {
        // One tier governs the whole line, including "Level 4 with X, Y and Z".
        for (const trader of named) add(trader, tiers[0].level);
      } else if (named.length === tiers.length) {
        // Equal counts: gates are written one per trader, so pair them in the order
        // they appear. This holds for either word order - "Level 3 with Prapor and
        // Level 2 with Skier" and "Prapor at Level 3 and Skier at Level 2" - and for
        // a line that mixes the two, which a per-line order rule would mis-pair.
        named.forEach((trader, i) => add(trader, tiers[i].level));
      } else {
        // Counts disagree, so fall back to reading each tier's own span. Which side
        // of a tier its traders sit on is decided once per line from whether
        // anything is named before the first tier.
        const traderFirst = namedInOrder(text.slice(0, tiers[0].index)).length > 0;
        const assigned = new Set<string>();
        tiers.forEach((tier, i) => {
          const span = traderFirst
            ? text.slice(i === 0 ? 0 : tiers[i - 1].index, tier.index)
            : text.slice(tier.index, tiers[i + 1]?.index ?? text.length);
          for (const trader of namedInOrder(span)) {
            assigned.add(trader);
            add(trader, tier.level);
          }
        });
        // A name outside every span still had a gate on this line. The fallback
        // follows the line's order - the last tier when tiers trail their traders,
        // the first when they lead - so it stays visible without inventing a tier
        // from the opposite end of the sentence.
        const fallback = (traderFirst ? tiers[tiers.length - 1] : tiers[0]).level;
        for (const trader of named) if (!assigned.has(trader)) add(trader, fallback);
      }
    } else if (questGiver && known.has(questGiver.toLowerCase())) {
      // "Must be Loyalty Level N to start this quest" - the tier belongs to the
      // quest giver, which the sentence leaves implicit. That is an inference,
      // not a quoted requirement, so mark it: trader loyalty is
      // progression-critical, and a reviewer must be able to see which entries
      // came from the sentence naming a trader and which came from the infobox.
      add(known.get(questGiver.toLowerCase())!, tiers[0].level, true);
    }
  }
  return out;
}

/** The PMC faction gate ("This quest is only obtainable by [[USEC]] PMCs."). */
export function parseFactionRequirement(requirements: string[]): 'USEC' | 'BEAR' | undefined {
  for (const line of requirements) {
    const text = stripWikiMarkup(line);
    if (!/only\s+obtainable\s+by/i.test(text)) continue;
    if (/\busec\b/i.test(text)) return 'USEC';
    if (/\bbear\b/i.test(text)) return 'BEAR';
  }
  return undefined;
}

/**
 * The Scav karma gate. The wiki writes both bounds, e.g. "Scav karma of at
 * least +3" and "Scav karma of -6", so the sign is preserved.
 */
export function parseScavKarma(
  requirements: string[]
): { value: number; compareMethod?: '>=' | '<=' | '>' | '<' } | undefined {
  for (const line of requirements) {
    const text = stripWikiMarkup(line);
    if (!/scav\s*karma/i.test(text)) continue;
    const match =
      /scav\s*karma\s+of\s+(?:(at least|at most|more than|less than)\s+)?([+-]?\s*\d+(?:\.\d+)?)/i.exec(
        text
      );
    if (!match) continue;
    const value = Number(match[2].replace(/\s+/g, ''));
    const directions = {
      'at least': '>=',
      'at most': '<=',
      'more than': '>',
      'less than': '<',
    } as const;
    const phrase = match[1]?.toLowerCase() as keyof typeof directions | undefined;
    return phrase ? { value, compareMethod: directions[phrase] } : { value };
  }
  return undefined;
}

/** Remove linked names with a bounded Aho-Corasick matcher. */
function removeLinkedNames(value: string, patterns: string[]): string | undefined {
  if (patterns.length === 0) return value;
  if (patterns.some((pattern) => pattern.length > MAX_LINK_PATTERN_LENGTH)) return undefined;

  const nodes: Array<{
    children: Map<string, number>;
    failure: number;
    outputLength: number;
  }> = [{ children: new Map(), failure: 0, outputLength: 0 }];

  for (const pattern of patterns) {
    let nodeIndex = 0;
    for (let index = 0; index < pattern.length; index += 1) {
      const character = pattern[index];
      let nextIndex = nodes[nodeIndex].children.get(character);
      if (nextIndex === undefined) {
        if (nodes.length >= MAX_LINK_MATCHER_NODES) return undefined;
        nextIndex = nodes.length;
        nodes[nodeIndex].children.set(character, nextIndex);
        nodes.push({ children: new Map(), failure: 0, outputLength: 0 });
      }
      nodeIndex = nextIndex;
    }
    nodes[nodeIndex].outputLength = Math.max(nodes[nodeIndex].outputLength, pattern.length);
  }

  const queue: number[] = [...nodes[0].children.values()];
  for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
    const nodeIndex = queue[queueIndex];
    for (const [character, childIndex] of nodes[nodeIndex].children) {
      let fallback = nodes[nodeIndex].failure;
      while (fallback !== 0 && !nodes[fallback].children.has(character)) {
        fallback = nodes[fallback].failure;
      }
      nodes[childIndex].failure = nodes[fallback].children.get(character) ?? 0;
      nodes[childIndex].outputLength = Math.max(
        nodes[childIndex].outputLength,
        nodes[nodes[childIndex].failure].outputLength
      );
      queue.push(childIndex);
    }
  }

  const removalRanges = new Int32Array(value.length + 1);
  let nodeIndex = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    while (nodeIndex !== 0 && !nodes[nodeIndex].children.has(character)) {
      nodeIndex = nodes[nodeIndex].failure;
    }
    nodeIndex = nodes[nodeIndex].children.get(character) ?? 0;
    const matchLength = nodes[nodeIndex].outputLength;
    if (matchLength > 0) {
      removalRanges[index - matchLength + 1] += 1;
      removalRanges[index + 1] -= 1;
    }
  }

  const characters: string[] = [];
  let activeRanges = 0;
  for (let index = 0; index < value.length; index += 1) {
    activeRanges += removalRanges[index];
    if (activeRanges === 0) characters.push(value[index]);
  }
  return characters.join('');
}

export function extractCount(text: string, links: string[] = []): number | undefined {
  if (links.length > MAX_LINK_PATTERN_COUNT) return undefined;

  const normalized = stripWikiMarkup(text).toLowerCase();
  if (!/\d/.test(normalized)) return undefined;

  let scrubbed = normalized;

  // Remove linked item names to avoid pulling numbers from item titles. The
  // bounded matcher scans the line once and never treats page data as regex.
  if (links.some((link) => link.trim().length > MAX_LINK_PATTERN_LENGTH)) {
    return undefined;
  }
  const linkPatterns = [...new Set(links.map((link) => link.trim().toLowerCase()))]
    .filter((link) => link.length > 0)
    .sort((left, right) => right.length - left.length);
  const linkedNamesRemoved = removeLinkedNames(scrubbed, linkPatterns);
  if (linkedNamesRemoved === undefined) return undefined;
  scrubbed = linkedNamesRemoved;

  // Remove distance patterns like "75 meters".
  scrubbed = scrubbed.replace(/\b\d+\s*meters?\b/gi, '');
  // Remove percentage ranges and single percentages like "0-50%" or "75%".
  scrubbed = scrubbed.replace(/\b\d+\s*[-–]\s*\d+\s*%/g, '');
  scrubbed = scrubbed.replace(/\b\d+\s*%/g, '');
  // Remove numeric ranges like "3-4".
  scrubbed = scrubbed.replace(/\b\d+\s*[-–]\s*\d+\b/g, '');
  // Remove calibers/dimensions like "7.62x51" or "12x70".
  scrubbed = scrubbed.replace(/\b\d+(?:\.\d+)?\s*(?:x|×)\s*\d+(?:\.\d+)?\b/g, '');
  // Remove decimals like "7.62".
  scrubbed = scrubbed.replace(/\b\d+\.\d+\b/g, '');
  // Remove numbers like "#2".
  scrubbed = scrubbed.replace(/#\d+\b/g, '');
  // Remove 4-digit numbers starting with 0 (item IDs like "0052").
  scrubbed = scrubbed.replace(/\b0\d{3,}\b/g, '');
  // Remove alphanumeric model tokens (e.g., "SV-98", "AK-74", "6B43", "DVL-10").
  scrubbed = scrubbed
    .replace(/\b[a-z]+-?\d+[a-z0-9-]*\b/g, '')
    .replace(/\b\d+-[a-z0-9-]+\b/g, '')
    .replace(/\b[a-z0-9-]+-\d+\b/g, '')
    .replace(/\b\d+[a-z][a-z0-9-]*\b/g, '')
    .replace(/\b[a-z]+\d+[a-z0-9-]*\b/g, '');
  // Remove location numbers like "room 203" or "gate 3".
  scrubbed = scrubbed.replace(
    /\b(?:room|dorm|gate|floor|level|block|sector|wing|building|office|warehouse|shop|store|hangar|checkpoint|bunker)\s+\d+\b/g,
    ''
  );

  // Each candidate regex looks for a count in a specific position. The first
  // pattern that captures a number wins, matching the original early-return
  // ladder order. These patterns are literals because no runtime input is part
  // of their grammar.
  const extract = (pattern: RegExp): number | undefined => {
    const m = scrubbed.match(pattern);
    return m?.[1] ? Number(m[1].replace(/,/g, '')) : undefined;
  };

  return (
    extract(
      /\b(\d{1,3}(?:,\d{3})*)\b\s*(?:times?|kills?|targets?|pmcs?|scavs?|operatives?|headshots?|shots?|matches?|raiders?|rogues?|snipers?|dogtags?|tags?)\b/i
    ) ??
    extract(
      /\b(?:times?|kills?|targets?|pmcs?|scavs?|operatives?|headshots?|shots?|matches?|raiders?|rogues?|snipers?|dogtags?|tags?)\b\s*(\d{1,3}(?:,\d{3})*)\b/i
    ) ??
    extract(/\b(\d{1,3}(?:,\d{3})*)\b\s*x\b/i) ??
    extract(/\bx\s*(\d{1,3}(?:,\d{3})*)\b/i) ??
    // Last-resort verb fallback: "reach 10", "visit 3", ... A number that is
    // part of a distance/time qualifier ("over 40 meters away", "for 5
    // minutes") is not an objective count, so exclude it with a negative
    // lookahead.
    extract(
      /\b(?:kill|eliminate|neutralize|find|locate|obtain|get|hand over|handover|turn in|submit|deliver|give|bring|collect|stash|install|mark|plant|place|reach|visit|use|transfer|complete|survive|extract|escape|hit|shoot)\b[^\d]{0,24}\b(\d{1,3}(?:,\d{3})*)\b(?!\s*(?:meters?|metres?|minutes?|seconds?|hours?|km)\b)/i
    ) ??
    extract(/\b(\d{1,3}(?:,\d{3})*)\b\s*(?:items?|pcs?|pieces?|packs?|bottles?|units?)\b/i)
  );
}

export function parseObjectives(
  lines: string[],
  mapAliasMap: Map<string, string>
): WikiObjective[] {
  const objectives: WikiObjective[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const clean = stripWikiMarkup(line);

    // Check if this is a PvE note line (not a main objective)
    // Pattern: "Note: The objective in the PvE mode is to ... X targets"
    const isPveNote = /PvE\s*mode/i.test(line) || /PVE/i.test(line);
    if (isPveNote && objectives.length > 0) {
      // Extract PvE count and attach to previous objective
      const pveCount = extractCount(clean);
      if (pveCount !== undefined) {
        objectives[objectives.length - 1].pveCount = pveCount;
      }
      continue;
    }

    // Skip Note lines that aren't PvE-specific
    if (/^'''?Note:?'''?/i.test(line.trim())) {
      continue;
    }

    const linkData = extractWikiLinkData(line);
    const links = linkData.map((link) => link.target);
    const mapLinkEntries: Array<{ canonical: string; link: string }> = [];
    const mapLinkIndexes = new Set<number>();

    linkData.forEach((link, index) => {
      const candidates = [link.target, link.display].filter((value): value is string =>
        Boolean(value)
      );
      let matchedMap = false;
      for (const candidate of candidates) {
        const canonical = mapAliasMap.get(normalizeMapName(candidate));
        if (canonical) {
          mapLinkEntries.push({ canonical, link: candidate });
          matchedMap = true;
        }
      }
      if (matchedMap) mapLinkIndexes.add(index);
    });

    const mapsFromLinks = mapLinkEntries
      .filter((entry) => !isExcludedMapMention(clean, entry.link))
      .map((entry) => entry.canonical);
    // Always merge text-derived maps: an objective that links one map (e.g.
    // Streets) but names another only in plain text (e.g. Factory) would
    // otherwise lose the text-only map. extractMapsFromText applies the same
    // excluding/except guard, so the merge only adds genuine mentions.
    const maps = uniqueList([...mapsFromLinks, ...extractMapsFromText(clean, mapAliasMap)]);
    const items = filterWikiItems(
      uniqueList(
        linkData
          .filter((_, index) => !mapLinkIndexes.has(index))
          .map((link) => selectWikiItemLabel(link, mapAliasMap))
      )
    );

    // Regular objective line
    objectives.push({
      text: clean,
      count: extractCount(clean, links),
      maps,
      items,
      links,
    });
  }

  return objectives;
}

export function parseRewards(lines: string[]): WikiRewards {
  let xp: number | undefined;
  const reputations: TraderReputation[] = [];
  let money: number | undefined;
  const items: Array<{ name: string; count: number }> = [];

  for (const line of lines) {
    const clean = stripWikiMarkup(line);

    const xpMatch = clean.match(/\+?([\d,]+)\s*EXP/i);
    if (xpMatch && xpMatch[1]) {
      xp = Number(xpMatch[1].replace(/,/g, ''));
      continue;
    }

    // Extract trader name and reputation value
    // Wiki format: "[[Prapor]] Rep +0.02" or "Prapor Rep +0.02"
    const repMatch = clean.match(/(\w+)\s+Rep\s*\+?([0-9.]+)/i);
    if (repMatch && repMatch[1] && repMatch[2]) {
      reputations.push({
        trader: repMatch[1],
        value: Number(repMatch[2]),
      });
      continue;
    }

    // Only take first rouble value (base amount, not IC bonuses)
    if (money === undefined) {
      const moneyMatch = clean.match(/([\d,]+)\s*Roubles/i);
      if (moneyMatch && moneyMatch[1]) {
        money = Number(moneyMatch[1].replace(/,/g, ''));
        continue;
      }
    }

    const itemMatch = clean.match(new RegExp(`^(\\d+)\\s*(?:x|\\u00d7)\\s*(.+)$`, 'i'));
    if (itemMatch && itemMatch[1] && itemMatch[2]) {
      items.push({ count: Number(itemMatch[1]), name: itemMatch[2].trim() });
    }
  }

  return {
    xp,
    reputations,
    money,
    items,
    raw: lines.map(stripWikiMarkup),
  };
}

export function parseRelatedQuestItems(wikitext: string): WikiRelatedItem[] {
  const lines = wikitext.split('\n');
  const items: WikiRelatedItem[] = [];
  let inTable = false;
  let currentRow: string[] = [];

  const flushRow = (): void => {
    if (currentRow.length < 4) {
      currentRow = [];
      return;
    }

    const itemCell = currentRow[1] ?? '';
    const requirementCell = currentRow[3] ?? '';
    const name = extractWikiLinks(itemCell)[0] ?? stripWikiMarkup(itemCell).trim();
    if (name.length === 0) {
      currentRow = [];
      return;
    }

    items.push({
      name,
      requirement: stripWikiMarkup(requirementCell).trim(),
    });
    currentRow = [];
  };

  for (const line of lines) {
    if (!inTable && /Related Quest Items/i.test(line)) {
      inTable = true;
      continue;
    }

    if (!inTable) continue;

    const trimmed = line.trim();
    if (trimmed.startsWith('|}')) {
      flushRow();
      break;
    }

    if (trimmed.startsWith('|-')) {
      flushRow();
      continue;
    }

    if (/^[|!]/.test(trimmed)) {
      const raw = trimmed.replace(/^[|!]/, '');
      const cells = raw.split(/\s*(?:\|\||!!)\s*/);
      for (const cell of cells) {
        currentRow.push(cell.trim());
      }
    }
  }

  return items;
}

export function parseInfoboxLinks(wikitext: string, field: string): string[] {
  // Use [ \t]* instead of \s* to avoid matching newlines
  const regex = new RegExp(`^\\|\\s*${escapeRegExp(field)}\\s*=[ \\t]*(.+)$`, 'mi');
  const match = wikitext.match(regex);
  if (!match || !match[1]) return [];
  const value = match[1].trim();
  const results: string[] = [];

  const linkRegex = /\[\[([^|\]]+)/g;
  let linkMatch: RegExpExecArray | null = linkRegex.exec(value);
  while (linkMatch) {
    if (linkMatch[1]) {
      results.push(stripWikiMarkup(linkMatch[1]));
    }
    linkMatch = linkRegex.exec(value);
  }

  return results;
}

export function parseInfoboxValue(wikitext: string, field: string): string | undefined {
  // Use [ \t]* instead of \s* to avoid matching newlines
  const regex = new RegExp(`^\\|\\s*${escapeRegExp(field)}\\s*=[ \\t]*(.+)$`, 'mi');
  const match = wikitext.match(regex);
  if (!match || !match[1]) return undefined;
  return match[1].trim();
}

export function parseWikiTask(
  pageTitle: string,
  wikitext: string,
  mapAliasMap: Map<string, string>,
  lastRevision?: WikiTaskData['lastRevision'],
  traderNames: Iterable<string> = Object.values(TARKOV_TRADER_NAMES_BY_ID).filter(
    (name): name is string => typeof name === 'string'
  )
): WikiTaskData {
  const requirements = extractSectionLines(wikitext, 'Requirements');
  const objectivesLines = extractSectionLines(wikitext, 'Objectives');
  const rewardsLines = extractSectionLines(wikitext, 'Rewards');
  const mapFields = ['location', 'map', 'maps', 'locations'];
  const mapsFromInfobox = new Set<string>();

  for (const field of mapFields) {
    const links = parseInfoboxLinks(wikitext, field);
    for (const link of links) {
      const canonical = mapAliasMap.get(normalizeMapName(link));
      const rawValue = parseInfoboxValue(wikitext, field) ?? '';
      if (canonical && !isExcludedMapMention(rawValue, link)) {
        mapsFromInfobox.add(canonical);
      }
    }
    if (links.length === 0) {
      const rawValue = parseInfoboxValue(wikitext, field);
      if (rawValue) {
        for (const mapName of extractMapsFromText(rawValue, mapAliasMap)) {
          mapsFromInfobox.add(mapName);
        }
      }
    }
  }

  const relatedItems = parseRelatedQuestItems(wikitext);
  const relatedRequiredItems = uniqueList(
    relatedItems.filter((item) => /required/i.test(item.requirement ?? '')).map((item) => item.name)
  );
  const relatedHandoverItems = uniqueList(
    relatedItems.filter((item) => /handover/i.test(item.requirement ?? '')).map((item) => item.name)
  );

  const nextTasks = uniqueList([
    ...parseInfoboxLinks(wikitext, 'next'),
    ...parseInfoboxLinks(wikitext, 'next_task'),
    ...parseInfoboxLinks(wikitext, 'next task'),
    ...parseInfoboxLinks(wikitext, 'next_quest'),
    ...parseInfoboxLinks(wikitext, 'next quest'),
  ]);

  return {
    pageTitle,
    requirements,
    objectives: parseObjectives(objectivesLines, mapAliasMap),
    rewards: parseRewards(rewardsLines),
    minPlayerLevel: parseMinLevel(requirements),
    traderLoyalty: parseTraderLoyalty(
      requirements,
      traderNames,
      parseInfoboxLinks(wikitext, 'given by')[0] ?? parseInfoboxLinks(wikitext, 'given_by')[0]
    ),
    factionName: parseFactionRequirement(requirements),
    scavKarma: parseScavKarma(requirements),
    previousTasks: parseInfoboxLinks(wikitext, 'previous'),
    nextTasks,
    maps: Array.from(mapsFromInfobox),
    relatedItems,
    relatedRequiredItems,
    relatedHandoverItems,
    lastRevision,
  };
}

export function printWikiData(wiki: WikiTaskData): void {
  printHeader('WIKI EXTRACTION');
  console.log(`${bold('Page')}: ${wiki.pageTitle}`);

  // Show last revision info
  if (wiki.lastRevision) {
    const revDate = new Date(wiki.lastRevision.timestamp);
    const daysAgo = Math.floor((Date.now() - revDate.getTime()) / (1000 * 60 * 60 * 24));
    const dateStr = revDate.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
    const isPost1_0 = revDate >= TARKOV_1_0_LAUNCH;
    const freshness = isPost1_0 ? colorize('[POST-1.0]', 'green') : colorize('[PRE-1.0]', 'red');
    console.log(`${bold('Last Edit')}: ${dateStr} (${daysAgo} days ago) ${freshness}`);
    console.log(`  ${dim(`by ${wiki.lastRevision.user}`)}`);
  }

  console.log(`${bold('Requirements')}: ${wiki.requirements.length}`);
  for (const line of wiki.requirements) {
    console.log(`  - ${stripWikiMarkup(line)}`);
  }
  if (wiki.minPlayerLevel !== undefined) {
    console.log(`  ${dim(`Detected level requirement: ${wiki.minPlayerLevel}`)}`);
  }
  if (wiki.traderLoyalty.length > 0) {
    // An inferred trader is flagged inline: the sentence stated a tier without
    // naming a trader, so the attribution to the quest giver needs confirming
    // before it becomes an override.
    const gates = wiki.traderLoyalty
      .map((ll) => `${ll.trader} LL${ll.level}${ll.inferredTrader ? ' (trader inferred)' : ''}`)
      .join(', ');
    console.log(`  ${dim(`Detected trader loyalty: ${gates}`)}`);
  }
  if (wiki.factionName !== undefined) {
    console.log(`  ${dim(`Detected faction restriction: ${wiki.factionName}`)}`);
  }
  if (wiki.scavKarma !== undefined) {
    console.log(
      `  ${dim(`Detected Scav karma requirement: ${wiki.scavKarma.compareMethod ?? '(direction unspecified)'} ${wiki.scavKarma.value}`)}`
    );
  }
  if (wiki.maps.length > 0) {
    console.log(`  ${dim(`Detected map(s): ${wiki.maps.join(', ')}`)}`);
  }

  console.log();
  console.log(`${bold('Objectives')}: ${wiki.objectives.length}`);
  for (const obj of wiki.objectives) {
    const count = obj.count !== undefined ? ` (count: ${obj.count})` : '';
    console.log(`  - ${obj.text}${count}`);
  }

  console.log();
  console.log(`${bold('Rewards')}: ${wiki.rewards.raw.length}`);
  for (const reward of wiki.rewards.raw) {
    console.log(`  - ${reward}`);
  }
  if (wiki.rewards.items.length > 0) {
    console.log(`  ${dim(`Parsed ${wiki.rewards.items.length} reward item(s)`)}`);
  }

  console.log();
  if (wiki.previousTasks.length > 0) {
    console.log(`${bold('Previous Tasks')}: ${wiki.previousTasks.join(', ')}`);
  }
  if (wiki.nextTasks.length > 0) {
    console.log(`${bold('Next Tasks')}: ${wiki.nextTasks.join(', ')}`);
  }
  console.log();
}
