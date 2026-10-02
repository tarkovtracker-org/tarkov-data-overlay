/** Console presentation for wiki discrepancies; comparison policy lives in compare.ts. */
import { printHeader, bold, dim, colorize } from '../../src/lib/index.js';
import type { Discrepancy, Priority, GroupBy } from './types.js';

// Priority order and labels
const priorityOrder: Priority[] = ['high', 'medium', 'low'];
const priorityLabels: Record<Priority, string> = {
  high: colorize('[HIGH]', 'red'),
  medium: colorize('[MEDIUM]', 'yellow'),
  low: colorize('[LOW]', 'green'),
};

const categoryLabels: Record<string, string> = {
  minPlayerLevel: 'Level Requirements',
  traderRequirements: 'Trader Loyalty Requirements',
  scavKarma: 'Scav Karma Requirements',
  factionName: 'PMC Faction Restriction',
  taskRequirements: 'Task Prerequisites',
  nextTasks: 'Task Next / Unlocks',
  map: 'Task Map / Location',
  'objectives.description': 'Objective Descriptions',
  experience: 'Reward: Experience (XP)',
  money: 'Reward: Money (Roubles)',
  'objectives.count': 'Objective Counts',
  'objectives.maps': 'Objective Maps / Locations',
  'objectives.items': 'Objective Required Items',
};

// Define category display order (most important first)
const categoryOrder = [
  'minPlayerLevel',
  'traderRequirements',
  'scavKarma',
  'factionName',
  'taskRequirements',
  'nextTasks',
  'map',
  'objectives.description',
  'objectives.count',
  'objectives.maps',
  'objectives.items',
  'experience',
  'money',
  // Reputation fields will be sorted alphabetically after these
];

// Helper to get category label (handles dynamic reputation.TraderName fields)
function getCategoryLabel(field: string): string {
  if (field.startsWith('reputation.')) {
    const trader = field.replace('reputation.', '');
    return `Reward: Reputation (${trader})`;
  }
  return categoryLabels[field] ?? field;
}

// Helper to print a single discrepancy
function printDiscrepancy(d: Discrepancy, showPriority: boolean, showCategory: boolean): void {
  const freshness =
    d.wikiEditedPost1_0 === true
      ? colorize('[POST-1.0]', 'green')
      : d.wikiEditedPost1_0 === false
        ? colorize('[PRE-1.0]', 'red')
        : dim('[UNKNOWN]');
  const editInfo = d.wikiEditDaysAgo !== undefined ? `${d.wikiEditDaysAgo}d ago` : '';
  const priorityPrefix = showPriority ? `${priorityLabels[d.priority]} ` : '  ';
  const categoryInfo = showCategory ? ` ${dim(`[${getCategoryLabel(d.field)}]`)}` : '';

  console.log(`\n${priorityPrefix}${d.taskName}${categoryInfo}`);
  console.log(`    ${dim(`ID: ${d.taskId}`)}`);
  console.log(`    API:  ${d.apiValue}`);
  console.log(`    Wiki: ${d.wikiValue} ${d.trustsWiki ? dim('← likely correct') : ''}`);
  if (editInfo) {
    console.log(`    ${dim(`Wiki edit: ${freshness} ${editInfo}`)}`);
  }
}

function compareCategory(a: string, b: string): number {
  const aIdx = categoryOrder.indexOf(a);
  const bIdx = categoryOrder.indexOf(b);
  if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
  if (aIdx !== -1) return -1;
  if (bIdx !== -1) return 1;
  return a.localeCompare(b);
}

function groupDiscrepancies(discrepancies: Discrepancy[]) {
  const byPriority = new Map(priorityOrder.map((p) => [p, [] as Discrepancy[]]));
  const byCategory = new Map<string, Discrepancy[]>();
  for (const d of discrepancies) {
    byPriority.get(d.priority)!.push(d);
    if (!byCategory.has(d.field)) byCategory.set(d.field, []);
    byCategory.get(d.field)!.push(d);
  }
  return {
    byPriority,
    byCategory,
    sortedCategories: Array.from(byCategory.keys()).sort(compareCategory),
  };
}

type Groups = ReturnType<typeof groupDiscrepancies>;

function printSummary(
  { byPriority, byCategory, sortedCategories }: Groups,
  groupBy: GroupBy
): void {
  printHeader('SUMMARY');
  console.log(`  Grouping by: ${bold(groupBy.toUpperCase())}`);
  console.log();
  console.log('  By Priority:');
  for (const p of priorityOrder) {
    const count = byPriority.get(p)!.length;
    if (count > 0) console.log(`    ${priorityLabels[p]}: ${count}`);
  }
  console.log();
  console.log('  By Category:');
  for (const field of sortedCategories)
    console.log(`    ${getCategoryLabel(field)}: ${byCategory.get(field)!.length}`);
  console.log();
}

function printGroup(label: string, discrepancies: Discrepancy[], showPriority: boolean): void {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`${bold(label)} (${discrepancies.length})`);
  console.log(`${'─'.repeat(60)}`);
  for (const d of discrepancies) printDiscrepancy(d, showPriority, !showPriority);
}

function renderCategories({ byCategory, sortedCategories }: Groups): void {
  printHeader('DISCREPANCIES BY CATEGORY');
  const order = { high: 0, medium: 1, low: 2 };
  for (const field of sortedCategories) {
    const discs = byCategory.get(field)!;
    discs.sort((a, b) => order[a.priority] - order[b.priority]);
    printGroup(getCategoryLabel(field), discs, true);
  }
}

function renderPriorities({ byPriority }: Groups): void {
  printHeader('DISCREPANCIES BY PRIORITY');
  for (const p of priorityOrder) {
    const discs = byPriority.get(p)!;
    if (discs.length === 0) continue;
    discs.sort((a, b) => compareCategory(a.field, b.field));
    printGroup(priorityLabels[p], discs, false);
  }
}

export function renderDiscrepancies(discrepancies: Discrepancy[], groupBy: GroupBy): void {
  if (discrepancies.length === 0) return;
  const groups = groupDiscrepancies(discrepancies);
  printSummary(groups, groupBy);
  if (groupBy === 'category') renderCategories(groups);
  else renderPriorities(groups);
  console.log();
}
