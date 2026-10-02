/**
 * API-vs-wiki task comparison producing prioritized discrepancies.
 *
 * Extracted from the former single-file scripts/wiki-compare.ts.
 */

import { printHeader, printSuccess, icons } from '../../src/lib/index.js';
import {
  ApiObjective,
  Discrepancy,
  ExtendedTaskData,
  TARKOV_1_0_LAUNCH,
  WikiObjective,
  WikiTaskData,
  getPriority,
} from './types.js';
import { TaskSuppressionEntry, isObjectiveSuppressed, nextTaskKey } from './overlay.js';
import {
  ObjectiveItemRef,
  aliasSetIntersects,
  buildAliasSet,
  collectObjectiveItemNames,
  collectObjectiveItems,
  extractMapsFromText,
  getObjectiveVerbKey,
  hasItemIntersection,
  isSubset,
  itemsMatch,
  normalizeItemName,
  normalizeMapName,
  normalizeObjectiveMatchKey,
  normalizeObjectiveText,
  normalizeWhitespace,
  normalizeWikiItemAliases,
  objectiveHasCategoryItemRequirement,
  objectiveMentionsItem,
  objectiveTextCoversApiItems,
  setsEqual,
  stripCountPhrases,
  stripMapAliases,
  toNormalizedSet,
  uniqueList,
} from './normalize.js';
import { normalizeTaskName } from './api.js';
import { extractCount } from './wiki.js';

/**
 * Fence, whose trader reputation *is* Scav karma. Matched by id rather than name
 * because a display name can be localized or renamed upstream, while the id is
 * the merge identity consumers use (see TARKOV_TRADER_NAMES_BY_ID).
 */
const FENCE_TRADER_ID = '579dc571d53a0658a154fbec';

/**
 * Log a set-difference summary when two name sets disagree. Shared by the
 * prerequisite and next-task comparisons, which differ only in labels.
 */
function logTaskSetDiff(
  verbose: boolean,
  label: string,
  wikiNames: string[],
  apiNames: string[],
  apiSet: Set<string>,
  wikiSet: Set<string>
): void {
  if (!verbose) return;
  const missing = wikiNames.filter((t) => !apiSet.has(normalizeTaskName(t)));
  const extra = apiNames.filter((t) => !wikiSet.has(normalizeTaskName(t)));
  if (missing.length > 0)
    console.log(`${icons.warning} ${label} missing in API: ${missing.join(', ')}`);
  if (extra.length > 0) console.log(`${icons.warning} ${label} extra in API: ${extra.join(', ')}`);
}

type DiscrepancyInput = Pick<Discrepancy, 'field' | 'apiValue' | 'wikiValue' | 'trustsWiki'>;
type Report = (input: DiscrepancyInput) => void;
type ComparisonContext = {
  apiTask: ExtendedTaskData;
  wiki: WikiTaskData;
  mapAliasMap: Map<string, string>;
  verbose: boolean;
  taskId: string;
  taskName: string;
  report: Report;
  nextTaskMap?: Map<string, string[]>;
  taskSuppressions?: Map<string, TaskSuppressionEntry>;
};

function createReporter(
  apiTask: ExtendedTaskData,
  wiki: WikiTaskData,
  discrepancies: Discrepancy[]
): Report {
  let wikiLastEdit: string | undefined;
  let wikiEditDaysAgo: number | undefined;
  let wikiEditedPost1_0: boolean | undefined;
  if (wiki.lastRevision?.timestamp) {
    const revDate = new Date(wiki.lastRevision.timestamp);
    wikiLastEdit = revDate.toISOString().split('T')[0];
    wikiEditDaysAgo = Math.floor((Date.now() - revDate.getTime()) / (1000 * 60 * 60 * 24));
    wikiEditedPost1_0 = revDate >= TARKOV_1_0_LAUNCH;
  }
  return (input) =>
    discrepancies.push({
      taskId: apiTask.id,
      taskName: apiTask.name,
      field: input.field,
      apiValue: input.apiValue,
      wikiValue: input.wikiValue,
      priority: getPriority(input.field),
      trustsWiki: input.trustsWiki,
      wikiLastEdit,
      wikiEditDaysAgo,
      wikiEditedPost1_0,
    });
}

function compareKnownValue(
  { verbose, report }: ComparisonContext,
  field: string,
  apiValue: string | number | undefined,
  wikiValue: string | number,
  matches = apiValue === wikiValue
): void {
  if (!matches) {
    report({ field, apiValue, wikiValue, trustsWiki: true });
    if (verbose) console.log(`${icons.warning} ${field}: API=${apiValue}, Wiki=${wikiValue}`);
  } else if (verbose) {
    console.log(`${icons.success} ${field} matches (${apiValue})`);
  }
}

