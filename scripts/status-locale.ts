#!/usr/bin/env tsx
/**
 * Translation status for one locale, measured against the English source.
 *
 * Answers the three questions that otherwise get re-derived by hand every
 * session, and answered slightly differently each time:
 *
 *   1. What is still untranslated, per trader, NOT counting what this overlay
 *      already covers. Measuring against the upstream bundle alone reports
 *      work as open that is long done - and invites translating it twice.
 *   2. Which entries rest on an English source that has since changed. The
 *      "// Was:" comment records the English a translation was written from;
 *      if the bundle no longer says that, the German may describe something
 *      the game no longer asks for. check-overrides cannot see this class:
 *      it compares the German override against the German bundle and never
 *      looks at the English side.
 *   3. Which overrides the bundle now matches on its own, making them no-ops.
 *
 * Read-only. Exits non-zero only when something needs a human.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import JSON5 from 'json5';
import {
  bold,
  colorize,
  dim,
  fetchLocaleBundle,
  getProjectPaths,
  isDirectExecution,
  printError,
  printHeader,
  printProgress,
} from '../src/lib/index.js';

interface TraderRow {
  trader: string;
  tasks: number;
  objectives: number;
  openNames: number;
  openObjectives: number;
  covered: number;
}

const NO_TRADER = '(no trader)';

/**
 * What this overlay patches, keyed the way the translation bundle keys it:
 * `<task-id> name` for names, the bare objective id for descriptions.
 */
export function readCoverage(file: string): Map<string, string> {
  const parsed = JSON5.parse<{
    tasks?: Record<
      string,
      { name?: string; objectives?: Record<string, { description?: string }> }
    >;
  }>(readFileSync(file, 'utf-8'));
  const covered = new Map<string, string>();
  for (const [taskId, entry] of Object.entries(parsed.tasks ?? {})) {
    if (entry.name) covered.set(`${taskId} name`, entry.name);
    for (const [objectiveId, objective] of Object.entries(entry.objectives ?? {})) {
      if (objective.description) covered.set(objectiveId, objective.description);
    }
  }
  return covered;
}

/**
 * Pair every "// Was: <english>" with the entry it documents.
 *
 * Textual because JSON5.parse drops comments. Both placements in the file are
 * handled: above the id, and inside the entry above `description`.
 */
