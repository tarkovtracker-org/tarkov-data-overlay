/**
 * Tests for the seasonal-perk addition data (src/additions/seasonalPerks.json5).
 *
 * Guards the hand-captured dataset's referential integrity: every perk's id
 * matches its object key, and mutuallyExclusiveSeasonalPerkIds references
 * resolve to real perks and are symmetric (A excludes B => B excludes A).
 */

import { describe, expect, it } from 'vitest';
import { join } from 'path';
import { getProjectPaths, loadAllJson5FromDir, type SeasonalPerk } from '../src/lib/index.js';

function loadSeasonalPerks(): Record<string, SeasonalPerk> {
  const { srcDir } = getProjectPaths();
  const additions = loadAllJson5FromDir(join(srcDir, 'additions'), false);
  return (additions.seasonalPerks ?? {}) as Record<string, SeasonalPerk>;
}

describe('seasonal perks (hand-captured)', () => {
  const perks = loadSeasonalPerks();

  it('ships a non-trivial perk set', () => {
    expect(Object.keys(perks).length).toBeGreaterThanOrEqual(30);
  });

  it('matches every object key to its id', () => {
    for (const [key, perk] of Object.entries(perks)) {
      expect(perk.id, `key ${key}`).toBe(key);
    }
  });

  it('resolves every mutuallyExclusiveSeasonalPerkIds reference to a defined perk', () => {
    for (const [key, perk] of Object.entries(perks)) {
      for (const ref of perk.mutuallyExclusiveSeasonalPerkIds ?? []) {
        expect(perks[ref], `perk ${key} excludes unknown perk ${ref}`).toBeDefined();
      }
    }
  });

  it('mirrors mutual exclusivity back symmetrically', () => {
    for (const [key, perk] of Object.entries(perks)) {
      for (const ref of perk.mutuallyExclusiveSeasonalPerkIds ?? []) {
        const back = perks[ref]?.mutuallyExclusiveSeasonalPerkIds ?? [];
        expect(
          back,
          `perk ${key} excludes ${ref}, but ${ref} does not exclude ${key} back`
        ).toContain(key);
      }
    }
  });
});
