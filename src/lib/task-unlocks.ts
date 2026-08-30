/**
 * Deterministic task-availability model.
 *
 * json.tarkov.dev publishes task definitions, not a player's current quest,
 * trader, map, dialogue, or global-variable state. This module turns the
 * definition into a small boolean model and evaluates it only when the
 * corresponding account state is supplied.
 */

import type {
  TaskData,
  TaskDialogueRequirement,
  TaskGlobalVariableRequirement,
  TaskKeyRequirement,
  TaskOtherRequirement,
  TaskRequirement,
  TraderRequirement,
} from './types.js';

export type TaskUnlockCompareMethod = '>=' | '<=' | '>' | '<' | '=';
export type RequirementState = 'met' | 'unmet' | 'unknown';
export type TaskAvailabilityStatus = 'available' | 'blocked' | 'unknown';
export type TaskStatusValue = string | number;

/** BSG quest status codes accepted by the evaluator when a profile is numeric. */
export const TASK_STATUS_NAMES: Readonly<Record<number, string>> = {
  0: 'locked',
  1: 'active',
  2: 'active',
  3: 'active',
  4: 'complete',
  5: 'failed',
  6: 'failed',
  7: 'failed',
  8: 'failed',
  9: 'active',
};

type TaskRef = { id: string; name: string };

/** A single condition that must be evaluated against player state. */
export type TaskUnlockCondition =
  | {
      type: 'playerLevel';
      compareMethod: '>=';
      value: number;
    }
  | {
      type: 'faction';
      faction: string;
    }
  | {
      type: 'taskStatus';
      task: TaskRef;
      /** Accepted task states are ORed within this one condition. */
      statuses: string[];
    }
  | {
      type: 'traderLevel' | 'traderReputation';
      requirementId: string;
      trader: TaskRef;
      compareMethod: TaskUnlockCompareMethod;
      value: number;
    }
  | {
      type: 'globalVariable';
      /** BSG condition id, distinct from the variable being compared. */
      requirementId: string;
      variableId: string;
      compareMethod: TaskUnlockCompareMethod;
      value: number;
    }
  | {
      type: 'dialogue';
      /** BSG condition id recorded when the required trader interaction occurs. */
      requirementId: string;
      traders: TaskRef[];
    }
  | {
      type: 'prestigeLevel';
      prestige: { id?: string; name: string; prestigeLevel: number };
      compareMethod: '>=';
      value: number;
    }
  | {
      /** Explicit story progress supplied by the story-chapter overlay. */
      type: 'storyChapterProgress';
      storyChapter: TaskRef;
    }
  | {
      /** A future upstream condition that this version does not understand. */
      type: 'unknown';
      requirementId: string;
      requirementType: string;
    };

/** Player/account state needed to evaluate a task definition. */
export interface TaskUnlockState {
  playerLevel?: number;
  faction?: string;
  prestigeLevel?: number;
  /** Accepts BSG numeric status codes or normalized/string status names. */
  taskStatuses?: Record<string, TaskStatusValue | TaskStatusValue[]>;
  traderLevels?: Record<string, number>;
  traderReputation?: Record<string, number>;
  /** True only after the trader is unlocked for this account/mode. */
  traderUnlocked?: Record<string, boolean>;
  /** True after the account has unlocked the Lightkeeper chain. */
  lightkeeperUnlocked?: boolean;
  /** Values from the account's variable-group state, keyed by variableId. */
  globalVariables?: Record<string, number>;
  /** Dialogue requirement IDs acknowledged by the player. */
  dialogues?: Record<string, boolean>;
  /** Alternative input for profiles that expose completed BSG condition IDs. */
  completedConditionIds?: string[];
  /** Story chapter progress, keyed by the addition's chapter ID. */
  storyChapters?: Record<string, boolean>;
  /** Current epoch time in seconds, used for delayed availability. */
  nowSeconds?: number;
  /** Time at which this task's non-delay conditions became satisfied. */
  taskAvailableSince?: Record<string, number>;
  /** Account-specific map access, separate from static map entry rules. */
  mapAccess?: Record<string, boolean>;
}

/** Optional switches for callers that do not have one of the account feeds. */
export interface TaskUnlockEvaluationOptions {
  checkTraderUnlock?: boolean;
  checkLightkeeperAccess?: boolean;
  checkMapAccess?: boolean;
  checkTiming?: boolean;
}

