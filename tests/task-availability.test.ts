import { describe, expect, it } from 'vitest';
import type { OverlayOutput, TaskAddition } from '../src/lib/index.js';
import { getTaskAddition as getReportTaskAddition } from '../scripts/task-availability.js';

const sharedAddition = {
  id: 'task-id',
  name: 'Shared task',
  wikiLink: 'https://example.com/shared-task',
  trader: { name: 'Prapor' },
  objectives: [],
} satisfies TaskAddition;

const modeAddition = {
  ...sharedAddition,
  name: 'PvE task',
  disabled: true,
} satisfies TaskAddition;

const overlay = {
  tasksAdd: { [sharedAddition.id]: sharedAddition },
  modes: {
    pve: { tasksAdd: { [modeAddition.id]: modeAddition } },
  },
} as unknown as OverlayOutput;

describe('task availability report helpers', () => {
  it('prefers the mode-specific addition when resolving report metadata', () => {
    expect(getReportTaskAddition(overlay, 'pve', sharedAddition.id)).toBe(modeAddition);
    expect(getReportTaskAddition(overlay, 'regular', sharedAddition.id)).toBe(sharedAddition);
  });
});
