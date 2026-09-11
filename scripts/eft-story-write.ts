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
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import JSON5 from 'json5';
import Ajv from 'ajv';
import { isDirectExecution } from '../src/lib/index.js';
import { promoteStoryReferenceLock } from './eft-story-generate.js';

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
  writeFileSync(dest, out);
  console.log(`wrote ${dest} (${out.length} bytes, ${Object.keys(data).length} chapters)`);

  // The artifact is on disk, so a staged re-pin can now be applied. Doing it here
  // rather than in the generator keeps the lock and the data it describes in
  // step: a failed redirect or a write error above leaves the previous pin
  // intact, matching the lock's purpose of recording which capture produced the
  // committed chapters. The hash ties the pin to this exact input, so a sidecar
  // left over from an unrelated generation is discarded instead of applied.
  promoteStoryReferenceLock(createHash('sha256').update(raw).digest('hex'));
}

if (isDirectExecution(import.meta.url)) {
  main();
}