export interface TaskUnlockTiming {
  minSeconds?: number;
  maxSeconds?: number;
}

/**
 * Normalized task availability.
 *
 * `all` is always required. `taskRequirements` are also ANDed, and each
 * `anyOf` group requires one entry. `alternatives` are complete
 * task-prerequisite branches; with `alternativesExclusive: true` they replace
 * the ordinary task requirements/groups while the common `all` conditions
 * still apply. Statuses inside one taskStatus condition are ORed.
 */
export interface TaskUnlockDefinition {
  all: TaskUnlockCondition[];
  taskRequirements: TaskUnlockCondition[];
  anyOf: TaskUnlockCondition[][];
  alternatives?: TaskUnlockCondition[][];
  alternativesExclusive?: boolean;
  context: {
    trader?: TaskRef;
    map?: TaskRef;
    lightkeeperRequired?: true;
  };
  timing?: TaskUnlockTiming;
  /** Completion/raid-entry requirements, deliberately not start gates. */
  completion?: {
    neededKeys: TaskKeyRequirement[];
  };
}

/** An evaluated condition, including an explanation suitable for UI/debugging. */
export interface EvaluatedTaskUnlockCondition {
  condition: TaskUnlockCondition | TaskContextCondition;
  state: RequirementState;
  reason: string;
}

/** Conditions derived from task context rather than the task's start list. */
export type TaskContextCondition =
  | { type: 'traderUnlocked'; trader: TaskRef }
  | { type: 'lightkeeperAccess' }
  | { type: 'mapAccess'; map: TaskRef }
  | { type: 'availabilityTiming'; task: TaskRef; timing: TaskUnlockTiming };

export interface TaskUnlockEvaluation {
  status: TaskAvailabilityStatus;
  all: EvaluatedTaskUnlockCondition[];
  taskRequirements: EvaluatedTaskUnlockCondition[];
  anyOf: EvaluatedTaskUnlockCondition[][];
  alternatives: EvaluatedTaskUnlockCondition[][];
  context: EvaluatedTaskUnlockCondition[];
  /** Only conditions relevant to the resulting blocked/unknown status. */
  blockers: EvaluatedTaskUnlockCondition[];
  unknown: EvaluatedTaskUnlockCondition[];
}

const DEFAULT_TASK_STATUSES = ['complete'];

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function statusesFor(requirement: TaskRequirement): string[] {
  const statuses = requirement.status?.filter(
    (status): status is string => typeof status === 'string'
  );
  return uniqueStrings(statuses && statuses.length > 0 ? statuses : DEFAULT_TASK_STATUSES);
}

function taskRequirementCondition(requirement: TaskRequirement): TaskUnlockCondition {
  return {
    type: 'taskStatus',
    task: requirement.task,
    statuses: statusesFor(requirement),
  };
}

function traderRequirementCondition(requirement: TraderRequirement): TaskUnlockCondition {
  if (requirement.requirementType === 'level') {
    return {
      type: 'traderLevel',
      requirementId: requirement.id,
      trader: requirement.trader,
      compareMethod: requirement.compareMethod,
      value: requirement.value,
    };
  }

  return {
    type: 'traderReputation',
    requirementId: requirement.id,
    trader: requirement.trader,
    compareMethod: requirement.compareMethod,
    value: requirement.value,
  };
}

function otherRequirementCondition(requirement: TaskOtherRequirement): TaskUnlockCondition {
  if (requirement.type === 'dialogue') {
    const dialogue = requirement as TaskDialogueRequirement;
    return {
      type: 'dialogue',
      requirementId: dialogue.id,
      traders: dialogue.traders,
    };
  }

  if (requirement.type === 'globalVariable') {
    const globalVariable = requirement as TaskGlobalVariableRequirement;
    return {
      type: 'globalVariable',
      requirementId: globalVariable.id,
      variableId: globalVariable.variableId,
      compareMethod: globalVariable.compareMethod,
      value: globalVariable.value,
    };
  }

  return {
    type: 'unknown',
    requirementId: requirement.id,
    requirementType: requirement.type,
  };
}

/**
 * Convert the fields published by json.tarkov.dev into an explicit unlock
 * definition. No dependency is inferred from task order, name, map, or
 * objective text.
 */
