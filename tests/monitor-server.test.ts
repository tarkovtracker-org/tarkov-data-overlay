/**
 * Tests for monitor/server.js
 *
 * Every test in this file imports the real module via createRequire and
 * exercises the real exported functions / the real http.Server instance.
 * No test doubles, no local re-implementations.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'module';

// NODE_ENV must be "test" *before* require() so the module:
//   1. skips startOverlayWatcher / startApiPolling / startServer
//   2. populates module.exports
process.env.NODE_ENV = 'test';

const require = createRequire(import.meta.url);
const mod = require('../monitor/server.js');

// ---------------------------------------------------------------------------
// Sanity: prove the import is the real module, not a stub
// ---------------------------------------------------------------------------

describe('module import sanity', () => {
  it('exports real functions, not undefined', () => {
    expect(typeof mod.buildTasksSections).toBe('function');
    expect(typeof mod.buildSummary).toBe('function');
    expect(typeof mod.buildOverrideSections).toBe('function');
    expect(typeof mod.buildEditionsSections).toBe('function');
    expect(typeof mod.buildStoryChapterSections).toBe('function');
    expect(typeof mod.buildTaskAdditionSections).toBe('function');
    expect(typeof mod.mergeTaskOverrides).toBe('function');
    expect(typeof mod.rebuildSummaries).toBe('function');
    expect(typeof mod.valuesEqual).toBe('function');
    expect(typeof mod.formatValue).toBe('function');
    expect(typeof mod.normalizeView).toBe('function');
    expect(typeof mod.normalizeMode).toBe('function');
    expect(typeof mod.createSection).toBe('function');
    expect(typeof mod.pushRow).toBe('function');
  });

  it('exports the real http.Server instance', () => {
    expect(mod.server.constructor.name).toBe('Server');
    expect(typeof mod.server.listen).toBe('function');
  });

  it('exports mutable overlayState / apiState singletons', () => {
    expect(mod.overlayState).toHaveProperty('data');
    expect(mod.overlayState).toHaveProperty('updatedAt');
    expect(mod.apiState).toHaveProperty('regular');
    expect(mod.apiState).toHaveProperty('pve');
  });
});

// ---------------------------------------------------------------------------
// Destructure for convenience (all references point to the real module)
// ---------------------------------------------------------------------------

const {
  MAX_ROWS,
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
} = mod;

// ---------------------------------------------------------------------------
// buildTasksSections
// ---------------------------------------------------------------------------

describe('buildTasksSections', () => {
  it('returns 4 sections: diff, added-objectives, missing, disabled', () => {
    const sections = buildTasksSections({}, [], 'regular');
    expect(sections).toHaveLength(4);
    expect(sections.map((s: any) => s.title)).toEqual([
      'Task Overrides vs API',
      'Added Objectives',
      'Tasks Missing From API',
      'Disabled Tasks',
    ]);
  });

  it('produces an "override" row when the value differs from the API', () => {
    const sections = buildTasksSections(
      { t1: { minPlayerLevel: 45 } },
      [{ id: 't1', name: 'T', minPlayerLevel: 10, objectives: [] }],
      'regular',
    );
    const row = sections[0].rows.find((r: string[]) => r[1] === 'minPlayerLevel');
    expect(row).toBeDefined();
    expect(row[2]).toBe('10');
    expect(row[3]).toBe('45');
    expect(row[4]).toBe('override');
  });

  it('produces a "same" row when values match', () => {
    const sections = buildTasksSections(
      { t1: { minPlayerLevel: 10 } },
      [{ id: 't1', name: 'T', minPlayerLevel: 10, objectives: [] }],
      'regular',
    );
    const row = sections[0].rows.find((r: string[]) => r[1] === 'minPlayerLevel');
    expect(row).toBeDefined();
    expect(row[4]).toBe('same');
  });

  it('routes unknown task IDs to the missing section', () => {
    const [, , missing] = buildTasksSections(
      { ghost: { name: 'Ghost' } },
      [],
      'regular',
    );
    expect(missing.rows).toHaveLength(1);
    expect(missing.rows[0]).toEqual(['Ghost', 'ghost']);
  });

  it('routes disabled tasks to the disabled section', () => {
    const [, , , disabled] = buildTasksSections(
      { t1: { disabled: true } },
      [{ id: 't1', name: 'D', objectives: [] }],
      'regular',
    );
    expect(disabled.rows).toHaveLength(1);
    expect(disabled.rows[0][0]).toBe('D');
  });

  it('routes objectivesAdd to the added-objectives section', () => {
    const [, added] = buildTasksSections(
      { t1: { objectivesAdd: [{ id: 'o', description: 'Plant' }] } },
      [{ id: 't1', name: 'T', objectives: [] }],
      'regular',
    );
    expect(added.rows).toHaveLength(1);
    expect(added.rows[0][0]).toBe('T');
    expect(added.rows[0][1]).toBe('Plant');
  });

  it('diffs individual objective field overrides', () => {
    const [diff] = buildTasksSections(
      { t1: { objectives: { o1: { description: 'Fixed' } } } },
      [{ id: 't1', name: 'T', objectives: [{ id: 'o1', description: 'Orig' }] }],
      'regular',
    );
    const row = diff.rows.find((r: string[]) => r[1] === 'objective:o1.description');
    expect(row).toBeDefined();
    expect(row[2]).toBe('Orig');
    expect(row[3]).toBe('Fixed');
    expect(row[4]).toBe('override');
  });

  it('marks objectives missing from the API', () => {
    const [diff] = buildTasksSections(
      { t1: { objectives: { gone: { description: 'x' } } } },
      [{ id: 't1', name: 'T', objectives: [] }],
      'regular',
    );
    const row = diff.rows.find((r: string[]) => r[1] === 'objective:gone');
    expect(row).toBeDefined();
    expect(row[4]).toBe('missing');
  });

  it('skips null/non-object overrides', () => {
    const sections = buildTasksSections({ t1: null }, [], 'regular');
    const total = sections.reduce((n: number, s: any) => n + s.rows.length, 0);
    expect(total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// buildSummary — depends on overlayState / apiState singletons
// ---------------------------------------------------------------------------

describe('buildSummary', () => {
  // Seed state that all tests in this block share
  beforeAll(() => {
    overlayState.data = {
      tasks: { t1: { minPlayerLevel: 45 } },
      items: { i1: { name: 'Item' } },
      hideout: {},
      traders: {},
      editions: { std: { id: 'std', title: 'Std' } },
      storyChapters: { ch1: { id: 'ch1', name: 'Ch1' } },
      itemsAdd: {},
      tasksAdd: { ct: { id: 'ct', name: 'Custom' } },
      modes: {
        regular: { tasks: {}, tasksAdd: {} },
        pve: { tasks: {}, tasksAdd: {} },
      },
    };
    overlayState.updatedAt = new Date().toISOString();
    overlayState.error = null;

    apiState.regular.data = [
      { id: 't1', name: 'T', minPlayerLevel: 10, objectives: [] },
    ];
    apiState.regular.updatedAt = new Date().toISOString();
    apiState.regular.error = null;
    apiState.pve.data = [];
    apiState.pve.updatedAt = new Date().toISOString();
    apiState.pve.error = null;
  });

  it('returns an error when overlay is not loaded', () => {
    const saved = overlayState.data;
    try {
      overlayState.data = null;
      const s = buildSummary('tasks', 'regular');
      expect(s.sections).toEqual([]);
      expect(s.error).toMatch(/not loaded/i);
    } finally {
      overlayState.data = saved;
    }
  });

  it('returns 4 task sections for the "tasks" view', () => {
    const s = buildSummary('tasks', 'regular');
    expect(s.sections).toHaveLength(4);
    expect(s.error).toBeNull();
  });

  it('returns 1 section for "items"', () => {
    const s = buildSummary('items', '');
    expect(s.sections).toHaveLength(1);
    expect(s.sections[0].title).toContain('Items');
  });

  it('returns 1 section for "tasksAdd"', () => {
    const s = buildSummary('tasksAdd', 'regular');
    expect(s.sections).toHaveLength(1);
    expect(s.sections[0].title).toContain('Task Additions');
  });

  it('returns 1 section for "editions"', () => {
    const s = buildSummary('editions', '');
    expect(s.sections).toHaveLength(1);
    expect(s.sections[0].title).toBe('Editions');
  });

  it('returns 1 section for "storyChapters"', () => {
    const s = buildSummary('storyChapters', '');
    expect(s.sections).toHaveLength(1);
    expect(s.sections[0].title).toBe('Story Chapters');
  });

  it('returns error string for unknown view', () => {
    expect(buildSummary('nope', '').error).toBe('Unknown view');
  });
});

// ---------------------------------------------------------------------------
// Other section builders
// ---------------------------------------------------------------------------

describe('buildOverrideSections', () => {
  it('emits one row per entity field', () => {
    const [sec] = buildOverrideSections('Items', {
      i1: { name: 'A', price: 100 },
    });
    expect(sec.rows).toHaveLength(2);
  });

  it('handles empty entity objects', () => {
    const [sec] = buildOverrideSections('X', { e: {} });
    expect(sec.rows[0][1]).toBe('(empty)');
  });
});

describe('buildEditionsSections', () => {
  it('renders edition metadata', () => {
    const [sec] = buildEditionsSections({
      std: { id: 'std', title: 'Standard', defaultStashLevel: 1, traderRepBonus: { p: 0.2 } },
    });
    expect(sec.rows[0][0]).toBe('Standard');
    expect(sec.rows[0][2]).toBe(1);
    expect(sec.rows[0][3]).toBe('1 traders');
  });
});

describe('buildStoryChapterSections', () => {
  it('renders chapter metadata', () => {
    const [sec] = buildStoryChapterSections({
      ch: { id: 'ch', name: 'Ch', order: 1, objectives: [{ id: 'o' }] },
    });
    expect(sec.rows[0][0]).toBe('Ch');
    expect(sec.rows[0][3]).toBe(1);
  });
});

describe('buildTaskAdditionSections', () => {
  it('renders additions with trader and map', () => {
    const [sec] = buildTaskAdditionSections(
      { ct: { id: 'ct', name: 'CT', trader: { name: 'Prapor' }, map: { name: 'Customs' } } },
      'regular',
    );
    expect(sec.rows[0][0]).toBe('CT');
    expect(sec.rows[0][2]).toBe('Prapor');
    expect(sec.rows[0][3]).toBe('Customs');
  });
});

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

describe('normalizeView', () => {
  it('passes through known views', () => {
    for (const v of Object.keys(VIEW_CONFIG)) {
      expect(normalizeView(v)).toBe(v);
    }
  });
  it('defaults to "tasks"', () => {
    expect(normalizeView('nope')).toBe('tasks');
    expect(normalizeView(null)).toBe('tasks');
    expect(normalizeView(undefined)).toBe('tasks');
  });
});

describe('normalizeMode', () => {
  it('passes through regular / pve', () => {
    expect(normalizeMode('regular')).toBe('regular');
    expect(normalizeMode('pve')).toBe('pve');
  });
  it('defaults to "regular"', () => {
    expect(normalizeMode('x')).toBe('regular');
    expect(normalizeMode(null)).toBe('regular');
  });
});

describe('formatValue', () => {
  it('returns strings unchanged', () => expect(formatValue('hi')).toBe('hi'));
  it('renders null/undefined', () => {
    expect(formatValue(null)).toBe('null');
    expect(formatValue(undefined)).toBe('undefined');
  });
  it('serialises objects', () => expect(formatValue({ a: 1 })).toBe('{"a":1}'));
  it('truncates with ellipsis', () => {
    const r = formatValue({ a: 'x'.repeat(300) });
    expect(r.length).toBeLessThanOrEqual(221);
    expect(r.endsWith('…')).toBe(true);
  });
});

describe('valuesEqual', () => {
  it('normalises object key order', () =>
    expect(valuesEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true));
  it('preserves array order', () => {
    expect(valuesEqual([1, 2], [1, 2])).toBe(true);
    expect(valuesEqual([1, 2], [2, 1])).toBe(false);
  });
  it('undefined === undefined', () => expect(valuesEqual(undefined, undefined)).toBe(true));
  it('undefined !== null', () => expect(valuesEqual(undefined, null)).toBe(false));
});

describe('mergeTaskOverrides', () => {
  it('mode-specific wins', () => {
    const m = mergeTaskOverrides({ t: { a: 1 } }, { t: { a: 2 } });
    expect(m.t.a).toBe(2);
  });
  it('merges objectives maps', () => {
    const m = mergeTaskOverrides(
      { t: { objectives: { o1: { x: 1 } } } },
      { t: { objectives: { o2: { y: 2 } } } },
    );
    expect(m.t.objectives).toHaveProperty('o1');
    expect(m.t.objectives).toHaveProperty('o2');
  });
  it('concatenates objectivesAdd', () => {
    const m = mergeTaskOverrides(
      { t: { objectivesAdd: [{ id: 'a' }] } },
      { t: { objectivesAdd: [{ id: 'b' }] } },
    );
    expect(m.t.objectivesAdd).toHaveLength(2);
  });
  it('preserves unmerged tasks', () => {
    const m = mergeTaskOverrides({ a: { x: 1 }, b: { y: 2 } }, { a: { x: 3 } });
    expect(m.b.y).toBe(2);
  });
});

describe('createSection / pushRow', () => {
  it('creates an empty section', () => {
    const s = createSection('S', ['A']);
    expect(s).toEqual({ title: 'S', columns: ['A'], rows: [], truncated: false });
  });
  it('truncates at MAX_ROWS', () => {
    const s = createSection('S', ['A']);
    for (let i = 0; i <= MAX_ROWS; i++) pushRow(s, [`v${i}`]);
    expect(s.rows).toHaveLength(MAX_ROWS);
    expect(s.truncated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// HTTP integration — starts the REAL server from monitor/server.js
// ---------------------------------------------------------------------------

describe('HTTP — real monitor/server.js handlers', () => {
  let baseUrl: string;

  beforeAll(() => {
    // Seed singleton state
    overlayState.data = {
      tasks: { t1: { minPlayerLevel: 45 } },
      items: { i1: { name: 'Item' } },
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
      { id: 't1', name: 'T', minPlayerLevel: 10, objectives: [] },
    ];
    apiState.regular.updatedAt = new Date().toISOString();
    apiState.regular.error = null;
    apiState.pve.data = [];
    apiState.pve.updatedAt = new Date().toISOString();
    apiState.pve.error = null;

    // Fill the summaryByKey cache (same as refreshOverlay → rebuildSummaries)
    rebuildSummaries();

    return new Promise<void>((resolve, reject) => {
      server.listen(0, () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('Unable to determine monitor server address'));
          return;
        }
        baseUrl = `http://localhost:${address.port}`;
        resolve();
      });
    });
  });

  afterAll(() => {
    overlayState.data = null;
    overlayState.updatedAt = null;
    overlayState.error = null;
    apiState.regular.data = null;
    apiState.regular.updatedAt = null;
    apiState.regular.error = null;
    apiState.pve.data = null;
    apiState.pve.updatedAt = null;
    apiState.pve.error = null;
    return new Promise<void>((resolve) => server.close(resolve));
  });

  // -- /latest ---------------------------------------------------------------

  it('GET /latest — 200, application/json', async () => {
    const res = await fetch(`${baseUrl}/latest?view=tasks&mode=regular`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('GET /latest — response shape includes overlay, api, sections', async () => {
    const data = await (await fetch(`${baseUrl}/latest?view=tasks&mode=regular`)).json();
    expect(data.view).toBe('tasks');
    expect(data.mode).toBe('regular');
    expect(data.title).toBe('Task Overrides');
    expect(data).toHaveProperty('overlay');
    expect(data).toHaveProperty('api');
    expect(data.sections).toHaveLength(4);
  });

  it('GET /latest — sections contain the seeded override diff', async () => {
    const data = await (await fetch(`${baseUrl}/latest?view=tasks&mode=regular`)).json();
    const row = data.sections[0].rows.find((r: string[]) => r[1] === 'minPlayerLevel');
    expect(row).toBeDefined();
    expect(row[2]).toBe('10');       // API
    expect(row[3]).toBe('45');       // overlay
    expect(row[4]).toBe('override');
  });

  it('GET /latest — respects view=items', async () => {
    const data = await (await fetch(`${baseUrl}/latest?view=items`)).json();
    expect(data.view).toBe('items');
    expect(data.mode).toBeNull();
    expect(data.sections[0].title).toContain('Items');
  });

  it('GET /latest — defaults unknown view to tasks', async () => {
    const data = await (await fetch(`${baseUrl}/latest?view=xxx`)).json();
    expect(data.view).toBe('tasks');
  });

  it('GET /latest — respects mode=pve', async () => {
    const data = await (await fetch(`${baseUrl}/latest?view=tasks&mode=pve`)).json();
    expect(data.mode).toBe('pve');
  });

  // -- /events ---------------------------------------------------------------

  it('GET /events — SSE headers', async () => {
    const res = await fetch(`${baseUrl}/events?view=tasks&mode=regular`);
    const reader = res.body!.getReader();
    try {
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('connection')).toContain('keep-alive');
    } finally {
      await reader.cancel();
    }
  });

  it('GET /events — first frame is a parseable summary with sections', async () => {
    const res = await fetch(`${baseUrl}/events?view=tasks&mode=regular`);
    const reader = res.body!.getReader();
    try {
      const { value } = await reader.read();
      const text = new TextDecoder().decode(value);

      expect(text).toContain('event: summary');

      const dataLine = text.split('\n').find((l: string) => l.startsWith('data: '));
      expect(dataLine).toBeDefined();

      const payload = JSON.parse(dataLine!.slice(6));
      expect(payload.view).toBe('tasks');
      expect(payload.mode).toBe('regular');
      expect(payload.sections).toHaveLength(4);
    } finally {
      await reader.cancel();
    }
  });

  it('GET /events — non-mode view (items)', async () => {
    const res = await fetch(`${baseUrl}/events?view=items`);
    const reader = res.body!.getReader();
    try {
      const { value } = await reader.read();
      const text = new TextDecoder().decode(value);
      expect(text).toContain('"view":"items"');
    } finally {
      await reader.cancel();
    }
  });

  // -- error paths -----------------------------------------------------------

  it('POST /latest — 405', async () => {
    const res = await fetch(`${baseUrl}/latest`, { method: 'POST' });
    expect(res.status).toBe(405);
  });
});
