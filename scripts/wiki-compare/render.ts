/** Console presentation for wiki discrepancies; comparison policy lives in compare.ts. */
import { printHeader, bold, dim, colorize } from '../../src/lib/index.js';
import type { Discrepancy, Priority, GroupBy } from './types.js';

export function renderDiscrepancies(newDiscrepancies: Discrepancy[], groupBy: GroupBy): void {
  if (newDiscrepancies.length > 0) {
    // Priority order and labels
    const priorityOrder: Priority[] = ['high', 'medium', 'low'];
    const priorityLabels: Record<Priority, string> = {
      high: colorize('[HIGH]', 'red'),
      medium: colorize('[MEDIUM]', 'yellow'),
      low: colorize('[LOW]', 'green'),
    };

    const priorityIcons: Record<Priority, string> = {
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
    const getCategoryLabel = (field: string): string => {
      if (field.startsWith('reputation.')) {
        const trader = field.replace('reputation.', '');
        return `Reward: Reputation (${trader})`;
      }
      return categoryLabels[field] ?? field;
    };

    // Helper to print a single discrepancy
    const printDiscrepancy = (
      d: Discrepancy,
      showPriority: boolean,
      showCategory: boolean
    ): void => {
      const freshness =
        d.wikiEditedPost1_0 === true
          ? colorize('[POST-1.0]', 'green')
          : d.wikiEditedPost1_0 === false
            ? colorize('[PRE-1.0]', 'red')
            : dim('[UNKNOWN]');
      const editInfo = d.wikiEditDaysAgo !== undefined ? `${d.wikiEditDaysAgo}d ago` : '';
      const priorityPrefix = showPriority ? `${priorityIcons[d.priority]} ` : '  ';
      const categoryInfo = showCategory ? ` ${dim(`[${getCategoryLabel(d.field)}]`)}` : '';

      console.log(`\n${priorityPrefix}${d.taskName}${categoryInfo}`);
      console.log(`    ${dim(`ID: ${d.taskId}`)}`);
      console.log(`    API:  ${d.apiValue}`);
      console.log(`    Wiki: ${d.wikiValue} ${d.trustsWiki ? dim('← likely correct') : ''}`);
      if (editInfo) {
        console.log(`    ${dim(`Wiki edit: ${freshness} ${editInfo}`)}`);
      }
    };

    // Group by priority
    const byPriority = new Map<Priority, Discrepancy[]>();
    for (const p of priorityOrder) {
      byPriority.set(p, []);
    }
    for (const d of newDiscrepancies) {
      byPriority.get(d.priority)!.push(d);
    }

    // Group by category
    const byCategory = new Map<string, Discrepancy[]>();
    for (const d of newDiscrepancies) {
      const field = d.field;
      if (!byCategory.has(field)) byCategory.set(field, []);
      byCategory.get(field)!.push(d);
    }

    const sortedCategories = Array.from(byCategory.keys()).sort((a, b) => {
      const aIdx = categoryOrder.indexOf(a);
      const bIdx = categoryOrder.indexOf(b);
      if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
      if (aIdx !== -1) return -1;
      if (bIdx !== -1) return 1;
      return a.localeCompare(b);
    });

    // Print summary
    printHeader('SUMMARY');
    console.log(`  Grouping by: ${bold(groupBy.toUpperCase())}`);
    console.log();
    console.log('  By Priority:');
    for (const p of priorityOrder) {
      const count = byPriority.get(p)!.length;
      if (count > 0) {
        console.log(`    ${priorityLabels[p]}: ${count}`);
      }
    }
    console.log();
    console.log('  By Category:');
    for (const field of sortedCategories) {
      const discs = byCategory.get(field)!;
      const label = getCategoryLabel(field);
      console.log(`    ${label}: ${discs.length}`);
    }
    console.log();

    // Print details based on groupBy mode
    if (groupBy === 'category') {
      printHeader('DISCREPANCIES BY CATEGORY');

      for (const field of sortedCategories) {
        const discs = byCategory.get(field)!;
        const label = getCategoryLabel(field);

        // Sort by priority within category (high first)
        discs.sort((a, b) => {
          const order = { high: 0, medium: 1, low: 2 };
          return order[a.priority] - order[b.priority];
        });

        console.log(`\n${'─'.repeat(60)}`);
        console.log(`${bold(label)} (${discs.length})`);
        console.log(`${'─'.repeat(60)}`);

        for (const d of discs) {
          printDiscrepancy(d, true, false);
        }
      }
    } else {
      // groupBy === 'priority'
      printHeader('DISCREPANCIES BY PRIORITY');

      for (const p of priorityOrder) {
        const discs = byPriority.get(p)!;
        if (discs.length === 0) continue;

        // Sort by category within priority
        discs.sort((a, b) => {
          const aIdx = categoryOrder.indexOf(a.field);
          const bIdx = categoryOrder.indexOf(b.field);
          if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
          if (aIdx !== -1) return -1;
          if (bIdx !== -1) return 1;
          return a.field.localeCompare(b.field);
        });

        console.log(`\n${'─'.repeat(60)}`);
        console.log(`${bold(priorityLabels[p])} (${discs.length})`);
        console.log(`${'─'.repeat(60)}`);

        for (const d of discs) {
          printDiscrepancy(d, false, true);
        }
      }
    }
    console.log();
  }
}
