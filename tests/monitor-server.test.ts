/**
 * Tests for monitor server module
 * Tests the actual builder functions and endpoint behavior from monitor/server.js
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// Set test environment before importing server — this prevents auto-start
// of the HTTP server, overlay watcher, and API polling.
process.env.NODE_ENV = 'test';

// Mock fs to prevent actual file operations triggered at import time
vi.mock('fs', () => ({
  promises: {
    readFile: vi.fn(),
    stat: vi.fn(),
  },
  watchFile: vi.fn(),
  existsSync: vi.fn(() => false),
  readdirSync: vi.fn(() => []),
  statSync: vi.fn(() => ({ isDirectory: () => false })),
  readFile: vi.fn(),
}));

// Import the real server module (CommonJS)
const serverModule = require('../monitor/server.js');

const {
  buildTasksSections,
  buildSummary,
  buildOverrideSections,
  buildEditionsSections,
  buildStoryChapterSections,
  buildTaskAdditionSections,
  mergeTaskOverrides,
  rebuildSummaries,
  valuesEqual,
  formatValue,
  normalizeView,
  normalizeMode,
  createSection,
  pushRow,
  overlayState,
  apiState,
  server,
  VIEW_CONFIG,
} = serverModule;

// ---------------------------------------------------------------------------
// Builder function tests — exercise the real functions from server.js
// ---------------------------------------------------------------------------

describe('buildTasksSections', () => {
  it('returns the four expected sections', () => {
    const sections = buildTasksSections({}, [], 'regular');

    expect(sections).toHaveLength(4);
    expect(sections[0].title).toBe('Task Overrides vs API');
    expect(sections[1].title).toBe('Added Objectives');
    expect(sections[2].title).toBe('Tasks Missing From API');
    expect(sections[3].title).toBe('Disabled Tasks');
  });

  it('detects field overrides and marks them as "override"', () => {
    const overrides = {
      't1': { minPlayerLevel: 45 },
    };
    const apiTasks = [
      { id: 't1', name: 'Task', minPlayerLevel: 10, objectives: [] },
    ];

    const [diff] = buildTasksSections(overrides, apiTasks, 'regular');
    const row = diff.rows.find((r: string[]) => r[1] === 'minPlayerLevel');

    expect(row).toBeDefined();
    expect(row[2]).toBe('10');       // API value
    expect(row[3]).toBe('45');       // overlay value
    expect(row[4]).toBe('override'); // status
  });

  it('marks matching values as "same"', () => {
    const overrides = {
      't1': { minPlayerLevel: 10 },
    };
    const apiTasks = [
      { id: 't1', name: 'Task', minPlayerLevel: 10, objectives: [] },
    ];

    const [diff] = buildTasksSections(overrides, apiTasks, 'regular');
    const row = diff.rows.find((r: string[]) => r[1] === 'minPlayerLevel');

    expect(row).toBeDefined();
    expect(row[4]).toBe('same');
  });

  it('puts unknown task IDs into the missing section', () => {
    const overrides = {
      'no-such-task': { name: 'Ghost' },
    };

    const [, , missing] = buildTasksSections(overrides, [], 'regular');

    expect(missing.rows).toHaveLength(1);
    expect(missing.rows[0][0]).toBe('Ghost');
    expect(missing.rows[0][1]).toBe('no-such-task');
  });

  it('puts disabled tasks into the disabled section', () => {
    const overrides = {
      't1': { disabled: true },
    };
    const apiTasks = [
      { id: 't1', name: 'Disabled One', objectives: [] },
    ];

    const [, , , disabled] = buildTasksSections(overrides, apiTasks, 'regular');

    expect(disabled.rows).toHaveLength(1);
    expect(disabled.rows[0][0]).toBe('Disabled One');
  });

  it('adds objectivesAdd entries to the added-objectives section', () => {
    const overrides = {
      't1': {
        objectivesAdd: [
          { id: 'obj-new', description: 'Plant marker' },
        ],
      },
    };
    const apiTasks = [
      { id: 't1', name: 'Task', objectives: [] },
    ];

    const [, added] = buildTasksSections(overrides, apiTasks, 'regular');

    expect(added.rows).toHaveLength(1);
    expect(added.rows[0][0]).toBe('Task');
    expect(added.rows[0][1]).toBe('Plant marker');
  });

  it('diffs individual objective field overrides', () => {
    const overrides = {
      't1': {
        objectives: {
          'obj-1': { description: 'Corrected' },
        },
      },
    };
    const apiTasks = [
      {
        id: 't1',
        name: 'Task',
        objectives: [{ id: 'obj-1', description: 'Original' }],
      },
    ];

    const [diff] = buildTasksSections(overrides, apiTasks, 'regular');
    const row = diff.rows.find((r: string[]) =>
      r[1] === 'objective:obj-1.description',
    );

    expect(row).toBeDefined();
    expect(row[2]).toBe('Original');
    expect(row[3]).toBe('Corrected');
    expect(row[4]).toBe('override');
  });

  it('marks objective ID as missing when API task has no matching objective', () => {
    const overrides = {
      't1': {
        objectives: {
          'obj-gone': { description: 'Does not exist' },
        },
      },
    };
    const apiTasks = [
      { id: 't1', name: 'Task', objectives: [] },
    ];

    const [diff] = buildTasksSections(overrides, apiTasks, 'regular');
    const row = diff.rows.find((r: string[]) =>
      r[1] === 'objective:obj-gone',
    );

    expect(row).toBeDefined();
    expect(row[2]).toBe('missing');
    expect(row[4]).toBe('missing');
  });

  it('skips null overrides', () => {
    const overrides = {
      't1': null,
    };

    const sections = buildTasksSections(overrides, [], 'regular');
    const totalRows = sections.reduce(
      (n: number, s: any) => n + s.rows.length,
      0,
    );

    expect(totalRows).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// buildSummary — relies on overlayState / apiState singletons
// ---------------------------------------------------------------------------

describe('buildSummary', () => {
  const savedOverlay = { ...overlayState };
  const savedApi = {
    regular: { ...apiState.regular },
    pve: { ...apiState.pve },
  };

  beforeAll(() => {
    overlayState.data = {
      tasks: { 't1': { minPlayerLevel: 45 } },
      items: { 'i1': { name: 'Item' } },
      hideout: {},
      traders: {},
      editions: {},
      storyChapters: {},
      itemsAdd: {},
      tasksAdd: {},
      modes: {
        regular: { tasks: {}, tasksAdd: {} },
        pve: { tasks: {}, tasksAdd: {} },
      },
    };
    overlayState.updatedAt = new Date().toISOString();
    overlayState.error = null;

    apiState.regular.data = [];
    apiState.regular.updatedAt = new Date().toISOString();
    apiState.regular.error = null;
    apiState.pve.data = [];
    apiState.pve.updatedAt = new Date().toISOString();
    apiState.pve.error = null;
  });

  afterAll(() => {
    Object.assign(overlayState, savedOverlay);
    Object.assign(apiState.regular, savedApi.regular);
    Object.assign(apiState.pve, savedApi.pve);
  });

  it('returns error when overlay is not loaded', () => {
    const orig = overlayState.data;
    overlayState.data = null;

    const summary = buildSummary('tasks', 'regular');

    expect(summary.sections).toEqual([]);
    expect(summary.error).toContain('not loaded');

    overlayState.data = orig;
  });

  it('builds task summary with 4 sections', () => {
    const summary = buildSummary('tasks', 'regular');

    expect(summary.sections).toHaveLength(4);
    expect(summary.error).toBeNull();
  });

  it('builds items summary', () => {
    const summary = buildSummary('items', '');

    expect(summary.sections).toHaveLength(1);
    expect(summary.sections[0].title).toContain('Items');
  });

  it('returns error for unknown view', () => {
    const summary = buildSummary('does-not-exist', '');

    expect(summary.error).toBe('Unknown view');
  });

  it('builds tasksAdd summary', () => {
    const summary = buildSummary('tasksAdd', 'regular');

    expect(summary.sections).toHaveLength(1);
    expect(summary.sections[0].title).toContain('Task Additions');
  });

  it('builds editions summary', () => {
    const summary = buildSummary('editions', '');

    expect(summary.sections).toHaveLength(1);
    expect(summary.sections[0].title).toBe('Editions');
  });

  it('builds storyChapters summary', () => {
    const summary = buildSummary('storyChapters', '');

    expect(summary.sections).toHaveLength(1);
    expect(summary.sections[0].title).toBe('Story Chapters');
  });
});

// ---------------------------------------------------------------------------
// Other builder helpers
// ---------------------------------------------------------------------------

describe('buildOverrideSections', () => {
  it('lists every field for each entity', () => {
    const sections = buildOverrideSections('Items', {
      'i1': { name: 'A', price: 100 },
      'i2': { weight: 2 },
    });

    expect(sections).toHaveLength(1);
    expect(sections[0].rows).toHaveLength(3);
  });

  it('handles empty entities', () => {
    const sections = buildOverrideSections('Items', { 'i1': {} });

    expect(sections[0].rows).toHaveLength(1);
    expect(sections[0].rows[0][1]).toBe('(empty)');
  });
});

describe('buildEditionsSections', () => {
  it('renders edition metadata', () => {
    const sections = buildEditionsSections({
      std: {
        id: 'std',
        title: 'Standard Edition',
        defaultStashLevel: 1,
        traderRepBonus: { p: 0.2 },
      },
    });

    expect(sections[0].rows).toHaveLength(1);
    expect(sections[0].rows[0][0]).toBe('Standard Edition');
    expect(sections[0].rows[0][2]).toBe(1); // stash level
    expect(sections[0].rows[0][3]).toBe('1 traders'); // rep bonus
  });
});

describe('buildStoryChapterSections', () => {
  it('renders chapter metadata', () => {
    const sections = buildStoryChapterSections({
      ch1: {
        id: 'ch1',
        name: 'Chapter One',
        order: 1,
        objectives: [{ id: 'o1' }, { id: 'o2' }],
      },
    });

    expect(sections[0].rows).toHaveLength(1);
    expect(sections[0].rows[0][0]).toBe('Chapter One');
    expect(sections[0].rows[0][3]).toBe(2); // 2 objectives
  });
});

describe('buildTaskAdditionSections', () => {
  it('renders task additions with trader and map', () => {
    const sections = buildTaskAdditionSections(
      {
        ct: {
          id: 'ct',
          name: 'Custom Task',
          trader: { name: 'Prapor' },
          map: { name: 'Customs' },
          wikiLink: 'https://example.com',
        },
      },
      'regular',
    );

    expect(sections[0].rows).toHaveLength(1);
    expect(sections[0].rows[0][0]).toBe('Custom Task');
    expect(sections[0].rows[0][2]).toBe('Prapor');
    expect(sections[0].rows[0][3]).toBe('Customs');
  });
});

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

describe('normalizeView', () => {
  it('returns known views unchanged', () => {
    Object.keys(VIEW_CONFIG).forEach((v: string) => {
      expect(normalizeView(v)).toBe(v);
    });
  });

  it('defaults unknown values to "tasks"', () => {
    expect(normalizeView('garbage')).toBe('tasks');
    expect(normalizeView(null)).toBe('tasks');
    expect(normalizeView(undefined)).toBe('tasks');
  });
});

describe('normalizeMode', () => {
  it('returns regular and pve unchanged', () => {
    expect(normalizeMode('regular')).toBe('regular');
    expect(normalizeMode('pve')).toBe('pve');
  });

  it('defaults unknown values to "regular"', () => {
    expect(normalizeMode('hardcore')).toBe('regular');
    expect(normalizeMode(null)).toBe('regular');
  });
});

describe('formatValue', () => {
  it('returns strings unchanged', () => {
    expect(formatValue('hello')).toBe('hello');
  });

  it('renders null and undefined', () => {
    expect(formatValue(null)).toBe('null');
    expect(formatValue(undefined)).toBe('undefined');
  });

  it('serialises objects', () => {
    expect(formatValue({ a: 1 })).toBe('{"a":1}');
  });

  it('truncates long values with ellipsis', () => {
    const result = formatValue({ a: 'x'.repeat(300) });
    expect(result.length).toBeLessThanOrEqual(221);
    expect(result.endsWith('…')).toBe(true);
  });
});

describe('valuesEqual', () => {
  it('considers objects with reordered keys equal', () => {
    expect(valuesEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
  });

  it('preserves array order', () => {
    expect(valuesEqual([1, 2], [2, 1])).toBe(false);
    expect(valuesEqual([1, 2], [1, 2])).toBe(true);
  });

  it('handles undefined vs undefined', () => {
    expect(valuesEqual(undefined, undefined)).toBe(true);
  });

  it('handles undefined vs null', () => {
    expect(valuesEqual(undefined, null)).toBe(false);
  });
});

describe('mergeTaskOverrides', () => {
  it('mode-specific overrides win', () => {
    const merged = mergeTaskOverrides(
      { t1: { minPlayerLevel: 10 } },
      { t1: { minPlayerLevel: 20 } },
    );
    expect(merged.t1.minPlayerLevel).toBe(20);
  });

  it('merges objectives maps', () => {
    const merged = mergeTaskOverrides(
      { t1: { objectives: { o1: { x: 1 } } } },
      { t1: { objectives: { o2: { y: 2 } } } },
    );
    expect(merged.t1.objectives).toHaveProperty('o1');
    expect(merged.t1.objectives).toHaveProperty('o2');
  });

  it('concatenates objectivesAdd arrays', () => {
    const merged = mergeTaskOverrides(
      { t1: { objectivesAdd: [{ id: 'a' }] } },
      { t1: { objectivesAdd: [{ id: 'b' }] } },
    );
    expect(merged.t1.objectivesAdd).toHaveLength(2);
  });

  it('preserves tasks only in shared', () => {
    const merged = mergeTaskOverrides(
      { t1: { name: 'A' }, t2: { name: 'B' } },
      { t1: { name: 'C' } },
    );
    expect(merged.t2.name).toBe('B');
  });
});

describe('createSection / pushRow', () => {
  it('creates a section with empty rows', () => {
    const s = createSection('S', ['A', 'B']);
    expect(s.title).toBe('S');
    expect(s.columns).toEqual(['A', 'B']);
    expect(s.rows).toEqual([]);
    expect(s.truncated).toBe(false);
  });

  it('truncates at MAX_ROWS (250)', () => {
    const s = createSection('S', ['A']);
    for (let i = 0; i < 251; i++) {
      pushRow(s, [`v${i}`]);
    }
    expect(s.rows).toHaveLength(250);
    expect(s.truncated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// HTTP integration tests — hit the *real* http.createServer from server.js
// ---------------------------------------------------------------------------

describe('HTTP Integration — real server', () => {
  const TEST_PORT = 0; // let the OS pick a free port
  let baseUrl: string;

  beforeAll(() => {
    // Populate overlay/api state so endpoints return meaningful data
    overlayState.data = {
      tasks: { 't1': { minPlayerLevel: 45 } },
      items: { 'i1': { name: 'Item' } },
      hideout: {},
      traders: {},
      editions: {},
      storyChapters: {},
      itemsAdd: {},
      tasksAdd: {},
      modes: {
        regular: { tasks: {}, tasksAdd: {} },
        pve: { tasks: {}, tasksAdd: {} },
      },
    };
    overlayState.updatedAt = new Date().toISOString();
    overlayState.error = null;

    apiState.regular.data = [
      { id: 't1', name: 'Task', minPlayerLevel: 10, objectives: [] },
    ];
    apiState.regular.updatedAt = new Date().toISOString();
    apiState.regular.error = null;
    apiState.pve.data = [];
    apiState.pve.updatedAt = new Date().toISOString();
    apiState.pve.error = null;

    // Populate the summaryByKey cache so /latest and /events return real data
    rebuildSummaries();

    return new Promise<void>((resolve) => {
      server.listen(TEST_PORT, () => {
        const addr = server.address();
        baseUrl = `http://localhost:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(() => {
    return new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  // -- /latest ---------------------------------------------------------------

  it('GET /latest returns JSON with full state shape', async () => {
    const res = await fetch(`${baseUrl}/latest?view=tasks&mode=regular`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');

    const data = await res.json();
    expect(data.view).toBe('tasks');
    expect(data.mode).toBe('regular');
    expect(data.title).toBe('Task Overrides');
    expect(data).toHaveProperty('overlay');
    expect(data).toHaveProperty('api');
    expect(Array.isArray(data.sections)).toBe(true);
    expect(data.sections).toHaveLength(4);
  });

  it('GET /latest reflects overlay task overrides in sections', async () => {
    const res = await fetch(`${baseUrl}/latest?view=tasks&mode=regular`);
    const data = await res.json();

    const diff = data.sections[0];
    const row = diff.rows.find((r: string[]) => r[1] === 'minPlayerLevel');
    expect(row).toBeDefined();
    expect(row[4]).toBe('override');
  });

  it('GET /latest respects the view parameter', async () => {
    const res = await fetch(`${baseUrl}/latest?view=items`);
    const data = await res.json();

    expect(data.view).toBe('items');
    expect(data.mode).toBeNull(); // items is non-mode
    expect(data.sections[0].title).toContain('Items');
  });

  it('GET /latest respects the mode parameter', async () => {
    const res = await fetch(`${baseUrl}/latest?view=tasks&mode=pve`);
    const data = await res.json();

    expect(data.mode).toBe('pve');
  });

  it('GET /latest defaults unknown view to tasks', async () => {
    const res = await fetch(`${baseUrl}/latest?view=nope`);
    const data = await res.json();

    expect(data.view).toBe('tasks');
  });

  // -- /events ---------------------------------------------------------------

  it('GET /events returns SSE headers', async () => {
    const res = await fetch(`${baseUrl}/events?view=tasks&mode=regular`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('connection')).toContain('keep-alive');

    // read and discard so the connection closes cleanly
    const reader = res.body!.getReader();
    reader.cancel();
  });

  it('GET /events initial frame is a valid summary', async () => {
    const res = await fetch(`${baseUrl}/events?view=tasks&mode=regular`);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    const { value } = await reader.read();
    const text = decoder.decode(value);

    expect(text).toContain('event: summary');
    expect(text).toContain('data:');

    // Parse the JSON payload embedded after "data: "
    const dataLine = text
      .split('\n')
      .find((l: string) => l.startsWith('data: '));
    expect(dataLine).toBeDefined();
    const payload = JSON.parse(dataLine!.replace('data: ', ''));
    expect(payload.view).toBe('tasks');
    expect(payload.mode).toBe('regular');
    expect(Array.isArray(payload.sections)).toBe(true);

    reader.cancel();
  });

  it('GET /events works for non-mode views', async () => {
    const res = await fetch(`${baseUrl}/events?view=items`);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    const { value } = await reader.read();
    const text = decoder.decode(value);

    expect(text).toContain('"view":"items"');

    reader.cancel();
  });

  // -- error paths -----------------------------------------------------------

  it('returns 405 for POST requests', async () => {
    const res = await fetch(`${baseUrl}/latest`, { method: 'POST' });
    expect(res.status).toBe(405);
  });
});
