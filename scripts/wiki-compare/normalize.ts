/**
 * Text normalization and fuzzy matching helpers: objective text, item and
 * map names/aliases, wiki link extraction, and set utilities.
 *
 * Extracted from the former single-file scripts/wiki-compare.ts.
 */

import {
  ApiObjective,
  ExtendedTaskData,
  WikiLink,
} from './types.js';

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function extractSectionLines(wikitext: string, heading: string): string[] {
  const lines = wikitext.split('\n');
  const headingRegex = new RegExp(
    `^==\\s*${escapeRegExp(heading)}\\s*==\\s*$`,
    'i'
  );
  const startIndex = lines.findIndex((line) => headingRegex.test(line.trim()));
  if (startIndex === -1) return [];

  const items: string[] = [];
  const isTopLevelHeading = (line: string): boolean => {
    const trimmed = line.trim();
    return (
      trimmed.startsWith('==') &&
      !trimmed.startsWith('===') &&
      trimmed.endsWith('==') &&
      !trimmed.endsWith('===')
    );
  };

  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const raw = lines[i].trim();
    if (isTopLevelHeading(raw)) break;
    // Capture bulleted and numbered list entries.
    if (/^[*#]/.test(raw)) {
      items.push(raw.replace(/^[*#]+\s*/, ''));
      continue;
    }
    // Also capture Note lines (for PvE/PvP differences)
    if (raw.startsWith("'''Note:") || raw.startsWith("''Note:")) {
      items.push(raw);
    }
  }

  return items;
}

export function stripWikiMarkup(value: string): string {
  return removeHtmlTags(value)
    .replace(/''+/g, '')
    .replace(/\[\[(?:[^|\]]*\|)?([^\]]+)\]\]/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function removeHtmlTags(value: string): string {
  let result = '';
  let inTag = false;

  for (const char of value) {
    if (char === '<') {
      inTag = true;
      continue;
    }
    if (char === '>') {
      inTag = false;
      continue;
    }
    if (!inTag) result += char;
  }

  return result;
}

export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function normalizeCyrillic(value: string): string {
  // Replace Cyrillic characters commonly mistaken for Latin ones (e.g., PMСs).
  return value.replace(/[\u0421\u0441]/g, 'c');
}

export function normalizeObjectiveText(value: string): string {
  const normalizedTimes = normalizeCyrillic(value).replace(
    /\b0(\d):(\d{2})\b/g,
    '$1:$2'
  );
  return normalizeWhitespace(
    stripWikiMarkup(normalizedTimes)
      .toLowerCase()
      .replace(/[’']/g, '')
      .replace(/[^a-z0-9]+/gi, ' ')
      .replace(/\b(all over|throughout)\s+the\s+tarkov\s+territory\b/g, ' ')
      .replace(/\bover\s+(the\s+)?tarkov\s+territory\b/g, ' ')
      .replace(/\bon\s+any\s+(location|map)\b/g, ' ')
      .replace(/\bany\s+location\b/g, ' ')
      .replace(/\bon\s+(the\s+)?location\b/g, ' ')
      .replace(/\bfind a way (inside|into)\b/g, 'enter')
      .replace(/\bone of\b/g, ' ')
      .replace(/\b(the|a|an|any|all)\b/g, ' ')
      .replace(/\bskill level of \d+\b/g, 'skill level')
      .replace(
        /\brequired\s+\d+\s+([a-z]+)\s+skill\s+level\b/g,
        'required $1 skill level'
      )
      .replace(/\blocate and check\b/g, 'locate')
      .replace(/\blocate and obtain\b/g, 'obtain')
      .replace(/\blocate and mark\b/g, 'mark')
      .replace(/\blocate and neutralize\b/g, 'eliminate')
      .replace(/\blocate and eliminate\b/g, 'eliminate')
      .replace(/\bneutralize\b/g, 'eliminate')
      .replace(/\bkill\b/g, 'eliminate')
      .replace(/\bget into\b/g, 'enter')
      .replace(/\bfind\b/g, 'locate')
      .replace(/\bwhile using\b/g, 'using')
      .replace(/\bwith\b/g, 'using')
      .replace(
        /\b([a-z]{2,4}\s?\d{1,3}[a-z0-9]*)\s+series\s+assault\s+rifle\b/g,
        '$1'
      )
      .replace(/\bbunkhouses\b/g, 'bunkhouse')
      .replace(/\band\b/g, ' ')
      .replace(/\bthat\b/g, ' ')
      .replace(/\b(is|are|was|were)\b/g, ' ')
      .replace(/\baway\b/g, ' ')
      .replace(/\boptional\b/g, ' ')
      .replace(/\bfound in raid items?\b/g, 'found in raid')
      .replace(/\bhand grenades?\b/g, 'grenades')
      .replace(/\bscav\s+(bosses?|raiders?)\b/g, '$1')
      .replace(
        /\bto\s+(prapor|therapist|skier|peacekeeper|mechanic|ragman|jaeger|fence|lightkeeper|ref)\b/g,
        ' '
      )
      .replace(/\bpmc operatives?\b/g, 'pmc')
      .replace(/\bpmcs\b/g, 'pmc')
      .replace(/\benemies?\b/g, 'target')
  );
}

export function objectiveHasCategoryItemRequirement(text: string): boolean {
  const normalized = text.toLowerCase();
  const categoryPatterns = [
    /\bany\b.*\b(weapon|gun|firearm)\b/,
    /\bmelee weapons?\b/,
    /\bgrenades?\b/,
    /\bgrenade launchers?\b/,
    /\bassault rifles?\b/,
    /\bbolt[-\s]?action rifles?\b/,
    /\bsniper rifles?\b/,
    /\bmarksman rifles?\b/,
    /\bdmrs?\b/,
    /\bsmgs?\b/,
    /\blmgs?\b/,
    /\bshotguns?\b/,
    /\bpistols?\b/,
    /\brevolvers?\b/,
    /\bak[-\s]?series\b/,
    /\bar[-\s]?15\b/,
    /\bplatform weapons?\b/,
    /\bseries\b.*\bweapons?\b/,
    /\bsuppressed\b.*\bweapons?\b/,
    /\bsilenced\b.*\bweapons?\b/,
    /\bsuppressors?\b/,
    /\bsilencers?\b/,
    /\bbrand equipment\b/,
    /\bbrand items?\b/,
    /\bany\b.*\b(backpacks?|tactical rigs?|chest rigs?|plate carriers?|armored rigs?|body armou?r|helmets?)\b/,
    /\bany\b.*\b(medical|medicine|meds|medication)\b/,
    /\b(ballistic plates?|armor plates?)\b/,
  ];

  return categoryPatterns.some((pattern) => pattern.test(normalized));
}

export function stripCountPhrases(value: string): string {
  const normalizedValue = normalizeCyrillic(value);
  const countWords =
    '(times?|kills?|targets?|pmcs?|scavs?|operatives?|headshots?|shots?|enemies?|guards?|bosses?|matches?|raiders?|rogues?|snipers?|dogtags?|tags?)';
  const verbCounts =
    '(find|hand over|handover|turn in|submit|deliver|give|bring|obtain|collect|stash|sell|win)';
  const numberWordMap: Record<string, string> = {
    one: '1',
    two: '2',
    three: '3',
    four: '4',
    five: '5',
    six: '6',
    seven: '7',
    eight: '8',
    nine: '9',
    ten: '10',
    eleven: '11',
    twelve: '12',
  };
  const normalizedNumbers = normalizedValue.replace(
    /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/gi,
    (match) => numberWordMap[match.toLowerCase()] ?? match
  );

  return normalizedNumbers
    .replace(/\bwin\b\s+\d+\s+out\s+of\s+\d+\b/gi, 'win')
    .replace(/\b\d+\s+times?\b/gi, '')
    .replace(/\b\d+\s+of\b/gi, '')
    .replace(
      new RegExp(`\\b\\d+\\b\\s+((?:[a-z]+\\s+){0,2}${countWords})\\b`, 'gi'),
      '$1'
    )
    .replace(new RegExp(`\\b${countWords}\\b\\s*\\d+\\b`, 'gi'), '$1')
    .replace(new RegExp(`\\b(item|items)\\b\\s*:\\s*\\d+\\b`, 'gi'), '$1:')
    .replace(
      new RegExp(`\\b${verbCounts}\\b\\s+(?:any\\s+)?(the\\s+)?\\d+\\b`, 'gi'),
      (_match, verb, article) => `${verb} ${article ?? ''}`.trim()
    )
    .replace(
      /\b(sell)\b\s+(prapor|therapist|skier|peacekeeper|mechanic|ragman|jaeger|fence|lightkeeper|ref)\s+(?:any\s+)?\d+\b/gi,
      '$1 $2'
    )
    .replace(/\s+/g, ' ')
    .trim();
}

export function singularizeCountWords(value: string): string {
  return value
    .replace(/\btimes\b/g, 'time')
    .replace(/\bkills\b/g, 'kill')
    .replace(/\btargets\b/g, 'target')
    .replace(/\bpmcs\b/g, 'pmc')
    .replace(/\bscavs\b/g, 'scav')
    .replace(/\boperatives\b/g, 'operative')
    .replace(/\bheadshots\b/g, 'headshot')
    .replace(/\bshots\b/g, 'shot')
    .replace(/\benemies\b/g, 'enemy')
    .replace(/\bguards\b/g, 'guard')
    .replace(/\bbosses\b/g, 'boss')
    .replace(/\bmatches\b/g, 'match')
    .replace(/\braiders\b/g, 'raider')
    .replace(/\brogues\b/g, 'rogue')
    .replace(/\bsnipers\b/g, 'sniper')
    .replace(/\bdogtags\b/g, 'dogtag')
    .replace(/\btags\b/g, 'tag');
}

export function normalizeObjectiveMatchKey(value: string): string {
  return singularizeCountWords(
    normalizeObjectiveText(stripCountPhrases(value))
  );
}

export function normalizeMapName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\bnight factory\b/g, 'factory')
    .replace(/\s+21\+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeItemName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^#+/, '')
    .replace(/#(?=\d)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function uniqueList(values: string[]): string[] {
  return Array.from(new Set(values.filter((v) => v.trim().length > 0)));
}

export const WIKI_ITEM_EXCLUSIONS = new Set([
  'found in raid',
  'in raid',
  'fi r',
  'weapon',
  'weapons',
  'assault rifles',
  'sniper rifles',
  'bolt-action rifles',
  'melee weapon',
  'melee weapons',
  'grenade',
  'grenades',
  'grenade launcher',
  'grenade launchers',
  'dmrs',
  'smgs',
  'lmgs',
  'shotguns',
  'pistols',
  'usec',
  'bear',
  'pmc',
  'pmcs',
  'scav',
  'scavs',
  'boss',
  'bosses',
  'rogues',
  'raiders',
  'scav raiders',
  'glukhar',
  'killa',
  'vengeful killa',
  'reshala',
  'shturman',
  'tagilla',
  'shadow of tagilla',
  'sanitar',
  'kaban',
  'kollontay',
  'basmach',
  'gus',
  'partisan',
  'goons',
  'minotaur',
  'zryachiy',
  'birdeye',
  'big pipe',
  'knight',
  'medical',
  'medicine',
  'meds',
  'medication',
  'backpack',
  'backpacks',
  'tactical rig',
  'tactical rigs',
  'chest rig',
  'chest rigs',
  'plate carrier',
  'plate carriers',
  'armored rig',
  'armored rigs',
  'body armor',
  'body armour',
  'helmet',
  'helmets',
  'armor plate',
  'armor plates',
  'ballistic plate',
  'ballistic plates',
  'weapon mods',
  'weapon_mods',
  'search',
  'stress resistance',
  'strength',
  'endurance',
  'metabolism',
  'immunity',
  'intellect',
  'attention',
  'perception',
  'memory',
  'charisma',
  'health',
  'prapor',
  'therapist',
  'skier',
  'peacekeeper',
  'mechanic',
  'ragman',
  'jaeger',
  'fence',
  'lightkeeper',
  'ref',
  'arena',
]);

export function isExcludedWikiItem(value: string): boolean {
  return WIKI_ITEM_EXCLUSIONS.has(normalizeItemName(value));
}

export function filterWikiItems(items: string[]): string[] {
  return items.filter((item) => !isExcludedWikiItem(item));
}

export function selectWikiItemLabel(
  link: WikiLink,
  mapAliasMap: Map<string, string>
): string {
  const target = link.target;
  const display = link.display?.trim();
  if (!display) return target;

  const normalizedTarget = normalizeItemName(target);
  const normalizedDisplay = normalizeItemName(display);
  if (normalizedTarget === normalizedDisplay) return target;

  const isMapTarget = mapAliasMap.has(normalizeMapName(target));
  const isMapDisplay = mapAliasMap.has(normalizeMapName(display));
  if (isMapTarget || isMapDisplay) return target;

  if (isExcludedWikiItem(target) || isExcludedWikiItem(display)) return target;

  if (
    normalizedDisplay.includes(normalizedTarget) ||
    normalizedTarget.includes(normalizedDisplay)
  ) {
    return normalizedDisplay.length >= normalizedTarget.length
      ? display
      : target;
  }

  return target;
}

export function getObjectiveVerbKey(text: string): string | undefined {
  const normalized = text.toLowerCase();
  if (
    /\bhand over\b|\bhandover\b|\bturn in\b|\bsubmit\b|\bdeliver\b|\bgive\b|\bbring\b/.test(
      normalized
    )
  ) {
    return 'hand_over';
  }
  if (/\bfind\b|\bloc(at|ate)\b|\bobtain\b|\bcollect\b/.test(normalized)) {
    return 'find';
  }
  if (/\bmark\b|\bplace\b|\bplant\b|\binstall\b|\bstash\b/.test(normalized)) {
    return 'mark';
  }
  if (/\buse\b|\butilize\b/.test(normalized)) {
    return 'use';
  }
  if (/\beliminate\b|\bkill\b|\bshoot\b/.test(normalized)) {
    return 'eliminate';
  }
  if (/\bextract\b|\bsurvive\b|\bescape\b/.test(normalized)) {
    return 'extract';
  }
  return undefined;
}

export type ObjectiveItemRef = { name: string; shortName?: string; id?: string };

export function normalizeItemAliases(item: ObjectiveItemRef): string[] {
  const aliases: string[] = [];
  if (item.name) aliases.push(normalizeItemName(item.name));
  if (item.shortName) aliases.push(normalizeItemName(item.shortName));
  if (item.name && /dogtag/i.test(item.name)) aliases.push('dogtag');
  if (item.shortName && /dogtag/i.test(item.shortName)) aliases.push('dogtag');
  return uniqueList(aliases);
}

export function normalizeItemAliasesWithContext(
  item: ObjectiveItemRef,
  context?: string
): string[] {
  const aliases = normalizeItemAliases(item);
  if (!context || !item.name) return aliases;

  const contextKey = normalizeItemName(context);
  if (contextKey.length === 0) return aliases;

  const match = item.name.match(/\(([^)]+)\)\s*$/);
  if (!match || !match[1]) return aliases;
  const suffix = normalizeItemName(match[1]);
  if (suffix.length === 0) return aliases;

  if (suffix.includes(contextKey)) {
    const stripped = normalizeItemName(
      item.name.replace(/\s*\([^)]+\)\s*$/, '')
    );
    if (stripped.length > 0) aliases.push(stripped);
  }

  return uniqueList(aliases);
}

export function normalizeWikiItemAliases(item: string, context?: string): string[] {
  const aliases = [normalizeItemName(item)];
  if (/\(quest item\)/i.test(item)) {
    const stripped = normalizeItemName(item.replace(/\s*\([^)]+\)\s*$/, ''));
    if (stripped.length > 0) aliases.push(stripped);
  }
  if (!context) return aliases;

  const contextKey = normalizeItemName(context);
  if (contextKey.length === 0) return aliases;

  const match = item.match(/\(([^)]+)\)\s*$/);
  if (!match || !match[1]) return aliases;
  const suffix = normalizeItemName(match[1]);
  if (suffix.includes(contextKey)) {
    const stripped = normalizeItemName(item.replace(/\s*\([^)]+\)\s*$/, ''));
    if (stripped.length > 0) aliases.push(stripped);
  }

  return uniqueList(aliases);
}

