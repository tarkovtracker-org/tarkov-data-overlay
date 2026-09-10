import { describe, expect, it } from 'vitest';
import Ajv from 'ajv';
import { readFileSync } from 'node:fs';
import {
  evaluateTaskProgression,
  normalizeTaskStatus,
  type ProgressionCounterDefinition,
  type TaskProgressionOptions,
  type TaskData,
  type TaskUnlockState,
} from '../src/lib/index.js';

const mapping: ProgressionCounterDefinition = {
  revision: 'test-revision',
  verification: 'verified',
  coverage: 'complete',
  derivation: { type: 'distinctTaskCompletions', taskIds: ['a', 'b', 'c'] },
  proof: ['https://example.com/verified-rule'],
};
const options: TaskProgressionOptions = {
  mode: 'pve',
  revision: 'test-revision',
  counters: { pve: { pool: mapping } },
};
const task: TaskData = {
  id: 'target',
  name: 'Target',
  trader: { id: 'trader', name: 'Trader' },
  otherRequirements: [
    { id: 'gate', type: 'globalVariable', variableId: 'pool', compareMethod: '>=', value: 2 },
  ],
};
const state: TaskUnlockState = {
  traderUnlocked: { trader: true },
  taskStatuses: { a: 4, b: 'complete', c: 'active' },
};

describe('progress-based task eligibility', () => {
  it('recomputes verified distinct completions without mutating progress', () => {
    const before = structuredClone(state);
    expect(evaluateTaskProgression(task, state, options)).toMatchObject({
      status: 'available',
      counters: {
        pool: { source: 'tasks', value: 2, completedTaskIds: ['a', 'b'], incompleteTaskIds: ['c'] },
      },
    });
    const changed = { ...state, taskStatuses: { ...state.taskStatuses, b: 'active' } };
    expect(evaluateTaskProgression(task, changed, options)).toMatchObject({
      status: 'blocked',
      counters: { pool: { value: 1 } },
    });
    expect(state).toEqual(before);
  });

  it.each([
    { mode: 'regular' },
    { revision: 'another-patch' },
    { revision: undefined },
    { counters: {} },
  ])('does not borrow a mapping across scope: %j', (override) => {
    expect(
      evaluateTaskProgression(task, state, { ...options, ...override } as TaskProgressionOptions)
        .status
    ).toBe('unknown');
  });

  it.each([
    { verification: 'unresolved' },
    { coverage: 'partial' },
    { proof: [] },
    { proof: ['not a link'] },
    { proof: ['https://example.com/rule', 'https://example.com/rule'] },
    { derivation: { type: 'sum', taskIds: ['a'] } },
    { derivation: { type: 'distinctTaskCompletions', taskIds: ['a', 'a'] } },
    { derivation: { type: 'distinctTaskCompletions', taskIds: [] } },
    { derivation: { type: 'distinctTaskCompletions', taskIds: new Array(2) } },
    { unknownSemantics: true },
  ])('fails closed for an incomplete/untrusted rule: %j', (override) => {
    const counters = {
      pve: { pool: { ...mapping, ...override } },
    } as unknown as TaskProgressionOptions['counters'];
    expect(evaluateTaskProgression(task, state, { ...options, counters }).status).toBe('unknown');
  });

  it.each([undefined, 'unsupported', ['complete', 'active'], [], new Array(1)])(
    'does not infer zero for missing or ambiguous history: %j',
    (status) => {
      const incomplete = {
        ...state,
        taskStatuses: { a: 'complete', b: status, c: 'active' },
      } as TaskUnlockState;
      expect(evaluateTaskProgression(task, incomplete, options)).toMatchObject({
        status: 'unknown',
        counters: { pool: { source: 'unresolved', unknownTaskIds: ['b'] } },
      });
    }
  );

  it('counts synonymous completion statuses once and keeps definite non-completion at zero', () => {
    const supplied = {
      ...state,
      taskStatuses: { a: [4, 'completed'], b: ['active', 'locked'], c: 'failed' },
    };
    expect(evaluateTaskProgression(task, supplied, options).counters.pool.value).toBe(1);
  });

  it('prefers resolved account values without adding computed counts', () => {
    const result = evaluateTaskProgression(
      task,
      { ...state, globalVariables: { pool: 0 } },
      options
    );
    expect(result).toMatchObject({
      status: 'blocked',
      counters: { pool: { source: 'account', value: 0 } },
    });
    expect(
      evaluateTaskProgression(task, { ...state, globalVariables: { pool: 2 } }, { mode: 'pve' })
        .status
    ).toBe('available');
  });

  it.each([NaN, Infinity, null, '2', undefined])(
    'does not replace an invalid explicit value with an inferred one: %j',
    (value) => {
      const supplied = { ...state, globalVariables: { pool: value } } as unknown as TaskUnlockState;
      expect(evaluateTaskProgression(task, supplied, options).status).toBe('unknown');
    }
  );

  it('does not use profile children as a parent value or inherit status entries', () => {
    expect(
      evaluateTaskProgression(task, { ...state, globalVariables: { child: 2 } }, { mode: 'pve' })
        .status
    ).toBe('unknown');
    const taskStatuses = Object.create(state.taskStatuses!);
    expect(evaluateTaskProgression(task, { ...state, taskStatuses }, options).status).toBe(
      'unknown'
    );
  });

  it('does not derive a parent from an inherited mapping', () => {
    const counters = { pve: Object.create({ pool: mapping }) };
    expect(evaluateTaskProgression(task, state, { ...options, counters }).status).toBe('unknown');
  });

  it('does not accept prototype-supplied definition fields', () => {
    const inherited = { pve: { pool: Object.create(mapping) } };
    expect(evaluateTaskProgression(task, state, { ...options, counters: inherited }).status).toBe(
      'unknown'
    );
    const polluted: Record<string, unknown> = Object.assign(
      Object.create({ verification: 'verified' }),
      mapping
    );
    delete polluted.verification;
    const counters = { pve: { pool: polluted } } as unknown as TaskProgressionOptions['counters'];
    expect(evaluateTaskProgression(task, state, { ...options, counters }).status).toBe('unknown');
  });

  it('does not read state or registry containers from a polluted prototype', () => {
    const polluted = {
      globalVariables: { pool: 999 },
      counters: { pve: { pool: mapping } },
      revision: 'test-revision',
      taskStatuses: { a: 'complete', b: 'complete', c: 'complete' },
    };
    const proto = Object.prototype as unknown as Record<string, unknown>;
    try {
      Object.assign(proto, polluted);
      // Only `mode` is supplied; every container must come from own properties.
      const result = evaluateTaskProgression(task, { traderUnlocked: { trader: true } }, {
        mode: 'pve',
      } as TaskProgressionOptions);
      expect(result.status).toBe('unknown');
      expect(result.counters.pool).toMatchObject({ source: 'unresolved' });
      expect(result.counters.pool.value).toBeUndefined();
      expect(result.recordedStatus).toBeUndefined();
    } finally {
      Object.keys(polluted).forEach((key) => delete proto[key]);
    }
    expect(Object.keys(Object.prototype)).toHaveLength(0);
  });

  it('retains other account gates and recorded lifecycle status', () => {
    const supplied = {
      ...state,
      taskStatuses: { ...state.taskStatuses, target: 'active' },
      traderUnlocked: { trader: false },
    };
    expect(evaluateTaskProgression(task, supplied, options)).toMatchObject({
      status: 'blocked',
      recordedStatus: 'active',
    });
    expect(
      evaluateTaskProgression(task, { taskStatuses: state.taskStatuses }, options).status
    ).toBe('unknown');
  });

  it('preserves AND/OR requirements and never marks predecessors complete', () => {
    const gated: TaskData = {
      ...task,
      taskRequirements: [{ task: { id: 'pre', name: 'Previous' }, status: ['active', 'complete'] }],
    };
    const supplied = { ...state, taskStatuses: { ...state.taskStatuses, pre: 'active' } };
    expect(evaluateTaskProgression(gated, supplied, options).status).toBe('available');
    expect(supplied.taskStatuses.pre).toBe('active');
  });

  it('supports BSG equality without changing missing values to zero', () => {
    const equality: TaskData = {
      ...task,
      otherRequirements: [{ ...task.otherRequirements![0], compareMethod: '==', value: 0 }],
    };
    expect(evaluateTaskProgression(equality, state, { mode: 'pve' }).status).toBe('unknown');
    expect(
      evaluateTaskProgression(equality, { ...state, globalVariables: { pool: 0 } }, options).status
    ).toBe('available');
    expect(
      evaluateTaskProgression(equality, { ...state, globalVariables: { pool: 1 } }, options).status
    ).toBe('blocked');
  });
});

