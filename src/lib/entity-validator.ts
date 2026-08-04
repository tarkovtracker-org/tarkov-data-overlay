/**
 * Validation for entity types other than tasks
 *
 * `check-overrides` historically only validated task overrides, task additions,
 * edition task references and locale overrides. Everything else in src/ was
 * unverified, so a stale prestige/items/traders/hideout correction could sit
 * there indefinitely. These validators close that gap.
 *
 * Design notes:
 * - Corrections are compared with the same subset semantics as task overrides,
 *   so patching one field does not require the whole object to match.
 * - Some fields are not corrections at all. `prestigeLevel` identifies the
 *   entry; comparing it would report a permanent "FIXED" false positive. Those
 *   are declared as `identityFields` and instead checked for drift.
 * - Some fields are absent from tarkov.dev by design (`storyRequirements`).
 *   Those are declared as `additiveFields`: still needed while absent upstream,
 *   and flagged for retirement once upstream ships them.
 */

import type { TaskData } from './types.js';
import { compareSubset, formatValue } from './value-compare.js';

export type EntityDetailStatus = 'needed' | 'fixed' | 'synthetic' | 'error' | 'info';

export interface EntityValidationDetail {
  field: string;
  status: EntityDetailStatus;
  message: string;
}

export type EntityStatus = 'NEEDED' | 'FIXED' | 'REMOVED_FROM_API';

export interface EntityValidationResult {
  id: string;
  status: EntityStatus;
  stillNeeded: boolean;
  details: EntityValidationDetail[];
}

export interface EntityValidatorConfig {
  /** Fields that identify the entry rather than correct it. */
  identityFields?: string[];
  /** Fields tarkov.dev does not expose at all. */
  additiveFields?: string[];
  /** ID-keyed sub-objects where overlay-only keys are synthetic additions. */
  keyedFields?: string[];
}

/**
 * Validate ID-keyed entity overrides against raw API records.
 *
 * @param overrides - parsed override file (entityId -> changed fields)
 * @param apiEntities - raw API records keyed by entity id
 * @param config - per-entity-type field semantics
 */
export function validateEntityOverrides(
  overrides: Record<string, unknown>,
  apiEntities: Map<string, Record<string, unknown>>,
  config: EntityValidatorConfig = {}
): EntityValidationResult[] {
  const identity = new Set(config.identityFields ?? []);
  const additive = new Set(config.additiveFields ?? []);
  const keyed = new Set(config.keyedFields ?? []);

  const results: EntityValidationResult[] = [];

  for (const [entityId, rawOverride] of Object.entries(overrides)) {
    if (!rawOverride || typeof rawOverride !== 'object' || Array.isArray(rawOverride)) {
      continue;
    }
    const override = rawOverride as Record<string, unknown>;
    const apiEntity = apiEntities.get(entityId);

    if (!apiEntity) {
      results.push({
        id: entityId,
        status: 'REMOVED_FROM_API',
        stillNeeded: false,
        details: [
          {
            field: 'entity',
            status: 'error',
            message: 'Not found in API - removed upstream, or the ID is wrong',
          },
        ],
      });
      continue;
    }

    const details: EntityValidationDetail[] = [];

    for (const [field, overrideValue] of Object.entries(override)) {
      if (overrideValue === undefined) continue;
      const apiValue = apiEntity[field];

      // Identity fields must agree with upstream but are not corrections.
      if (identity.has(field)) {
        if (apiValue === undefined) {
          details.push({
            field,
            status: 'error',
            message: `${field}: identity field absent from API - entity shape changed or the ID is wrong`,
          });
        } else if (!compareSubset(overrideValue, apiValue)) {
          details.push({
            field,
            status: 'error',
            message: `${field}: identity field disagrees with API (API=${formatValue(
              apiValue
            )}, overlay=${formatValue(overrideValue)}) - wrong entity or upstream renumbered`,
          });
        }
        continue;
      }

      // Fields tarkov.dev does not expose: needed while absent.
      if (additive.has(field)) {
        if (apiValue === undefined) {
          details.push({
            field,
            status: 'needed',
            message: `${field}: absent from API (not exposed upstream) - STILL NEEDED`,
          });
        } else {
          details.push({
            field,
            status: 'fixed',
            message: `${field}: NOW PRESENT IN API (${formatValue(
              apiValue
            )}) - review and retire the addition`,
          });
        }
        continue;
      }

      // ID-keyed sub-objects: overlay-only keys are deliberate additions.
      if (keyed.has(field) && overrideValue && typeof overrideValue === 'object') {
        const apiKeyed = (apiValue && typeof apiValue === 'object' ? apiValue : {}) as Record<
          string,
          unknown
        >;
        const apiKeyedIds = new Set(collectKeyedIds(apiValue));

        for (const [subKey, subValue] of Object.entries(
          overrideValue as Record<string, unknown>
        )) {
          if (!apiKeyedIds.has(subKey)) {
            details.push({
              field: `${field}:${subKey}`,
              status: 'synthetic',
              message: `${field} '${subKey}': not in API - synthetic overlay entry, STILL NEEDED`,
            });
            continue;
          }
          const apiSub = findKeyedEntry(apiValue, subKey) ?? apiKeyed[subKey];
          const isMatch = compareSubset(subValue, apiSub);
          details.push({
            field: `${field}:${subKey}`,
            status: isMatch ? 'fixed' : 'needed',
            message: isMatch
              ? `${field} '${subKey}': FIXED IN API`
              : `${field} '${subKey}': API=${formatValue(apiSub)}, overlay=${formatValue(
                  subValue
                )} - STILL NEEDED`,
          });
        }
        continue;
      }

      const isMatch = compareSubset(overrideValue, apiValue);
      details.push({
        field,
        status: isMatch ? 'fixed' : 'needed',
        message: isMatch
          ? `${field}: ${formatValue(apiValue)} - FIXED IN API`
          : `${field}: API=${formatValue(apiValue)}, overlay=${formatValue(
              overrideValue
            )} - STILL NEEDED`,
      });
    }

    const stillNeeded = details.some(
      (d) => d.status === 'needed' || d.status === 'synthetic' || d.status === 'error'
    );

    results.push({
      id: entityId,
      status: stillNeeded ? 'NEEDED' : 'FIXED',
      stillNeeded,
      details,
    });
  }

  return results;
}