export function deriveTaskUnlockDefinition(task: TaskData): TaskUnlockDefinition {
  const all: TaskUnlockCondition[] = [];

  if (typeof task.minPlayerLevel === 'number' && task.minPlayerLevel > 0) {
    all.push({ type: 'playerLevel', compareMethod: '>=', value: task.minPlayerLevel });
  }

  if (task.factionName && task.factionName.toLowerCase() !== 'any') {
    all.push({ type: 'faction', faction: task.factionName });
  }

  if (task.requiredPrestige) {
    all.push({
      type: 'prestigeLevel',
      prestige: task.requiredPrestige,
      compareMethod: '>=',
      value: task.requiredPrestige.prestigeLevel,
    });
  }

  for (const requirement of task.traderRequirements ?? []) {
    all.push(traderRequirementCondition(requirement));
  }

  for (const requirement of task.otherRequirements ?? []) {
    all.push(otherRequirementCondition(requirement));
  }

  const definition: TaskUnlockDefinition = {
    all,
    taskRequirements: (task.taskRequirements ?? []).map(taskRequirementCondition),
    anyOf: (task.taskRequirementGroups ?? []).map((group) => group.map(taskRequirementCondition)),
    context: {},
  };

  if (task.trader) definition.context.trader = task.trader;
  if (task.map) definition.context.map = task.map;
  if (task.lightkeeperRequired === true) definition.context.lightkeeperRequired = true;

  if ((task.availableDelaySecondsMin ?? 0) > 0 || (task.availableDelaySecondsMax ?? 0) > 0) {
    definition.timing = {
      minSeconds: task.availableDelaySecondsMin,
      maxSeconds: task.availableDelaySecondsMax,
    };
  }

  if (task.neededKeys?.length) {
    definition.completion = { neededKeys: task.neededKeys };
  }

  return definition;
}

/**
 * Attach externally modeled alternatives, for example a story chapter that
 * unlocks a task. An alternative is explicit; this helper never derives one
 * from task order or from a global-variable ID.
 */
export function withTaskUnlockAlternatives(
  definition: TaskUnlockDefinition,
  alternatives: TaskUnlockCondition[][],
  exclusive = true
): TaskUnlockDefinition {
  if (alternatives.some((branch) => branch.length === 0)) {
    throw new Error('Task unlock alternatives must contain at least one condition per branch');
  }

  return {
    ...definition,
    alternatives,
    alternativesExclusive: exclusive,
  };
}

function compare(actual: number, method: TaskUnlockCompareMethod, expected: number): boolean {
  switch (method) {
    case '>=':
      return actual >= expected;
    case '<=':
      return actual <= expected;
    case '>':
      return actual > expected;
    case '<':
      return actual < expected;
    case '=':
      return actual === expected;
  }
}

function canonicalStatus(status: TaskStatusValue): string {
  if (typeof status === 'number') return TASK_STATUS_NAMES[status] ?? `status:${status}`;

  const normalized = status.toLowerCase().replace(/[\s_-]/g, '');
  if (normalized === 'completed' || normalized === 'success') return 'complete';
  if (
    normalized === 'accepted' ||
    normalized === 'started' ||
    normalized === 'availableforstart' ||
    normalized === 'availableforfinish' ||
    normalized === 'availableafter'
  ) {
    return 'active';
  }
  if (
    normalized === 'fail' ||
    normalized === 'failedrestartable' ||
    normalized === 'markedasfailed' ||
    normalized === 'expired'
  ) {
    return 'failed';
  }
  return normalized;
}

function numberState(
  value: number | undefined,
  method: TaskUnlockCompareMethod,
  expected: number
): EvaluatedTaskUnlockCondition['state'] {
  if (value === undefined || !Number.isFinite(value)) return 'unknown';
  return compare(value, method, expected) ? 'met' : 'unmet';
}

