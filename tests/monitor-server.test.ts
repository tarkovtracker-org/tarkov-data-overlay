/**
 * Tests for monitor/server.js
 *
 * Every test in this file imports the real module via createRequire and
 * exercises the real exported functions / the real http.Server instance.
 * No test doubles, no local re-implementations.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import path from 'node:path';
import vm from 'node:vm';
import { createServer as createHttpServer } from 'node:http';

// NODE_ENV must be "test" *before* importing the module so it:
//   1. skips startOverlayWatcher / startApiPolling / startServer
//   2. populates module.exports
process.env.NODE_ENV = 'test';

let mod: any;
let configModule: any;
const previousTargetOverlay = process.env.TARGET_OVERLAY;
const previousRemoteFetchTimeout = process.env.REMOTE_FETCH_TIMEOUT_MS;
try {
  process.env.TARGET_OVERLAY = path.resolve('dist/overlay.json');
  process.env.REMOTE_FETCH_TIMEOUT_MS = '100';
  // These CommonJS monitor modules intentionally have no declaration files.
  // @ts-expect-error Dynamic import of the JavaScript CommonJS server module.
  mod = (await import('../monitor/server.js')).default;
  // @ts-expect-error Dynamic import of the JavaScript CommonJS config module.
  configModule = (await import('../monitor/lib/config.js')).default;
} finally {
  if (previousTargetOverlay === undefined) {
    delete process.env.TARGET_OVERLAY;
  } else {
    process.env.TARGET_OVERLAY = previousTargetOverlay;
  }
  if (previousRemoteFetchTimeout === undefined) {
    delete process.env.REMOTE_FETCH_TIMEOUT_MS;
  } else {
    process.env.REMOTE_FETCH_TIMEOUT_MS = previousRemoteFetchTimeout;
  }
}

const { buildViewParams, readPositiveInteger, readPort, readTimerMilliseconds } = configModule;

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
    expect(typeof mod.buildPrestigeSections).toBe('function');
    expect(typeof mod.buildLocaleSections).toBe('function');
    expect(typeof mod.buildSeasonalPerkSections).toBe('function');
    expect(typeof mod.buildCraftAddSections).toBe('function');
    expect(typeof mod.mergeTaskOverrides).toBe('function');
    expect(typeof mod.rebuildSummaries).toBe('function');
    expect(typeof mod.valuesEqual).toBe('function');
    expect(typeof mod.formatValue).toBe('function');
    expect(typeof mod.normalizeView).toBe('function');
    expect(typeof mod.normalizeMode).toBe('function');
    expect(typeof mod.normalizeLocale).toBe('function');
    expect(typeof mod.getSummaryKey).toBe('function');
    expect(typeof mod.parseViewParams).toBe('function');
    expect(typeof mod.handleResponseFailure).toBe('function');
    expect(typeof mod.createSection).toBe('function');
    expect(typeof mod.pushRow).toBe('function');
    expect(typeof mod.isDefaultOverlayPath).toBe('function');
    expect(typeof mod.fetchRemoteText).toBe('function');
    expect(typeof mod.registerModes).toBe('function');
    expect(typeof mod.MAX_SSE_BUFFERED_BYTES).toBe('number');
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
    expect(mod.apiState).toHaveProperty('pvp-season');
  });
});

describe('mode discovery', () => {
  it('removes retired defaults and falls back to a discovered mode', () => {
    const originalModes = Object.keys(apiState);
    try {
      mod.registerModes(['pve']);
      expect(Object.keys(apiState)).toEqual(['pve']);
      expect(mod.normalizeMode('regular')).toBe('pve');
    } finally {
      mod.registerModes(originalModes);
    }
  });

  it('rejects an unexpectedly large discovered mode list', () => {
    const originalModes = Object.keys(apiState);
    try {
      mod.registerModes(
        Array.from({ length: mod.MAX_DISCOVERED_MODES + 1 }, (_, index) => `mode-${index}`)
      );
      expect(Object.keys(apiState)).toEqual(originalModes);
    } finally {
      mod.registerModes(originalModes);
    }
  });

  it('rejects discovered mode names that collide with object properties', () => {
    const originalModes = Object.keys(apiState);
    try {
      mod.registerModes(['constructor', 'prototype']);
      expect(Object.keys(apiState)).toEqual(originalModes);
    } finally {
      mod.registerModes(originalModes);
    }
  });
});

// ---------------------------------------------------------------------------
// Destructure for convenience (all references point to the real module)
// ---------------------------------------------------------------------------

const {
  MAX_ROWS,
  MAX_SSE_BUFFERED_BYTES,
  buildTasksSections,
  buildSummary,
  buildOverrideSections,
  buildEditionsSections,
  buildStoryChapterSections,
  buildTaskAdditionSections,
  buildPrestigeSections,
  buildLocaleSections,
  buildSeasonalPerkSections,
  buildCraftAddSections,
  mergeTaskAdditions,
  mergeTaskOverrides,
  rebuildSummaries,
  valuesEqual,
  formatValue,
  normalizeView,
  normalizeMode,
  normalizeLocale,
  getSummaryKey,
  parseViewParams,
  handleResponseFailure,
  getLatestTagVersion,
  isVersionStale,
  isRebuildEnabled,
  safeJoin,
  writeSse,
  createSection,
  pushRow,
  overlayState,
  apiState,
  server,
  fetchRemoteText,
  VIEW_CONFIG,
} = mod;

const EXPECTED_SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; base-uri 'none'; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'",
  'Permissions-Policy': 'camera=(), geolocation=(), microphone=()',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
} as const;

// ---------------------------------------------------------------------------
// buildTasksSections
// ---------------------------------------------------------------------------

describe('buildTasksSections', () => {
  it('returns 4 sections: diff, added-objectives, missing, disabled', () => {
    const sections = buildTasksSections({}, []);
    expect(sections).toHaveLength(4);
    expect(sections.map((s: any) => s.title)).toEqual([
      'Task Overrides vs API',
      'Added Objectives',
      'Tasks Missing From API',
      'Disabled Tasks',
    ]);
  });

  it('produces an "override" row when the value differs from the API', () => {
    const sections = buildTasksSections({ t1: { minPlayerLevel: 45 } }, [
      { id: 't1', name: 'T', minPlayerLevel: 10, objectives: [] },
    ]);
    const row = sections[0].rows.find((r: string[]) => r[1] === 'minPlayerLevel');
    expect(row).toBeDefined();
    expect(row[2]).toBe('10');
    expect(row[3]).toBe('45');
    expect(row[4]).toBe('override');
  });

  it('produces a "same" row when values match', () => {
    const sections = buildTasksSections({ t1: { minPlayerLevel: 10 } }, [
      { id: 't1', name: 'T', minPlayerLevel: 10, objectives: [] },
    ]);
    const row = sections[0].rows.find((r: string[]) => r[1] === 'minPlayerLevel');
    expect(row).toBeDefined();
    expect(row[4]).toBe('same');
  });

  it('routes unknown task IDs to the missing section', () => {
    const [, , missing] = buildTasksSections({ ghost: { name: 'Ghost' } }, []);
    expect(missing.rows).toHaveLength(1);
    expect(missing.rows[0]).toEqual(['Ghost', 'ghost']);
  });

  it('routes disabled tasks to the disabled section', () => {
    const [, , , disabled] = buildTasksSections({ t1: { disabled: true } }, [
      { id: 't1', name: 'D', objectives: [] },
    ]);
    expect(disabled.rows).toHaveLength(1);
    expect(disabled.rows[0][0]).toBe('D');
  });

  it('routes objectivesAdd to the added-objectives section', () => {
    const [, added] = buildTasksSections(
      { t1: { objectivesAdd: [{ id: 'o', description: 'Plant' }] } },
      [{ id: 't1', name: 'T', objectives: [] }]
    );
    expect(added.rows).toHaveLength(1);
    expect(added.rows[0][0]).toBe('T');
    expect(added.rows[0][1]).toBe('Plant');
  });

  it('diffs individual objective field overrides', () => {
    const [diff] = buildTasksSections({ t1: { objectives: { o1: { description: 'Fixed' } } } }, [
      { id: 't1', name: 'T', objectives: [{ id: 'o1', description: 'Orig' }] },
    ]);
    const row = diff.rows.find((r: string[]) => r[1] === 'objective:o1.description');
    expect(row).toBeDefined();
    expect(row[2]).toBe('Orig');
    expect(row[3]).toBe('Fixed');
    expect(row[4]).toBe('override');
  });

  it('marks objectives missing from the API', () => {
    const [diff] = buildTasksSections({ t1: { objectives: { gone: { description: 'x' } } } }, [
      { id: 't1', name: 'T', objectives: [] },
    ]);
    const row = diff.rows.find((r: string[]) => r[1] === 'objective:gone');
    expect(row).toBeDefined();
    expect(row[4]).toBe('missing');
  });

  it('skips null/non-object overrides', () => {
    const sections = buildTasksSections({ t1: null }, []);
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
      tasksAdd: { ct: { id: 'ct', name: 'Custom', trader: { name: 'Prapor' } } },
      locales: {
        en: { tasks: { t1: { name: 'Renamed' } } },
      },
      seasonalPerks: {},
      craftsAdd: {},
      modes: {
        regular: {
          tasks: {},
          tasksAdd: {},
          prestige: { p1: { prestigeLevel: 1, name: 'First' } },
        },
        pve: { tasks: {}, tasksAdd: {} },
        'pvp-season': { tasks: {}, tasksAdd: {} },
      },
    };
    overlayState.updatedAt = new Date().toISOString();
    overlayState.error = null;

    apiState.regular.data = [{ id: 't1', name: 'T', minPlayerLevel: 10, objectives: [] }];
    apiState.regular.updatedAt = new Date().toISOString();
    apiState.regular.error = null;
    apiState.pve.data = [];
    apiState.pve.updatedAt = new Date().toISOString();
    apiState.pve.error = null;
    apiState['pvp-season'].data = [];
    apiState['pvp-season'].updatedAt = new Date().toISOString();
    apiState['pvp-season'].error = null;
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

  it('reports malformed task additions through the tasksAdd view error', () => {
    const saved = overlayState.data;
    try {
      overlayState.data = {
        ...saved,
        tasksAdd: { broken: { name: 'Missing ID' } },
      };
      const summary = buildSummary('tasksAdd', 'regular');
      expect(summary.sections).toEqual([]);
      expect(summary.error).toContain('has no valid id');
    } finally {
      overlayState.data = saved;
    }
  });

  it('merges task additions by embedded ID before rendering a mode', () => {
    const merged = mergeTaskAdditions(
      { shared_key: { id: 'task-1', name: 'Shared', trader: { name: 'Prapor' } } },
      { mode_key: { id: 'task-1', name: 'Mode', trader: { name: 'Prapor' } } }
    );

    expect(Object.keys(merged)).toEqual(['task-1']);
    expect(merged['task-1'].name).toBe('Mode');
  });

  it('does not assign mode override keys through the object prototype', () => {
    const merged = mergeTaskOverrides(
      {},
      JSON.parse('{"__proto__":{"polluted":true},"task-1":{"minPlayerLevel":2}}')
    );

    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    expect(Object.hasOwn(merged, '__proto__')).toBe(true);
    expect(merged['task-1'].minPlayerLevel).toBe(2);
  });

  it('rejects malformed or duplicate task additions instead of silently dropping data', () => {
    expect(() =>
      mergeTaskAdditions(
        {
          first: { id: 'task-1', trader: { name: 'Prapor' } },
          second: { id: 'task-1', trader: { name: 'Prapor' } },
        },
        {}
      )
    ).toThrow("contains duplicate id 'task-1'");
    expect(() => mergeTaskAdditions({ broken: { name: 'Missing ID' } }, {})).toThrow(
      "tasksAdd.broken' has no valid id"
    );
    expect(() => mergeTaskAdditions({}, { broken: null })).toThrow(
      "mode tasksAdd.broken' has no valid id"
    );
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

  it('returns 1 section for "prestige"', () => {
    const s = buildSummary('prestige', '');
    expect(s.sections).toHaveLength(1);
    expect(s.sections[0].title).toBe('Prestige Levels');
  });

  it('returns locale sections for "locales"', () => {
    const s = buildSummary('locales', '', 'en');
    expect(s.sections).toHaveLength(1);
    expect(s.sections[0].title).toBe('tasks (en)');
  });

  it('returns 1 section for "seasonalPerks" and "craftsAdd"', () => {
    expect(buildSummary('seasonalPerks', '').sections[0].title).toBe('Seasonal Perks');
    expect(buildSummary('craftsAdd', '').sections[0].title).toBe('Craft Additions');
  });
});

describe('remote overlay loading', () => {
  it('uses a total deadline instead of allowing a slow trickle to hang forever', async () => {
    const httpServer = createHttpServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.write('partial');
      const interval = setInterval(() => response.write('.'), 20);
      response.on('close', () => clearInterval(interval));
    });

    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');

    try {
      await expect(
        fetchRemoteText(`http://127.0.0.1:${address.port}/overlay.json`)
      ).rejects.toThrow(/timed out after 100ms/);
    } finally {
      await new Promise<void>((resolve, reject) =>
        httpServer.close((error) => (error ? reject(error) : resolve()))
      );
    }
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
      'regular'
    );
    expect(sec.rows[0][0]).toBe('CT');
    expect(sec.rows[0][2]).toBe('Prapor');
    expect(sec.rows[0][3]).toBe('Customs');
  });

  it('uses the human-readable mode label in the title', () => {
    const [sec] = buildTaskAdditionSections({}, 'regular');
    expect(sec.title).toBe('Task Additions (PvP)');
    const [seasonal] = buildTaskAdditionSections({}, 'pvp-season');
    expect(seasonal.title).toBe('Task Additions (PvP PvE Seasonal)');
  });
});

describe('buildPrestigeSections', () => {
  it('renders prestige metadata', () => {
    const [sec] = buildPrestigeSections({
      p1: {
        id: 'p1',
        prestigeLevel: 1,
        name: 'First',
        conditions: { c1: { type: 'playerLevel', playerLevel: 55 } },
        storyRequirements: [
          { type: 'storyChapterStatus', storyChapter: 'tour', name: 'Tour', status: ['complete'] },
        ],
      },
    });
    expect(sec.rows[0][0]).toBe(1);
    expect(sec.rows[0][1]).toBe('p1');
    expect(sec.rows[0][3]).toBe(1);
    expect(sec.rows[0][4]).toBe('Tour');
  });

  it('handles entries without story requirements', () => {
    const [sec] = buildPrestigeSections({ p2: { prestigeLevel: 2 } });
    expect(sec.rows[0][4]).toBe('-');
  });
});

describe('buildLocaleSections', () => {
  it('renders one section per entity type with field rows', () => {
    const sections = buildLocaleSections(
      {
        en: {
          tasks: { t1: { name: 'Renamed', objectives: { o1: { description: 'Fixed' } } } },
          items: { i1: { name: 'Item EN' } },
        },
      },
      'en'
    );
    expect(sections.map((s: any) => s.title)).toEqual(['tasks (en)', 'items (en)']);
    const taskRows = sections[0].rows;
    expect(taskRows).toEqual([
      ['t1', 'name', 'Renamed'],
      ['t1', 'objective:o1.description', 'Fixed'],
    ]);
  });

  it('returns an empty placeholder section for unknown locales', () => {
    const [sec] = buildLocaleSections({ en: { tasks: { t1: { name: 'x' } } } }, 'fr');
    expect(sec.rows[0][0]).toBe('(no corrections)');
  });

  it('skips empty entity bundles', () => {
    const sections = buildLocaleSections({ en: { tasks: {} } }, 'en');
    expect(sections).toHaveLength(1);
    expect(sections[0].rows[0][0]).toBe('(no corrections)');
  });
});

describe('buildSeasonalPerkSections', () => {
  it('renders perk metadata and effect ids', () => {
    const [sec] = buildSeasonalPerkSections({
      perk1: {
        id: 'perk1',
        name: 'Perk One',
        type: 'common',
        points: 5,
        effects: [{ effectId: 'pmc_experience_multiplicator' }],
      },
    });
    expect(sec.rows[0][0]).toBe('Perk One');
    expect(sec.rows[0][3]).toBe(5);
    expect(sec.rows[0][4]).toBe('pmc_experience_multiplicator');
  });

  it('handles perks without effects', () => {
    const [sec] = buildSeasonalPerkSections({ p: { name: 'P' } });
    expect(sec.rows[0][4]).toBe('-');
  });
  it('handles malformed effects', () => {
    const [sec] = buildSeasonalPerkSections({ p: { name: 'P', effects: [null, 'bad'] } });
    expect(sec.rows[0][4]).toBe('?, ?');
  });
});

describe('buildCraftAddSections', () => {
  it('renders craft metadata with formatted duration', () => {
    const [sec] = buildCraftAddSections({
      c1: {
        id: 'c1',
        station: 'medstation',
        level: 3,
        duration: 3600,
        productItem: { item: 'meds', count: 1 },
      },
    });
    expect(sec.rows[0][0]).toBe('c1');
    expect(sec.rows[0][2]).toBe('medstation');
    expect(sec.rows[0][3]).toBe(3);
    expect(sec.rows[0][4]).toBe('60 min');
    expect(sec.rows[0][5]).toBe('meds');
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
  it('passes through regular / pve / pvp-season', () => {
    expect(normalizeMode('regular')).toBe('regular');
    expect(normalizeMode('pve')).toBe('pve');
    expect(normalizeMode('pvp-season')).toBe('pvp-season');
  });
  it('defaults to "regular"', () => {
    expect(normalizeMode('x')).toBe('regular');
    expect(normalizeMode(null)).toBe('regular');
  });
});

describe('locale request parsing', () => {
  it('defers locale normalization until overlay locales are available', () => {
    const previousData = overlayState.data;
    try {
      overlayState.data = null;
      const parsed = parseViewParams(new URL('http://localhost/latest?view=locales&locale=fr'));
      expect(parsed).not.toHaveProperty('locale');

      overlayState.data = { locales: { fr: {} } };
      expect(normalizeLocale('fr')).toBe('fr');
    } finally {
      overlayState.data = previousData;
    }
  });
});

describe('isVersionStale', () => {
  it('flags loaded builds behind the latest release', () => {
    expect(isVersionStale('1.0.0', '1.56')).toBe(true);
    expect(isVersionStale('1.55', '1.56')).toBe(true);
    expect(isVersionStale('1.56', '1.56')).toBe(false);
    expect(isVersionStale('1.56.1', '1.56')).toBe(false);
  });
  it('tolerates leading v and missing versions', () => {
    expect(isVersionStale('v1.0.0', 'v1.56')).toBe(true);
    expect(isVersionStale('', '1.56')).toBe(true);
    expect(isVersionStale('1.56', undefined)).toBe(false);
    expect(isVersionStale('1.56', null)).toBe(false);
  });
  it('compares prerelease identifiers using semver precedence', () => {
    expect(isVersionStale('1.56.0-alpha.1', '1.56.0-beta.1')).toBe(true);
    expect(isVersionStale('1.56.0-beta.1', '1.56.0-alpha.1')).toBe(false);
    expect(isVersionStale('1.56', '1.56.0')).toBe(false);
  });
  it('reports the local git tag as a non-empty string', () => {
    const tag = getLatestTagVersion();
    if (tag !== undefined) {
      expect(tag).toMatch(/^\d/);
    }
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
      { t: { objectives: { o2: { y: 2 } } } }
    );
    expect(m.t.objectives).toHaveProperty('o1');
    expect(m.t.objectives).toHaveProperty('o2');
  });
  it('merges overlapping objective patches field-by-field', () => {
    const m = mergeTaskOverrides(
      { t: { objectives: { o1: { x: 1, shared: 'base' } } } },
      { t: { objectives: { o1: { y: 2, shared: 'mode' } } } }
    );
    expect(m.t.objectives.o1).toEqual({ x: 1, y: 2, shared: 'mode' });
  });
  it('concatenates objectivesAdd', () => {
    const m = mergeTaskOverrides(
      { t: { objectivesAdd: [{ id: 'a' }] } },
      { t: { objectivesAdd: [{ id: 'b' }] } }
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

describe('monitor hardening', () => {
  it('keeps mode and locale distinct in summary subscription keys', () => {
    expect(getSummaryKey('locales', 'pve', 'fr')).toBe('locales:pve:fr');
    expect(getSummaryKey('locales', '', 'fr')).toBe('locales::fr');
  });

  it('closes failed asynchronous responses without throwing', () => {
    const sent: Array<{ status?: number; body?: string }> = [];
    const unsentResponse = {
      destroyed: false,
      writableEnded: false,
      headersSent: false,
      setHeaders: () => {},
      writeHead: (status: number) => sent.push({ status }),
      end: (body?: string) => sent.push({ body }),
      destroy: () => {
        unsentResponse.destroyed = true;
      },
    };
    handleResponseFailure(unsentResponse);
    expect(sent).toEqual([{ status: 500 }, { body: 'Internal server error' }]);

    const ended: Array<string | undefined> = [];
    handleResponseFailure({
      destroyed: false,
      writableEnded: false,
      headersSent: true,
      end: (body?: string) => ended.push(body),
    });
    expect(ended).toEqual([undefined]);

    const failedResponse = {
      destroyed: false,
      writableEnded: false,
      headersSent: false,
      setHeaders: () => {},
      writeHead: () => {
        throw new Error('socket closed');
      },
      end: () => {},
      destroy: () => {
        failedResponse.destroyed = true;
      },
    };
    expect(() => handleResponseFailure(failedResponse)).not.toThrow();
    expect(failedResponse.destroyed).toBe(true);

    const closedCalls: string[] = [];
    const closedResponse = {
      destroyed: true,
      writableEnded: false,
      headersSent: false,
      writeHead: () => closedCalls.push('writeHead'),
      end: () => closedCalls.push('end'),
      destroy: () => closedCalls.push('destroy'),
    };
    handleResponseFailure(closedResponse);
    handleResponseFailure({ ...closedResponse, destroyed: false, writableEnded: true });
    expect(closedCalls).toEqual([]);
  });

  it('rejects unsafe numeric environment values', () => {
    expect(readPositiveInteger('25', 10)).toBe(25);
    expect(readPositiveInteger('0', 10)).toBe(10);
    expect(readPositiveInteger('-1', 10)).toBe(10);
    expect(readPositiveInteger('Infinity', 10)).toBe(10);
    expect(readPositiveInteger('1.5', 10)).toBe(10);
    expect(readPort('65535', 3000)).toBe(65535);
    expect(readPort('65536', 3000)).toBe(3000);
    expect(readTimerMilliseconds('2147483647', 120000)).toBe(2147483647);
    expect(readTimerMilliseconds('2147483648', 120000)).toBe(120000);
  });

  it('builds view-specific query parameters from the shared configuration', () => {
    expect(buildViewParams('tasks', 'pve', 'en').toString()).toBe('view=tasks&mode=pve');
    expect(buildViewParams('locales', 'regular', 'en').toString()).toBe('view=locales&locale=en');
    expect(buildViewParams('items', 'pve', 'en').toString()).toBe('view=items');
  });

  it('only enables rebuilds for the default overlay path', () => {
    expect(mod.isDefaultOverlayPath(path.resolve('dist/overlay.json'))).toBe(true);
    expect(mod.isDefaultOverlayPath(path.resolve('custom-overlay.json'))).toBe(false);
  });

  it('keeps static paths inside the configured public directory', () => {
    const publicDir = path.resolve('monitor/public');
    expect(safeJoin(publicDir, '/app.js')).toBe(path.join(publicDir, 'app.js'));
    expect(safeJoin(publicDir, '../publicity/secret.txt')).toBeNull();
    expect(safeJoin(publicDir, 'nested/../../server.js')).toBeNull();
  });

  it('requires explicit opt-in before enabling rebuilds', () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousAllowRebuild = process.env.ALLOW_REBUILD;
    const previousRebuildToken = process.env.REBUILD_TOKEN;
    try {
      process.env.NODE_ENV = 'development';
      delete process.env.ALLOW_REBUILD;
      delete process.env.REBUILD_TOKEN;
      expect(isRebuildEnabled()).toBe(false);
      process.env.ALLOW_REBUILD = 'true';
      expect(isRebuildEnabled()).toBe(false);
      process.env.REBUILD_TOKEN = 'local-secret';
      expect(isRebuildEnabled()).toBe(true);
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
      if (previousAllowRebuild === undefined) {
        delete process.env.ALLOW_REBUILD;
      } else {
        process.env.ALLOW_REBUILD = previousAllowRebuild;
      }
      if (previousRebuildToken === undefined) {
        delete process.env.REBUILD_TOKEN;
      } else {
        process.env.REBUILD_TOKEN = previousRebuildToken;
      }
    }
  });

  it('keeps an SSE client when backpressure is within the buffer bound', () => {
    const client = {
      destroyed: false,
      writableEnded: false,
      writableLength: MAX_SSE_BUFFERED_BYTES,
      write: vi.fn(() => false),
      destroy: vi.fn(),
    };

    expect(writeSse('test', client, 'event: summary\n\n')).toBe(true);
    expect(client.destroy).not.toHaveBeenCalled();
  });

  it('closes an SSE client whose buffered data exceeds the bound', () => {
    const client = {
      destroyed: false,
      writableEnded: false,
      writableLength: MAX_SSE_BUFFERED_BYTES + 1,
      write: vi.fn(() => false),
      destroy: vi.fn(),
    };

    expect(writeSse('test', client, 'event: summary\n\n')).toBe(false);
    expect(client.destroy).toHaveBeenCalledOnce();
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
      locales: { en: { tasks: { t1: { name: 'Renamed' } } } },
      seasonalPerks: { perk1: { id: 'perk1', name: 'Perk One' } },
      craftsAdd: {},
      modes: {
        regular: {
          tasks: {},
          tasksAdd: {},
          prestige: { p1: { prestigeLevel: 1, name: 'First' } },
        },
        pve: { tasks: {}, tasksAdd: {} },
        'pvp-season': { tasks: {}, tasksAdd: {} },
      },
    };
    overlayState.updatedAt = new Date().toISOString();
    overlayState.error = null;

    apiState.regular.data = [{ id: 't1', name: 'T', minPlayerLevel: 10, objectives: [] }];
    apiState.regular.updatedAt = new Date().toISOString();
    apiState.regular.error = null;
    apiState.pve.data = [];
    apiState.pve.updatedAt = new Date().toISOString();
    apiState.pve.error = null;
    apiState['pvp-season'].data = [];
    apiState['pvp-season'].updatedAt = new Date().toISOString();
    apiState['pvp-season'].error = null;

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
    apiState['pvp-season'].data = null;
    apiState['pvp-season'].updatedAt = null;
    apiState['pvp-season'].error = null;
    return new Promise<void>((resolve) => server.close(resolve));
  });

  // -- static assets ---------------------------------------------------------

  it('GET /view-config.js — serves the shared browser configuration', async () => {
    const res = await fetch(`${baseUrl}/view-config.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/javascript');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');

    const source = await res.text();
    const context: {
      window: { viewMeta?: typeof configModule };
      module: { exports: typeof configModule | Record<string, never> };
    } = { window: {}, module: { exports: {} } };
    vm.runInNewContext(source, context);

    expect(context.window.viewMeta).toBe(context.module.exports);
    expect(context.window.viewMeta?.DEFAULT_MODES).toEqual(['regular', 'pve', 'pvp-season']);
    expect(Object.keys(context.window.viewMeta?.VIEW_CONFIG ?? {})).toEqual(
      Object.keys(VIEW_CONFIG)
    );
  });

  it('GET /app.js — reports a visible error when shared configuration is unavailable', async () => {
    const res = await fetch(`${baseUrl}/app.js`);
    expect(res.status).toBe(200);
    const source = await res.text();

    const staleViewMeta = {
      DEFAULT_MODES: ['regular', 'pve', 'pvp-season'],
      MODE_LABELS: {},
      VIEW_CONFIG: { tasks: { requiresMode: true } },
    };
    for (const viewMeta of [undefined, staleViewMeta]) {
      const errorBanner = { textContent: '', style: { display: 'none' } };
      const context = {
        document: {
          getElementById: (id: string) => (id === 'error-banner' ? errorBanner : null),
        },
        window: { viewMeta },
      };

      expect(() => vm.runInNewContext(source, context)).toThrow(/configuration failed to load/i);
      expect(errorBanner.textContent).toMatch(/configuration failed to load/i);
      expect(errorBanner.style.display).toBe('block');
    }
  });

  // -- /latest ---------------------------------------------------------------

  it('GET /latest — 200, application/json', async () => {
    const res = await fetch(`${baseUrl}/latest?view=tasks&mode=regular`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const csp = res.headers.get('content-security-policy');
    expect(csp).toBeDefined();
    for (const directive of EXPECTED_SECURITY_HEADERS['Content-Security-Policy'].split('; ')) {
      expect(csp).toContain(directive);
    }
    for (const [name, value] of Object.entries(EXPECTED_SECURITY_HEADERS)) {
      if (name === 'Content-Security-Policy') continue;
      expect(res.headers.get(name)).toBe(value);
    }
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
    expect(row[2]).toBe('10'); // API
    expect(row[3]).toBe('45'); // overlay
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

  it('GET /latest — respects mode=pvp-season', async () => {
    const data = await (await fetch(`${baseUrl}/latest?view=tasks&mode=pvp-season`)).json();
    expect(data.mode).toBe('pvp-season');
  });

  it('GET /latest — exposes human-readable mode labels', async () => {
    const data = await (await fetch(`${baseUrl}/latest?view=tasks&mode=regular`)).json();
    expect(data.modes).toContain('pvp-season');
    expect(data.modeLabels.regular).toBe('PvP');
    expect(data.modeLabels['pvp-season']).toBe('PvP PvE Seasonal');
  });

  it('GET /latest — rebuild block reports availability', async () => {
    const data = await (await fetch(`${baseUrl}/latest?view=tasks&mode=regular`)).json();
    expect(data.rebuild).toHaveProperty('enabled');
    expect(data.rebuild).toHaveProperty('running');
  });

  it('POST /rebuild — disabled in the test environment', async () => {
    const res = await fetch(`${baseUrl}/rebuild`, { method: 'POST' });
    expect(res.status).toBe(503);
    const data = await res.json();
    expect(data.ok).toBe(false);
  });

  it('GET /rebuild — 405', async () => {
    const res = await fetch(`${baseUrl}/rebuild`);
    expect(res.status).toBe(405);
  });

  it('GET /latest — defaults unknown mode to regular', async () => {
    const data = await (await fetch(`${baseUrl}/latest?view=tasks&mode=xxx`)).json();
    expect(data.mode).toBe('regular');
  });

  it('GET /latest — view=prestige returns prestige sections', async () => {
    const data = await (await fetch(`${baseUrl}/latest?view=prestige`)).json();
    expect(data.view).toBe('prestige');
    expect(data.mode).toBeNull();
    expect(data.sections[0].title).toBe('Prestige Levels');
    expect(data.sections[0].rows[0][1]).toBe('p1');
  });

  it('GET /latest — view=locales with locale=en returns locale sections', async () => {
    const data = await (await fetch(`${baseUrl}/latest?view=locales&locale=en`)).json();
    expect(data.view).toBe('locales');
    expect(data.locale).toBe('en');
    expect(data.locales).toContain('en');
    expect(data.sections[0].title).toBe('tasks (en)');
  });

  it('GET /latest — view=seasonalPerks returns perk rows', async () => {
    const data = await (await fetch(`${baseUrl}/latest?view=seasonalPerks`)).json();
    expect(data.sections[0].title).toBe('Seasonal Perks');
    expect(data.sections[0].rows[0][0]).toBe('Perk One');
  });

  it('GET /health — reports ok and mode api states', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    const modes = data.api.map((entry: any) => entry.mode);
    expect(modes).toContain('regular');
    expect(modes).toContain('pve');
    expect(modes).toContain('pvp-season');
  });

  it('GET /health — reports not ok when any supported mode is unhealthy', async () => {
    const previousError = apiState.pve.error;
    try {
      apiState.pve.error = 'API unavailable';
      const res = await fetch(`${baseUrl}/health`);
      const data = await res.json();
      expect(data.ok).toBe(false);
    } finally {
      apiState.pve.error = previousError;
    }
  });

  // -- /events ---------------------------------------------------------------

  it('GET /events — SSE headers', async () => {
    const res = await fetch(`${baseUrl}/events?view=tasks&mode=regular`);
    const reader = res.body!.getReader();
    try {
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const csp = res.headers.get('content-security-policy');
      expect(csp).toBeDefined();
      for (const directive of EXPECTED_SECURITY_HEADERS['Content-Security-Policy'].split('; ')) {
        expect(csp).toContain(directive);
      }
      for (const [name, value] of Object.entries(EXPECTED_SECURITY_HEADERS)) {
        if (name === 'Content-Security-Policy') continue;
        expect(res.headers.get(name)).toBe(value);
      }
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
