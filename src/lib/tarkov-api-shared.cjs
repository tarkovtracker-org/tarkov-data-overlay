"use strict";

/**
 * Runtime-neutral helpers shared by the TypeScript API client and the
 * standalone CommonJS monitor. Keep this module dependency-free so both
 * runtimes can consume it without a build step.
 */

function fetchCached(cache, path, load) {
  const existing = cache.get(path);
  if (existing) return existing;
  const promise = load(path).catch((error) => {
    cache.delete(path);
    throw error;
  });
  cache.set(path, promise);
  return promise;
}

function resolveReferenceMatrix(value, resolveReference) {
  if (!Array.isArray(value)) return undefined;
  return value
    .map((group) => {
      const list = Array.isArray(group) ? group : [group];
      return list.map(resolveReference).filter(Boolean);
    })
    .filter((group) => group.length > 0);
}

function adaptReward(raw, context, helpers) {
  const { isRecord, compact, resolveItemRef, resolveTraderRef } = helpers;
  if (!isRecord(raw)) return undefined;
  return compact({
    ...raw,
    items: Array.isArray(raw.items)
      ? raw.items
          .filter(isRecord)
          .map((entry) => compact({ ...entry, item: resolveItemRef(entry.item, context) }))
      : undefined,
    traderStanding: Array.isArray(raw.traderStanding)
      ? raw.traderStanding
          .filter(isRecord)
          .map((entry) => compact({ ...entry, trader: resolveTraderRef(entry.trader, context) }))
      : undefined,
    offerUnlock: Array.isArray(raw.offerUnlock)
      ? raw.offerUnlock.filter(isRecord).map((entry) =>
          compact({
            ...entry,
            trader: resolveTraderRef(entry.trader, context),
            item: resolveItemRef(entry.item, context),
          })
        )
      : undefined,
  });
}

async function buildTaskContext(cache, mode, tasksData, helpers) {
  const { fetchEnvelope, fetchTranslations, isRecord, toLookup } = helpers;
  const [itemsEnvelope, mapsEnvelope, tradersEnvelope, itemsEn, tasksEn, mapsEn, tradersEn] =
    await Promise.all([
      fetchEnvelope(cache, `${mode}/items`),
      fetchEnvelope(cache, `${mode}/maps`),
      fetchEnvelope(cache, `${mode}/traders`),
      fetchTranslations(cache, mode, "items"),
      fetchTranslations(cache, mode, "tasks"),
      fetchTranslations(cache, mode, "maps"),
      fetchTranslations(cache, mode, "traders"),
    ]);

  const itemsData = isRecord(itemsEnvelope.data) ? itemsEnvelope.data : {};
  const mapsData = isRecord(mapsEnvelope.data) ? mapsEnvelope.data : {};

  return {
    itemsById: toLookup(itemsData.items),
    questItemsById: toLookup(tasksData.questItems),
    tasksById: toLookup(tasksData.tasks),
    mapsById: toLookup(mapsData.maps),
    tradersById: toLookup(tradersEnvelope.data),
    prestigeById: toLookup(tasksData.prestige),
    itemsEn,
    tasksEn,
    mapsEn,
    tradersEn,
  };
}

module.exports = {
  adaptReward,
  buildTaskContext,
  fetchCached,
  resolveReferenceMatrix,
};