/** API keyed collections may arrive as arrays of {id} or as id-keyed objects. */
function collectKeyedIds(apiValue: unknown): string[] {
  if (Array.isArray(apiValue)) {
    return apiValue
      .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object')
      .map((entry) => entry.id)
      .filter((id): id is string => typeof id === 'string');
  }
  if (apiValue && typeof apiValue === 'object') {
    return Object.keys(apiValue as Record<string, unknown>);
  }
  return [];
}

function findKeyedEntry(apiValue: unknown, key: string): unknown {
  if (Array.isArray(apiValue)) {
    return apiValue.find(
      (entry) => !!entry && typeof entry === 'object' && (entry as Record<string, unknown>).id === key
    );
  }
  if (apiValue && typeof apiValue === 'object') {
    return (apiValue as Record<string, unknown>)[key];
  }
  return undefined;
}

/**
 * Check whether additions (entities absent upstream) have since appeared.
 *
 * Matches on the object key and on an explicit `id` field, since additions use
 * stable snake_case keys with `id` set to the same value.
 */
export function validateEntityAdditions(
  additions: Record<string, unknown>,
  apiEntities: Map<string, Record<string, unknown>>
): EntityValidationResult[] {
  const results: EntityValidationResult[] = [];

  for (const [key, rawAddition] of Object.entries(additions)) {
    const addition =
      rawAddition && typeof rawAddition === 'object' && !Array.isArray(rawAddition)
        ? (rawAddition as Record<string, unknown>)
        : {};
    const explicitId = typeof addition.id === 'string' ? addition.id : undefined;

    const present = apiEntities.has(key) || (explicitId ? apiEntities.has(explicitId) : false);

    results.push({
      id: key,
      status: present ? 'FIXED' : 'NEEDED',
      stillNeeded: !present,
      details: [
        {
          field: 'addition',
          status: present ? 'fixed' : 'needed',
          message: present
            ? 'NOW IN API - remove the addition and switch to an override if still wrong'
            : 'Still missing from API - STILL NEEDED',
        },
      ],
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Story chapters
// ---------------------------------------------------------------------------

export type StoryChapterIssueKind =
  | 'ID_MISMATCH'
  | 'DUPLICATE_ORDER'
  | 'DUPLICATE_OBJECTIVE_ID'
  | 'MISSING_CHAPTER_QUEST'
  | 'MISSING_SOURCE_QUEST'
  | 'UNKNOWN_CHAPTER_REF';

export interface StoryChapterIssue {
  chapterId: string;
  kind: StoryChapterIssueKind;
  message: string;
}

/**
 * Referential-integrity check for story chapters.
 *
 * Chapters are overlay-authored so they cannot be validated against tarkov.dev.
 * Two classes of check apply:
 *
 * 1. Internal consistency - always runs. Keys must match `id`, `order` must be
 *    unique, objective IDs must be unique across all chapters, and
 *    `chapterRequirements` must name chapters that exist in this file.
 *
 * 2. Quest reference resolution - only runs when `knownQuestIds` is supplied.
 *    Story quests are NOT part of the tarkov.dev task list, so their IDs can
 *    only be resolved against the local EFT reference. Without it, resolution
 *    is skipped rather than reporting every reference as broken.
 *
 * @param chapters - parsed additions/storyChapters.json5
 * @param knownQuestIds - union of EFT reference quest IDs, API task IDs and
 *   overlay task additions. Omit to skip resolution checks.
 */
export function checkStoryChapterIntegrity(
  chapters: Record<string, unknown>,
  knownQuestIds?: Set<string>
): StoryChapterIssue[] {
  const issues: StoryChapterIssue[] = [];
  const chapterKeys = new Set(Object.keys(chapters));
  const seenOrder = new Map<number, string>();
  const seenObjectiveIds = new Map<string, string>();
  const canResolveQuests = knownQuestIds !== undefined && knownQuestIds.size > 0;

  for (const [chapterId, rawChapter] of Object.entries(chapters)) {
    if (!rawChapter || typeof rawChapter !== 'object' || Array.isArray(rawChapter)) continue;
    const chapter = rawChapter as Record<string, unknown>;

    if (typeof chapter.id === 'string' && chapter.id !== chapterId) {
      issues.push({
        chapterId,
        kind: 'ID_MISMATCH',
        message: `id '${chapter.id}' does not match its key '${chapterId}'`,
      });
    }

    if (typeof chapter.order === 'number') {
      const existing = seenOrder.get(chapter.order);
      if (existing) {
        issues.push({
          chapterId,
          kind: 'DUPLICATE_ORDER',
          message: `order ${chapter.order} already used by '${existing}'`,
        });
      } else {
        seenOrder.set(chapter.order, chapterId);
      }
    }

    const chapterQuestId = chapter.chapterQuestId;
    if (
      canResolveQuests &&
      typeof chapterQuestId === 'string' &&
      !knownQuestIds!.has(chapterQuestId)
    ) {
      issues.push({
        chapterId,
        kind: 'MISSING_CHAPTER_QUEST',
        message: `chapterQuestId '${chapterQuestId}' does not resolve to a known quest`,
      });
    }

    for (const requirement of asArray(chapter.chapterRequirements)) {
      if (!requirement || typeof requirement !== 'object') continue;
      const ref = (requirement as Record<string, unknown>).storyChapter;
      if (typeof ref === 'string' && !chapterKeys.has(ref)) {
        issues.push({
          chapterId,
          kind: 'UNKNOWN_CHAPTER_REF',
          message: `chapterRequirements references unknown chapter '${ref}'`,
        });
      }
    }

    for (const objective of asArray(chapter.objectives)) {
      if (!objective || typeof objective !== 'object') continue;
      const obj = objective as Record<string, unknown>;

      if (typeof obj.id === 'string') {
        const owner = seenObjectiveIds.get(obj.id);
        if (owner) {
          issues.push({
            chapterId,
            kind: 'DUPLICATE_OBJECTIVE_ID',
            message: `objective id '${obj.id}' already used by chapter '${owner}'`,
          });
        } else {
          seenObjectiveIds.set(obj.id, chapterId);
        }
      }

      const sourceQuestId = obj.sourceQuestId;
      if (
        canResolveQuests &&
        typeof sourceQuestId === 'string' &&
        !knownQuestIds!.has(sourceQuestId)
      ) {
        issues.push({
          chapterId,
          kind: 'MISSING_SOURCE_QUEST',
          message: `objective '${String(
            obj.id ?? obj.description ?? '?'
          )}' sourceQuestId '${sourceQuestId}' does not resolve to a known quest`,
        });
      }
    }
  }

  return issues;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

// ---------------------------------------------------------------------------
// Suppressions
// ---------------------------------------------------------------------------

export interface SuppressionStaleness {
  taskId: string;
  objectiveId?: string;
  stale: boolean;
  message: string;
}

/**
 * Detect suppressions that no longer suppress anything.
 *
 * A suppression exists to silence a real upstream quirk (e.g. a duplicate
 * objective). Once the quirk is gone the suppression is dead weight and hides
 * future problems, so it should be removed.
 */
export function checkTaskSuppressionStaleness(
  suppressions: Record<string, unknown>,
  apiTasks: TaskData[]
): SuppressionStaleness[] {
  const byId = new Map(apiTasks.map((task) => [task.id, task]));
  const results: SuppressionStaleness[] = [];

  for (const [taskId, rawEntry] of Object.entries(suppressions)) {
    const apiTask = byId.get(taskId);

    if (!apiTask) {
      results.push({
        taskId,
        stale: true,
        message: 'task no longer present in API - suppression is dead',
      });
      continue;
    }

    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) continue;
    const entry = rawEntry as Record<string, unknown>;

    const objectives = entry.objectives;
    if (!objectives || typeof objectives !== 'object') {
      results.push({
        taskId,
        stale: false,
        message: 'task-level suppression - verify manually against the wiki report',
      });
      continue;
    }

    for (const objectiveId of Object.keys(objectives as Record<string, unknown>)) {
      const exists = apiTask.objectives?.some((o) => o.id === objectiveId) ?? false;
      results.push({
        taskId,
        objectiveId,
        stale: !exists,
        message: exists
          ? 'suppressed objective still present upstream - STILL NEEDED'
          : 'suppressed objective no longer present upstream - suppression is stale',
      });
    }
  }

  return results;
}

/** Group entity results by status for reporting. */
export function categorizeEntityResults(results: EntityValidationResult[]) {
  return {
    stillNeeded: results.filter((r) => r.stillNeeded),
    fixed: results.filter((r) => r.status === 'FIXED'),
    removedFromApi: results.filter((r) => r.status === 'REMOVED_FROM_API'),
  };
}