function evaluateCondition(
  condition: TaskUnlockCondition,
  state: TaskUnlockState
): Pick<EvaluatedTaskUnlockCondition, 'state' | 'reason'> {
  switch (condition.type) {
    case 'playerLevel': {
      const result = numberState(state.playerLevel, condition.compareMethod, condition.value);
      return {
        state: result,
        reason:
          result === 'unknown'
            ? 'player level is not present'
            : `player level ${condition.compareMethod} ${condition.value}`,
      };
    }
    case 'faction': {
      if (state.faction === undefined)
        return { state: 'unknown', reason: 'faction is not present' };
      return {
        state: state.faction.toLowerCase() === condition.faction.toLowerCase() ? 'met' : 'unmet',
        reason: `faction is ${condition.faction}`,
      };
    }
    case 'taskStatus': {
      const actual = state.taskStatuses?.[condition.task.id];
      if (actual === undefined) return { state: 'unknown', reason: 'task status is not present' };
      const statuses = Array.isArray(actual) ? actual : [actual];
      const accepted = new Set(condition.statuses.map(canonicalStatus));
      const matches = statuses.some((status) => accepted.has(canonicalStatus(status)));
      return {
        state: matches ? 'met' : 'unmet',
        reason: `task status is one of: ${condition.statuses.join(', ')}`,
      };
    }
    case 'traderLevel': {
      const result = numberState(
        state.traderLevels?.[condition.trader.id],
        condition.compareMethod,
        condition.value
      );
      return {
        state: result,
        reason:
          result === 'unknown'
            ? 'trader level is not present'
            : `trader level ${condition.compareMethod} ${condition.value}`,
      };
    }
    case 'traderReputation': {
      const result = numberState(
        state.traderReputation?.[condition.trader.id],
        condition.compareMethod,
        condition.value
      );
      return {
        state: result,
        reason:
          result === 'unknown'
            ? 'trader reputation is not present'
            : `trader reputation ${condition.compareMethod} ${condition.value}`,
      };
    }
    case 'globalVariable': {
      const result = numberState(
        state.globalVariables?.[condition.variableId],
        condition.compareMethod,
        condition.value
      );
      return {
        state: result,
        reason:
          result === 'unknown'
            ? `global variable ${condition.variableId} is not present`
            : `global variable ${condition.variableId} ${condition.compareMethod} ${condition.value}`,
      };
    }
    case 'dialogue': {
      const dialogueMap = state.dialogues;
      const value =
        dialogueMap && Object.prototype.hasOwnProperty.call(dialogueMap, condition.requirementId)
          ? dialogueMap[condition.requirementId]
          : state.completedConditionIds?.includes(condition.requirementId);
      if (value === undefined) return { state: 'unknown', reason: 'dialogue flag is not present' };
      return { state: value ? 'met' : 'unmet', reason: 'required trader dialogue is acknowledged' };
    }
    case 'prestigeLevel': {
      const result = numberState(state.prestigeLevel, condition.compareMethod, condition.value);
      return {
        state: result,
        reason:
          result === 'unknown'
            ? 'prestige level is not present'
            : `prestige level ${condition.compareMethod} ${condition.value}`,
      };
    }
    case 'storyChapterProgress': {
      const value = state.storyChapters?.[condition.storyChapter.id];
      if (value === undefined) {
        return { state: 'unknown', reason: 'story chapter progress is not present' };
      }
      return {
        state: value ? 'met' : 'unmet',
        reason: 'story chapter has reached the unlock point',
      };
    }
    case 'unknown':
      return {
        state: 'unknown',
        reason: `unsupported requirement type: ${condition.requirementType}`,
      };
  }
}

function evaluateTiming(
  taskId: string,
  timing: TaskUnlockTiming,
  state: TaskUnlockState
): Pick<EvaluatedTaskUnlockCondition, 'state' | 'reason'> {
  const since = state.taskAvailableSince?.[taskId];
  if (since === undefined || state.nowSeconds === undefined) {
    return { state: 'unknown', reason: 'availability timing state is not present' };
  }

  const min = Math.max(0, timing.minSeconds ?? 0);
  const max = Math.max(min, timing.maxSeconds ?? min);
  const elapsed = state.nowSeconds - since;
  if (!Number.isFinite(elapsed)) {
    return { state: 'unknown', reason: 'availability timing state is invalid' };
  }
  if (elapsed < min) {
    return { state: 'unmet', reason: `availability delay is at least ${min} seconds` };
  }
  if (elapsed < max) {
    return {
      state: 'unknown',
      reason: `availability delay is between ${min} and ${max} seconds`,
    };
  }
  return { state: 'met', reason: 'availability delay has elapsed' };
}