export function buildAliasSet(
  items: ObjectiveItemRef[],
  context?: string
): Set<string> {
  const aliasSet = new Set<string>();
  for (const item of items) {
    for (const alias of normalizeItemAliasesWithContext(item, context))
      aliasSet.add(alias);
  }
  return aliasSet;
}

export function hasItemIntersection(
  apiItems: ObjectiveItemRef[],
  wikiItems: string[],
  context?: string
): boolean {
  if (apiItems.length === 0 || wikiItems.length === 0) return false;
  const apiAliasSet = buildAliasSet(apiItems, context);
  for (const item of wikiItems) {
    const wikiAliases = normalizeWikiItemAliases(item, context);
    if (wikiAliases.some((alias) => apiAliasSet.has(alias))) return true;
  }
  return false;
}

export function aliasSetIntersects(
  aliasSet: Set<string>,
  wikiItems: string[]
): boolean {
  if (aliasSet.size === 0 || wikiItems.length === 0) return false;
  for (const item of wikiItems) {
    if (aliasSet.has(normalizeItemName(item))) return true;
  }
  return false;
}

export function itemsMatch(
  apiItems: ObjectiveItemRef[],
  wikiItems: string[],
  context?: string
): boolean {
  if (apiItems.length === 0 && wikiItems.length === 0) return true;
  if (apiItems.length === 0 || wikiItems.length === 0) return false;

  const wikiAliases = wikiItems.map((item) =>
    normalizeWikiItemAliases(item, context)
  );
  const matchedWikiIndexes = new Set<number>();

  for (const apiItem of apiItems) {
    const aliases = normalizeItemAliasesWithContext(apiItem, context);
    const matchIndex = wikiAliases.findIndex((values) =>
      values.some((value) => aliases.includes(value))
    );
    if (matchIndex === -1) return false;
    matchedWikiIndexes.add(matchIndex);
  }

  return wikiAliases.every((_, index) => matchedWikiIndexes.has(index));
}

