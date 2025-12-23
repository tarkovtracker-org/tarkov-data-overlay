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
  map?: { id: string; name: string };
  kappaRequired?: boolean;
  lightkeeperRequired?: boolean;
  objectives?: Record<string, ObjectiveOverride>;
  taskRequirements?: TaskRequirement[];
}

/** Objective override for nested corrections */
export interface ObjectiveOverride {
  count?: number;
  description?: string;
  maps?: Array<{ id: string; name: string }>;
}

/** Task requirement reference */
export interface TaskRequirement {
  task: { id: string; name: string };
  status?: string[];
}

/** Task data from tarkov.dev API */
export interface TaskData {
  id: string;
  name: string;
  minPlayerLevel?: number;
  wikiLink?: string;
  map?: { id: string; name: string };
  taskRequirements?: TaskRequirement[];
  objectives?: TaskObjective[];
}

/** Task objective from tarkov.dev API */
export interface TaskObjective {
  id: string;
  description?: string;
  count?: number;
  maps?: Array<{ id: string; name: string }>;
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
export type ValidationStatus = 'NEEDED' | 'FIXED' | 'NOT_FOUND' | 'REMOVED_FROM_API';

/** Detail about a specific field validation */
export interface ValidationDetail {
  field: string;
  status: 'needed' | 'fixed' | 'check' | 'info';
  message: string;
}

/** Built overlay output structure */
export interface OverlayOutput {
  tasks?: Record<string, TaskOverride>;
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
  { pattern: 'tasks.json5', schemaFile: 'task-override.schema.json' },
  { pattern: 'editions.json5', schemaFile: 'edition.schema.json' },
];