function comparePlayerLevel(context: ComparisonContext): void {
  const { apiTask, wiki } = context;
  if (wiki.minPlayerLevel !== undefined) {
    compareKnownValue(context, 'minPlayerLevel', apiTask.minPlayerLevel, wiki.minPlayerLevel);
  }
}

function compareTraderLoyalty({ apiTask, wiki, verbose, report }: ComparisonContext): void {
  // traderRequirements (loyalty gates)
  //
  // Patch 1.1.0.0 moved most quest gates from a player level onto a trader
  // loyalty tier and expresses them as opaque `GlobalVariableValue` start
  // conditions, so the client cannot confirm a tier and the wiki Requirements
  // section is the source for this field (see AGENTS.md). Compare only when the
  // wiki actually states a gate: wiki silence is not evidence of absence, since
  // many pages still document the pre-1.1 player level instead.
  if (wiki.traderLoyalty.length > 0) {
    // The comparator is part of the gate, not decoration: `Prapor >= 3` and
    // `Prapor <= 3` describe opposite availability. Dropping it let an
    // API record with the right trader and tier but the wrong direction read as
    // correct. The wiki phrasing ("Must reach Loyalty Level N") is always a
    // minimum, so `>=` is the expected direction. All 335 loyalty requirements
    // tarkov.dev currently serves across the three modes use `>=`, so this adds
    // no noise today and reports a direction regression if one appears.
    const apiLoyalty = (apiTask.traderRequirements ?? [])
      .filter((req) => req.requirementType === 'level')
      .map((req) => `${req.trader?.name}:${req.compareMethod ?? '?'}:${req.value}`)
      .sort();
    const wikiLoyalty = wiki.traderLoyalty.map((ll) => `${ll.trader}:>=:${ll.level}`).sort();
    if (wikiLoyalty.some((gate) => !apiLoyalty.includes(gate))) {
      // Mark attributions the wiki sentence did not state: the tier is quoted,
      // the trader is inferred from the infobox quest giver, and a reviewer must
      // be able to tell those apart before writing an override.
      const reported = wiki.traderLoyalty
        .map((ll) => `${ll.trader}:${ll.level}${ll.inferredTrader ? ' (trader inferred)' : ''}`)
        .sort();
      report({
        field: 'traderRequirements',
        apiValue: apiLoyalty.join(', ') || '(none)',
        wikiValue: reported.join(', '),
        trustsWiki: !wiki.traderLoyalty.some((entry) => entry.inferredTrader),
      });
      if (verbose)
        console.log(
          `${icons.warning} traderRequirements: API=${apiLoyalty.join(', ') || '(none)'}, Wiki=${reported.join(', ')}`
        );
    } else if (verbose) {
      console.log(`${icons.success} traderRequirements match (${wikiLoyalty.join(', ')})`);
    }
  }
}

function compareScavKarma({ apiTask, wiki, verbose, report }: ComparisonContext): void {
  // scavKarma (Fence reputation gate)
  //
  // json.tarkov.dev models Scav karma as a `reputation` trader requirement on
  // Fence (a `level` requirement is a loyalty tier, compared above), so a wiki
  // karma sentence is comparable to API data. Reported, never auto-generated:
  // like every trader requirement the gate is progression-critical and a wiki
  // sentence states the threshold without always making the direction explicit,
  // so a mismatch is escalated for a human to confirm.
  //
  // One-directional on purpose, for the same reason as the loyalty block: a wiki
  // page with no karma sentence is not evidence that the task has no karma gate,
  // so an API-only gate is not reported as a wiki disagreement.
  if (wiki.scavKarma !== undefined) {
    const apiKarma = (apiTask.traderRequirements ?? []).filter(
      (req) => req.requirementType === 'reputation' && req.trader?.id === FENCE_TRADER_ID
    );
    const karma = wiki.scavKarma;
    const wikiKarma = `${karma.compareMethod ?? '(direction unspecified)'} ${karma.value}`;
    const matches = apiKarma.some(
      (req) =>
        req.value === karma.value &&
        karma.compareMethod !== undefined &&
        req.compareMethod === karma.compareMethod
    );
    if (!matches) {
      report({
        field: 'scavKarma',
        apiValue:
          apiKarma.map((req) => `${req.compareMethod ?? '>='} ${req.value}`).join(', ') || '(none)',
        wikiValue: wikiKarma,
        trustsWiki: karma.compareMethod !== undefined,
      });
      if (verbose)
        console.log(
          `${icons.warning} scavKarma: API=${
            apiKarma.map((req) => `${req.compareMethod ?? '>='} ${req.value}`).join(', ') ||
            '(none)'
          }, Wiki=${wikiKarma}`
        );
    } else if (verbose) {
      console.log(`${icons.success} scavKarma matches (${wikiKarma})`);
    }
  }
}