export function collectMapNames(tasks: ExtendedTaskData[]): string[] {
  const names = new Set<string>();
  for (const task of tasks) {
    if (task.map?.name) names.add(task.map.name);
    for (const obj of task.objectives ?? []) {
      for (const map of obj.maps ?? []) {
        if (map?.name) names.add(map.name);
      }
    }
  }
  return Array.from(names);
}

export function buildMapAliasMap(mapNames: string[]): Map<string, string> {
  const aliasMap = new Map<string, string>();

  const addAlias = (alias: string, canonical: string): void => {
    const key = normalizeMapName(alias);
    if (key.length === 0) return;
    if (!aliasMap.has(key)) aliasMap.set(key, canonical);
  };

  for (const name of mapNames) {
    addAlias(name, name);
    if (name.toLowerCase().startsWith('the ')) {
      addAlias(name.slice(4), name);
    }
    if (name.toLowerCase().endsWith(' of tarkov')) {
      addAlias(name.replace(/\s+of tarkov$/i, ''), name);
    }
  }

  // Common shorthand
  if (mapNames.some((n) => n.toLowerCase() === 'the lab')) {
    addAlias('lab', 'The Lab');
    addAlias('laboratory', 'The Lab');
  }
  if (mapNames.some((n) => n.toLowerCase() === 'streets of tarkov')) {
    addAlias('streets', 'Streets of Tarkov');
  }
  if (mapNames.some((n) => n.toLowerCase() === 'ground zero')) {
    addAlias('gz', 'Ground Zero');
  }

  return aliasMap;
}