function evaluateContextCondition(
  condition: TaskContextCondition,
  state: TaskUnlockState
): Pick<EvaluatedTaskUnlockCondition, 'state' | 'reason'> {
  if (condition.type === 'traderUnlocked') {
    const value = state.traderUnlocked?.[condition.trader.id];
    if (value === undefined)
      return { state: 'unknown', reason: 'trader unlock state is not present' };
    return { state: value ? 'met' : 'unmet', reason: 'task-giver trader is unlocked' };
  }

  if (condition.type === 'lightkeeperAccess') {
    if (state.lightkeeperUnlocked === undefined) {
      return { state: 'unknown', reason: 'Lightkeeper unlock state is not present' };
    }
    return {
      state: state.lightkeeperUnlocked ? 'met' : 'unmet',
      reason: 'Lightkeeper access is unlocked',
    };
  }

  if (condition.type === 'mapAccess') {
    const value = state.mapAccess?.[condition.map.id];
    if (value === undefined) return { state: 'unknown', reason: 'map access state is not present' };
    return { state: value ? 'met' : 'unmet', reason: 'task map is accessible' };
  }

  return evaluateTiming(condition.task.id, condition.timing, state);
}

function evaluateConditionList(
  conditions: readonly TaskUnlockCondition[],
  state: TaskUnlockState
): EvaluatedTaskUnlockCondition[] {
  return conditions.map((condition) => ({
    condition,
    ...evaluateCondition(condition, state),
  }));
}

function evaluateContextList(
  conditions: readonly TaskContextCondition[],
  state: TaskUnlockState
): EvaluatedTaskUnlockCondition[] {
  return conditions.map((condition) => ({
    condition,
    ...evaluateContextCondition(condition, state),
  }));
}

function allStatus(checks: readonly EvaluatedTaskUnlockCondition[]): TaskAvailabilityStatus {
  if (checks.some((check) => check.state === 'unmet')) return 'blocked';
  if (checks.some((check) => check.state === 'unknown')) return 'unknown';
  return 'available';
}

function anyStatus(statuses: readonly TaskAvailabilityStatus[]): TaskAvailabilityStatus {
  if (statuses.some((status) => status === 'available')) return 'available';
  if (statuses.some((status) => status === 'unknown')) return 'unknown';
  return 'blocked';
}

function andStatus(statuses: readonly TaskAvailabilityStatus[]): TaskAvailabilityStatus {
  if (statuses.some((status) => status === 'blocked')) return 'blocked';
  if (statuses.some((status) => status === 'unknown')) return 'unknown';
  return 'available';
}

function anyStatusForChecks(
  checks: readonly EvaluatedTaskUnlockCondition[]
): TaskAvailabilityStatus {
  return anyStatus(
    checks.map((check) =>
      check.state === 'met' ? 'available' : check.state === 'unmet' ? 'blocked' : 'unknown'
    )
  );
}

interface PathEvaluation {
  status: TaskAvailabilityStatus;
  blockers: EvaluatedTaskUnlockCondition[];
  unknown: EvaluatedTaskUnlockCondition[];
}

function evaluateAndPath(
  all: readonly EvaluatedTaskUnlockCondition[],
  anyOf: readonly (readonly EvaluatedTaskUnlockCondition[])[]
): PathEvaluation {
  const allState = allStatus(all);
  const groupStatuses = anyOf.map(anyStatusForChecks);
  const status = andStatus([allState, ...groupStatuses]);
  if (status === 'available') return { status, blockers: [], unknown: [] };

  const blockers: EvaluatedTaskUnlockCondition[] = [];
  const unknown: EvaluatedTaskUnlockCondition[] = [];
  if (status === 'blocked') {
    if (allState === 'blocked') blockers.push(...all.filter((check) => check.state === 'unmet'));
    anyOf.forEach((group, index) => {
      if (groupStatuses[index] === 'blocked') {
        blockers.push(...group.filter((check) => check.state === 'unmet'));
      }
    });
  } else {
    if (allState === 'unknown') unknown.push(...all.filter((check) => check.state === 'unknown'));
    anyOf.forEach((group, index) => {
      if (groupStatuses[index] === 'unknown') {
        unknown.push(...group.filter((check) => check.state === 'unknown'));
      }
    });
  }
  return { status, blockers, unknown };
}