function compareFaction(context: ComparisonContext): void {
  const { apiTask, wiki } = context;
  if (wiki.factionName !== undefined) {
    compareKnownValue(context, 'factionName', apiTask.factionName ?? 'Any', wiki.factionName);
  }
}

function compareTaskMap(context: ComparisonContext): void {
  const { apiTask, wiki, verbose } = context;
  const apiMapName = apiTask.map?.name;
  const wikiObjectiveMaps = uniqueList(wiki.objectives.flatMap((obj) => obj.maps ?? []));
  const wikiTaskMaps = wiki.maps.length > 0 ? wiki.maps : wikiObjectiveMaps;
  const wikiTaskMapSet = toNormalizedSet(wikiTaskMaps, normalizeMapName);
  if (wikiTaskMapSet.size === 0) {
    if (verbose && apiMapName) {
      console.log(`${icons.info} map in API: ${apiMapName}, Wiki=none (not specified)`);
    }
    return;
  }
  const apiMapSet = apiMapName ? new Set([normalizeMapName(apiMapName)]) : new Set<string>();
  compareKnownValue(
    context,
    'map',
    apiMapName ?? 'none',
    wikiTaskMaps.join(', '),
    setsEqual(apiMapSet, wikiTaskMapSet)
  );
}

function compareTaskFields(context: ComparisonContext): void {
  comparePlayerLevel(context);
  compareTraderLoyalty(context);
  compareScavKarma(context);
  compareFaction(context);
  compareTaskMap(context);
}

type MatchedObjective = {
  api: ApiObjective;
  wiki: WikiObjective;
  matchType: 'text' | 'item';
};
type WikiCandidate = {
  wiki: WikiObjective;
  index: number;
  textKey: string;
  verb: ReturnType<typeof getObjectiveVerbKey>;
  items: string[];
};
type ObjectiveCandidates = {
  candidates: WikiCandidate[];
  unmatched: Set<number>;
};

/** Explicit non-FiR wording must not contribute to either FiR matching rule. */
function isFoundInRaidObjective(objective: ApiObjective): boolean {
  const description = objective.description ?? '';
  return (
    objective.foundInRaid === true ||
    (/found in raid/i.test(description) && !/not\s+found in raid/i.test(description))
  );
}

function findTextCandidate(textKey: string, { candidates, unmatched }: ObjectiveCandidates) {
  if (!textKey) return undefined;
  const exact = candidates.find(
    (candidate) => unmatched.has(candidate.index) && candidate.textKey === textKey
  );
  if (exact) return exact;
  if (textKey.split(' ').filter(Boolean).length < 4) return undefined;
  const substringMatches = candidates.filter((candidate) => {
    if (!unmatched.has(candidate.index) || !candidate.textKey) return false;
    if (candidate.textKey.split(' ').filter(Boolean).length < 4) return false;
    return candidate.textKey.includes(textKey) || textKey.includes(candidate.textKey);
  });
  return substringMatches.length === 1 ? substringMatches[0] : undefined;
}

function findItemCandidate(
  apiObj: ApiObjective,
  { candidates, unmatched }: ObjectiveCandidates,
  taskName: string
) {
  const verb = getObjectiveVerbKey(apiObj.description ?? '');
  const items = collectObjectiveItems(apiObj);
  if (!verb || items.length === 0) return undefined;
  const findVerb = (candidateVerb: string) =>
    candidates.find(
      (candidate) =>
        unmatched.has(candidate.index) &&
        candidate.verb === candidateVerb &&
        hasItemIntersection(items, candidate.items, taskName)
    );
  const candidate = findVerb(verb);
  if (candidate) return candidate;
  if (verb === 'hand_over' && isFoundInRaidObjective(apiObj)) return findVerb('find');
  return undefined;
}

function collectUnmatchedWiki(
  { candidates, unmatched }: ObjectiveCandidates,
  objectives: ApiObjective[]
): WikiObjective[] {
  const foundInRaidItemSets = objectives
    .filter(isFoundInRaidObjective)
    .map((obj) => buildAliasSet(collectObjectiveItems(obj)));
  return candidates
    .filter((candidate) => {
      if (!unmatched.has(candidate.index)) return false;
      if (candidate.verb !== 'find' || candidate.items.length === 0) return true;
      return !foundInRaidItemSets.some((aliasSet) => aliasSetIntersects(aliasSet, candidate.items));
    })
    .map((candidate) => candidate.wiki);
}

type ObjectiveMatches = {
  matchedObjectives: MatchedObjective[];
  unmatchedApi: ApiObjective[];
  unmatchedWiki: WikiObjective[];
  apiQuestItemSet: Set<string>;
};

