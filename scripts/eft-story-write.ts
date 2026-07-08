#!/usr/bin/env tsx
/**
 * Assemble src/additions/storyChapters.json5 from the deterministic EFT story
 * generation. Reads the generator's JSON (default data/eft/story-final.json, or
 * argv[2]), validates it against story-chapter.schema.json, and writes JSON5
 * with comment headers, chapters ordered by `order`.
 *
 * Run via: npm run eft:story  (or: tsx scripts/eft-story-write.ts <input.json>)
 */

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import JSON5 from 'json5';
import Ajv from 'ajv';
import { isDirectExecution } from '../src/lib/index.js';

const HEADER =
  '  // Story chapters (Edge of Darkness storyline) - not present in the tarkov.dev API.\n' +
  '  //\n' +
  '  // Source: local quest reference (structure/ordering) cross-referenced with the\n' +
  '  // EFT wiki (objective text + optional/required flags). Chapters are the storyline\n' +
  '  // narrator-trader quests; objectives are the ordered sub-quest references. Optional\n' +
  '  // flags come from the wiki. Chapter ordering, wikiLink, activation, and requirements\n' +
  '  // are curated (scripts/story-chapter-meta.json). Each generated objective id is\n' +
  '  // the stable source objective id, with sourceQuestId linking to its sub-quest\n' +
  "  // (The Ticket keeps its curated branching objectives). Regenerate with `npm run eft:story`.\n" +
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
  const data: StoryChapterMap = JSON.parse(readFileSync(input, 'utf8'));

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
}

if (isDirectExecution(import.meta.url)) {
  main();
}
