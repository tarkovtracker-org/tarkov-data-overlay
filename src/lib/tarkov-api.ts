/**
 * Tarkov.dev API client
 *
 * Provides a clean interface for querying the tarkov.dev GraphQL API.
 * Separates API concerns from validation and presentation logic.
 */

import type { TaskData } from "./types.js";

const TARKOV_API = "https://api.tarkov.dev/graphql";

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
      map {
        id
        name
      }
      experience
      taskRequirements {
        task {
          id
          name
        }
        status
      }
      traderRequirements {
        trader {
          id
          name
        }
        value
      }
      factionName
      requiredPrestige {
        id
        name
        prestigeLevel
      }
      objectives {
        id
        type
        description
        maps {
          id
          name
        }
        ... on TaskObjectiveBasic {
          requiredKeys { id name shortName }
        }
        ... on TaskObjectiveMark {
          markerItem { id name shortName }
          requiredKeys { id name shortName }
        }
        ... on TaskObjectiveExtract {
          requiredKeys { id name shortName }
        }
        ... on TaskObjectiveShoot {
          count
          usingWeapon { id name shortName }
          usingWeaponMods { id name shortName }
          requiredKeys { id name shortName }
        }
        ... on TaskObjectiveItem {
          count
          items { id name shortName }
          foundInRaid
          requiredKeys { id name shortName }
        }
        ... on TaskObjectiveQuestItem {
          count
          questItem { id name shortName }
          requiredKeys { id name shortName }
        }
        ... on TaskObjectiveUseItem {
          count
          useAny { id name shortName }
          requiredKeys { id name shortName }
        }
        ... on TaskObjectiveBuildItem {
          item { id name shortName }
          containsAll { id name shortName }
        }
      }
      startRewards {
        items { item { id name shortName } count }
        traderStanding { trader { id name } standing }
        offerUnlock { id trader { id name } level item { id name shortName } }
        skillLevelReward {
          name
          level
          skill {
            id
            name
            imageLink
          }
        }
        traderUnlock {
          id
          name
        }
      }
      finishRewards {
        items { item { id name shortName } count }
        traderStanding { trader { id name } standing }
        offerUnlock { id trader { id name } level item { id name shortName } }
        skillLevelReward {
          name
          level
          skill {
            id
            name
            imageLink
          }
        }
        traderUnlock {
          id
          name
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
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });

  if (!response.ok) {
    throw new Error(
      `API request failed: ${response.status} ${response.statusText}`
    );
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
export function findTaskById(
  tasks: TaskData[],
  taskId: string
): TaskData | undefined {
  return tasks.find((t) => t.id === taskId);
}