function applySingleObjectiveFallback(
  result: ObjectiveMatches,
  apiObjectives: ApiObjective[],
  wikiObjectives: WikiObjective[]
): void {
  // Compare a sole objective directly even when its text does not match.
  if (
    result.matchedObjectives.length !== 0 ||
    apiObjectives.length !== 1 ||
    wikiObjectives.length !== 1
  )
    return;
  result.matchedObjectives.push({
    api: apiObjectives[0],
    wiki: wikiObjectives[0],
    matchType: 'text',
  });
  result.unmatchedApi.length = 0;
  result.unmatchedWiki.length = 0;
}

function matchObjectives({ apiTask, wiki, mapAliasMap, taskName }: ComparisonContext) {
  const apiObjectives = apiTask.objectives ?? [];
  // Objective matching by normalized description
  const wikiCandidates = wiki.objectives.map((wikiObj, index) => ({
    wiki: wikiObj,
    index,
    textKey: stripMapAliases(normalizeObjectiveMatchKey(wikiObj.text), mapAliasMap),
    verb: getObjectiveVerbKey(wikiObj.text),
    items: uniqueList(wikiObj.items ?? []),
  }));

  const matchedObjectives: MatchedObjective[] = [];
  const unmatchedApi: ApiObjective[] = [];
  const unmatchedWikiIndexes = new Set(wikiCandidates.map((c) => c.index));
  const apiQuestItemSet = toNormalizedSet(
    apiObjectives.map((obj) => obj.questItem?.name).filter((name): name is string => Boolean(name)),
    normalizeItemName
  );

  const candidates = { candidates: wikiCandidates, unmatched: unmatchedWikiIndexes };
  for (const apiObj of apiObjectives) {
    const textKey = stripMapAliases(
      normalizeObjectiveMatchKey(apiObj.description ?? ''),
      mapAliasMap
    );
    const textCandidate = findTextCandidate(textKey, candidates);
    const candidate = textCandidate ?? findItemCandidate(apiObj, candidates, taskName);
    if (!candidate) {
      unmatchedApi.push(apiObj);
      continue;
    }
    matchedObjectives.push({
      api: apiObj,
      wiki: candidate.wiki,
      matchType: textCandidate ? 'text' : 'item',
    });
    unmatchedWikiIndexes.delete(candidate.index);
  }
  const unmatchedWiki = collectUnmatchedWiki(candidates, apiObjectives);

  const result = { matchedObjectives, unmatchedApi, unmatchedWiki, apiQuestItemSet };
  applySingleObjectiveFallback(result, apiObjectives, wiki.objectives);
  return result;
}

type ObjectiveReport = (
  objectiveId: string,
  field: string,
  apiValue: string | number | undefined,
  wikiValue: string | number | undefined,
  logMessage: () => void
) => void;
type ObjectiveContext = ComparisonContext & {
  apiQuestItemSet: Set<string>;
  pushObjectiveDiscrepancy: ObjectiveReport;
};

function objectiveIsSuppressed(
  { taskSuppressions, taskId }: ComparisonContext,
  objectiveId: string,
  field?: string
): boolean {
  return taskSuppressions
    ? isObjectiveSuppressed(taskSuppressions, taskId, objectiveId, field)
    : false;
}

function createObjectiveReporter(context: ComparisonContext): ObjectiveReport {
  return (objectiveId, field, apiValue, wikiValue, logMessage) => {
    if (objectiveIsSuppressed(context, objectiveId, field)) return;
    context.report({ field, apiValue, wikiValue, trustsWiki: true });
    if (context.verbose) logMessage();
  };
}

function compareUnmatchedObjectives(
  context: ObjectiveContext,
  unmatchedApi: ApiObjective[],
  unmatchedWiki: WikiObjective[]
): void {
  for (const apiObj of unmatchedApi) {
    const desc = apiObj.description ?? apiObj.id;
    context.pushObjectiveDiscrepancy(apiObj.id, 'objectives.description', desc, 'not found', () =>
      console.log(`${icons.warning} objective missing in wiki: ${desc}`)
    );
  }
  for (const wikiObj of unmatchedWiki) {
    context.report({
      field: 'objectives.description',
      apiValue: 'not found',
      wikiValue: wikiObj.text,
      trustsWiki: true,
    });
    if (context.verbose) console.log(`${icons.warning} objective missing in API: ${wikiObj.text}`);
  }
}

function matchingObjectiveRequiredItems(
  { wiki, taskName }: ObjectiveContext,
  apiObj: ApiObjective
): string[] {
  const apiRequiredKeys = buildAliasSet(
    Array.isArray(apiObj.requiredKeys) ? (apiObj.requiredKeys.flat() as ObjectiveItemRef[]) : [],
    taskName
  );
  if (apiRequiredKeys.size === 0) return [];
  return wiki.relatedRequiredItems.filter((item) =>
    normalizeWikiItemAliases(item, taskName).some((alias) => apiRequiredKeys.has(alias))
  );
}

