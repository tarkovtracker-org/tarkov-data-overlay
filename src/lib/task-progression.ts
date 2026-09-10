/** Progress-based counter resolution in front of the existing unlock evaluator. */
import {
  deriveTaskUnlockDefinition,
  evaluateTaskUnlock,
  normalizeTaskStatus,
  type TaskUnlockDerivationOptions,
  type TaskUnlockEvaluation,
  type TaskUnlockEvaluationOptions,
  type TaskUnlockState,
} from './task-unlocks.js';
import {
  SUPPORTED_GAME_MODES,
  type GameMode,
  type ProgressionCounterRegistry,
  type TaskData,
} from './types.js';

export interface TaskProgressionOptions extends TaskUnlockDerivationOptions {
  mode: GameMode;
  /** Must match the registry revision; omitted/mismatched revisions never derive values. */
  revision?: string;
  counters?: ProgressionCounterRegistry;
  evaluation?: TaskUnlockEvaluationOptions;
}

export interface ProgressionCounterEvaluation {
  source: 'account' | 'tasks' | 'unresolved';
  value?: number;
  reason: string;
  completedTaskIds?: string[];
  incompleteTaskIds?: string[];
  unknownTaskIds?: string[];
}

export interface TaskProgressionEvaluation extends TaskUnlockEvaluation {
  /** Recorded lifecycle state, independent of calculated start eligibility. */
  recordedStatus?: string;
  counters: Record<string, ProgressionCounterEvaluation>;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Read only JSON-like own properties, never an inherited counter/status. */
function own(value: unknown, key: string): unknown {
  return record(value) && Object.hasOwn(value, key) ? value[key] : undefined;
}

function unresolved(reason: string): ProgressionCounterEvaluation {
  return { source: 'unresolved', reason };
}

/** Validate externally supplied registry entries even when schema validation was skipped. */
function contributorIds(definition: unknown, revision: unknown): string[] | undefined {
  if (
    !record(definition) ||
    !nonEmpty(revision) ||
    own(definition, 'revision') !== revision ||
    own(definition, 'verification') !== 'verified' ||
    own(definition, 'coverage') !== 'complete'
  )
    return undefined;
  if (
    Object.keys(definition).some(
      (key) => !['revision', 'verification', 'coverage', 'derivation', 'proof'].includes(key)
    )
  )
    return undefined;
  const derivation = own(definition, 'derivation');
  if (
    !record(derivation) ||
    own(derivation, 'type') !== 'distinctTaskCompletions' ||
    Object.keys(derivation).some((key) => !['type', 'taskIds'].includes(key))
  )
    return undefined;
  const ids = own(derivation, 'taskIds');
  const proof = own(definition, 'proof');
  if (
    !Array.isArray(ids) ||
    ids.length === 0 ||
    !Array.from(ids).every(nonEmpty) ||
    new Set(ids).size !== ids.length ||
    !Array.isArray(proof) ||
    proof.length === 0 ||
    !Array.from(proof).every((link) => nonEmpty(link) && /^https?:\/\/\S+$/.test(link)) ||
    new Set(proof).size !== proof.length
  )
    return undefined;
  return ids;
}

/** A mixed status list expresses uncertainty, not an additional completion. */
function completionState(value: unknown): 'complete' | 'incomplete' | 'unknown' {
  const statuses = Array.isArray(value) ? Array.from(value) : [value];
  const normalized = statuses.map(normalizeTaskStatus);
  if (!normalized.length || normalized.some((status) => status === undefined)) return 'unknown';
  if (normalized.every((status) => status === 'complete')) return 'complete';
  if (normalized.every((status) => status !== 'complete')) return 'incomplete';
  return 'unknown';
}

/** Count once per verified contributor; missing task history is never implicitly zero. */
function resolveCounter(
  variableId: string,
  state: TaskUnlockState,
  options: TaskProgressionOptions
): ProgressionCounterEvaluation {
  const globalVariables = own(state, 'globalVariables');
  if (record(globalVariables) && Object.hasOwn(globalVariables, variableId)) {
    const account = globalVariables[variableId];
    return typeof account === 'number' && Number.isFinite(account)
      ? { source: 'account', value: account, reason: 'explicit resolved account value' }
      : unresolved('account value is invalid');
  }
  const mode = own(options, 'mode');
  if (!nonEmpty(mode) || !SUPPORTED_GAME_MODES.includes(mode as GameMode))
    return unresolved('game mode is invalid');
  const ids = contributorIds(
    own(own(own(options, 'counters'), mode), variableId),
    own(options, 'revision')
  );
  if (!ids) return unresolved('no complete verified mapping for this mode and revision');
  const taskStatuses = own(state, 'taskStatuses');
  const completedTaskIds: string[] = [];
  const incompleteTaskIds: string[] = [];
  const unknownTaskIds: string[] = [];
  for (const id of ids) {
    const status = completionState(own(taskStatuses, id));
    if (status === 'complete') completedTaskIds.push(id);
    else if (status === 'incomplete') incompleteTaskIds.push(id);
    else unknownTaskIds.push(id);
  }
  const progress = { completedTaskIds, incompleteTaskIds, unknownTaskIds };
  return unknownTaskIds.length
    ? { ...unresolved('contributor task history is missing or ambiguous'), ...progress }
    : {
        source: 'tasks',
        value: completedTaskIds.length,
        reason: 'verified distinct task completions',
        ...progress,
      };
}

/**
 * Evaluate start eligibility without changing recorded progress or backfilling history.
 * The caller supplies one account/mode/run snapshot and already-merged TaskData.
 */
export function evaluateTaskProgression(
  task: TaskData,
  state: TaskUnlockState,
  options: TaskProgressionOptions
): TaskProgressionEvaluation {
  const safeState = record(state) ? state : {};
  const safeOptions = (record(options) ? options : {}) as unknown as TaskProgressionOptions;
  const safeTask = (record(task) ? task : {}) as unknown as TaskData;
  const definition = deriveTaskUnlockDefinition(safeTask, safeOptions);
  const counters: Record<string, ProgressionCounterEvaluation> = Object.create(null);
  const globalVariables: Record<string, number> = Object.create(null);
  for (const condition of definition.all) {
    if (condition.type !== 'globalVariable' || Object.hasOwn(counters, condition.variableId))
      continue;
    const counter = resolveCounter(condition.variableId, safeState, safeOptions);
    counters[condition.variableId] = counter;
    if (counter.value !== undefined) globalVariables[condition.variableId] = counter.value;
  }
  const result = evaluateTaskUnlock(
    safeTask,
    definition,
    { ...safeState, globalVariables },
    own(safeOptions, 'evaluation') as TaskUnlockEvaluationOptions | undefined
  );
  const taskId = own(safeTask, 'id');
  return {
    ...result,
    recordedStatus: nonEmpty(taskId)
      ? normalizeTaskStatus(own(own(safeState, 'taskStatuses'), taskId))
      : undefined,
    counters,
  };
}
