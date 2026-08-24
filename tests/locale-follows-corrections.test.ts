/**
 * A translation must follow the English the overlay corrects to, not the
 * English the API serves.
 *
 * overrides/tasks.json5 replaces wrong English outright. One-Way Ticket is the
 * example: the API says "Eliminate any target with headshots using a Steyr AUG
 * on Factory", the quest actually wants fifteen headshot kills, and the overlay
 * corrects the text. A reader sees the corrected wording, so that is what the
 * German has to say and what its "// Was:" has to record.
 *
 * This existed and was correct until a drift check that compared against the
 * raw bundle reported it as stale. Acting on that report reverted the German to
 * the uncorrected wording — the translation then promised one kill where the
 * quest wants fifteen. The check has since been fixed; this makes sure the file
 * itself cannot drift back, without needing the network.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { getProjectPaths } from '../src/lib/index.js';
import { readDataCorrections, readWasComments } from '../scripts/status-locale.js';

const { srcDir } = getProjectPaths();
const localesDir = join(srcDir, 'overrides', 'locales');
const corrections = readDataCorrections(join(srcDir, 'overrides', 'tasks.json5'));

const localeFiles = ['de.json5', 'en.json5'];

describe('recorded English source', () => {
  it('reads corrections to compare against', () => {
    expect(corrections.size).toBeGreaterThan(0);
  });

  it.each(localeFiles)('%s records the corrected English, not the raw bundle text', (file) => {
    const path = join(localesDir, file);
    const contradictions = readWasComments(path)
      .filter(({ id }) => corrections.has(id))
      .filter(({ id, was }) => corrections.get(id) !== was)
      .map(({ id, was }) => ({ id, recorded: was, corrected: corrections.get(id) }));
    expect(contradictions).toEqual([]);
  });

  it('reads the file it claims to read', () => {
    // Guards the silent-pass case: a rename or a changed comment prefix would
    // leave the check above with nothing to compare and still go green.
    expect(readWasComments(join(localesDir, 'de.json5')).length).toBeGreaterThan(0);
  });
});