export function extractWikiLinkData(line: string): WikiLink[] {
  const results: WikiLink[] = [];
  const regex = /\[\[([^|\]]+)(?:\|([^\]]+))?\]\]/g;
  let match = regex.exec(line);
  while (match) {
    const target = match[1]?.trim();
    if (target && !/^(File|Category):/i.test(target)) {
      const cleanedTarget = stripWikiMarkup(target.split('#')[0]);
      const displayRaw = match[2]?.trim();
      const cleanedDisplay = displayRaw
        ? stripWikiMarkup(displayRaw.split('#')[0])
        : undefined;
      results.push({ target: cleanedTarget, display: cleanedDisplay });
    }
    match = regex.exec(line);
  }
  return results;
}

export function extractWikiLinks(line: string): string[] {
  return extractWikiLinkData(line).map((link) => link.target);
}

export function isExcludedMapMention(text: string, mapName: string): boolean {
  const normalized = text.toLowerCase();
  const map = mapName.toLowerCase();
  if (!normalized.includes(map)) return false;

  const clauseRegex = /\b(excluding|except)\b([^.)]*)/gi;
  let match = clauseRegex.exec(normalized);
  while (match) {
    const clause = match[2] ?? '';
    const mapRegex = new RegExp(`\\b${escapeRegExp(map)}\\b`, 'i');
    if (mapRegex.test(clause)) return true;
    match = clauseRegex.exec(normalized);
  }

  return false;
}