export function readWasComments(file: string): { id: string; was: string }[] {
  const out: { id: string; was: string }[] = [];
  let taskId: string | null = null;
  let objectiveId: string | null = null;
  let pending: string | null = null;
  for (const line of readFileSync(file, 'utf-8').split('\n')) {
    const task = line.match(/^ {4}'([0-9a-f]{24})': \{$/);
    const nested = line.match(/^ {6,}'([0-9a-f]{24})': \{$/);
    const comment = line.match(/^\s*\/\/ Was: (.+)$/);
    if (comment) {
      pending = comment[1]!.trim();
      continue;
    }
    if (task) {
      taskId = task[1]!;
      objectiveId = null;
      if (pending) {
        out.push({ id: `${taskId} name`, was: pending });
        pending = null;
      }
      continue;
    }
    if (nested) {
      objectiveId = nested[1]!;
      if (pending) {
        out.push({ id: objectiveId, was: pending });
        pending = null;
      }
      continue;
    }
    if (/^\s*name:/.test(line) && pending && taskId) {
      out.push({ id: `${taskId} name`, was: pending });
      pending = null;
      continue;
    }
    // The older placement: comment inside the entry, above `description`.
    if (/^\s*description:/.test(line) && pending && objectiveId) {
      out.push({ id: objectiveId, was: pending });
      pending = null;
    }
  }
  return out;
}

function traderName(bundle: Awaited<ReturnType<typeof fetchLocaleBundle>>, id: unknown): string {
  if (typeof id !== 'string') return NO_TRADER;
  const nickname = bundle.tradersLocale[`${id} Nickname`];
  return typeof nickname === 'string' && nickname ? nickname : id;
}

export async function statusLocale(locale: string): Promise<number> {
  const { srcDir } = getProjectPaths();
  const overrideFile = join(srcDir, 'overrides', 'locales', `${locale}.json5`);

  printProgress(`Loading ${locale}.json5 and both locale bundles...`);
  const coverage = readCoverage(overrideFile);
  const [en, translated] = await Promise.all([
    fetchLocaleBundle('regular', 'en'),
    fetchLocaleBundle('regular', locale),
  ]);

  // The English bundle is itself wrong in places - the New Beginning quests
  // carry the German string. en.json5 records those fixes; apply them, or
  // every one of them reports as drift forever.
  const englishFixes = readCoverage(join(srcDir, 'overrides', 'locales', 'en.json5'));
  const english: Record<string, unknown> = { ...en.tasksLocale };
  for (const [key, value] of englishFixes) english[key] = value;

  const rows = new Map<string, TraderRow>();
  const noop: string[] = [];

  /**
   * An entry is open when the bundle still shows the English string and we do
   * not patch it. An override is a no-op when the bundle already says exactly
   * what the override says - the bundle merely differing is not enough, since
   * correcting wrong German is the whole point of a locale override.
   */
  const classify = (key: string, onOpen: () => void, onCovered: () => void) => {
    const ours = coverage.get(key);
    const bundle = translated.tasksLocale[key];
    if (ours !== undefined && ours === bundle) {
      noop.push(`${key} — bundle now says exactly this`);
      onCovered();
      return;
    }
    if (ours !== undefined) {
      onCovered();
      return;
    }
    if (en.tasksLocale[key] === bundle) onOpen();
  };

  for (const [taskId, task] of en.tasksById) {
    const trader = traderName(en, task.trader);
    const row = rows.get(trader) ?? {
      trader,
      tasks: 0,
      objectives: 0,
      openNames: 0,
      openObjectives: 0,
      covered: 0,
    };
    rows.set(trader, row);
    row.tasks++;

    const nameKey = `${taskId} name`;
    classify(
      nameKey,
      () => row.openNames++,
      () => row.covered++
    );

    const objectives = Array.isArray(task.objectives) ? task.objectives : [];
    for (const objective of objectives) {
      const id = (objective as { id?: unknown }).id;
      if (typeof id !== 'string') continue;
      row.objectives++;
      classify(
        id,
        () => row.openObjectives++,
        () => row.covered++
      );
    }
  }

  const drifted = readWasComments(overrideFile).filter(({ id, was }) => {
    const current = english[id];
    return typeof current === 'string' && current !== was;
  });

  printHeader(`TRANSLATION STATUS (${locale})`);
  const sorted = [...rows.values()].sort(
    (a, b) => b.openNames + b.openObjectives - (a.openNames + a.openObjectives)
  );
  console.log(bold('  Trader           Tasks   Obj  |   open  (names + obj)  | covered'));
  console.log(dim('  ' + '-'.repeat(66)));
  let openTotal = 0;
  let coveredTotal = 0;
  for (const r of sorted) {
    const open = r.openNames + r.openObjectives;
    openTotal += open;
    coveredTotal += r.covered;
    const label =
      open === 0 ? colorize(String(open).padStart(6), 'green') : String(open).padStart(6);
    console.log(
      `  ${r.trader.padEnd(15)}${String(r.tasks).padStart(6)}${String(r.objectives).padStart(6)}  |${label}  (${r.openNames} + ${r.openObjectives})`.padEnd(
        60
      ) + `| ${r.covered}`
    );
  }
  console.log(dim('  ' + '-'.repeat(66)));
  console.log(
    bold(`  ${'TOTAL'.padEnd(15)}${' '.repeat(12)}  |${String(openTotal).padStart(6)}`) +
      `                 | ${coveredTotal}`
  );
  console.log(
    dim(
      '\n  Identical strings are counted as open: Level, PvP, Scav and the like\n' +
        '  read the same in both languages and need no override.'
    )
  );

  printHeader('ENGLISH SOURCE CHANGED SINCE THE TRANSLATION');
  if (drifted.length === 0) {
    console.log(colorize('  None — every "// Was:" still matches the English bundle.', 'green'));
  } else {
    for (const { id, was } of drifted) {
      console.log(colorize(`  ${id}`, 'yellow'));
      console.log(`      was: ${was}`);
      console.log(`      now: ${String(english[id])}`);
    }
  }

  printHeader('OVERRIDES THE BUNDLE NOW MATCHES');
  if (noop.length === 0) {
    console.log(colorize('  None — every override still changes something.', 'green'));
  } else {
    for (const entry of noop) console.log(colorize(`  ${entry}`, 'yellow'));
  }

  return drifted.length > 0 || noop.length > 0 ? 1 : 0;
}

if (isDirectExecution(import.meta.url)) {
  const locale = process.argv[2];
  if (!locale || locale === 'en') {
    printError(
      'Pass the locale to report on, e.g. `status-locale de`. ' +
        'Comparing en against itself yields nothing.'
    );
    process.exit(2);
  }
  statusLocale(locale)
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      printError('status-locale failed', error instanceof Error ? error : new Error(String(error)));
      process.exit(2);
    });
}
