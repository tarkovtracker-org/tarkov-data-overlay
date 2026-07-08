/**
 * API-vs-wiki task comparison producing prioritized discrepancies.
 *
 * Extracted from the former single-file scripts/wiki-compare.ts.
 */

import {
  printHeader,
  printSuccess,
  icons,
} from '../../src/lib/index.js';
import {
  ApiObjective,
  Discrepancy,
  ExtendedTaskData,
  TARKOV_1_0_LAUNCH,
  WikiObjective,
  WikiTaskData,
  getPriority,
} from './types.js';
import {
  TaskSuppressionEntry,
  isObjectiveSuppressed,
} from './overlay.js';
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
import {
  normalizeTaskName,
} from './api.js';
import {
  extractCount,
} from './wiki.js';

export function compareTasks(
  apiTask: ExtendedTaskData,
  wiki: WikiTaskData,
  mapAliasMap: Map<string, string>,
  verbose = true,
  nextTaskMap?: Map<string, string[]>,
  taskSuppressions?: Map<string, TaskSuppressionEntry>
): Discrepancy[] {
  const discrepancies: Discrepancy[] = [];
  const taskId = apiTask.id;
  const taskName = apiTask.name;

  // Calculate wiki edit age for discrepancy context
  let wikiLastEdit: string | undefined;
  let wikiEditDaysAgo: number | undefined;
  let wikiEditedPost1_0: boolean | undefined;
  if (wiki.lastRevision?.timestamp) {
    const revDate = new Date(wiki.lastRevision.timestamp);
    wikiLastEdit = revDate.toISOString().split('T')[0];
    wikiEditDaysAgo = Math.floor(
      (Date.now() - revDate.getTime()) / (1000 * 60 * 60 * 24)
    );
    wikiEditedPost1_0 = revDate >= TARKOV_1_0_LAUNCH;
  }

  if (verbose) printHeader('COMPARISON');

  const isSuppressedObjectiveField = (objectiveId: string, field: string): boolean =>
    taskSuppressions
      ? isObjectiveSuppressed(taskSuppressions, taskId, objectiveId, field)
      : false;

  // minPlayerLevel
  if (wiki.minPlayerLevel !== undefined) {
    if (apiTask.minPlayerLevel !== wiki.minPlayerLevel) {
      discrepancies.push({
        taskId,
        taskName,
        field: 'minPlayerLevel',
        apiValue: apiTask.minPlayerLevel,
        wikiValue: wiki.minPlayerLevel,
        priority: getPriority('minPlayerLevel'),
        trustsWiki: true,
        wikiLastEdit,
        wikiEditDaysAgo,
        wikiEditedPost1_0,
      });
      if (verbose)
        console.log(
          `${icons.warning} minPlayerLevel: API=${apiTask.minPlayerLevel}, Wiki=${wiki.minPlayerLevel}`
        );
    } else if (verbose) {
      console.log(
        `${icons.success} minPlayerLevel matches (${apiTask.minPlayerLevel})`
      );
    }
  }

  const isPveTask =
    apiTask.gameModes?.length === 1 && apiTask.gameModes[0] === 'pve';

  // Task-level map/location
  const apiMapName = apiTask.map?.name;
  const wikiObjectiveMaps = uniqueList(
    wiki.objectives.flatMap((obj) => obj.maps ?? [])
  );
  const wikiTaskMaps = wiki.maps.length > 0 ? wiki.maps : wikiObjectiveMaps;
  const wikiTaskMapSet = toNormalizedSet(wikiTaskMaps, normalizeMapName);

  if (wikiTaskMapSet.size > 0) {
    const apiMapSet = apiMapName
      ? new Set([normalizeMapName(apiMapName)])
      : new Set<string>();
    const mapsMatch = apiMapName ? setsEqual(apiMapSet, wikiTaskMapSet) : false;

    if (!mapsMatch) {
      discrepancies.push({
        taskId,
        taskName,
        field: 'map',
        apiValue: apiMapName ?? 'none',
        wikiValue: wikiTaskMaps.join(', ') || 'none',
        priority: getPriority('map'),
        trustsWiki: true,
        wikiLastEdit,
        wikiEditDaysAgo,
        wikiEditedPost1_0,
      });
      if (verbose)
        console.log(
          `${icons.warning} map: API=${apiMapName ?? 'none'}, Wiki=${
            wikiTaskMaps.join(', ') || 'none'
          }`
        );
    } else if (verbose) {
      console.log(`${icons.success} map matches (${apiMapName})`);
    }
  } else if (verbose && apiMapName) {
    console.log(
      `${icons.info} map in API: ${apiMapName}, Wiki=none (not specified)`
    );
  }

  // Objective matching by normalized description
  const wikiCandidates = wiki.objectives.map((wikiObj, index) => ({
    wiki: wikiObj,
    index,
    textKey: stripMapAliases(
      normalizeObjectiveMatchKey(wikiObj.text),
      mapAliasMap
    ),
    verb: getObjectiveVerbKey(wikiObj.text),
    items: uniqueList(wikiObj.items ?? []),
  }));

  const matchedObjectives: Array<{
    api: ApiObjective;
    wiki: WikiObjective;
    matchType: 'text' | 'item';
  }> = [];
  const unmatchedApi: ApiObjective[] = [];
  const unmatchedWikiIndexes = new Set(wikiCandidates.map((c) => c.index));
  const apiQuestItemSet = toNormalizedSet(
    (apiTask.objectives ?? [])
      .map((obj) => obj.questItem?.name)
      .filter((name): name is string => Boolean(name)),
    normalizeItemName
  );

  for (const apiObj of apiTask.objectives ?? []) {
    const apiTextKey = stripMapAliases(
      normalizeObjectiveMatchKey(apiObj.description ?? ''),
      mapAliasMap
    );
    const apiVerb = getObjectiveVerbKey(apiObj.description ?? '');
    const apiItemRefs = collectObjectiveItems(apiObj);
    const apiFoundInRaid =
      apiObj.foundInRaid === true ||
      /found in raid/i.test(apiObj.description ?? '');

    let matched = false;

    if (apiTextKey.length > 0) {
      const candidate = wikiCandidates.find(
        (c) => unmatchedWikiIndexes.has(c.index) && c.textKey === apiTextKey
      );
      if (candidate) {
        matchedObjectives.push({
          api: apiObj,
          wiki: candidate.wiki,
          matchType: 'text',
        });
        unmatchedWikiIndexes.delete(candidate.index);
        matched = true;
      }
    }

    if (!matched && apiTextKey.length > 0) {
      const apiTokens = apiTextKey.split(' ').filter(Boolean);
      if (apiTokens.length >= 4) {
        const substringMatches = wikiCandidates.filter((c) => {
          if (!unmatchedWikiIndexes.has(c.index)) return false;
          if (!c.textKey || c.textKey.length === 0) return false;
          const wikiTokens = c.textKey.split(' ').filter(Boolean);
          if (wikiTokens.length < 4) return false;
          return (
            c.textKey.includes(apiTextKey) || apiTextKey.includes(c.textKey)
          );
        });

        if (substringMatches.length === 1) {
          const candidate = substringMatches[0];
          matchedObjectives.push({
            api: apiObj,
            wiki: candidate.wiki,
            matchType: 'text',
          });
          unmatchedWikiIndexes.delete(candidate.index);
          matched = true;
        }
      }
    }

    if (!matched && apiVerb && apiItemRefs.length > 0) {
      let candidate = wikiCandidates.find(
        (c) =>
          unmatchedWikiIndexes.has(c.index) &&
          c.verb === apiVerb &&
          hasItemIntersection(apiItemRefs, c.items, taskName)
      );
      if (!candidate && apiVerb === 'hand_over' && apiFoundInRaid) {
        candidate = wikiCandidates.find(
          (c) =>
            unmatchedWikiIndexes.has(c.index) &&
            c.verb === 'find' &&
            hasItemIntersection(apiItemRefs, c.items, taskName)
        );
      }
      if (candidate) {
        matchedObjectives.push({
          api: apiObj,
          wiki: candidate.wiki,
          matchType: 'item',
        });
        unmatchedWikiIndexes.delete(candidate.index);
        matched = true;
      }
    }

    if (!matched) {
      unmatchedApi.push(apiObj);
    }
  }

  const apiFoundInRaidItemSets = (apiTask.objectives ?? [])
    .filter(
      (obj) =>
        obj.foundInRaid === true || /found in raid/i.test(obj.description ?? '')
    )
    .map((obj) => buildAliasSet(collectObjectiveItems(obj)));

  const unmatchedWiki: WikiObjective[] = [];
  for (const candidate of wikiCandidates) {
    if (!unmatchedWikiIndexes.has(candidate.index)) continue;

    if (candidate.verb === 'find' && candidate.items.length > 0) {
      const redundantFind = apiFoundInRaidItemSets.some((aliasSet) =>
        aliasSetIntersects(aliasSet, candidate.items)
      );
      if (redundantFind) continue;
    }

    unmatchedWiki.push(candidate.wiki);
  }

  // If both sides have exactly one objective, compare them directly even if text doesn't match
  if (
    matchedObjectives.length === 0 &&
    (apiTask.objectives ?? []).length === 1 &&
    wiki.objectives.length === 1
  ) {
    matchedObjectives.push({
      api: (apiTask.objectives ?? [])[0],
      wiki: wiki.objectives[0],
      matchType: 'text',
    });
    unmatchedApi.length = 0;
    unmatchedWiki.length = 0;
  }

  for (const apiObj of unmatchedApi) {
    if (isSuppressedObjectiveField(apiObj.id, 'objectives.description')) {
      continue;
    }
    const desc = apiObj.description ?? apiObj.id;
    discrepancies.push({
      taskId,
      taskName,
      field: 'objectives.description',
      apiValue: desc,
      wikiValue: 'not found',
      priority: getPriority('objectives.description'),
      trustsWiki: true,
      wikiLastEdit,
      wikiEditDaysAgo,
      wikiEditedPost1_0,
    });
    if (verbose)
      console.log(`${icons.warning} objective missing in wiki: ${desc}`);
  }

  for (const wikiObj of unmatchedWiki) {
    discrepancies.push({
      taskId,
      taskName,
      field: 'objectives.description',
      apiValue: 'not found',
      wikiValue: wikiObj.text,
      priority: getPriority('objectives.description'),
      trustsWiki: true,
      wikiLastEdit,
      wikiEditDaysAgo,
      wikiEditedPost1_0,
    });
    if (verbose)
      console.log(`${icons.warning} objective missing in API: ${wikiObj.text}`);
  }

  for (const { api: apiObj, wiki: wikiObj, matchType } of matchedObjectives) {
    if (taskSuppressions && isObjectiveSuppressed(taskSuppressions, taskId, apiObj.id)) {
      continue;
    }

    const apiDesc = normalizeWhitespace(apiObj.description ?? '');
    const wikiDesc = normalizeWhitespace(wikiObj.text);
    const objectiveLabel = apiObj.description ?? wikiObj.text ?? apiObj.id;
    const apiVerb = getObjectiveVerbKey(apiObj.description ?? '');
    const apiItemRefs = collectObjectiveItems(apiObj);
    const apiItems = uniqueList(apiItemRefs.map((item) => item.name));
    const wikiItems = uniqueList(wikiObj.items ?? []);
    const apiRequiredKeys = buildAliasSet(
      Array.isArray(apiObj.requiredKeys)
        ? (apiObj.requiredKeys.flat() as ObjectiveItemRef[])
        : [],
      taskName
    );
    const matchingRequiredItems =
      apiRequiredKeys.size > 0
        ? wiki.relatedRequiredItems.filter((item) =>
            normalizeWikiItemAliases(item, taskName).some((alias) =>
              apiRequiredKeys.has(alias)
            )
          )
        : [];
    const apiHasQuestItem = Boolean(apiObj.questItem);
    const wikiItemsForCompare = uniqueList([
      ...wikiItems,
      ...matchingRequiredItems,
      ...(wikiItems.length === 0 && (apiHasQuestItem || apiVerb === 'hand_over')
        ? wiki.relatedHandoverItems
        : []),
    ]);
    const itemsMatchForDescription =
      apiItemRefs.length > 0 &&
      wikiItemsForCompare.length > 0 &&
      itemsMatch(apiItemRefs, wikiItemsForCompare, taskName);

    const apiCount =
      apiObj.count ??
      extractCount(apiObj.description ?? '', collectObjectiveItemNames(apiObj));
    const wikiCount =
      isPveTask && wikiObj.pveCount !== undefined
        ? wikiObj.pveCount
        : wikiObj.count;
    const shouldStripCounts = apiObj.count !== undefined;
    const apiDescStripped = shouldStripCounts
      ? normalizeWhitespace(stripCountPhrases(apiDesc))
      : apiDesc;
    const wikiDescStripped = shouldStripCounts
      ? normalizeWhitespace(stripCountPhrases(wikiDesc))
      : wikiDesc;
    const apiDescForCompare =
      apiDescStripped.length > 0 ? apiDescStripped : apiDesc;
    const wikiDescForCompare =
      wikiDescStripped.length > 0 ? wikiDescStripped : wikiDesc;

    const normalizedApi = stripMapAliases(
      normalizeObjectiveText(apiDescForCompare),
      mapAliasMap
    );
    const normalizedWiki = stripMapAliases(
      normalizeObjectiveText(wikiDescForCompare),
      mapAliasMap
    );
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
      if (!isSuppressedObjectiveField(apiObj.id, 'objectives.description')) {
        discrepancies.push({
          taskId,
          taskName,
          field: 'objectives.description',
          apiValue: apiDescForCompare,
          wikiValue: wikiDescForCompare,
          priority: getPriority('objectives.description'),
          trustsWiki: true,
          wikiLastEdit,
          wikiEditDaysAgo,
          wikiEditedPost1_0,
        });
        if (verbose)
          console.log(
            `${icons.warning} objective text differs: API="${apiDescForCompare}", Wiki="${wikiDescForCompare}"`
          );
      }
    }

    if (apiCount !== undefined && wikiCount !== undefined) {
      const matchesPveVariant =
        wikiObj.pveCount !== undefined &&
        (apiCount === wikiObj.count || apiCount === wikiObj.pveCount);

      if (!matchesPveVariant && apiCount !== wikiCount) {
        if (!isSuppressedObjectiveField(apiObj.id, 'objectives.count')) {
          discrepancies.push({
            taskId,
            taskName,
            field: 'objectives.count',
            apiValue: `${apiCount} (${objectiveLabel})`,
            wikiValue: `${wikiCount} (${wikiObj.text})`,
            priority: getPriority('objectives.count'),
            trustsWiki: true,
            wikiLastEdit,
            wikiEditDaysAgo,
            wikiEditedPost1_0,
          });
          if (verbose)
            console.log(
              `${icons.warning} objective count: API=${apiCount}, Wiki=${wikiCount} (${objectiveLabel})`
            );
        }
      } else if (verbose) {
        console.log(`${icons.success} objective count matches (${apiCount})`);
      }
    }

    let apiMapNames = uniqueList((apiObj.maps ?? []).map((m) => m.name));
    if (apiMapNames.length === 0) {
      apiMapNames = extractMapsFromText(apiObj.description ?? '', mapAliasMap);
    }
    const wikiMapNames = uniqueList(wikiObj.maps ?? []);
    if (wikiMapNames.length > 0) {
      const apiSet = toNormalizedSet(apiMapNames, normalizeMapName);
      const wikiSet = toNormalizedSet(wikiMapNames, normalizeMapName);
      const descForTransit = `${apiObj.description ?? ''} ${
        wikiObj.text ?? ''
      }`;
      const isTransitObjective =
        /\btransit\b|\btransfer\b|\bpassage\b|\bleading to\b/i.test(
          descForTransit
        );
      const allowTransitSuperset =
        isTransitObjective && apiSet.size > 0 && isSubset(apiSet, wikiSet);
      const skipMapCompare = apiVerb === 'hand_over' && apiSet.size === 0;

      if (
        !setsEqual(apiSet, wikiSet) &&
        !allowTransitSuperset &&
        !skipMapCompare
      ) {
        if (!isSuppressedObjectiveField(apiObj.id, 'objectives.maps')) {
          discrepancies.push({
            taskId,
            taskName,
            field: 'objectives.maps',
            apiValue: `${apiMapNames.join(', ') || 'none'} (${objectiveLabel})`,
            wikiValue: `${wikiMapNames.join(', ') || 'none'} (${wikiObj.text})`,
            priority: getPriority('objectives.maps'),
            trustsWiki: true,
            wikiLastEdit,
            wikiEditDaysAgo,
            wikiEditedPost1_0,
          });
          if (verbose)
            console.log(
              `${icons.warning} objective maps differ: API=${
                apiMapNames.join(', ') || 'none'
              }, Wiki=${wikiMapNames.join(', ') || 'none'}`
            );
        }
      }
    } else if (verbose && apiMapNames.length > 0) {
      console.log(
        `${icons.info} objective maps: API=${apiMapNames.join(
          ', '
        )}, Wiki=none (not specified)`
      );
    }

    if (apiItemRefs.length > 0 || wikiItemsForCompare.length > 0) {
      const apiDescText = apiObj.description ?? '';
      const isSkillObjective =
        /\bskill level\b/i.test(apiDescText) ||
        /\bskill level\b/i.test(wikiObj.text ?? '');
      if (isSkillObjective) {
        if (verbose)
          console.log(
            `${icons.info} objective items: skill requirement, skipping item compare`
          );
        continue;
      }
      const usesRelatedItems =
        matchingRequiredItems.length > 0 ||
        (wikiItems.length === 0 &&
          (apiHasQuestItem || apiVerb === 'hand_over') &&
          wiki.relatedHandoverItems.length > 0);
      const mentionsItemsInText =
        wikiItems.length > 0 &&
        wikiItems.every(
          (item) =>
            objectiveMentionsItem(item, apiDescText, mapAliasMap) ||
            objectiveMentionsItem(item, wikiObj.text ?? '', mapAliasMap)
        );
      const objectiveText = `${apiDescText} ${wikiObj.text ?? ''}`;
      const textCoversApiItems =
        apiItemRefs.length > 0 &&
        wikiItemsForCompare.length === 0 &&
        objectiveTextCoversApiItems(apiItemRefs, objectiveText, mapAliasMap);
      if (
        apiItemRefs.length === 0 &&
        !usesRelatedItems &&
        apiVerb !== 'hand_over' &&
        mentionsItemsInText
      ) {
        if (verbose)
          console.log(
            `${icons.info} objective items: item mentioned in text, skipping strict compare`
          );
        continue;
      }
      const apiAnyItem =
        /\bany\b/i.test(apiDescText) &&
        apiItemRefs.length >= 8 &&
        wikiItemsForCompare.length === 0;
      const categoryRequirement =
        objectiveHasCategoryItemRequirement(apiDescText) ||
        objectiveHasCategoryItemRequirement(wikiObj.text ?? '');
      const handoverMatchesQuestItem =
        apiItemRefs.length === 0 &&
        apiVerb === 'hand_over' &&
        wikiItemsForCompare.length > 0 &&
        Array.from(
          toNormalizedSet(wikiItemsForCompare, normalizeItemName)
        ).every((item) => apiQuestItemSet.has(item));

      if (categoryRequirement && wikiItemsForCompare.length === 0) {
        if (verbose)
          console.log(
            `${icons.info} objective items: category requirement, skipping strict compare`
          );
      } else if (textCoversApiItems) {
        if (verbose)
          console.log(
            `${icons.info} objective items: objective text covers API items, skipping strict compare`
          );
      } else if (apiAnyItem) {
        if (verbose)
          console.log(
            `${icons.info} objective items: API allows any item, skipping strict compare`
          );
      } else if (handoverMatchesQuestItem) {
        if (verbose)
          console.log(
            `${icons.info} objective items: handover matches quest item, skipping strict compare`
          );
      } else if (!itemsMatch(apiItemRefs, wikiItemsForCompare, taskName)) {
        if (!isSuppressedObjectiveField(apiObj.id, 'objectives.items')) {
          discrepancies.push({
            taskId,
            taskName,
            field: 'objectives.items',
            apiValue: `${apiItems.join(', ') || 'none'} (${objectiveLabel})`,
            wikiValue: `${wikiItemsForCompare.join(', ') || 'none'} (${
              wikiObj.text
            })`,
            priority: getPriority('objectives.items'),
            trustsWiki: true,
            wikiLastEdit,
            wikiEditDaysAgo,
            wikiEditedPost1_0,
          });
          if (verbose)
            console.log(
              `${icons.warning} objective items differ: API=${
                apiItems.join(', ') || 'none'
              }, Wiki=${wikiItems.join(', ') || 'none'}`
            );
        }
      }
    }
  }

  // Prerequisites (previous tasks)
  {
    const apiReqNames = (apiTask.taskRequirements ?? [])
      .map((req) => req.task?.name)
      .filter((n): n is string => Boolean(n));
    const apiSet = toNormalizedSet(apiReqNames, normalizeTaskName);
    const wikiSet = toNormalizedSet(
      wiki.previousTasks ?? [],
      normalizeTaskName
    );

    if (apiSet.size > 0 || wikiSet.size > 0) {
      if (!setsEqual(apiSet, wikiSet)) {
        discrepancies.push({
          taskId,
          taskName,
          field: 'taskRequirements',
          apiValue: apiReqNames.join(', ') || 'none',
          wikiValue: wiki.previousTasks.join(', ') || 'none',
          priority: getPriority('taskRequirements'),
          trustsWiki: true,
          wikiLastEdit,
          wikiEditDaysAgo,
          wikiEditedPost1_0,
        });
        if (verbose) {
          const missing = wiki.previousTasks.filter(
            (t) => !apiSet.has(normalizeTaskName(t))
          );
          const extra = apiReqNames.filter(
            (t) => !wikiSet.has(normalizeTaskName(t))
          );
          if (missing.length > 0)
            console.log(
              `${icons.warning} prerequisites missing in API: ${missing.join(
                ', '
              )}`
            );
          if (extra.length > 0)
            console.log(
              `${icons.warning} prerequisites extra in API: ${extra.join(', ')}`
            );
        }
      } else if (verbose) {
        console.log(`${icons.success} prerequisites match`);
      }
    }
  }

  // Next tasks (unlocks)
  {
    const apiNextNames = nextTaskMap?.get(taskId) ?? [];
    const apiSet = toNormalizedSet(apiNextNames, normalizeTaskName);
    const wikiSet = toNormalizedSet(wiki.nextTasks ?? [], normalizeTaskName);

    if (apiSet.size > 0 || wikiSet.size > 0) {
      if (!setsEqual(apiSet, wikiSet)) {
        discrepancies.push({
          taskId,
          taskName,
          field: 'nextTasks',
          apiValue: apiNextNames.join(', ') || 'none',
          wikiValue: wiki.nextTasks.join(', ') || 'none',
          priority: getPriority('nextTasks'),
          trustsWiki: true,
          wikiLastEdit,
          wikiEditDaysAgo,
          wikiEditedPost1_0,
        });
        if (verbose) {
          const missing = wiki.nextTasks.filter(
            (t) => !apiSet.has(normalizeTaskName(t))
          );
          const extra = apiNextNames.filter(
            (t) => !wikiSet.has(normalizeTaskName(t))
          );
          if (missing.length > 0)
            console.log(
              `${icons.warning} next tasks missing in API: ${missing.join(
                ', '
              )}`
            );
          if (extra.length > 0)
            console.log(
              `${icons.warning} next tasks extra in API: ${extra.join(', ')}`
            );
        }
      } else if (verbose) {
        console.log(`${icons.success} next tasks match`);
      }
    }
  }

  // Experience (XP)
  if (wiki.rewards.xp !== undefined && apiTask.experience !== undefined) {
    if (apiTask.experience !== wiki.rewards.xp) {
      discrepancies.push({
        taskId,
        taskName,
        field: 'experience',
        apiValue: apiTask.experience,
        wikiValue: wiki.rewards.xp,
        priority: getPriority('experience'),
        trustsWiki: true,
        wikiLastEdit,
        wikiEditDaysAgo,
        wikiEditedPost1_0,
      });
      if (verbose)
        console.log(
          `${icons.warning} experience: API=${apiTask.experience}, Wiki=${wiki.rewards.xp}`
        );
    } else if (verbose) {
      console.log(
        `${icons.success} experience matches (${apiTask.experience})`
      );
    }
  }

  // Reputation (per trader)
  if (
    wiki.rewards.reputations.length > 0 &&
    apiTask.finishRewards?.traderStanding
  ) {
    for (const wikiRep of wiki.rewards.reputations) {
      // Find matching trader in API data (case-insensitive)
      const apiTraderRep = apiTask.finishRewards.traderStanding.find(
        (t) => t.trader.name.toLowerCase() === wikiRep.trader.toLowerCase()
      );

      if (apiTraderRep) {
        if (Math.abs(apiTraderRep.standing - wikiRep.value) > 0.001) {
          discrepancies.push({
            taskId,
            taskName,
            field: `reputation.${wikiRep.trader}`,
            apiValue: apiTraderRep.standing,
            wikiValue: wikiRep.value,
            priority: getPriority('reputation'),
            trustsWiki: true,
            wikiLastEdit,
            wikiEditDaysAgo,
            wikiEditedPost1_0,
          });
          if (verbose) {
            console.log(
              `${icons.warning} ${wikiRep.trader} rep: API=${apiTraderRep.standing}, Wiki=${wikiRep.value}`
            );
          }
        } else if (verbose) {
          console.log(
            `${icons.success} ${wikiRep.trader} rep matches (${apiTraderRep.standing})`
          );
        }
      } else if (verbose) {
        console.log(
          `${icons.info} ${wikiRep.trader} rep: Wiki=${wikiRep.value}, not found in API`
        );
      }
    }
  }

  // Money (Roubles)
  if (wiki.rewards.money !== undefined && apiTask.finishRewards?.items) {
    const apiMoney = apiTask.finishRewards.items.find(
      (i) => i.item.name === 'Roubles'
    )?.count;
    if (apiMoney !== undefined && apiMoney !== wiki.rewards.money) {
      discrepancies.push({
        taskId,
        taskName,
        field: 'money',
        apiValue: apiMoney,
        wikiValue: wiki.rewards.money,
        priority: getPriority('money'),
        trustsWiki: true,
        wikiLastEdit,
        wikiEditDaysAgo,
        wikiEditedPost1_0,
      });
      if (verbose)
        console.log(
          `${icons.warning} money: API=${apiMoney}, Wiki=${wiki.rewards.money}`
        );
    } else if (verbose && apiMoney !== undefined) {
      console.log(`${icons.success} money matches (${apiMoney})`);
    }
  }

  if (verbose) {
    console.log();
    if (discrepancies.length === 0) {
      printSuccess('No discrepancies detected.');
    } else {
      printSuccess(`Detected ${discrepancies.length} discrepancy(ies).`);
    }
  }

  return discrepancies;
}
