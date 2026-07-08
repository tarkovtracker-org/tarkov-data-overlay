/**
 * EFT wiki fetching and wikitext parsing into structured task data.
 *
 * Extracted from the former single-file scripts/wiki-compare.ts.
 */

import {
  printHeader,
  bold,
  dim,
} from '../../src/lib/index.js';
import {
  TARKOV_1_0_LAUNCH,
  TraderReputation,
  WIKI_API,
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

export type WikiFetchResult = {
  title: string;
  wikitext: string;
  lastRevision?: {
    timestamp: string;
    user: string;
    comment: string;
  };
};

export async function fetchWikiWikitext(pageTitle: string): Promise<WikiFetchResult> {
  // Fetch wikitext
  const parseParams = new URLSearchParams({
    action: 'parse',
    page: pageTitle,
    prop: 'wikitext',
    format: 'json',
  });

  const parseResponse = await fetch(`${WIKI_API}?${parseParams.toString()}`);
  if (!parseResponse.ok) {
    throw new Error(
      `Wiki request failed: ${parseResponse.status} ${parseResponse.statusText}`
    );
  }

  const parseData = (await parseResponse.json()) as {
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
    const revResponse = await fetch(`${WIKI_API}?${revParams.toString()}`);
    if (revResponse.ok) {
      const revData = (await revResponse.json()) as {
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
    }
  } catch {
    // Revision fetch failed, continue without it
  }

  return { title, wikitext, lastRevision };
}

export function parseMinLevel(requirements: string[]): number | undefined {
  for (const line of requirements) {
    const match = stripWikiMarkup(line).match(/level\s+(\d+)/i);
    if (match && match[1]) {
      return Number(match[1]);
    }
  }
  return undefined;
}

export function extractCount(text: string, links: string[] = []): number | undefined {
  const normalized = stripWikiMarkup(text).toLowerCase();
  if (!/\d/.test(normalized)) return undefined;

  let scrubbed = normalized;

  // Remove linked item names to avoid pulling numbers from item titles.
  for (const link of links) {
    const linkText = link.trim().toLowerCase();
    if (linkText.length === 0) continue;
    const escaped = linkText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    scrubbed = scrubbed.replace(new RegExp(escaped, 'g'), '');
  }

  // Remove distance patterns like "75 meters".
  scrubbed = scrubbed.replace(/\b\d+\s*meters?\b/gi, '');
  // Remove percentage ranges and single percentages like "0-50%" or "75%".
  scrubbed = scrubbed.replace(/\b\d+\s*[-–]\s*\d+\s*%/g, '');
  scrubbed = scrubbed.replace(/\b\d+\s*%/g, '');
  // Remove numeric ranges like "3-4".
  scrubbed = scrubbed.replace(/\b\d+\s*[-–]\s*\d+\b/g, '');
  // Remove calibers/dimensions like "7.62x51" or "12x70".
  scrubbed = scrubbed.replace(
    /\b\d+(?:\.\d+)?\s*(?:x|×)\s*\d+(?:\.\d+)?\b/g,
    ''
  );
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

  const numberPattern = '\\d{1,3}(?:,\\d{3})*';
  const countWords =
    '(?:times?|kills?|targets?|pmcs?|scavs?|operatives?|headshots?|shots?|matches?|raiders?|rogues?|snipers?|dogtags?|tags?)';
  const verbs =
    '(?:kill|eliminate|neutralize|find|locate|obtain|get|hand over|handover|turn in|submit|deliver|give|bring|collect|stash|install|mark|plant|place|reach|visit|use|transfer|complete|survive|extract|escape|hit|shoot)';

  let match = scrubbed.match(
    new RegExp(`\\b(${numberPattern})\\b\\s*${countWords}\\b`, 'i')
  );
  if (match?.[1]) return Number(match[1].replace(/,/g, ''));

  match = scrubbed.match(
    new RegExp(`\\b${countWords}\\b\\s*(${numberPattern})\\b`, 'i')
  );
  if (match?.[1]) return Number(match[1].replace(/,/g, ''));

  match = scrubbed.match(new RegExp(`\\b(${numberPattern})\\b\\s*x\\b`, 'i'));
  if (match?.[1]) return Number(match[1].replace(/,/g, ''));

  match = scrubbed.match(new RegExp(`\\bx\\s*(${numberPattern})\\b`, 'i'));
  if (match?.[1]) return Number(match[1].replace(/,/g, ''));

  match = scrubbed.match(
    new RegExp(`\\b${verbs}\\b[^\\d]{0,24}\\b(${numberPattern})\\b`, 'i')
  );
  if (match?.[1]) return Number(match[1].replace(/,/g, ''));

  match = scrubbed.match(
    new RegExp(
      `\\b(${numberPattern})\\b\\s*(?:items?|pcs?|pieces?|packs?|bottles?|units?)\\b`,
      'i'
    )
  );
  if (match?.[1]) return Number(match[1].replace(/,/g, ''));

  return undefined;
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
      const candidates = [link.target, link.display].filter(
        (value): value is string => Boolean(value)
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
    const mapsFromText =
      mapsFromLinks.length > 0 ? [] : extractMapsFromText(clean, mapAliasMap);
    const maps = uniqueList([...mapsFromLinks, ...mapsFromText]);
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

    const itemMatch = clean.match(
      new RegExp(`^(\\d+)\\s*(?:x|\\u00d7)\\s*(.+)$`, 'i')
    );
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
    const name =
      extractWikiLinks(itemCell)[0] ?? stripWikiMarkup(itemCell).trim();
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
  const regex = new RegExp(
    `^\\|\\s*${escapeRegExp(field)}\\s*=[ \\t]*(.+)$`,
    'mi'
  );
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

export function parseInfoboxValue(
  wikitext: string,
  field: string
): string | undefined {
  // Use [ \t]* instead of \s* to avoid matching newlines
  const regex = new RegExp(
    `^\\|\\s*${escapeRegExp(field)}\\s*=[ \\t]*(.+)$`,
    'mi'
  );
  const match = wikitext.match(regex);
  if (!match || !match[1]) return undefined;
  return match[1].trim();
}

export function parseWikiTask(
  pageTitle: string,
  wikitext: string,
  mapAliasMap: Map<string, string>,
  lastRevision?: WikiTaskData['lastRevision']
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
    relatedItems
      .filter((item) => /required/i.test(item.requirement ?? ''))
      .map((item) => item.name)
  );
  const relatedHandoverItems = uniqueList(
    relatedItems
      .filter((item) => /handover/i.test(item.requirement ?? ''))
      .map((item) => item.name)
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
    const daysAgo = Math.floor(
      (Date.now() - revDate.getTime()) / (1000 * 60 * 60 * 24)
    );
    const dateStr = revDate.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
    const isPost1_0 = revDate >= TARKOV_1_0_LAUNCH;
    const freshness = isPost1_0 ? '🟢 Post-1.0' : '🔴 Pre-1.0';
    console.log(
      `${bold('Last Edit')}: ${dateStr} (${daysAgo} days ago) ${freshness}`
    );
    console.log(`  ${dim(`by ${wiki.lastRevision.user}`)}`);
  }

  console.log(`${bold('Requirements')}: ${wiki.requirements.length}`);
  for (const line of wiki.requirements) {
    console.log(`  - ${stripWikiMarkup(line)}`);
  }
  if (wiki.minPlayerLevel !== undefined) {
    console.log(
      `  ${dim(`Detected level requirement: ${wiki.minPlayerLevel}`)}`
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
    console.log(
      `  ${dim(`Parsed ${wiki.rewards.items.length} reward item(s)`)}`
    );
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
