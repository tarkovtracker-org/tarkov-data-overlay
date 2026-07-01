// Assemble src/additions/storyChapters.json5 from the deterministic EFT story
// generation. Reads the generator's JSON (default /tmp/story-final-raw.json, or
// argv[2]), validates it against story-chapter.schema.json, and writes JSON5 with
// comment headers, chapters ordered by `order`.
// Run via: npm run eft:story  (or: node scripts/eft-story-write.cjs <input.json>)
const fs = require('fs');
const path = require('path');
const JSON5 = require('json5');
const Ajv = require('ajv');

const input = process.argv[2] || '/tmp/story-final-raw.json';
const data = JSON.parse(fs.readFileSync(input, 'utf8'));

// Validate against the story-chapter schema before writing.
const schema = JSON.parse(
  fs.readFileSync(path.join('src', 'schemas', 'story-chapter.schema.json'), 'utf8')
);
const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
if (!validate(data)) {
  console.error('story-chapter schema validation failed:');
  for (const e of (validate.errors || []).slice(0, 20)) {
    console.error(`  ${e.instancePath} ${e.message}`);
  }
  process.exit(1);
}

const ids = Object.keys(data).sort((a, b) => data[a].order - data[b].order);

let out = '{\n';
out +=
  '  // Story chapters (Edge of Darkness storyline) - not present in the tarkov.dev API.\n' +
  '  //\n' +
  '  // Source: local quest reference (structure/ordering) cross-referenced with the\n' +
  '  // EFT wiki (objective text + optional/required flags). Chapters are the storyline\n' +
  '  // narrator-trader quests; objectives are the ordered sub-quest references. Optional\n' +
  '  // flags come from the wiki. Chapter ordering, wikiLink, activation, and requirements\n' +
  '  // are curated (scripts/story-chapter-meta.json). Each objective records\n' +
  '  // sourceQuestId/sourceObjectiveId for traceability. The Ticket keeps its curated\n' +
  '  // branching (endings + mutual exclusion). Regenerate with `npm run eft:story`.\n' +
  '  // The storyline is shared between PVP and PVE.\n' +
  '  //\n' +
  '  // Objectives can carry task-style marker data (maps, zones, possibleLocations,\n' +
  '  // requiredKeys, item/items/markerItem/questItem, count, foundInRaid) for map\n' +
  '  // rendering; see docs/MASTER_SAMPLES.md.\n';

for (const id of ids) {
  const ch = data[id];
  const body = JSON5.stringify(ch, { space: 4, quote: "'" })
    .split('\n')
    .map((line, i) => (i === 0 ? line : '  ' + line))
    .join('\n');
  out += `\n  // ${ch.name}\n`;
  out += `  // Source: ${ch.wikiLink}\n`;
  out += `  ${JSON5.stringify(id, { quote: "'" })}: ${body},\n`;
}
out += '}\n';

const dest = path.join('src', 'additions', 'storyChapters.json5');
fs.writeFileSync(dest, out);
console.log(`wrote ${dest} (${out.length} bytes, ${ids.length} chapters)`);