export function extractMapsFromText(
  text: string,
  aliasMap: Map<string, string>
): string[] {
  const results = new Set<string>();
  for (const [alias, canonical] of aliasMap.entries()) {
    if (isExcludedMapMention(text, alias)) continue;
    if (alias === 'lab' || alias === 'the lab') {
      const pattern = new RegExp(
        `\\b${escapeRegExp(alias)}\\b(?!\\s+scientist)`,
        'i'
      );
      if (pattern.test(text)) results.add(canonical);
      continue;
    }
    const pattern = new RegExp(`\\b${escapeRegExp(alias)}\\b`, 'i');
    if (pattern.test(text)) results.add(canonical);
  }
  return Array.from(results);
}

export function stripMapAliases(value: string, aliasMap: Map<string, string>): string {
  let result = value;
  for (const alias of aliasMap.keys()) {
    const normalizedAlias = normalizeObjectiveText(alias);
    if (!normalizedAlias) continue;
    const prepositionPattern = new RegExp(
      `\\b(?:on|in|at|from|near)\\s+${escapeRegExp(normalizedAlias)}\\b`,
      'gi'
    );
    result = result.replace(prepositionPattern, ' ');
    const pattern = new RegExp(`\\b${escapeRegExp(normalizedAlias)}\\b`, 'gi');
    result = result.replace(pattern, ' ');
  }
  return normalizeWhitespace(result);
}

