"use strict";

const { config, getModeLabel } = require("./config.js");

function createSection(title, columns, options = {}) {
  return {
    ...options,
    title,
    columns,
    rows: [],
    truncated: false,
  };
}

function pushRow(section, row) {
  if (section.rows.length >= config.maxRows) {
    section.truncated = true;
    return;
  }
  section.rows.push(row);
}

function normalizeCompareValue(value) {
  if (Array.isArray(value)) {
    return value.map(normalizeCompareValue);
  }

  if (value && typeof value === "object") {
    const normalized = {};
    for (const key of Object.keys(value).sort()) {
      normalized[key] = normalizeCompareValue(value[key]);
    }
    return normalized;
  }

  return value;
}

function valuesEqual(a, b) {
  if (a === undefined && b === undefined) return true;
  return JSON.stringify(normalizeCompareValue(a)) === JSON.stringify(normalizeCompareValue(b));
}

function formatValue(value, maxLength = 220) {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return value;
  const json = JSON.stringify(value);
  if (!json) return String(value);
  if (json.length <= maxLength) return json;
  return `${json.slice(0, maxLength - 1)}…`;
}

function mergeTaskOverride(base = {}, next = {}) {
  const merged = { ...base, ...next };
  if (base.objectives || next.objectives) {
    merged.objectives = { ...(base.objectives || {}) };
    for (const [objectiveId, objectivePatch] of Object.entries(next.objectives || {})) {
      const existingPatch = merged.objectives[objectiveId];
      if (
        existingPatch &&
        typeof existingPatch === "object" &&
        !Array.isArray(existingPatch) &&
        objectivePatch &&
        typeof objectivePatch === "object" &&
        !Array.isArray(objectivePatch)
      ) {
        merged.objectives[objectiveId] = { ...existingPatch, ...objectivePatch };
      } else {
        merged.objectives[objectiveId] = objectivePatch;
      }
    }
  }
  if (base.objectivesAdd || next.objectivesAdd) {
    merged.objectivesAdd = [...(base.objectivesAdd || []), ...(next.objectivesAdd || [])];
  }
  return merged;
}

function mergeTaskOverrides(shared = {}, modeSpecific = {}) {
  const merged = { ...shared };
  for (const [taskId, override] of Object.entries(modeSpecific)) {
    merged[taskId] = mergeTaskOverride(merged[taskId], override);
  }
  return merged;
}

function buildOverrideSections(title, overrides = {}) {
  const section = createSection(`${title} Overrides`, ["Entity", "Field", "Overlay"]);

  for (const [entityId, override] of Object.entries(overrides)) {
    if (!override || typeof override !== "object") {
      pushRow(section, [entityId, "value", formatValue(override)]);
      continue;
    }
    const entries = Object.entries(override);
    if (entries.length === 0) {
      pushRow(section, [entityId, "(empty)", "{}"]);
      continue;
    }
    for (const [field, value] of entries) {
      pushRow(section, [entityId, field, formatValue(value)]);
    }
  }

  return [section];
}

function buildEditionsSections(editions = {}) {
  const section = createSection("Editions", [
    "Edition",
    "ID",
    "Stash",
    "Rep Bonus",
    "Exclusive Tasks",
    "Excluded Tasks",
  ]);

  for (const [key, edition] of Object.entries(editions)) {
    if (!edition || typeof edition !== "object") {
      pushRow(section, [key, key, "-", "-", "-", "-"]);
      continue;
    }
    const repCount = edition.traderRepBonus ? Object.keys(edition.traderRepBonus).length : 0;
    const exclusiveCount = Array.isArray(edition.exclusiveTaskIds)
      ? edition.exclusiveTaskIds.length
      : 0;
    const excludedCount = Array.isArray(edition.excludedTaskIds)
      ? edition.excludedTaskIds.length
      : 0;
    pushRow(section, [
      edition.title || key,
      edition.id || key,
      edition.defaultStashLevel ?? "-",
      repCount ? `${repCount} traders` : "-",
      exclusiveCount || "-",
      excludedCount || "-",
    ]);
  }

  return [section];
}

