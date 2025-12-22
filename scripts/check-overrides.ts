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

import JSON5 from 'json5';
import { readFileSync } from 'fs';
import { join } from 'path';

// Color codes for terminal output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

interface TaskOverride {
  name?: string;
  minPlayerLevel?: number;
  wikiLink?: string;
  disabled?: boolean;
  objectives?: Record<string, { count?: number }>;
  taskRequirements?: Array<{ task: { id: string; name: string } }>;
}

interface TaskData {
  id: string;
  name: string;
  minPlayerLevel?: number;
  wikiLink?: string;
  taskRequirements?: Array<{ task: { id: string; name: string }; status?: string[] }>;
  objectives?: Array<{ id: string; count?: number }>;
}

interface ValidationResult {
  id: string;
  name: string;
  status: 'NEEDED' | 'FIXED' | 'NOT_FOUND' | 'REMOVED_FROM_API';
  stillNeeded: boolean;
  details: string[];
}

const TARKOV_API = 'https://api.tarkov.dev/graphql';

/**
 * Load task overrides from source file
 */
function loadTaskOverrides(): Record<string, TaskOverride> {
  const filePath = join(process.cwd(), 'src/overrides/tasks.json5');
  const content = readFileSync(filePath, 'utf-8');
  return JSON5.parse(content);
}

/**
 * Query tarkov.dev API for all tasks
 */