function relatedObjectiveHandoverItems(
  wiki: WikiTaskData,
  wikiItems: string[],
  apiHasQuestItem: boolean,
  apiVerb: ReturnType<typeof getObjectiveVerbKey>
): string[] {
  return wikiItems.length === 0 && (apiHasQuestItem || apiVerb === 'hand_over')
    ? wiki.relatedHandoverItems
    : [];
}

function prepareObjective(
  context: ObjectiveContext,
  { api: apiObj, wiki: wikiObj, matchType }: MatchedObjective
) {
  const { wiki, taskName } = context;
  const apiDesc = normalizeWhitespace(apiObj.description ?? '');
  const wikiDesc = normalizeWhitespace(wikiObj.text);
  const objectiveLabel = apiObj.description ?? wikiObj.text ?? apiObj.id;
  const apiVerb = getObjectiveVerbKey(apiObj.description ?? '');
  const apiItemRefs = collectObjectiveItems(apiObj);
  const apiItems = uniqueList(apiItemRefs.map((item) => item.name));
  const wikiItems = uniqueList(wikiObj.items ?? []);
  const matchingRequiredItems = matchingObjectiveRequiredItems(context, apiObj);
  const apiHasQuestItem = Boolean(apiObj.questItem);
  const wikiItemsForCompare = uniqueList([
    ...wikiItems,
    ...matchingRequiredItems,
    ...relatedObjectiveHandoverItems(wiki, wikiItems, apiHasQuestItem, apiVerb),
  ]);
  const itemsMatchForDescription =
    apiItemRefs.length > 0 &&
    wikiItemsForCompare.length > 0 &&
    itemsMatch(apiItemRefs, wikiItemsForCompare, taskName);

  return {
    ...context,
    apiObj,
    wikiObj,
    matchType,
    apiDesc,
    wikiDesc,
    objectiveLabel,
    apiVerb,
    apiItemRefs,
    apiItems,
    wikiItems,
    matchingRequiredItems,
    apiHasQuestItem,
    wikiItemsForCompare,
    itemsMatchForDescription,
  };
}

type PreparedObjective = ReturnType<typeof prepareObjective>;

function objectiveDescriptionForCompare(description: string, stripCounts: boolean): string {
  const stripped = stripCounts ? normalizeWhitespace(stripCountPhrases(description)) : description;
  return stripped.length > 0 ? stripped : description;
}

function compareObjectiveDescription(objective: PreparedObjective): void {
  const {
    apiObj,
    mapAliasMap,
    pushObjectiveDiscrepancy,
    apiDesc,
    wikiDesc,
    itemsMatchForDescription,
    matchType,
  } = objective;
  const apiDescForCompare = objectiveDescriptionForCompare(apiDesc, apiObj.count !== undefined);
  const wikiDescForCompare = objectiveDescriptionForCompare(wikiDesc, apiObj.count !== undefined);

  const normalizedApi = stripMapAliases(normalizeObjectiveText(apiDescForCompare), mapAliasMap);
  const normalizedWiki = stripMapAliases(normalizeObjectiveText(wikiDescForCompare), mapAliasMap);
  const normalizedApiKey = stripMapAliases(
    normalizeObjectiveMatchKey(apiDescForCompare),
    mapAliasMap
  );
  const normalizedWikiKey = stripMapAliases(
    normalizeObjectiveMatchKey(wikiDescForCompare),
    mapAliasMap
  );

  if (
    matchType === 'text' &&
    apiDesc &&
    wikiDesc &&
    normalizedApi !== normalizedWiki &&
    normalizedApiKey !== normalizedWikiKey &&
    !itemsMatchForDescription
  ) {
    pushObjectiveDiscrepancy(
      apiObj.id,
      'objectives.description',
      apiDescForCompare,
      wikiDescForCompare,
      () =>
        console.log(
          `${icons.warning} objective text differs: API="${apiDescForCompare}", Wiki="${wikiDescForCompare}"`
        )
    );
  }
}

function wikiObjectiveCount(apiTask: ExtendedTaskData, wikiObj: WikiObjective) {
  const isPveTask = apiTask.gameModes?.length === 1 && apiTask.gameModes[0] === 'pve';
  return isPveTask && wikiObj.pveCount !== undefined ? wikiObj.pveCount : wikiObj.count;
}

function matchesWikiCountVariant(apiCount: number, wikiObj: WikiObjective): boolean {
  return (
    wikiObj.pveCount !== undefined && (apiCount === wikiObj.count || apiCount === wikiObj.pveCount)
  );
}