function buildStoryChapterSections(chapters = {}) {
  const section = createSection("Story Chapters", ["Chapter", "ID", "Order", "Objectives", "Wiki"]);

  for (const [key, chapter] of Object.entries(chapters)) {
    if (!chapter || typeof chapter !== "object") {
      pushRow(section, [key, key, "-", "-", "-"]);
      continue;
    }
    const objectiveCount = Array.isArray(chapter.objectives) ? chapter.objectives.length : 0;
    pushRow(section, [
      chapter.name || key,
      chapter.id || key,
      chapter.order ?? "-",
      objectiveCount,
      chapter.wikiLink || "-",
    ]);
  }

  return [section];
}

function buildTaskAdditionSections(tasksAdd = {}, mode) {
  const section = createSection(`Task Additions (${getModeLabel(mode)})`, [
    "Task",
    "ID",
    "Trader",
    "Map",
    "Wiki",
  ]);

  for (const [taskId, addition] of Object.entries(tasksAdd)) {
    if (!addition || typeof addition !== "object") {
      pushRow(section, [taskId, taskId, "-", "-", "-"]);
      continue;
    }
    pushRow(section, [
      addition.name || taskId,
      addition.id || taskId,
      addition.trader?.name || "-",
      addition.map?.name || "-",
      addition.wikiLink || "-",
    ]);
  }

  return [section];
}

function buildPrestigeSections(prestige = {}) {
  const section = createSection("Prestige Levels", [
    "Level",
    "ID",
    "Name",
    "Conditions",
    "Story Requirements",
  ]);

  for (const [id, entry] of Object.entries(prestige)) {
    if (!entry || typeof entry !== "object") {
      pushRow(section, ["-", id, "-", "-", "-"]);
      continue;
    }
    const conditionsCount = entry.conditions ? Object.keys(entry.conditions).length : 0;
    const storyRequirements = Array.isArray(entry.storyRequirements) ? entry.storyRequirements : [];
    const storySummary =
      storyRequirements.length > 0
        ? storyRequirements.map((req) => req.name || req.storyChapter).join("; ")
        : "-";
    pushRow(section, [
      entry.prestigeLevel ?? "-",
      entry.id || id,
      entry.name || "-",
      conditionsCount || "-",
      storySummary,
    ]);
  }

  return [section];
}

