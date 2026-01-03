/**
 * Shared type definitions
 *
 * Centralizes types used across multiple scripts to ensure consistency
 * and eliminate duplication.
 */

/** Task override structure for corrections */
export interface TaskOverride {
  name?: string;
  minPlayerLevel?: number;
  wikiLink?: string;
  disabled?: boolean;
  map?: { id: string; name: string } | null;
  kappaRequired?: boolean;
  lightkeeperRequired?: boolean;
  objectives?: Record<string, ObjectiveOverride>;
  objectivesAdd?: ObjectiveAdd[];
  taskRequirements?: TaskRequirement[];
  experience?: number;
  finishRewards?: TaskFinishRewards;
}

/** Task completion rewards */
export interface TaskFinishRewards {
  items?: Array<{ item: { id?: string; name: string; shortName?: string }; count: number }>;
  traderStanding?: Array<{ trader: { id?: string; name: string }; standing: number }>;
}

/** Task objective from tarkov.dev API */
export interface TaskObjective {
  id: string;
  type?: string;
  description?: string;
  count?: number;
  maps?: Array<{ id: string; name: string }>;
  items?: TaskItemRef[];
  markerItem?: TaskItemRef;
  questItem?: TaskItemRef;
  useAny?: TaskItemRef[];
  usingWeapon?: TaskItemRef[];
  usingWeaponMods?: Array<TaskItemRef[]>;
  item?: TaskItemRef;
  containsAll?: TaskItemRef[];
  requiredKeys?: Array<TaskItemRef[]>;
  foundInRaid?: boolean;
}

/** Task item reference */
export interface TaskItemRef {
  id: string;
  name: string;
  shortName?: string;
}

/** Objective override for nested corrections */
export interface ObjectiveOverride extends Omit<Partial<TaskObjective>, "id"> {}

/** Objective addition for missing objectives */
/** Task item reference for added objectives (allows name-only references) */
export interface TaskItemRefAdd {
  id?: string;
  name: string;
  shortName?: string;
}

/** Objective addition for missing objectives */
export interface ObjectiveAdd
  extends Omit<Partial<TaskObjective>, "id" | "description" | "items"> {
  id: string;
  description: string;
  items?: TaskItemRefAdd[];
}

/** Task requirement reference */
export interface TaskRequirement {
  task: { id: string; name: string };
  status?: string[];
}

/** Task addition structure for new tasks not in tarkov.dev */
export interface TaskAddition {
  id: string;
  name: string;
  wikiLink: string;
  trader: { id?: string; name: string };
  map?: { id: string; name: string } | null;
  maps?: Array<{ id: string; name: string }>;
  objectives: TaskObjectiveAdd[];
  taskRequirements?: TaskRequirement[];
  experience?: number;
  finishRewards?: TaskFinishRewards;
  kappaRequired?: boolean;
  lightkeeperRequired?: boolean;
  disabled?: boolean;
}

/** Objective definition for task additions */
export interface TaskObjectiveAdd
  extends Omit<Partial<TaskObjective>, "id" | "description"> {
  id: string;
  description: string;
}

/** Task data from tarkov.dev API */
export interface TaskData {
  id: string;
  name: string;
  minPlayerLevel?: number;
  wikiLink?: string;
  map?: { id: string; name: string } | null;
  taskRequirements?: TaskRequirement[];
  objectives?: TaskObjective[];
  experience?: number;
  finishRewards?: TaskFinishRewards;
}

/** Validation result for a single override */
export interface ValidationResult {
  id: string;
  name: string;
  status: ValidationStatus;
  stillNeeded: boolean;
  details: ValidationDetail[];
}

/** Possible validation statuses */
export type ValidationStatus =
  | "NEEDED"
  | "FIXED"
  | "NOT_FOUND"
  | "REMOVED_FROM_API";

/** Detail about a specific field validation */
export interface ValidationDetail {
  field: string;
  status: "needed" | "fixed" | "check" | "info";
  message: string;
}

/** Built overlay output structure */
export interface OverlayOutput {
  tasks?: Record<string, TaskOverride>;
  tasksAdd?: Record<string, TaskAddition>;
  items?: Record<string, unknown>;
  traders?: Record<string, unknown>;
  hideout?: Record<string, unknown>;
  editions?: Record<string, unknown>;
  $meta: OverlayMeta;
}

/** Overlay metadata */
export interface OverlayMeta {
  version: string;
  generated: string;
  sha256?: string;
}

/** Schema validation result */
export interface SchemaValidationResult {
  file: string;
  valid: boolean;
  errors?: string[];
}

/** Schema configuration for validation */
export interface SchemaConfig {
  /** File name pattern to match (e.g., "tasks.json5") */
  pattern: string;
  /** Path to schema file relative to schemas directory */
  schemaFile: string;
}

/** Default schema configurations */
export const SCHEMA_CONFIGS: SchemaConfig[] = [
  { pattern: "tasks.json5", schemaFile: "task-override.schema.json" },
  { pattern: "tasksAdd.json5", schemaFile: "task-additions.schema.json" },
  { pattern: "editions.json5", schemaFile: "edition.schema.json" },
];
