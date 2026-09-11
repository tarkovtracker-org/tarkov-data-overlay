#!/usr/bin/env tsx
/**
 * Assemble src/additions/storyChapters.json5 from the deterministic EFT story
 * generation. Reads the generator's JSON (default data/eft/story-final.json, or
 * argv[2]), validates it against story-chapter.schema.json, and writes JSON5
 * with comment headers, chapters ordered by `order`.
 *
 * Run via: npm run eft:story  (or: tsx scripts/eft-story-write.ts <input.json>)
 */

import { createHash } from 'crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import JSON5 from 'json5';
import Ajv from 'ajv';
import { isDirectExecution } from '../src/lib/index.js';
import {
  inspectStagedReferenceLock,
  PENDING_LOCK_SIDECAR,
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

function main(): void {
  const input = process.argv[2] || 'data/eft/story-final.json';
  const raw = readFileSync(input, 'utf8');
  const data: StoryChapterMap = JSON.parse(raw);

  // Validate against the story-chapter schema before writing.
  const schema = JSON.parse(
    readFileSync(join('src', 'schemas', 'story-chapter.schema.json'), 'utf8')
  );
  const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
  if (!validate(data)) {
    console.error('story-chapter schema validation failed:');
    for (const error of (validate.errors ?? []).slice(0, 20)) {
      console.error(`  ${error.instancePath} ${error.message}`);
    }
    process.exit(1);
  }

  const out = renderStoryChaptersJson5(data);
  const dest = join('src', 'additions', 'storyChapters.json5');
  const inputSha256 = createHash('sha256').update(raw).digest('hex');

  // A staged re-pin is validated *before* the artifact is replaced. Promotion can
  // legitimately refuse (a sidecar left by an unrelated generation, or a corrupt
  // one), and a refusal discovered after the write would leave freshly generated
  // chapters described by the previous pin - exactly the mismatch the lock exists
  // to prevent. Failing here leaves both the artifact and the lock untouched.
  const staged = inspectStagedReferenceLock(inputSha256);
  if (staged.status === 'mismatched' || staged.status === 'unusable') {
    const reason =
      staged.status === 'mismatched'
        ? 'it was generated for different output than the input just read'
        : 'it could not be read as a lock';
    console.error(
      `error: refusing to write ${dest}; a re-pin is staged at ${PENDING_LOCK_SIDECAR} but ` +
        `${reason}, so the lock cannot describe this artifact. Remove the sidecar, or re-run ` +
        'the generator with STORY_REFERENCE_UPDATE_LOCK=1 to stage a matching re-pin.'
    );
    process.exit(1);
  }

  const previous = existsSync(dest) ? readFileSync(dest) : null;
  writeFileSync(dest, out);
  console.log(`wrote ${dest} (${out.length} bytes, ${Object.keys(data).length} chapters)`);

  // The artifact is on disk, so a staged re-pin can now be applied. Doing it here
  // rather than before the write keeps the lock and the data it describes in
  // step: a failed redirect or a write error above leaves the previous pin
  // intact, matching the lock's purpose of recording which capture produced the
  // committed chapters. Only a sidecar the pre-write check found usable and bound
  // to this input reaches promotion, so this call is expected to succeed; it is
  // still checked rather than assumed, because the sidecar is a separate file that
  // could change between the two reads. If it does, the artifact is rolled back so
  // the pair never disagrees about which capture produced the committed chapters.
  if (staged.status === 'ready' && !promoteStoryReferenceLock(inputSha256)) {
    if (previous === null) rmSync(dest, { force: true });
    else writeFileSync(dest, previous);
    console.error(
      `error: the staged re-pin at ${PENDING_LOCK_SIDECAR} was refused after ${dest} was ` +
        'written, so it changed mid-run. The artifact has been rolled back and the ' +
        'source-capture lock left unchanged. Re-run the generator with ' +
        'STORY_REFERENCE_UPDATE_LOCK=1 to re-pin.'
    );
    process.exit(1);
  }
}

if (isDirectExecution(import.meta.url)) {
  main();
}