export function extractItemTokens(value: string): string[] {
  const cleaned = normalizeItemName(value)
    .replace(/\b\d+(?:\.\d+)?(?:x\d+(?:\.\d+)?)?\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

  const stopWords = new Set([
    'machine',
    'gun',
    'rifle',
    'pistol',
    'launcher',
    'grenade',
    'automatic',
    'assault',
    'sniper',
    'marksman',
    'bolt',
    'action',
    'submachine',
    'smg',
    'lmg',
    'dmr',
    'carbine',
    'weapon',
    'weapons',
    'heavy',
    'light',
  ]);

  const tokens = cleaned.split(/\s+/).filter(Boolean);
  const filtered = tokens.filter(
    (token) => token.length > 1 && !stopWords.has(token) && !/^\d+$/.test(token)
  );
  return uniqueList(filtered);
}

export const COVERAGE_STOP_WORDS = new Set([
  'key',
  'keys',
  'keycard',
  'keycards',
  'card',
  'cards',
  'room',
  'rooms',
  'dorm',
  'dorms',
  'office',
  'offices',
  'door',
  'doors',
  'bunker',
  'bunkers',
  'warehouse',
  'warehouses',
  'shop',
  'shops',
  'store',
  'stores',
  'station',
  'stations',
  'base',
  'bases',
  'floor',
  'floors',
  'building',
  'buildings',
  'hangar',
  'hangars',
  'checkpoint',
  'checkpoints',
  'gate',
  'gates',
  'corridor',
  'hall',
  'hallway',
  'hallways',
  'exit',
  'entrance',
  'entrances',
  'route',
  'road',
  'bridge',
  'tunnel',
  'yard',
  'roof',
]);

export function extractCoverageTokens(value: string): string[] {
  return extractItemTokens(value).filter(
    (token) => !COVERAGE_STOP_WORDS.has(token)
  );
}

export function objectiveMentionsItem(
  itemName: string,
  text: string,
  mapAliasMap: Map<string, string>
): boolean {
  if (!text.trim()) return false;
  const normalizedText = stripMapAliases(
    normalizeObjectiveText(text),
    mapAliasMap
  );
  if (!normalizedText) return false;

  const tokens = extractItemTokens(itemName);
  if (tokens.length === 0) return false;

  return tokens.some((token) => normalizedText.includes(token));
}

export function objectiveTextCoversApiItems(
  itemRefs: ObjectiveItemRef[],
  text: string,
  mapAliasMap: Map<string, string>
): boolean {
  if (!text.trim() || itemRefs.length === 0) return false;
  const normalizedText = stripMapAliases(
    normalizeObjectiveText(text),
    mapAliasMap
  );
  if (!normalizedText) return false;

  const itemNames = itemRefs
    .map((item) => item.name)
    .filter((name): name is string => Boolean(name));
  if (itemNames.length === 0) return false;

  const tokenCounts = new Map<string, number>();
  for (const name of itemNames) {
    const tokens = extractCoverageTokens(name);
    if (tokens.length === 0) continue;
    for (const token of tokens) {
      tokenCounts.set(token, (tokenCounts.get(token) ?? 0) + 1);
    }
  }

  if (tokenCounts.size === 0) return false;
  const threshold = Math.max(1, Math.floor(itemNames.length * 0.5));
  for (const [token, count] of tokenCounts) {
    if (count >= threshold && normalizedText.includes(token)) return true;
  }

  return false;
}

export function toNormalizedSet(
  values: string[],
  normalize: (value: string) => string
): Set<string> {
  return new Set(values.map(normalize).filter((v) => v.length > 0));
}

export function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
}

