/**
 * Tarkov.dev API client
 *
 * Provides a clean interface for querying the tarkov.dev GraphQL API.
 * Separates API concerns from validation and presentation logic.
 */

import type { TaskData } from "./types.js";

const TARKOV_API = "https://api.tarkov.dev/graphql";

function getValueType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * GraphQL query fragments for fetching all tasks with their details.
 * Keep the main and fallback queries identical except for usingWeapon.
 */
const TASK_OBJECTIVE_SHOOT_WITH_USING_WEAPON = `
          count
          usingWeapon { id name shortName }
          usingWeaponMods { id name shortName }
          wearing { id name shortName }
          notWearing { id name shortName }
          requiredKeys { id name shortName }
`;

const TASK_OBJECTIVE_SHOOT_WITHOUT_USING_WEAPON = `
          count
          usingWeaponMods { id name shortName }
          wearing { id name shortName }
          notWearing { id name shortName }
          requiredKeys { id name shortName }
`;

function buildTasksQuery(taskObjectiveShootFields: string): string {
  return `
  query($gameMode: GameMode) {
    tasks(lang: en, gameMode: $gameMode) {
      id
      name
      minPlayerLevel
      wikiLink
      kappaRequired
      lightkeeperRequired
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
        compareMethod
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
        ... on TaskObjectiveShoot {${taskObjectiveShootFields}
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
        achievement {
          id
          name
          description
        }
        customization {
          id
          name
          customizationType
          customizationTypeName
          imageLink
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
        achievement {
          id
          name
          description
        }
        customization {
          id
          name
          customizationType
          customizationTypeName
          imageLink
        }
      }
    }
  }
`;
}

const TASKS_QUERY = buildTasksQuery(TASK_OBJECTIVE_SHOOT_WITH_USING_WEAPON);
const TASKS_QUERY_WITHOUT_USING_WEAPON = buildTasksQuery(
  TASK_OBJECTIVE_SHOOT_WITHOUT_USING_WEAPON
);

class GraphQLRequestError extends Error {
  constructor(readonly graphQLErrors: unknown[]) {
    super(`GraphQL errors: ${JSON.stringify(graphQLErrors)}`);
    this.name = "GraphQLRequestError";
  }
}

const MISSING_ITEM_MESSAGE_PATTERN = /no\s+item|not\s+found|undefined/i;

function getGraphQLErrorsFromMessage(message: string): unknown[] | undefined {
  const prefix = "GraphQL errors: ";
  const json = message.startsWith(prefix) ? message.slice(prefix.length) : message;

  try {
    const parsed = JSON.parse(json) as unknown;
    if (Array.isArray(parsed)) return parsed;

    if (parsed && typeof parsed === "object" && "errors" in parsed) {
      const errors = (parsed as { errors?: unknown }).errors;
      if (Array.isArray(errors)) return errors;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function hasUsingWeaponPath(path: unknown): boolean {
  return Array.isArray(path) && path.includes("usingWeapon");
}

function hasMissingItemMessage(message: unknown): boolean {
  return MISSING_ITEM_MESSAGE_PATTERN.test(String(message ?? ""));
}

function getGraphQLErrorsFromError(
  error: unknown,
  message: string
): unknown[] | undefined {
  if (error instanceof GraphQLRequestError) return error.graphQLErrors;

  if (error && typeof error === "object" && "graphQLErrors" in error) {
    const graphQLErrors = (error as { graphQLErrors?: unknown }).graphQLErrors;
    if (Array.isArray(graphQLErrors)) return graphQLErrors;
  }

  return getGraphQLErrorsFromMessage(message);
}

function isMissingUsingWeaponItemError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const graphQLErrors = getGraphQLErrorsFromError(error, message);

  if (graphQLErrors) {
    return graphQLErrors.length > 0 && graphQLErrors.every((entry) => {
      if (!entry || typeof entry !== "object") return false;
      const graphQLError = entry as { message?: unknown; path?: unknown };
      return (
        hasUsingWeaponPath(graphQLError.path) &&
        hasMissingItemMessage(graphQLError.message)
      );
    });
  }

  return message.includes("usingWeapon") && MISSING_ITEM_MESSAGE_PATTERN.test(message);
}

/**
 * Execute a GraphQL query against the tarkov.dev API
 */
async function executeQuery<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const response = await fetch(TARKOV_API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(
      `API request failed: ${response.status} ${response.statusText}`
    );
  }

  const result = await response.json();

  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error(
      `Invalid GraphQL response: expected an object, got ${getValueType(result)}`
    );
  }

  if ("errors" in result) {
    const errors = (result as { errors?: unknown }).errors;
    if (Array.isArray(errors)) {
      throw new GraphQLRequestError(errors);
    }
    throw new Error(`GraphQL errors: ${JSON.stringify(errors)}`);
  }

  if (!("data" in result)) {
    throw new Error("Invalid GraphQL response: missing data field");
  }

  return result.data;
}

/**
 * Fetch all tasks from tarkov.dev API
 */
export async function fetchTasks(gameMode?: 'regular' | 'pve'): Promise<TaskData[]> {
  const variables = gameMode ? { gameMode } : undefined;
  let data: unknown;

  try {
    data = await executeQuery<unknown>(TASKS_QUERY, variables);
  } catch (error) {
    if (!isMissingUsingWeaponItemError(error)) throw error;
    data = await executeQuery<unknown>(
      TASKS_QUERY_WITHOUT_USING_WEAPON,
      variables
    );
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(
      `Invalid GraphQL response: expected data to be an object, got ${getValueType(data)}`
    );
  }

  if (!("tasks" in data)) {
    throw new Error("Invalid GraphQL response: missing data.tasks");
  }

  const tasks = (data as { tasks: unknown }).tasks;
  if (!Array.isArray(tasks)) {
    throw new Error(
      `Invalid GraphQL response: expected data.tasks to be an array, got ${getValueType(tasks)}`
    );
  }

  return tasks as TaskData[];
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
