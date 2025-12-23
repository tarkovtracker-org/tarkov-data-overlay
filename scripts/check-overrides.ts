#!/usr/bin/env tsx
/**
 * Validation script to check if overlay corrections are still needed
 *
 * This script queries the tarkov.dev API and compares current API data
 * with our overlay corrections to determine which overrides are still
 * necessary and which have been fixed upstream.
 *
 * Usage:
 *   npm run check-overrides
 *
 * Exit codes:
 *   0 - All overrides validated successfully
 *   1 - Error occurred during validation
 */

import { join } from 'path';
import {
  getProjectPaths,
  loadJson5File,
  colors,
  icons,
  bold,
  dim,
  printHeader,
  printProgress,
  printSuccess,
  printError,
  formatCountLabel,
  fetchTasks,
  validateAllOverrides,
  categorizeResults,
  type TaskOverride,
  type ValidationResult,
  type ValidationDetail,
} from '../src/lib/index.js';

const { srcDir } = getProjectPaths(import.meta.url);

/**
 * Load task overrides from source file
 */
function loadTaskOverrides(): Record<string, TaskOverride> {
  const filePath = join(srcDir, 'overrides', 'tasks.json5');
  return loadJson5File<Record<string, TaskOverride>>(filePath);
}

/**
 * Get status icon based on validation result status
 */
function getStatusIcon(status: ValidationResult['status']): string {
  switch (status) {
    case 'NEEDED':
      return icons.warning;
    case 'FIXED':
      return icons.success;
    case 'REMOVED_FROM_API':
      return icons.trash;
    default:
      return icons.error;
  }
}

/**
 * Get detail icon based on validation detail status
 */
function getDetailIcon(status: ValidationDetail['status']): string {
  switch (status) {
    case 'needed':
    case 'check':
      return icons.warning;
    case 'fixed':
      return icons.success;
    default:
      return icons.info;
  }
}

/**
 * Get detail color based on validation detail status
 */
function getDetailColor(status: ValidationDetail['status']): string {
  switch (status) {
    case 'needed':
    case 'check':
      return colors.yellow;
    case 'fixed':
      return colors.green;
    default:
      return colors.cyan;
  }
}

/**
 * Print validation results for all tasks
 */
function printResults(results: ValidationResult[]): void {
  printHeader('OVERLAY VALIDATION REPORT');

  // Print details for each task
  for (const result of results) {
    const icon = getStatusIcon(result.status);
    console.log(`${icon} ${bold(result.name)} ${dim(`(${result.id})`)}`);

    for (const detail of result.details) {
      const detailIcon = getDetailIcon(detail.status);
      const color = getDetailColor(detail.status);
      console.log(`   ${detailIcon} ${color}${detail.message}${colors.reset}`);
    }
    console.log();
  }

  // Print summary
  printHeader('SUMMARY');

  const { stillNeeded, fixed, removedFromApi } = categorizeResults(results);

  // Still needed
  console.log(formatCountLabel(`${icons.success} Still need overrides`, stillNeeded.length, 'green'));
  if (stillNeeded.length > 0) {
    for (const r of stillNeeded) {
      console.log(`  - ${r.name} (${r.id})`);
    }
  } else {
    console.log(`  ${dim('None')}`);
  }
  console.log();

  // Fixed in API
  console.log(formatCountLabel(`${icons.sync} Fixed in API, can remove`, fixed.length, 'yellow'));
  if (fixed.length > 0) {
    for (const r of fixed) {
      console.log(`  - ${r.name} (${r.id})`);
    }
  } else {
    console.log(`  ${dim('None')}`);
  }
  console.log();

  // Removed from API
  console.log(formatCountLabel(`${icons.trash} Removed from API, delete from overlay`, removedFromApi.length, 'red'));
  if (removedFromApi.length > 0) {
    for (const r of removedFromApi) {
      console.log(`  - ${r.name} (${r.id})`);
    }
  } else {
    console.log(`  ${dim('None')}`);
  }
  console.log();

  // Print recommendation
  const obsoleteCount = fixed.length + removedFromApi.length;
  if (obsoleteCount > 0) {
    console.log(`${icons.lightbulb} ${bold('RECOMMENDATION:')}`);
    console.log(`   Update src/overrides/tasks.json5 to remove ${obsoleteCount} obsolete override(s)`);
    console.log();
  }
}

/**
 * Main validation function
 */
async function main(): Promise<void> {
  try {
    printProgress('Loading task overrides...');
    const overrides = loadTaskOverrides();
    const taskCount = Object.keys(overrides).length;
    printSuccess(`Found ${taskCount} task override(s)\n`);

    printProgress('Fetching current data from tarkov.dev API...');
    const apiTasks = await fetchTasks();
    printSuccess(`Fetched ${apiTasks.length} tasks from API\n`);

    printProgress('Validating overrides...\n');
    const results = validateAllOverrides(overrides, apiTasks);

    printResults(results);

    process.exit(0);
  } catch (error) {
    printError('Error during validation:', error as Error);
    process.exit(1);
  }
}

main();