function evaluateAlternativePaths(
  alternatives: readonly (readonly EvaluatedTaskUnlockCondition[])[]
): PathEvaluation {
  const paths = alternatives.map((branch) => {
    const status = allStatus(branch);
    return {
      status,
      blockers: status === 'blocked' ? branch.filter((check) => check.state === 'unmet') : [],
      unknown: status === 'unknown' ? branch.filter((check) => check.state === 'unknown') : [],
    };
  });
  const status = anyStatus(paths.map((path) => path.status));
  if (status === 'available') return { status, blockers: [], unknown: [] };

  if (status === 'unknown') {
    return {
      status,
      blockers: [],
      unknown: paths.flatMap((path) => (path.status === 'unknown' ? path.unknown : [])),
    };
  }

  return {
    status,
    blockers: paths.flatMap((path) => path.blockers),
    unknown: [],
  };
}

/** Evaluate a normalized task definition against an account snapshot. */
export function evaluateTaskUnlock(
  task: TaskData,
  definition: TaskUnlockDefinition,
  state: TaskUnlockState,
  options: TaskUnlockEvaluationOptions = {}
): TaskUnlockEvaluation {
  const all = evaluateConditionList(definition.all, state);
  const taskRequirements = evaluateConditionList(definition.taskRequirements, state);
  const anyOf = definition.anyOf.map((group) => evaluateConditionList(group, state));
  const contextConditions: TaskContextCondition[] = [];

  if (options.checkTraderUnlock !== false && definition.context.trader) {
    contextConditions.push({ type: 'traderUnlocked', trader: definition.context.trader });
  }
  if (options.checkLightkeeperAccess !== false && definition.context.lightkeeperRequired) {
    contextConditions.push({ type: 'lightkeeperAccess' });
  }
  if (options.checkMapAccess !== false && definition.context.map) {
    contextConditions.push({ type: 'mapAccess', map: definition.context.map });
  }
  if (
    options.checkTiming !== false &&
    definition.timing &&
    ((definition.timing.minSeconds ?? 0) > 0 || (definition.timing.maxSeconds ?? 0) > 0)
  ) {
    contextConditions.push({
      type: 'availabilityTiming',
      task: { id: task.id, name: task.name },
      timing: definition.timing,
    });
  }
  const context = evaluateContextList(contextConditions, state);

  const commonPath = evaluateAndPath([...all, ...context], []);
  const basePath = evaluateAndPath(taskRequirements, anyOf);
  const alternatives = (definition.alternatives ?? []).map((branch) =>
    evaluateConditionList(branch, state)
  );
  const alternativePath = evaluateAlternativePaths(alternatives);

  let unlockPath = basePath;
  if (definition.alternatives?.length) {
    const hasOrdinaryTaskPath =
      definition.taskRequirements.length > 0 || definition.anyOf.length > 0;
    const candidates = [
      ...(definition.alternativesExclusive === false || hasOrdinaryTaskPath ? [basePath] : []),
      alternativePath,
    ];
    unlockPath = {
      status: anyStatus(candidates.map((candidate) => candidate.status)),
      blockers: [],
      unknown: [],
    };
    if (unlockPath.status === 'blocked') {
      unlockPath.blockers = candidates.flatMap((candidate) => candidate.blockers);
    } else if (unlockPath.status === 'unknown') {
      unlockPath.unknown = candidates.flatMap((candidate) => candidate.unknown);
    }
  }

  const status = andStatus([commonPath.status, unlockPath.status]);
  const blockers: EvaluatedTaskUnlockCondition[] = [];
  const unknown: EvaluatedTaskUnlockCondition[] = [];
  if (status === 'blocked') {
    if (commonPath.status === 'blocked') blockers.push(...commonPath.blockers);
    if (unlockPath.status === 'blocked') blockers.push(...unlockPath.blockers);
  } else if (status === 'unknown') {
    if (commonPath.status === 'unknown') unknown.push(...commonPath.unknown);
    if (unlockPath.status === 'unknown') unknown.push(...unlockPath.unknown);
  }

  return {
    status,
    all,
    taskRequirements,
    anyOf,
    alternatives,
    context,
    blockers,
    unknown,
  };
}