export function isSubset(subset: Set<string>, superset: Set<string>): boolean {
  for (const value of subset) {
    if (!superset.has(value)) return false;
  }
  return true;
}

export function collectObjectiveItems(objective: ApiObjective): ObjectiveItemRef[] {
  const items = new Map<string, ObjectiveItemRef>();

  const addItemRef = (item?: {
    id?: string;
    name?: string;
    shortName?: string;
  }): void => {
    if (!item?.name || item.name.trim().length === 0) return;
    const key = item.id ?? normalizeItemName(item.name);
    const existing = items.get(key);
    if (existing) {
      if (!existing.shortName && item.shortName)
        existing.shortName = item.shortName;
      return;
    }
    items.set(key, {
      id: item.id,
      name: item.name,
      shortName: item.shortName,
    });
  };

  const addItems = (
    list?: Array<{ id?: string; name?: string; shortName?: string }>
  ): void => {
    for (const item of list ?? []) addItemRef(item);
  };

  const addItemGroups = (
    groups?: Array<Array<{ id?: string; name?: string; shortName?: string }>>
  ): void => {
    for (const group of groups ?? []) {
      for (const item of group ?? []) addItemRef(item);
    }
  };

  const addMaybeGroupedItems = (
    value?:
      | Array<{ id?: string; name?: string; shortName?: string }>
      | Array<Array<{ id?: string; name?: string; shortName?: string }>>
  ): void => {
    if (!value) return;
    if (Array.isArray(value) && value.length > 0 && Array.isArray(value[0])) {
      addItemGroups(
        value as Array<
          Array<{ id?: string; name?: string; shortName?: string }>
        >
      );
    } else {
      addItems(
        value as Array<{ id?: string; name?: string; shortName?: string }>
      );
    }
  };

  addItems(objective.items);
  addItems(objective.useAny);
  addItems(objective.usingWeapon);
  addItemGroups(objective.usingWeaponMods);
  addItems(objective.containsAll);
  addItemRef(objective.markerItem);
  addItemRef(objective.questItem);
  addItemRef(objective.item);
  addMaybeGroupedItems(objective.requiredKeys);

  return Array.from(items.values());
}

export function collectObjectiveItemNames(objective: ApiObjective): string[] {
  return uniqueList(collectObjectiveItems(objective).map((item) => item.name));
}
