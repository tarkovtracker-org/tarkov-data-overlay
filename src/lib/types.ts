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
  factionName?: string;
  requiredPrestige?: { id?: string; name: string; prestigeLevel: number };
  objectives?: Record<string, ObjectiveOverride>;
  objectivesAdd?: ObjectiveAdd[];
  taskRequirements?: TaskRequirement[];
  traderRequirements?: Array<{
    trader: { id: string; name: string };
    value: number;
    compareMethod?: string;
  }>;
  experience?: number;
  startRewards?: TaskRewards;
  finishRewards?: TaskRewards;
}

/** Task completion rewards */
export interface TaskRewards {
  items?: Array<{ item: { id?: string; name: string; shortName?: string }; count: number }>;
  traderStanding?: Array<{ trader: { id?: string; name: string }; standing: number }>;
  offerUnlock?: Array<{
    id?: string;
    trader: { id?: string; name: string };
    level: number;
    item: { id?: string; name: string; shortName?: string };
  }>;
  skillLevelReward?: Array<{
    name: string;
    level: number;
    skill?: { id: string; name: string; imageLink?: string };
  }>;
  traderUnlock?: { id: string; name: string };
  achievement?: TaskAchievementReward[];
  customization?: TaskCustomizationReward[];
}

export interface TaskAchievementReward {
  id: string;
  name: string;
  description?: string;
}

export interface TaskCustomizationReward {
  id?: string;
  name: string;
  customizationType?: string;
  customizationTypeName?: string;
  imageLink?: string | null;
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
  zones?: ObjectiveZone[];
  possibleLocations?: ObjectivePossibleLocation[];
  wearing?: Array<TaskItemRef[]>;
  notWearing?: TaskItemRef[];
  minDurability?: number;
  maxDurability?: number;
  distance?: number;
  timeFromHour?: number;
  timeUntilHour?: number;
  optional?: boolean;
}

/** Task item reference */
export interface TaskItemRef {
  id: string;
  name: string;
  shortName?: string;
}

export interface ObjectiveZone {
  map?: { id: string; name: string };
  outline?: Array<{ x: number; y?: number; z: number }>;
  position?: { x: number; y?: number; z: number };
  top?: number;
  bottom?: number;
}

export interface ObjectiveZoneAdd extends Omit<ObjectiveZone, "map" | "outline"> {
  map: { id: string; name: string };
  outline: Array<{ x: number; y?: number; z: number }>;
}

export interface ObjectivePossibleLocation {
  map?: { id: string; name: string };
  positions?: Array<{ x: number; y?: number; z: number }>;
}

export interface ObjectivePossibleLocationAdd extends Omit<
  ObjectivePossibleLocation,
  "map" | "positions"
> {
  map: { id: string; name: string };
  positions: Array<{ x: number; y?: number; z: number }>;
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
  extends Omit<
    Partial<TaskObjective>,
    "id" | "description" | "items" | "zones" | "possibleLocations"
  > {
  id: string;
  description: string;
  items?: TaskItemRefAdd[];
  zones?: ObjectiveZoneAdd[];
  possibleLocations?: ObjectivePossibleLocationAdd[];
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
  minPlayerLevel?: number;
  factionName?: string;
  requiredPrestige?: { id?: string; name: string; prestigeLevel: number };
  objectives: TaskObjectiveAdd[];
  taskRequirements?: TaskRequirement[];
  traderRequirements?: Array<{
    trader: { id: string; name: string };
    value: number;
    compareMethod?: string;
  }>;
  experience?: number;
  startRewards?: TaskRewards;
  finishRewards?: TaskRewards;
  kappaRequired?: boolean;
  lightkeeperRequired?: boolean;
  disabled?: boolean;
}

/** Objective definition for task additions */
export interface TaskObjectiveAdd
  extends Omit<Partial<TaskObjective>, "id" | "description" | "zones" | "possibleLocations"> {
  id: string;
  description: string;
  zones?: ObjectiveZoneAdd[];
  possibleLocations?: ObjectivePossibleLocationAdd[];
}

/** Task data from tarkov.dev API */
export interface TaskData {
  id: string;
  name: string;
  minPlayerLevel?: number;
  wikiLink?: string;
  map?: { id: string; name: string } | null;
  kappaRequired?: boolean;
  lightkeeperRequired?: boolean;
  factionName?: string;
  requiredPrestige?: { id?: string; name: string; prestigeLevel: number };
  taskRequirements?: TaskRequirement[];
  traderRequirements?: Array<{
    trader: { id: string; name: string };
    value: number;
    compareMethod?: string;
  }>;
  objectives?: TaskObjective[];
  experience?: number;
  startRewards?: TaskRewards;
  finishRewards?: TaskRewards;
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

/** Story chapter structure for additions */
export interface StoryChapter {
  id: string;
  name: string;
  normalizedName: string;
  wikiLink: string;
  order: number;
  autoStart?: boolean;
  chapterRequirements?: Array<{ id: string; name: string }>;
  mapUnlocks?: Array<{ id: string; name: string }>;
  traderUnlocks?: Array<{ id: string; name: string }>;
}

/** Built overlay output structure */
export interface OverlayOutput {
  tasks?: Record<string, TaskOverride>;
  tasksAdd?: Record<string, TaskAddition>;
  items?: Record<string, unknown>;
  traders?: Record<string, unknown>;
  hideout?: Record<string, unknown>;
  editions?: Record<string, unknown>;
  storyChapters?: Record<string, StoryChapter>;
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
  { pattern: "storyChapters.json5", schemaFile: "story-chapter.schema.json" },
  { pattern: "itemsAdd.json5", schemaFile: "item-additions.schema.json" },
];
