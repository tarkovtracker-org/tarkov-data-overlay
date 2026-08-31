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

const STATUS_ALIASES: Readonly<Record<string, string>> = {
  completed: 'complete',
  success: 'complete',
  accepted: 'active',
  started: 'active',
  availableforstart: 'active',
  availableforfinish: 'active',
  availableafter: 'active',
  fail: 'failed',
  failedrestartable: 'failed',
  markedasfailed: 'failed',
  expired: 'failed',
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
 * task-prerequisite branches. When alternatives are present,
 * `alternativesExclusive: false` ORs them with the ordinary task path, while
 * `true` uses only the explicit alternatives; without alternatives, the
 * ordinary path is always used. The common `all` conditions still apply.
 * Statuses inside one taskStatus condition are ORed.
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

/** Deduplicate non-empty status names while preserving their first-seen order. */
function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

/** Normalize the statuses accepted by one upstream task prerequisite. */
function statusesFor(requirement: TaskRequirement): string[] {
  if (requirement.status === undefined) return [...DEFAULT_TASK_STATUSES];
  if (!Array.isArray(requirement.status)) return [];

  return uniqueStrings(
    requirement.status.filter((status): status is string => typeof status === 'string')
  );
}

/** Convert one task prerequisite into a task-status unlock condition. */
function taskRequirementCondition(requirement: TaskRequirement): TaskUnlockCondition {
  return {
    type: 'taskStatus',
    task: requirement.task,
    statuses: statusesFor(requirement),
  };
}

/** Convert one trader-level or trader-reputation prerequisite into a condition. */
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

/** Convert a known or future hidden requirement into an unlock condition. */
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

/** Derive the minimum-player-level condition when the task declares one. */
function playerLevelCondition(task: TaskData): TaskUnlockCondition | undefined {
  if (typeof task.minPlayerLevel !== 'number' || task.minPlayerLevel <= 0) return undefined;
  return { type: 'playerLevel', compareMethod: '>=', value: task.minPlayerLevel };
}

/** Derive the faction condition when the task is faction-specific. */
function factionCondition(task: TaskData): TaskUnlockCondition | undefined {
  if (!task.factionName || task.factionName.toLowerCase() === 'any') return undefined;
  return { type: 'faction', faction: task.factionName };
}

/** Derive the prestige condition when the task requires a prestige level. */
function prestigeCondition(task: TaskData): TaskUnlockCondition | undefined {
  if (!task.requiredPrestige) return undefined;
  return {
    type: 'prestigeLevel',
    prestige: task.requiredPrestige,
    compareMethod: '>=',
    value: task.requiredPrestige.prestigeLevel,
  };
}

/** Derive the task-level conditions shared by every unlock path. */
function deriveCommonUnlockConditions(task: TaskData): TaskUnlockCondition[] {
  const all = [playerLevelCondition(task), factionCondition(task), prestigeCondition(task)].filter(
    (condition): condition is TaskUnlockCondition => condition !== undefined
  );

  for (const requirement of task.traderRequirements ?? []) {
    all.push(traderRequirementCondition(requirement));
  }

  for (const requirement of task.otherRequirements ?? []) {
    all.push(otherRequirementCondition(requirement));
  }

  return all;
}

/** Derive timing metadata only when the task declares a positive delay. */
function deriveTaskTiming(task: TaskData): TaskUnlockTiming | undefined {
  const minSeconds = task.availableDelaySecondsMin ?? 0;
  const maxSeconds = task.availableDelaySecondsMax ?? 0;
  if (minSeconds <= 0 && maxSeconds <= 0) return undefined;
  return { minSeconds: task.availableDelaySecondsMin, maxSeconds: task.availableDelaySecondsMax };
}

/**
 * Convert the fields published by json.tarkov.dev into an explicit unlock
 * definition. No dependency is inferred from task order, name, map, or
 * objective text.
 */
export function deriveTaskUnlockDefinition(task: TaskData): TaskUnlockDefinition {
  const timing = deriveTaskTiming(task);
  const definition: TaskUnlockDefinition = {
    all: deriveCommonUnlockConditions(task),
    taskRequirements: (task.taskRequirements ?? []).map(taskRequirementCondition),
    anyOf: (task.taskRequirementGroups ?? []).map((group) => group.map(taskRequirementCondition)),
    context: {},
  };

  if (task.trader) definition.context.trader = task.trader;
  if (task.map) definition.context.map = task.map;
  if (task.lightkeeperRequired === true) definition.context.lightkeeperRequired = true;

  if (timing) definition.timing = timing;

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

/** Apply a supported comparison operator to two numeric values. */
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

/** Map numeric/profile status spellings to the evaluator's canonical names. */
function canonicalStatus(status: TaskStatusValue): string {
  if (typeof status === 'number') return TASK_STATUS_NAMES[status] ?? `status:${status}`;

  const normalized = status.toLowerCase().replace(/[\s_-]/g, '');
  return STATUS_ALIASES[normalized] ?? normalized;
}

/** Evaluate a numeric comparison, treating missing or non-finite input as unknown. */
function numberState(
  value: number | undefined,
  method: TaskUnlockCompareMethod,
  expected: number
): EvaluatedTaskUnlockCondition['state'] {
  if (value === undefined || !Number.isFinite(value)) return 'unknown';
  return compare(value, method, expected) ? 'met' : 'unmet';
}

type ConditionEvaluation = Pick<EvaluatedTaskUnlockCondition, 'state' | 'reason'>;

/** Evaluate a numeric condition and format its human-readable explanation. */
function evaluateNumericCondition(
  value: number | undefined,
  method: TaskUnlockCompareMethod,
  expected: number,
  label: string
): ConditionEvaluation {
  const result = numberState(value, method, expected);
  return {
    state: result,
    reason: result === 'unknown' ? `${label} is not present` : `${label} ${method} ${expected}`,
  };
}

/** Evaluate a player-level condition. */
function evaluatePlayerLevelCondition(
  condition: Extract<TaskUnlockCondition, { type: 'playerLevel' }>,
  state: TaskUnlockState
): ConditionEvaluation {
  return evaluateNumericCondition(
    state.playerLevel,
    condition.compareMethod,
    condition.value,
    'player level'
  );
}

/** Evaluate a faction condition. */
function evaluateFactionCondition(
  condition: Extract<TaskUnlockCondition, { type: 'faction' }>,
  state: TaskUnlockState
): ConditionEvaluation {
  if (state.faction === undefined) return { state: 'unknown', reason: 'faction is not present' };
  return {
    state: state.faction.toLowerCase() === condition.faction.toLowerCase() ? 'met' : 'unmet',
    reason: `faction is ${condition.faction}`,
  };
}

/** Evaluate one task-status condition, including its accepted status aliases. */
function evaluateTaskStatusCondition(
  condition: Extract<TaskUnlockCondition, { type: 'taskStatus' }>,
  state: TaskUnlockState
): ConditionEvaluation {
  if (condition.statuses.length === 0) {
    return { state: 'unknown', reason: 'task status requirement has no supported statuses' };
  }
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

/** Evaluate a trader level or reputation condition. */
function evaluateTraderCondition(
  condition: Extract<TaskUnlockCondition, { type: 'traderLevel' | 'traderReputation' }>,
  state: TaskUnlockState
): ConditionEvaluation {
  const values = condition.type === 'traderLevel' ? state.traderLevels : state.traderReputation;
  const label = condition.type === 'traderLevel' ? 'trader level' : 'trader reputation';
  return evaluateNumericCondition(
    values?.[condition.trader.id],
    condition.compareMethod,
    condition.value,
    label
  );
}

/** Evaluate a persistent global-variable condition. */
function evaluateGlobalVariableCondition(
  condition: Extract<TaskUnlockCondition, { type: 'globalVariable' }>,
  state: TaskUnlockState
): ConditionEvaluation {
  return evaluateNumericCondition(
    state.globalVariables?.[condition.variableId],
    condition.compareMethod,
    condition.value,
    `global variable ${condition.variableId}`
  );
}

/** Evaluate a trader-dialogue acknowledgement condition. */
function evaluateDialogueCondition(
  condition: Extract<TaskUnlockCondition, { type: 'dialogue' }>,
  state: TaskUnlockState
): ConditionEvaluation {
  const dialogueMap = state.dialogues;
  const value =
    dialogueMap && Object.prototype.hasOwnProperty.call(dialogueMap, condition.requirementId)
      ? dialogueMap[condition.requirementId]
      : state.completedConditionIds?.includes(condition.requirementId);
  if (value === undefined) return { state: 'unknown', reason: 'dialogue flag is not present' };
  return { state: value ? 'met' : 'unmet', reason: 'required trader dialogue is acknowledged' };
}

/** Evaluate a prestige-level condition. */
function evaluatePrestigeCondition(
  condition: Extract<TaskUnlockCondition, { type: 'prestigeLevel' }>,
  state: TaskUnlockState
): ConditionEvaluation {
  return evaluateNumericCondition(
    state.prestigeLevel,
    condition.compareMethod,
    condition.value,
    'prestige level'
  );
}

/** Evaluate an explicit story-chapter progress condition. */
function evaluateStoryChapterCondition(
  condition: Extract<TaskUnlockCondition, { type: 'storyChapterProgress' }>,
  state: TaskUnlockState
): ConditionEvaluation {
  const value = state.storyChapters?.[condition.storyChapter.id];
  if (value === undefined) {
    return { state: 'unknown', reason: 'story chapter progress is not present' };
  }
  return {
    state: value ? 'met' : 'unmet',
    reason: 'story chapter has reached the unlock point',
  };
}

/** Preserve unsupported conditions as unknown instead of guessing their state. */
function evaluateUnknownCondition(
  condition: Extract<TaskUnlockCondition, { type: 'unknown' }>
): ConditionEvaluation {
  return {
    state: 'unknown',
    reason: `unsupported requirement type: ${condition.requirementType}`,
  };
}

type ConditionHandlers = {
  [Type in TaskUnlockCondition['type']]: (
    condition: Extract<TaskUnlockCondition, { type: Type }>,
    state: TaskUnlockState
  ) => ConditionEvaluation;
};

const CONDITION_HANDLERS: ConditionHandlers = {
  playerLevel: evaluatePlayerLevelCondition,
  faction: evaluateFactionCondition,
  taskStatus: evaluateTaskStatusCondition,
  traderLevel: evaluateTraderCondition,
  traderReputation: evaluateTraderCondition,
  globalVariable: evaluateGlobalVariableCondition,
  dialogue: evaluateDialogueCondition,
  prestigeLevel: evaluatePrestigeCondition,
  storyChapterProgress: evaluateStoryChapterCondition,
  unknown: (condition) => evaluateUnknownCondition(condition),
};

/** Evaluate one static task-start condition against account state. */
function evaluateCondition(
  condition: TaskUnlockCondition,
  state: TaskUnlockState
): ConditionEvaluation {
  const handler = CONDITION_HANDLERS[condition.type] as (
    condition: TaskUnlockCondition,
    state: TaskUnlockState
  ) => ConditionEvaluation;
  return handler(condition, state);
}

/** Evaluate a delayed-availability condition against the account clock state. */
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

/** Evaluate a task-giver trader unlock condition. */
function evaluateTraderUnlockedCondition(
  condition: Extract<TaskContextCondition, { type: 'traderUnlocked' }>,
  state: TaskUnlockState
): ConditionEvaluation {
  const value = state.traderUnlocked?.[condition.trader.id];
  if (value === undefined)
    return { state: 'unknown', reason: 'trader unlock state is not present' };
  return { state: value ? 'met' : 'unmet', reason: 'task-giver trader is unlocked' };
}

/** Evaluate a Lightkeeper access condition. */
function evaluateLightkeeperCondition(
  _condition: Extract<TaskContextCondition, { type: 'lightkeeperAccess' }>,
  state: TaskUnlockState
): ConditionEvaluation {
  if (state.lightkeeperUnlocked === undefined) {
    return { state: 'unknown', reason: 'Lightkeeper unlock state is not present' };
  }
  return {
    state: state.lightkeeperUnlocked ? 'met' : 'unmet',
    reason: 'Lightkeeper access is unlocked',
  };
}

/** Evaluate account-specific access to a task's map. */
function evaluateMapAccessCondition(
  condition: Extract<TaskContextCondition, { type: 'mapAccess' }>,
  state: TaskUnlockState
): ConditionEvaluation {
  const value = state.mapAccess?.[condition.map.id];
  if (value === undefined) return { state: 'unknown', reason: 'map access state is not present' };
  return { state: value ? 'met' : 'unmet', reason: 'task map is accessible' };
}

type ContextConditionHandlers = {
  [Type in TaskContextCondition['type']]: (
    condition: Extract<TaskContextCondition, { type: Type }>,
    state: TaskUnlockState
  ) => ConditionEvaluation;
};

const CONTEXT_CONDITION_HANDLERS: ContextConditionHandlers = {
  traderUnlocked: evaluateTraderUnlockedCondition,
  lightkeeperAccess: evaluateLightkeeperCondition,
  mapAccess: evaluateMapAccessCondition,
  availabilityTiming: (condition, state) =>
    evaluateTiming(condition.task.id, condition.timing, state),
};

/** Evaluate one account-context condition against profile state. */
function evaluateContextCondition(
  condition: TaskContextCondition,
  state: TaskUnlockState
): ConditionEvaluation {
  const handler = CONTEXT_CONDITION_HANDLERS[condition.type] as (
    condition: TaskContextCondition,
    state: TaskUnlockState
  ) => ConditionEvaluation;
  return handler(condition, state);
}

/** Evaluate a list of task-definition conditions in order. */
function evaluateConditionList(
  conditions: readonly TaskUnlockCondition[],
  state: TaskUnlockState
): EvaluatedTaskUnlockCondition[] {
  return conditions.map((condition) => ({
    condition,
    ...evaluateCondition(condition, state),
  }));
}

/** Evaluate a list of derived context conditions in order. */
function evaluateContextList(
  conditions: readonly TaskContextCondition[],
  state: TaskUnlockState
): EvaluatedTaskUnlockCondition[] {
  return conditions.map((condition) => ({
    condition,
    ...evaluateContextCondition(condition, state),
  }));
}

/** Combine condition states using AND semantics. */
function allStatus(checks: readonly EvaluatedTaskUnlockCondition[]): TaskAvailabilityStatus {
  if (checks.some((check) => check.state === 'unmet')) return 'blocked';
  if (checks.some((check) => check.state === 'unknown')) return 'unknown';
  return 'available';
}

/** Combine path statuses using OR semantics. */
function anyStatus(statuses: readonly TaskAvailabilityStatus[]): TaskAvailabilityStatus {
  if (statuses.some((status) => status === 'available')) return 'available';
  if (statuses.some((status) => status === 'unknown')) return 'unknown';
  return 'blocked';
}

/** Combine path statuses using AND semantics. */
function andStatus(statuses: readonly TaskAvailabilityStatus[]): TaskAvailabilityStatus {
  if (statuses.some((status) => status === 'blocked')) return 'blocked';
  if (statuses.some((status) => status === 'unknown')) return 'unknown';
  return 'available';
}

/** Convert evaluated condition states into an OR-path status. */
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

/** Evaluate the ordinary AND path, including each required OR group. */
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

/** Evaluate explicit alternative branches, where any complete branch succeeds. */
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

/** Build the task-giver trader gate when enabled by the caller. */
function traderContextCondition(
  definition: TaskUnlockDefinition,
  options: TaskUnlockEvaluationOptions
): TaskContextCondition | undefined {
  if (options.checkTraderUnlock === false || !definition.context.trader) return undefined;
  return { type: 'traderUnlocked', trader: definition.context.trader };
}

/** Build the Lightkeeper gate when enabled by the caller. */
function lightkeeperContextCondition(
  definition: TaskUnlockDefinition,
  options: TaskUnlockEvaluationOptions
): TaskContextCondition | undefined {
  if (options.checkLightkeeperAccess === false || !definition.context.lightkeeperRequired) {
    return undefined;
  }
  return { type: 'lightkeeperAccess' };
}

/** Build the account-specific map-access gate when enabled by the caller. */
function mapContextCondition(
  definition: TaskUnlockDefinition,
  options: TaskUnlockEvaluationOptions
): TaskContextCondition | undefined {
  if (options.checkMapAccess === false || !definition.context.map) return undefined;
  return { type: 'mapAccess', map: definition.context.map };
}

/** Build the delayed-availability gate when enabled and declared by the task. */
function timingContextCondition(
  task: TaskData,
  definition: TaskUnlockDefinition,
  options: TaskUnlockEvaluationOptions
): TaskContextCondition | undefined {
  const timing = definition.timing;
  if (
    options.checkTiming === false ||
    !timing ||
    ((timing.minSeconds ?? 0) <= 0 && (timing.maxSeconds ?? 0) <= 0)
  ) {
    return undefined;
  }
  return { type: 'availabilityTiming', task: { id: task.id, name: task.name }, timing };
}

/** Build the account-context gates enabled for one evaluation. */
function contextConditionsForTask(
  task: TaskData,
  definition: TaskUnlockDefinition,
  options: TaskUnlockEvaluationOptions
): TaskContextCondition[] {
  return [
    traderContextCondition(definition, options),
    lightkeeperContextCondition(definition, options),
    mapContextCondition(definition, options),
    timingContextCondition(task, definition, options),
  ].filter((condition): condition is TaskContextCondition => condition !== undefined);
}

/** Select the ordinary or explicit alternative unlock path. */
function evaluateUnlockPath(
  definition: TaskUnlockDefinition,
  basePath: PathEvaluation,
  alternatives: readonly (readonly EvaluatedTaskUnlockCondition[])[]
): PathEvaluation {
  if (!definition.alternatives?.length) return basePath;

  const alternativePath = evaluateAlternativePaths(alternatives);
  const candidates =
    definition.alternativesExclusive === false ? [basePath, alternativePath] : [alternativePath];
  const status = anyStatus(candidates.map((candidate) => candidate.status));
  if (status === 'blocked') {
    return { status, blockers: candidates.flatMap((candidate) => candidate.blockers), unknown: [] };
  }
  if (status === 'unknown') {
    return { status, blockers: [], unknown: candidates.flatMap((candidate) => candidate.unknown) };
  }
  return { status, blockers: [], unknown: [] };
}

/** Keep only the conditions that explain the final combined status. */
function collectPathIssues(
  status: TaskAvailabilityStatus,
  commonPath: PathEvaluation,
  unlockPath: PathEvaluation
): Pick<PathEvaluation, 'blockers' | 'unknown'> {
  if (status === 'blocked') {
    return {
      blockers: [
        ...(commonPath.status === 'blocked' ? commonPath.blockers : []),
        ...(unlockPath.status === 'blocked' ? unlockPath.blockers : []),
      ],
      unknown: [],
    };
  }
  if (status === 'unknown') {
    return {
      blockers: [],
      unknown: [
        ...(commonPath.status === 'unknown' ? commonPath.unknown : []),
        ...(unlockPath.status === 'unknown' ? unlockPath.unknown : []),
      ],
    };
  }
  return { blockers: [], unknown: [] };
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
  const contextConditions = contextConditionsForTask(task, definition, options);
  const context = evaluateContextList(contextConditions, state);

  const commonPath = evaluateAndPath([...all, ...context], []);
  const basePath = evaluateAndPath(taskRequirements, anyOf);
  const alternatives = (definition.alternatives ?? []).map((branch) =>
    evaluateConditionList(branch, state)
  );
  const unlockPath = evaluateUnlockPath(definition, basePath, alternatives);

  const status = andStatus([commonPath.status, unlockPath.status]);
  const { blockers, unknown } = collectPathIssues(status, commonPath, unlockPath);

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