async function fetchTasksFromAPI(): Promise<TaskData[]> {
  const query = `
    query {
      tasks(lang: en) {
        id
        name
        minPlayerLevel
        wikiLink
        taskRequirements {
          task {
            id
            name
          }
          status
        }
        objectives {
          id
          ... on TaskObjectiveShoot {
            count
          }
          ... on TaskObjectiveItem {
            count
          }
          ... on TaskObjectiveQuestItem {
            count
          }
          ... on TaskObjectiveUseItem {
            count
          }
        }
      }
    }
  `;

  const response = await fetch(TARKOV_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });

  if (!response.ok) {
    throw new Error(`API request failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return data.data.tasks;
}

/**
 * Validate a single task override against API data
 */
function validateTaskOverride(
  taskId: string,
  override: TaskOverride,
  apiTasks: TaskData[]
): ValidationResult {
  const apiTask = apiTasks.find((t) => t.id === taskId);

  if (!apiTask) {
    return {
      id: taskId,
      name: 'Unknown',
      status: 'REMOVED_FROM_API',
      stillNeeded: false,
      details: ['Task not found in API - has been removed from tarkov.dev'],
    };
  }

  const details: string[] = [];
  let needsOverride = false;

  // Check if task has disabled flag
  if (override.disabled === true) {
    return {
      id: taskId,
      name: apiTask.name,
      status: 'REMOVED_FROM_API',
      stillNeeded: false,
      details: ['Task still in API but marked as disabled - should be removed from API or override can be removed'],
    };
  }

  // Check minPlayerLevel
  if (override.minPlayerLevel !== undefined) {
    if (apiTask.minPlayerLevel !== override.minPlayerLevel) {
      details.push(`minPlayerLevel: API=${apiTask.minPlayerLevel}, Override=${override.minPlayerLevel} - STILL NEEDED`);
      needsOverride = true;
    } else {
      details.push(`minPlayerLevel: ${apiTask.minPlayerLevel} - FIXED IN API`);
    }
  }

  // Check name
  if (override.name !== undefined) {
    if (apiTask.name !== override.name) {
      details.push(`name: API="${apiTask.name}", Override="${override.name}" - STILL NEEDED`);
      needsOverride = true;
    } else {
      details.push(`name: "${apiTask.name}" - FIXED IN API`);
    }
  }

  // Check wikiLink
  if (override.wikiLink !== undefined) {
    if (apiTask.wikiLink !== override.wikiLink) {
      details.push(`wikiLink: API="${apiTask.wikiLink}", Override="${override.wikiLink}" - STILL NEEDED`);
      needsOverride = true;
    } else {
      details.push(`wikiLink: FIXED IN API`);
    }
  }

  // Check taskRequirements
  if (override.taskRequirements !== undefined) {
    const apiReqs = (apiTask.taskRequirements || []).filter(r => !r.status || !r.status.includes('active'));
    const overrideReqs = override.taskRequirements;

    if (apiReqs.length === 0 && overrideReqs.length > 0) {
      details.push(`taskRequirements: API=[] (empty), Override has ${overrideReqs.length} requirement(s) - STILL NEEDED`);
      needsOverride = true;
    } else if (apiReqs.length > 0) {
      const apiReqIds = apiReqs.map(r => r.task?.id).sort();
      const overrideReqIds = overrideReqs.map(r => r.task?.id).sort();

      if (JSON.stringify(apiReqIds) !== JSON.stringify(overrideReqIds)) {
        details.push(`taskRequirements: API has different requirements (${apiReqIds.join(', ')}) vs Override (${overrideReqIds.join(', ')}) - NEEDS REVIEW`);
        needsOverride = true;
      } else {
        details.push(`taskRequirements: FIXED IN API`);
      }
    }
  }

  // Check objectives
  if (override.objectives !== undefined) {
    Object.keys(override.objectives).forEach((objId) => {
      const apiObj = apiTask.objectives?.find((o) => o.id === objId);
      const overrideCount = override.objectives![objId].count;

      if (!apiObj) {
        details.push(`objective ${objId}: Not found in API - CHECK MANUALLY`);
        needsOverride = true;
      } else if (overrideCount !== undefined && apiObj.count !== overrideCount) {
        details.push(`objective count: API=${apiObj.count}, Override=${overrideCount} - STILL NEEDED`);
        needsOverride = true;
      } else if (overrideCount !== undefined) {
        details.push(`objective count: ${apiObj.count} - FIXED IN API`);
      }
    });
  }

  return {
    id: taskId,
    name: apiTask.name,
    status: needsOverride ? 'NEEDED' : 'FIXED',
    stillNeeded: needsOverride,
    details,
  };
}

/**
 * Print validation results
 */
function printResults(results: ValidationResult[]): void {
  console.log('='.repeat(80));
  console.log(`${colors.bright}OVERLAY VALIDATION REPORT${colors.reset}`);
  console.log('='.repeat(80));
  console.log();

  // Print details for each task
  results.forEach((result) => {
    const statusIcon =
      result.status === 'NEEDED' ? `${colors.yellow}⚠️${colors.reset}` :
      result.status === 'FIXED' ? `${colors.green}✅${colors.reset}` :
      result.status === 'REMOVED_FROM_API' ? `${colors.red}🗑️${colors.reset}` :
      `${colors.red}❌${colors.reset}`;

    console.log(`${statusIcon} ${colors.bright}${result.name}${colors.reset} ${colors.gray}(${result.id})${colors.reset}`);
    result.details.forEach((detail) => {
      if (detail.includes('STILL NEEDED') || detail.includes('CHECK MANUALLY')) {
        console.log(`   ${colors.yellow}⚠️  ${detail}${colors.reset}`);
      } else if (detail.includes('FIXED IN API')) {
        console.log(`   ${colors.green}✅ ${detail}${colors.reset}`);
      } else {
        console.log(`   ${colors.cyan}ℹ️  ${detail}${colors.reset}`);
      }
    });
    console.log();
  });

  // Print summary
  console.log('='.repeat(80));
  console.log(`${colors.bright}SUMMARY${colors.reset}`);
  console.log('='.repeat(80));
  console.log();

  const stillNeeded = results.filter((r) => r.stillNeeded);
  const fixed = results.filter((r) => r.status === 'FIXED');
  const removedFromApi = results.filter((r) => r.status === 'REMOVED_FROM_API');

  console.log(`${colors.green}${colors.bright}✅ Still need overrides (${stillNeeded.length}):${colors.reset}`);
  if (stillNeeded.length > 0) {
    stillNeeded.forEach((r) => console.log(`  - ${r.name} (${r.id})`));
  } else {
    console.log(`  ${colors.gray}None${colors.reset}`);
  }
  console.log();

  console.log(`${colors.yellow}${colors.bright}🔄 Fixed in API, can remove (${fixed.length}):${colors.reset}`);
  if (fixed.length > 0) {
    fixed.forEach((r) => console.log(`  - ${r.name} (${r.id})`));
  } else {
    console.log(`  ${colors.gray}None${colors.reset}`);
  }
  console.log();

  console.log(`${colors.red}${colors.bright}🗑️  Removed from API, delete from overlay (${removedFromApi.length}):${colors.reset}`);
  if (removedFromApi.length > 0) {
    removedFromApi.forEach((r) => console.log(`  - ${r.name} (${r.id})`));
  } else {
    console.log(`  ${colors.gray}None${colors.reset}`);
  }
  console.log();

  // Print recommendation
  if (fixed.length > 0 || removedFromApi.length > 0) {
    console.log(`${colors.yellow}${colors.bright}💡 RECOMMENDATION:${colors.reset}`);
    console.log(`   Update src/overrides/tasks.json5 to remove ${fixed.length + removedFromApi.length} obsolete override(s)`);
    console.log();
  }
}

/**
 * Main validation function
 */
async function main(): Promise<void> {
  try {
    console.log(`${colors.cyan}Loading task overrides...${colors.reset}`);
    const overrides = loadTaskOverrides();
    const taskIds = Object.keys(overrides);
    console.log(`${colors.green}✓${colors.reset} Found ${taskIds.length} task override(s)\n`);

    console.log(`${colors.cyan}Fetching current data from tarkov.dev API...${colors.reset}`);
    const apiTasks = await fetchTasksFromAPI();
    console.log(`${colors.green}✓${colors.reset} Fetched ${apiTasks.length} tasks from API\n`);

    console.log(`${colors.cyan}Validating overrides...${colors.reset}\n`);
    const results = taskIds.map((taskId) =>
      validateTaskOverride(taskId, overrides[taskId], apiTasks)
    );

    printResults(results);

    // Exit with success
    process.exit(0);
  } catch (error) {
    console.error(`${colors.red}${colors.bright}Error during validation:${colors.reset}`, error);
    process.exit(1);
  }
}

// Run the script
main();