describe('lossless task lifecycle statuses', () => {
  const gated: TaskData = {
    ...task,
    otherRequirements: [],
    taskRequirements: [{ task: { id: 'pre', name: 'Previous' }, status: ['active'] }],
  };
  it.each([0, 1, 3, 4, 5, 6, 7, 8, 9, 'availableForStart', 'availableAfter'])(
    'does not treat %s as started',
    (status) => {
      expect(
        evaluateTaskProgression(gated, { ...state, taskStatuses: { pre: status } }, options).status
      ).toBe('blocked');
    }
  );
  it.each([2, 'active', 'started', 'accepted'])('accepts the started state %s', (status) => {
    expect(
      evaluateTaskProgression(gated, { ...state, taskStatuses: { pre: status } }, options).status
    ).toBe('available');
  });
  it('preserves every BSG code and accepts its string form', () => {
    const names = [
      'locked',
      'availableForStart',
      'active',
      'availableForFinish',
      'complete',
      'failed',
      'failedRestartable',
      'markedFailed',
      'expired',
      'availableAfter',
    ];
    names.forEach((name, code) => {
      expect(normalizeTaskStatus(code)).toBe(name);
      expect(normalizeTaskStatus(name)).toBe(name);
    });
  });
});

describe('published counter schema', () => {
  const schema = JSON.parse(
    readFileSync(new URL('../src/schemas/progression-counter.schema.json', import.meta.url), 'utf8')
  );
  const validate = new Ajv({ strict: true }).compile(schema);
  it('allows an empty registry and mode-scoped evidence', () => {
    expect(validate({})).toBe(true);
    expect(validate(options.counters)).toBe(true);
  });
  it.each([
    { pvp: { pool: mapping } },
    { pve: { pool: { ...mapping, coverage: 'maybe' } } },
    {
      pve: {
        pool: { ...mapping, derivation: { type: 'distinctTaskCompletions', taskIds: ['a', 'a'] } },
      },
    },
    { pve: { pool: { ...mapping, proof: ['not a link'] } } },
    { pve: { pool: { ...mapping, proof: ['https://example.com/r', 'https://example.com/r'] } } },
  ])('rejects malformed published definitions: %j', (registry) =>
    expect(validate(registry)).toBe(false)
  );
});
