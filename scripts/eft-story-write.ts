#!/usr/bin/env tsx
/**
 * Assemble src/additions/storyChapters.json5 from the deterministic EFT story
 * generation. Reads the generator's JSON (default data/eft/story-final.json, or
 * argv[2]), validates it against story-chapter.schema.json, and writes JSON5
 * with comment headers, chapters ordered by `order`.
 *
 * Run via: npm run eft:story  (or: tsx scripts/eft-story-write.ts <input.json>)
 *
 * The input must come from a generator run that staged its provenance binding:
 * replacing the artifact requires a sidecar bound to the input's exact bytes, so
 * a hand-edited or unrelated payload cannot be published under the committed
 * lock. `npm run eft:story` runs the generator and this writer in sequence and
 * satisfies that contract.
 */

import { createHash } from 'crypto';
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { basename, dirname, join } from 'path';
import JSON5 from 'json5';
import Ajv from 'ajv';
import { isDirectExecution } from '../src/lib/index.js';
import { writeFileAtomicSync } from './lib/atomic-write.js';
import {
  inspectStagedReferenceLock,
  LOCK,
  pendingLockSidecar,
  promoteStoryReferenceLock,
} from './eft-story-generate.js';

const HEADER =
  '  // Story chapters (Edge of Darkness storyline) - not present in the tarkov.dev API.\n' +
  '  //\n' +
  '  // Source: local quest reference (structure/ordering) cross-referenced with the\n' +
  '  // EFT wiki (objective text + optional/required flags). Chapters are the storyline\n' +
  '  // narrator-trader quests; objectives are the ordered sub-quest references. Optional\n' +
  '  // flags come from the wiki. Chapter ordering, wikiLink, activation, and requirements\n' +
  '  // are curated (scripts/story-chapter-meta.json). Each generated objective id is\n' +
  '  // the stable source objective id, with sourceQuestId linking to its sub-quest.\n' +
  '  // Every chapter is derived from the reference, so no objective carries a\n' +
  '  // fabricated id; endingId and the chapter-level `endings` list use the real\n' +
  '  // client/ending_list ids.\n' +
  '  //\n' +
  '  // `referenceCoverage` reports how much of each chapter the capture resolved. The\n' +
  '  // client only returns a story sub-quest template once the player has reached it,\n' +
  '  // so `partial: true` means these objectives are what the capture could see, not a\n' +
  '  // complete chapter - a missing objective is not evidence that none exists. For the\n' +
  '  // same reason an ending can appear in `endings` with objectiveCount 0: the branch\n' +
  '  // is real (the chapter quest references its gate sub-quest) but this capture holds\n' +
  '  // no objective-level evidence for it.\n' +
  '  //\n' +
  '  // `mutuallyExclusiveQuestPairs` contains unordered pairs of resolved chapter\n' +
  '  // sub-quest ids that cannot both be completed, derived from fail-on-start/complete\n' +
  '  // and fail-only start conditions. Each pair is emitted once in id order. Partial\n' +
  '  // progress on both quests is allowed: these are NOT objective exclusions. Cascade\n' +
  '  // failure and counterparts outside the resolved chapter sub-quests are excluded.\n' +
  '  //\n' +
  '  // Regenerate with `npm run eft:story`; the exact source capture is pinned by\n' +
  '  // scripts/story-reference.lock.json.\n' +
  '  // The storyline is shared between PVP and PVE.\n' +
  '  //\n' +
  '  // Objectives can carry task-style marker data (maps, zones, possibleLocations,\n' +
  '  // requiredKeys, item/items/markerItem/questItem, count, foundInRaid) for map\n' +
  '  // rendering; see docs/MASTER_SAMPLES.md.\n';

type StoryChapterMap = Record<string, Record<string, any>>;