function compareObjectiveCount(objective: PreparedObjective): void {
  const { apiObj, wikiObj, apiTask, verbose, pushObjectiveDiscrepancy, objectiveLabel } = objective;
  const apiCount =
    apiObj.count ?? extractCount(apiObj.description ?? '', collectObjectiveItemNames(apiObj));
  const wikiCount = wikiObjectiveCount(apiTask, wikiObj);
  if (apiCount !== undefined && wikiCount !== undefined) {
    const matchesPveVariant = matchesWikiCountVariant(apiCount, wikiObj);

    if (!matchesPveVariant && apiCount !== wikiCount) {
      pushObjectiveDiscrepancy(
        apiObj.id,
        'objectives.count',
        `${apiCount} (${objectiveLabel})`,
        `${wikiCount} (${wikiObj.text})`,
        () =>
          console.log(
            `${icons.warning} objective count: API=${apiCount}, Wiki=${wikiCount} (${objectiveLabel})`
          )
      );
    } else if (verbose) {
      console.log(`${icons.success} objective count matches (${apiCount})`);
    }
  }
}

function objectiveApiMapNames({ apiObj, mapAliasMap }: PreparedObjective): string[] {
  const names = uniqueList((apiObj.maps ?? []).map((map) => map.name));
  return names.length > 0 ? names : extractMapsFromText(apiObj.description ?? '', mapAliasMap);
}

function objectiveMapsMatch(
  { apiObj, wikiObj, apiVerb }: PreparedObjective,
  apiMapNames: string[],
  wikiMapNames: string[]
): boolean {
  const apiSet = toNormalizedSet(apiMapNames, normalizeMapName);
  const wikiSet = toNormalizedSet(wikiMapNames, normalizeMapName);
  if (setsEqual(apiSet, wikiSet)) return true;
  if (apiVerb === 'hand_over' && apiSet.size === 0) return true;
  const descForTransit = `${apiObj.description ?? ''} ${wikiObj.text ?? ''}`;
  const isTransitObjective = /\btransit\b|\btransfer\b|\bpassage\b|\bleading to\b/i.test(
    descForTransit
  );
  return isTransitObjective && apiSet.size > 0 && isSubset(apiSet, wikiSet);
}

function compareObjectiveMaps(objective: PreparedObjective): void {
  const { apiObj, wikiObj, verbose, pushObjectiveDiscrepancy, objectiveLabel } = objective;
  const apiMapNames = objectiveApiMapNames(objective);
  const wikiMapNames = uniqueList(wikiObj.maps ?? []);
  if (wikiMapNames.length === 0) {
    if (verbose && apiMapNames.length > 0) {
      console.log(
        `${icons.info} objective maps: API=${apiMapNames.join(', ')}, Wiki=none (not specified)`
      );
    }
    return;
  }
  if (objectiveMapsMatch(objective, apiMapNames, wikiMapNames)) return;
  pushObjectiveDiscrepancy(
    apiObj.id,
    'objectives.maps',
    `${apiMapNames.join(', ') || 'none'} (${objectiveLabel})`,
    `${wikiMapNames.join(', ') || 'none'} (${wikiObj.text})`,
    () =>
      console.log(
        `${icons.warning} objective maps differ: API=${apiMapNames.join(', ') || 'none'}, Wiki=${wikiMapNames.join(', ') || 'none'}`
      )
  );
}

function isSkillObjective({ apiObj, wikiObj }: PreparedObjective): boolean {
  return (
    /\bskill level\b/i.test(apiObj.description ?? '') || /\bskill level\b/i.test(wikiObj.text ?? '')
  );
}

function usesRelatedObjectiveItems(objective: PreparedObjective): boolean {
  const { matchingRequiredItems, wiki, wikiItems, apiHasQuestItem, apiVerb } = objective;
  return (
    matchingRequiredItems.length > 0 ||
    relatedObjectiveHandoverItems(wiki, wikiItems, apiHasQuestItem, apiVerb).length > 0
  );
}

function wikiItemsMentionedInObjective({
  apiObj,
  wikiObj,
  wikiItems,
  mapAliasMap,
}: PreparedObjective): boolean {
  if (wikiItems.length === 0) return false;
  return wikiItems.every(
    (item) =>
      objectiveMentionsItem(item, apiObj.description ?? '', mapAliasMap) ||
      objectiveMentionsItem(item, wikiObj.text ?? '', mapAliasMap)
  );
}

function hasNarrativeItemMention(objective: PreparedObjective): boolean {
  return (
    objective.apiItemRefs.length === 0 &&
    !usesRelatedObjectiveItems(objective) &&
    objective.apiVerb !== 'hand_over' &&
    wikiItemsMentionedInObjective(objective)
  );
}

