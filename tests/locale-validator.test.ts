/**
 * Tests for the locale-override validator (locale-validator module)
 *
 * Verdicts are exercised with hand-built LocaleBundle fixtures: STALE (bundle
 * fixed upstream), NEEDED (bundle still broken or unresolvable), REMOVED
 * (entity/objective gone from the API), and UNVERIFIABLE (storyChapters).
 */

import { describe, expect, it } from 'vitest';
import {
  validateLocaleOverrides,
  type LocaleBundle,
  type LocaleOverlay,
  type LocaleValidationResult,
} from '../src/lib/index.js';

function makeBundle(overrides: Partial<LocaleBundle> = {}): LocaleBundle {
  return {
    locale: 'en',
    tasksById: new Map(),
    itemsById: new Map(),
    tradersById: new Map(),
    mapsById: new Map(),
    prestigeById: new Map(),
    tasksLocale: {},
    itemsLocale: {},
    tradersLocale: {},
    mapsLocale: {},
    ...overrides,
  };
}

function byField(results: LocaleValidationResult[]): Record<string, LocaleValidationResult> {
  return Object.fromEntries(results.map((r) => [`${r.entityType}/${r.entityId}/${r.field}`, r]));
}

describe('validateLocaleOverrides', () => {
  it('returns no results for an empty overlay', () => {
    expect(validateLocaleOverrides('en', {}, makeBundle())).toEqual([]);
  });

  it('marks a task name STALE when the bundle now matches the override', () => {
    const bundle = makeBundle({
      tasksById: new Map([['t1', { id: 't1', name: 't1 name' }]]),
      tasksLocale: { 't1 name': 'New Beginning' },
    });
    const overrides: LocaleOverlay = {
      tasks: { t1: { name: 'New Beginning' } },
    };

    const [result] = validateLocaleOverrides('en', overrides, bundle);

    expect(result.verdict).toBe('STALE');
    expect(result.bundleValue).toBe('New Beginning');
    expect(result.field).toBe('name');
  });

  it('marks a task name NEEDED when the bundle still differs', () => {
    // The seeded en.json5 case: en bundle resolves to the German string.
    const bundle = makeBundle({
      tasksById: new Map([['t1', { id: 't1', name: 't1 name' }]]),
      tasksLocale: { 't1 name': 'Neuanfang' },
    });
    const overrides: LocaleOverlay = {
      tasks: { t1: { name: 'New Beginning' } },
    };

    const [result] = validateLocaleOverrides('en', overrides, bundle);

    expect(result.verdict).toBe('NEEDED');
    expect(result.bundleValue).toBe('Neuanfang');
  });

  it('marks NEEDED (not STALE) when the translation key is missing from the locale map', () => {
    const bundle = makeBundle({
      tasksById: new Map([['t1', { id: 't1', name: 't1 name' }]]),
      tasksLocale: {},
    });
    const overrides: LocaleOverlay = {
      tasks: { t1: { name: 'New Beginning' } },
    };

    const [result] = validateLocaleOverrides('en', overrides, bundle);

    expect(result.verdict).toBe('NEEDED');
    expect(result.bundleValue).toBeUndefined();
    expect(result.message).toContain('cannot confirm');
  });

  it('marks every patched field REMOVED when the entity is gone from the API', () => {
    const overrides: LocaleOverlay = {
      tasks: {
        gone: {
          name: 'Ghost Task',
          wikiLink: 'https://wiki/Ghost',
          objectives: { o1: { description: 'Do it' } },
        },
      },
    };

    const results = validateLocaleOverrides('en', overrides, makeBundle());

    expect(results).toHaveLength(3);
    expect(results.every((r) => r.verdict === 'REMOVED')).toBe(true);
    expect(results.map((r) => r.field).sort()).toEqual([
      'name',
      'objectives[o1].description',
      'wikiLink',
    ]);
  });

  it('compares wikiLink against the core endpoint, not the translation bundle', () => {
    const bundle = makeBundle({
      tasksById: new Map([
        ['fixed', { id: 'fixed', name: 'fixed name', wikiLink: 'https://wiki/Correct' }],
        ['broken', { id: 'broken', name: 'broken name', wikiLink: 'https://wiki/Wrong' }],
      ]),
      // Deliberately empty tasksLocale: wikiLink must not consult it.
      tasksLocale: {},
    });
    const overrides: LocaleOverlay = {
      tasks: {
        fixed: { wikiLink: 'https://wiki/Correct' },
        broken: { wikiLink: 'https://wiki/Correct' },
      },
    };

    const results = byField(validateLocaleOverrides('en', overrides, bundle));

    expect(results['tasks/fixed/wikiLink'].verdict).toBe('STALE');
    expect(results['tasks/broken/wikiLink'].verdict).toBe('NEEDED');
    expect(results['tasks/broken/wikiLink'].bundleValue).toBe('https://wiki/Wrong');
  });

  it('resolves objective descriptions via the core objective translation key', () => {
    const bundle = makeBundle({
      tasksById: new Map([
        [
          't1',
          {
            id: 't1',
            name: 't1 name',
            objectives: [
              { id: 'o1', description: 'o1' },
              { id: 'o2', description: 'o2' },
            ],
          },
        ],
      ]),
      tasksLocale: { o1: 'Eliminate Scavs', o2: 'Falsche Beschreibung' },
    });
    const overrides: LocaleOverlay = {
      tasks: {
        t1: {
          objectives: {
            o1: { description: 'Eliminate Scavs' },
            o2: { description: 'Correct description' },
            gone: { description: 'Objective removed upstream' },
          },
        },
      },
    };

    const results = byField(validateLocaleOverrides('en', overrides, bundle));

    expect(results['tasks/t1/objectives[o1].description'].verdict).toBe('STALE');
    expect(results['tasks/t1/objectives[o2].description'].verdict).toBe('NEEDED');
    expect(results['tasks/t1/objectives[gone].description'].verdict).toBe('REMOVED');
  });

  it('checks item name, shortName, description via itemsLocale and wikiLink directly', () => {
    const bundle = makeBundle({
      itemsById: new Map([
        [
          'i1',
          {
            id: 'i1',
            name: 'i1 Name',
            shortName: 'i1 ShortName',
            description: 'i1 Description',
            wikiLink: 'https://wiki/Roubles',
          },
        ],
      ]),
      itemsLocale: {
        'i1 Name': 'Roubles',
        'i1 ShortName': 'RUB',
        'i1 Description': 'Old text',
      },
    });
    const overrides: LocaleOverlay = {
      items: {
        i1: {
          name: 'Roubles',
          shortName: 'RUB',
          description: 'New text',
          wikiLink: 'https://wiki/Roubles',
        },
      },
    };

    const results = byField(validateLocaleOverrides('en', overrides, bundle));

    expect(results['items/i1/name'].verdict).toBe('STALE');
    expect(results['items/i1/shortName'].verdict).toBe('STALE');
    expect(results['items/i1/description'].verdict).toBe('NEEDED');
    expect(results['items/i1/wikiLink'].verdict).toBe('STALE');
  });

  it('checks trader and map fields via their own translation maps', () => {
    const bundle = makeBundle({
      tradersById: new Map([['tr1', { id: 'tr1', name: 'tr1 Nickname' }]]),
      tradersLocale: { 'tr1 Nickname': 'Prapor' },
      mapsById: new Map([['m1', { id: 'm1', name: 'm1 Name' }]]),
      mapsLocale: { 'm1 Name': 'Fabrik' },
    });
    const overrides: LocaleOverlay = {
      traders: { tr1: { name: 'Prapor' } },
      maps: { m1: { name: 'Factory' } },
    };

    const results = byField(validateLocaleOverrides('en', overrides, bundle));

    expect(results['traders/tr1/name'].verdict).toBe('STALE');
    expect(results['maps/m1/name'].verdict).toBe('NEEDED');
    expect(results['maps/m1/name'].bundleValue).toBe('Fabrik');
  });

  it('resolves prestige names from prestigeById via the tasks translation map', () => {
    const bundle = makeBundle({
      prestigeById: new Map([['p1', { id: 'p1', name: 'p1 name', prestigeLevel: 1 }]]),
      tasksLocale: { 'p1 name': 'Prestige 1' },
    });
    const overrides: LocaleOverlay = {
      prestige: { p1: { name: 'Prestige 1' } },
    };

    const [result] = validateLocaleOverrides('en', overrides, bundle);

    expect(result.entityType).toBe('prestige');
    expect(result.verdict).toBe('STALE');
  });

  it('marks storyChapter patches UNVERIFIABLE', () => {
    const overrides: LocaleOverlay = {
      storyChapters: {
        tour: { name: 'Tour', objectives: { 'tour-main-1': { description: 'Visit' } } },
      },
    };

    const results = validateLocaleOverrides('en', overrides, makeBundle());

    expect(results).toHaveLength(1);
    expect(results[0].verdict).toBe('UNVERIFIABLE');
    expect(results[0].entityType).toBe('storyChapters');
    expect(results[0].entityId).toBe('tour');
  });

  it('does not treat prototype keys as translations', () => {
    const bundle = makeBundle({
      tasksById: new Map([['t1', { id: 't1', name: 'toString' }]]),
      tasksLocale: {},
    });
    const overrides: LocaleOverlay = {
      tasks: { t1: { name: 'Anything' } },
    };

    const [result] = validateLocaleOverrides('en', overrides, bundle);

    // Object.prototype.toString must not leak in as a resolved translation.
    expect(result.verdict).toBe('NEEDED');
    expect(result.bundleValue).toBeUndefined();
  });
});