function buildLocaleSections(locales = {}, locale) {
  const bundle = locales[locale] || {};
  const sections = [];

  for (const [entityType, entries] of Object.entries(bundle)) {
    if (!entries || typeof entries !== "object") {
      continue;
    }
    const section = createSection(`${entityType} (${locale})`, ["Entity", "Field", "Overlay"]);

    for (const [entityId, patch] of Object.entries(entries)) {
      if (!patch || typeof patch !== "object") {
        pushRow(section, [entityId, "value", formatValue(patch)]);
        continue;
      }
      for (const [field, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        if (field === "objectives" && value && typeof value === "object") {
          for (const [objectiveId, objectivePatch] of Object.entries(value)) {
            if (!objectivePatch || typeof objectivePatch !== "object") {
              continue;
            }
            for (const [objectiveField, objectiveValue] of Object.entries(objectivePatch)) {
              if (objectiveValue === undefined) continue;
              pushRow(section, [
                entityId,
                `objective:${objectiveId}.${objectiveField}`,
                formatValue(objectiveValue),
              ]);
            }
          }
          continue;
        }
        pushRow(section, [entityId, field, formatValue(value)]);
      }
    }

    if (section.rows.length > 0) {
      sections.push(section);
    }
  }

  if (sections.length === 0) {
    const empty = createSection(`Locale ${locale}`, ["Entity", "Field", "Overlay"]);
    pushRow(empty, ["(no corrections)", "-", "-"]);
    return [empty];
  }
  return sections;
}

function buildSeasonalPerkSections(perks = {}) {
  const section = createSection("Seasonal Perks", ["Perk", "ID", "Type", "Points", "Effects"]);

  for (const [id, perk] of Object.entries(perks)) {
    if (!perk || typeof perk !== "object") {
      pushRow(section, [id, id, "-", "-", "-"]);
      continue;
    }
    const effects = Array.isArray(perk.effects) ? perk.effects : [];
    const effectSummary =
      effects.length > 0
        ? effects
            .map((effect) =>
              effect && typeof effect === "object" && !Array.isArray(effect)
                ? effect.effectId || "?"
                : "?"
            )
            .join(", ")
        : "-";
    pushRow(section, [
      perk.name || id,
      perk.id || id,
      perk.type || "-",
      perk.points ?? "-",
      effectSummary,
    ]);
  }

  return [section];
}

function buildCraftAddSections(crafts = {}) {
  const section = createSection("Craft Additions", [
    "Craft",
    "ID",
    "Station",
    "Level",
    "Duration",
    "Product",
  ]);

  for (const [id, craft] of Object.entries(crafts)) {
    if (!craft || typeof craft !== "object") {
      pushRow(section, [id, id, "-", "-", "-", "-"]);
      continue;
    }
    const duration =
      typeof craft.duration === "number" ? `${Math.round(craft.duration / 60)} min` : "-";
    const product =
      craft.productItem && typeof craft.productItem === "object"
        ? craft.productItem.item || "-"
        : "-";
    pushRow(section, [
      craft.id || id,
      id,
      craft.station || "-",
      craft.level ?? "-",
      duration,
      product,
    ]);
  }

  return [section];
}

function buildTasksSections(overrides = {}, apiTasks = []) {
  const diffSection = createSection(
    "Task Overrides vs API",
    ["Task", "Field", "API", "Overlay", "Status"],
    { statusColumnIndex: 4 }
  );
  const objectivesAddSection = createSection("Added Objectives", ["Task", "Objective", "Overlay"]);
  const missingSection = createSection("Tasks Missing From API", ["Task", "Task ID"]);
  const disabledSection = createSection("Disabled Tasks", ["Task", "Task ID"]);

  const apiById = new Map(apiTasks.map((task) => [task.id, task]));

  for (const [taskId, override] of Object.entries(overrides)) {
    if (!override || typeof override !== "object") {
      continue;
    }
    const apiTask = apiById.get(taskId);
    const taskName = apiTask?.name || override.name || `Task ID ${taskId}`;

    if (!apiTask) {
      pushRow(missingSection, [taskName, taskId]);
      continue;
    }

    if (override.disabled === true) {
      pushRow(disabledSection, [taskName, taskId]);
    }

    const { objectives, objectivesAdd, ...topLevel } = override;
    for (const [field, value] of Object.entries(topLevel)) {
      if (value === undefined) continue;
      const apiValue = apiTask[field];
      pushRow(diffSection, [
        taskName,
        field,
        formatValue(apiValue),
        formatValue(value),
        valuesEqual(apiValue, value) ? "same" : "override",
      ]);
    }

    if (objectives && typeof objectives === "object") {
      for (const [objectiveId, objOverride] of Object.entries(objectives)) {
        if (!objOverride || typeof objOverride !== "object") continue;
        const apiObjective = apiTask.objectives?.find((objective) => objective.id === objectiveId);
        if (!apiObjective) {
          pushRow(diffSection, [
            taskName,
            `objective:${objectiveId}`,
            "missing",
            formatValue(objOverride),
            "missing",
          ]);
          continue;
        }
        for (const [field, value] of Object.entries(objOverride)) {
          if (value === undefined) continue;
          const apiValue = apiObjective[field];
          pushRow(diffSection, [
            taskName,
            `objective:${objectiveId}.${field}`,
            formatValue(apiValue),
            formatValue(value),
            valuesEqual(apiValue, value) ? "same" : "override",
          ]);
        }
      }
    }

    if (Array.isArray(objectivesAdd)) {
      for (const objective of objectivesAdd) {
        const label = objective.description || objective.id || "Added objective";
        pushRow(objectivesAddSection, [taskName, label, formatValue(objective)]);
      }
    }
  }

  return [diffSection, objectivesAddSection, missingSection, disabledSection];
}

module.exports = {
  buildCraftAddSections,
  buildEditionsSections,
  buildLocaleSections,
  buildOverrideSections,
  buildPrestigeSections,
  buildSeasonalPerkSections,
  buildStoryChapterSections,
  buildTaskAdditionSections,
  buildTasksSections,
  createSection,
  formatValue,
  mergeTaskOverrides,
  pushRow,
  valuesEqual,
};
