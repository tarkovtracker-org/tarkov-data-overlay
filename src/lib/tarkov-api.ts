/**
 * Tarkov.dev API client
 *
 * Provides a clean interface for querying the tarkov.dev GraphQL API.
 * Separates API concerns from validation and presentation logic.
 */

import type { TaskData } from './types.js';

const TARKOV_API = 'https://api.tarkov.dev/graphql';

/**
 * GraphQL query for fetching all tasks with their details
 */
const TASKS_QUERY = `
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

/**
 * Execute a GraphQL query against the tarkov.dev API
 */
async function executeQuery<T>(query: string): Promise<T> {
  const response = await fetch(TARKOV_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });

  if (!response.ok) {
    throw new Error(`API request failed: ${response.status} ${response.statusText}`);
  }

  const result = await response.json();

  if (result.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(result.errors)}`);
  }

  return result.data;
}

/**
 * Fetch all tasks from tarkov.dev API
 */
export async function fetchTasks(): Promise<TaskData[]> {
  const data = await executeQuery<{ tasks: TaskData[] }>(TASKS_QUERY);
  return data.tasks;
}

/**
 * Find a task by ID from a list of tasks
 */
export function findTaskById(tasks: TaskData[], taskId: string): TaskData | undefined {
  return tasks.find(t => t.id === taskId);
}