function hasCategoryItemRequirement({
  apiObj,
  wikiObj,
  wikiItemsForCompare,
}: PreparedObjective): boolean {
  return (
    wikiItemsForCompare.length === 0 &&
    (objectiveHasCategoryItemRequirement(apiObj.description ?? '') ||
      objectiveHasCategoryItemRequirement(wikiObj.text ?? ''))
  );
}

function textCoversObjectiveItems(objective: PreparedObjective): boolean {
  const { apiObj, wikiObj, apiItemRefs, wikiItemsForCompare, mapAliasMap } = objective;
  return (
    apiItemRefs.length > 0 &&
    wikiItemsForCompare.length === 0 &&
    objectiveTextCoversApiItems(
      apiItemRefs,
      `${apiObj.description ?? ''} ${wikiObj.text ?? ''}`,
      mapAliasMap
    )
  );
}

function allowsAnyObjectiveItem({
  apiObj,
  apiItemRefs,
  wikiItemsForCompare,
}: PreparedObjective): boolean {
  return (
    /\bany\b/i.test(apiObj.description ?? '') &&
    apiItemRefs.length >= 8 &&
    wikiItemsForCompare.length === 0
  );
}

function handoverMatchesQuestItem(objective: PreparedObjective): boolean {
  const { apiItemRefs, apiVerb, wikiItemsForCompare, apiQuestItemSet } = objective;
  return (
    apiItemRefs.length === 0 &&
    apiVerb === 'hand_over' &&
    wikiItemsForCompare.length > 0 &&
    Array.from(toNormalizedSet(wikiItemsForCompare, normalizeItemName)).every((item) =>
      apiQuestItemSet.has(item)
    )
  );
}

/** Preserve exception precedence so verbose diagnostics keep the same reason. */
function objectiveItemSkipReason(objective: PreparedObjective): string | undefined {
  if (isSkillObjective(objective)) return 'skill requirement, skipping item compare';
  if (hasNarrativeItemMention(objective)) return 'item mentioned in text, skipping strict compare';
  if (hasCategoryItemRequirement(objective)) return 'category requirement, skipping strict compare';
  if (textCoversObjectiveItems(objective))
    return 'objective text covers API items, skipping strict compare';
  if (allowsAnyObjectiveItem(objective)) return 'API allows any item, skipping strict compare';
  if (handoverMatchesQuestItem(objective))
    return 'handover matches quest item, skipping strict compare';
  return undefined;
}

function compareObjectiveItems(objective: PreparedObjective): void {
  const {
    apiObj,
    wikiObj,
    taskName,
    verbose,
    pushObjectiveDiscrepancy,
    objectiveLabel,
    apiItemRefs,
    apiItems,
    wikiItems,
    wikiItemsForCompare,
  } = objective;
  if (apiItemRefs.length === 0 && wikiItemsForCompare.length === 0) return;
  const skipReason = objectiveItemSkipReason(objective);
  if (skipReason) {
    if (verbose) console.log(`${icons.info} objective items: ${skipReason}`);
    return;
  }
  if (itemsMatch(apiItemRefs, wikiItemsForCompare, taskName)) return;
  pushObjectiveDiscrepancy(
    apiObj.id,
    'objectives.items',
    `${apiItems.join(', ') || 'none'} (${objectiveLabel})`,
    `${wikiItemsForCompare.join(', ') || 'none'} (${wikiObj.text})`,
    () =>
      console.log(
        `${icons.warning} objective items differ: API=${apiItems.join(', ') || 'none'}, Wiki=${wikiItems.join(', ') || 'none'}`
      )
  );
}

function compareObjectives(context: ComparisonContext): void {
  const { matchedObjectives, unmatchedApi, unmatchedWiki, apiQuestItemSet } =
    matchObjectives(context);
  const objectiveContext: ObjectiveContext = {
    ...context,
    apiQuestItemSet,
    pushObjectiveDiscrepancy: createObjectiveReporter(context),
  };
  compareUnmatchedObjectives(objectiveContext, unmatchedApi, unmatchedWiki);
  for (const matched of matchedObjectives) {
    if (objectiveIsSuppressed(context, matched.api.id)) continue;
    const objective = prepareObjective(objectiveContext, matched);
    compareObjectiveDescription(objective);
    compareObjectiveCount(objective);
    compareObjectiveMaps(objective);
    compareObjectiveItems(objective);
  }
}