/** Render the storyChapters JSON5 source file content (comment headers included). */
export function renderStoryChaptersJson5(data: StoryChapterMap): string {
  const ids = Object.keys(data).sort((a, b) => data[a].order - data[b].order);

  let out = '{\n';
  out += HEADER;

  for (const id of ids) {
    const chapter = data[id];
    const body = JSON5.stringify(chapter, { space: 4, quote: "'" })
      .split('\n')
      .map((line, i) => (i === 0 ? line : `  ${line}`))
      .join('\n');
    out += `\n  // ${chapter.name}\n`;
    out += `  // Source: ${chapter.wikiLink}\n`;
    out += `  ${JSON5.stringify(id, { quote: "'" })}: ${body},\n`;
  }
  out += '}\n';
  return out;
}

const WRITE_LOCK = join('data', 'eft', 'story-write.lock');

/**
 * A refusal the writer reports by name so publication can unwind and release the
 * write lock before the process exits. `process.exit()` skips `finally` blocks,
 * so a refusal raised inside {@link publishStory} must not exit directly or it
 * would leave a stale lock that blocks every later run.
 */
class PublicationRefused extends Error {}

/**
 * Serialize artifact publication across runs.
 *
 * Two writers publishing concurrently can interleave in a way the pre-write
 * binding check cannot detect: each one's rollback can land after the other
 * published, leaving one run's artifact beside the other's lock. An exclusive
 * lock file makes publication one at a time. A crashed run leaves the file
 * behind, so the refusal names the remedy rather than waiting or guessing.
 */
function acquireWriteLock(): () => void {
  mkdirSync(dirname(WRITE_LOCK), { recursive: true });
  let fd: number;
  try {
    fd = openSync(WRITE_LOCK, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new PublicationRefused(
        `error: ${WRITE_LOCK} exists, so another story run appears to be publishing. ` +
          'If no run is active (a crashed run leaves it behind), delete that file and retry.'
      );
    }
    throw error;
  }
  try {
    // Diagnostic only: tells a human which process left a stale lock behind.
    writeFileSync(fd, `${process.pid}\n`);
  } catch {
    // Never fail publication over the diagnostic payload.
  }
  return () => {
    closeSync(fd);
    rmSync(WRITE_LOCK, { force: true });
  };
}

function publishStory(): void {
  const input = process.argv[2] || 'data/eft/story-final.json';
  const raw = readFileSync(input, 'utf8');
  const data: StoryChapterMap = JSON.parse(raw);

  // Validate against the story-chapter schema before writing.
  const schema = JSON.parse(
    readFileSync(join('src', 'schemas', 'story-chapter.schema.json'), 'utf8')
  );
  const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
  if (!validate(data)) {
    const details = (validate.errors ?? [])
      .slice(0, 20)
      .map((error) => `  ${error.instancePath} ${error.message}`)
      .join('\n');
    throw new PublicationRefused(`story-chapter schema validation failed:\n${details}`);
  }

  const out = renderStoryChaptersJson5(data);
  const dest = join('src', 'additions', 'storyChapters.json5');
  const inputSha256 = createHash('sha256').update(raw).digest('hex');

  // A staged provenance binding is required for every artifact write, and it is
  // validated *before* the artifact is replaced. The writer cannot show on its
  // own that a payload came from the pinned capture - only the generator that
  // read that capture can - so an input with no binding, or one bound to
  // different bytes, is refused rather than published under the committed lock.
  // A refusal discovered after the write would leave freshly generated chapters
  // described by the previous capture's pin, so failing here leaves both the
  // artifact and the lock untouched.
  const staged = inspectStagedReferenceLock(inputSha256);
  if (staged.status !== 'ready') {
    const reason =
      staged.status === 'none'
        ? `no provenance binding has been staged at ${pendingLockSidecar(inputSha256)}`
        : staged.status === 'mismatched'
          ? 'the staged binding was generated for a different payload'
          : 'the staged binding could not be read as a complete lock';
    throw new PublicationRefused(
      `error: refusing to write ${dest}; ${reason}, so ${LOCK} could not be shown to ` +
        'describe this artifact. Run `npm run eft:story` so the generator stages a binding ' +
        'for the payload it emits.'
    );
  }

  // Preserve the committed artifact as a renameable backup instead of keeping its
  // bytes only in memory. Rollback must not allocate a full write: the failures
  // that trigger it (ENOSPC) tend to make every later write fail too, and a
  // failed rollback would pair the newly published artifact with the old lock. A
  // sibling directory keeps the rename on the destination filesystem.
  const backupDir = mkdtempSync(join(dirname(dest), `.${basename(dest)}-backup-`));
  const backupFile = join(backupDir, 'previous');
  let hasBackup = false;
  try {
    if (statSync(dest).isFile()) {
      renameSync(dest, backupFile);
      hasBackup = true;
    } else {
      throw new Error(`${dest} exists but is not a regular file`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      rmSync(backupDir, { recursive: true, force: true });
      throw error;
    }
    // ENOENT: nothing committed yet, so there is nothing to back up.
  }

  // Roll back only this run's publication. If another run has already replaced
  // the destination with different bytes, restoring our backup would clobber its
  // artifact while the lock may already name its capture, so leave it alone.
  const stillOurs = (): boolean => {
    try {
      return readFileSync(dest, 'utf8') === out;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
      throw error;
    }
  };
  const restore = (): void => {
    if (!stillOurs()) {
      console.error(`note: ${dest} was replaced by another run; leaving it in place.`);
      return;
    }
    if (hasBackup) renameSync(backupFile, dest);
    else rmSync(dest, { force: true });
  };
  const discardBackup = (): void => rmSync(backupDir, { recursive: true, force: true });

  try {
    writeFileAtomicSync(dest, out);
  } catch (error) {
    // The previous artifact is still in the backup (or there was none), so the
    // committed state is restored by a metadata-only rename.
    restore();
    discardBackup();
    throw error;
  }
  console.log(`wrote ${dest} (${out.length} bytes, ${Object.keys(data).length} chapters)`);

  // The artifact is on disk, so the staged binding can now be promoted. Doing it
  // here rather than before the write keeps the lock and the data it describes in
  // step: a failed redirect or a write error above leaves the previous pin
  // intact, matching the lock's purpose of recording which capture produced the
  // committed chapters. Only a sidecar the pre-write check found usable and bound
  // to this input reaches promotion, so this call is expected to succeed; it is
  // still checked rather than assumed, because the sidecar is a separate file that
  // could change between the two reads. If it does, the artifact is rolled back so
  // the pair never disagrees about which capture produced the committed chapters.
  let promoted: boolean;
  try {
    promoted = promoteStoryReferenceLock(inputSha256);
  } catch (error) {
    restore();
    discardBackup();
    console.error(
      `error: the source-capture lock could not be updated after ${dest} was written, so the ` +
        'artifact has been rolled back and the pin left unchanged.'
    );
    throw error;
  }

  if (!promoted) {
    restore();
    discardBackup();
    throw new PublicationRefused(
      `error: the staged binding at ${pendingLockSidecar(inputSha256)} was refused after ${dest} was ` +
        'written, so it changed mid-run. The artifact has been rolled back and the ' +
        'source-capture lock left unchanged. Re-run `npm run eft:story`.'
    );
  }

  discardBackup();
}

function main(): void {
  let release: (() => void) | null = null;
  try {
    release = acquireWriteLock();
    publishStory();
  } catch (error) {
    if (error instanceof PublicationRefused) {
      console.error(error.message);
      // Exit code rather than process.exit(): the finally below must run so a
      // refusal cannot leave the write lock behind.
      process.exitCode = 1;
      return;
    }
    throw error;
  } finally {
    release?.();
  }
}

if (isDirectExecution(import.meta.url)) {
  main();
}