function compareTaskNames(
  context: ComparisonContext,
  field: 'taskRequirements' | 'nextTasks',
  label: string,
  apiNames: string[],
  wikiNames: string[]
): void {
  const apiSet = toNormalizedSet(apiNames, normalizeTaskName);
  const wikiSet = toNormalizedSet(wikiNames, normalizeTaskName);
  if (apiSet.size === 0 && wikiSet.size === 0) return;
  if (!setsEqual(apiSet, wikiSet)) {
    context.report({
      field,
      apiValue: apiNames.join(', ') || 'none',
      wikiValue: wikiNames.join(', ') || 'none',
      trustsWiki: false,
    });
    logTaskSetDiff(context.verbose, label, wikiNames, apiNames, apiSet, wikiSet);
  } else if (context.verbose) {
    console.log(`${icons.success} ${label} match`);
  }
}

function compareUnlockHints(context: ComparisonContext): void {
  // Narrative order is an investigation hint, never proof of an unlock edge.
  const { apiTask, wiki, taskId, nextTaskMap } = context;
  const apiReqNames = (apiTask.taskRequirements ?? [])
    .map((req) => req.task?.name)
    .filter((name): name is string => Boolean(name));
  compareTaskNames(context, 'taskRequirements', 'prerequisites', apiReqNames, wiki.previousTasks);
  // Mode-qualified: a mode-divergent prerequisite must not be read back into
  // the other mode's comparison when the same task id appears in both modes.
  const apiNextNames =
    nextTaskMap?.get(nextTaskKey(apiTask.gameModes?.[0] ?? 'regular', taskId)) ?? [];
  compareTaskNames(context, 'nextTasks', 'next tasks', apiNextNames, wiki.nextTasks);
}

function compareExperience(context: ComparisonContext): void {
  const { apiTask, wiki } = context;
  if (wiki.rewards.xp !== undefined && apiTask.experience !== undefined) {
    compareKnownValue(context, 'experience', apiTask.experience, wiki.rewards.xp);
  }
}

function compareTraderReputation(
  context: ComparisonContext,
  wikiRep: WikiTaskData['rewards']['reputations'][number],
  apiReputations: NonNullable<NonNullable<ExtendedTaskData['finishRewards']>['traderStanding']>
): void {
  const { verbose, report } = context;
  const apiTraderRep = apiReputations.find(
    (trader) => trader.trader.name.toLowerCase() === wikiRep.trader.toLowerCase()
  );
  if (!apiTraderRep) {
    if (verbose) {
      console.log(`${icons.info} ${wikiRep.trader} rep: Wiki=${wikiRep.value}, not found in API`);
    }
    return;
  }
  if (Math.abs(apiTraderRep.standing - wikiRep.value) > 0.001) {
    report({
      field: `reputation.${wikiRep.trader}`,
      apiValue: apiTraderRep.standing,
      wikiValue: wikiRep.value,
      trustsWiki: true,
    });
    if (verbose)
      console.log(
        `${icons.warning} ${wikiRep.trader} rep: API=${apiTraderRep.standing}, Wiki=${wikiRep.value}`
      );
  } else if (verbose) {
    console.log(`${icons.success} ${wikiRep.trader} rep matches (${apiTraderRep.standing})`);
  }
}

function compareReputation(context: ComparisonContext): void {
  const apiReputations = context.apiTask.finishRewards?.traderStanding;
  if (!apiReputations) return;
  for (const wikiRep of context.wiki.rewards.reputations) {
    compareTraderReputation(context, wikiRep, apiReputations);
  }
}

function compareMoney(context: ComparisonContext): void {
  const { apiTask, wiki } = context;
  if (wiki.rewards.money === undefined || !apiTask.finishRewards?.items) return;
  const apiMoney = apiTask.finishRewards.items.find((item) => item.item.name === 'Roubles')?.count;
  if (apiMoney !== undefined) compareKnownValue(context, 'money', apiMoney, wiki.rewards.money);
}

function compareRewards(context: ComparisonContext): void {
  compareExperience(context);
  compareReputation(context);
  compareMoney(context);
}

export function compareTasks(
  apiTask: ExtendedTaskData,
  wiki: WikiTaskData,
  mapAliasMap: Map<string, string>,
  verbose = true,
  nextTaskMap?: Map<string, string[]>,
  taskSuppressions?: Map<string, TaskSuppressionEntry>
): Discrepancy[] {
  const discrepancies: Discrepancy[] = [];
  const context: ComparisonContext = {
    apiTask,
    wiki,
    mapAliasMap,
    verbose,
    nextTaskMap,
    taskSuppressions,
    taskId: apiTask.id,
    taskName: apiTask.name,
    report: createReporter(apiTask, wiki, discrepancies),
  };
  if (verbose) printHeader('COMPARISON');
  compareTaskFields(context);
  compareObjectives(context);
  compareUnlockHints(context);
  compareRewards(context);
  if (verbose) {
    console.log();
    printSuccess(
      discrepancies.length === 0
        ? 'No discrepancies detected.'
        : `Detected ${discrepancies.length} discrepancy(ies).`
    );
  }
  return discrepancies;
}
