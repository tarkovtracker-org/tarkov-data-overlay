/**
 * Shared types, priorities, and constants for the wiki-compare tool.
 *
 * Extracted from the former single-file scripts/wiki-compare.ts.
 */

import type { TaskData } from '../../src/lib/types.js';

/** Extended task data with rewards for comparison */
export type ExtendedTaskData = TaskData & {
  experience?: number;
  finishRewards?: {
    traderStanding?: Array<{ trader: { name: string }; standing: number }>;
    items?: Array<{ item: { name: string }; count: number }>;
  };
  gameModes?: ('regular' | 'pve')[];
};

export type ApiObjective = NonNullable<TaskData['objectives']>[number];

export type WikiObjective = {
  text: string;
  count?: number;
  pveCount?: number; // PvE-specific count when wiki shows different values
  maps?: string[];
  items?: string[];
  links?: string[];
};

export type WikiLink = {
  target: string;
  display?: string;
};

export type TraderReputation = {
  trader: string;
  value: number;
};

export type WikiRewards = {
  xp?: number;
  reputations: TraderReputation[];
  money?: number;
  items: Array<{ name: string; count: number }>;
  raw: string[];
};

export type WikiRelatedItem = {
  name: string;
  requirement?: string;
};

export type WikiTaskData = {
  pageTitle: string;
  requirements: string[];
  objectives: WikiObjective[];
  rewards: WikiRewards;
  minPlayerLevel?: number;
  previousTasks: string[];
  nextTasks: string[];
  maps: string[];
  relatedItems: WikiRelatedItem[];
  relatedRequiredItems: string[];
  relatedHandoverItems: string[];
  lastRevision?: {
    timestamp: string;
    user: string;
    comment: string;
  };
};

export type GroupBy = 'priority' | 'category';

export type CliOptions = {
  id?: string;
  name?: string;
  wiki?: string;
  all?: boolean;
  useCache?: boolean;
  refresh?: boolean;
  output?: string;
  gameMode?: 'regular' | 'pve' | 'both';
  groupBy?: GroupBy;
};

export type Priority = 'high' | 'medium' | 'low';

export type Discrepancy = {
  taskId: string;
  taskName: string;
  field: string;
  apiValue: string | number | undefined;
  wikiValue: string | number | undefined;
  priority: Priority;
  trustsWiki: boolean;
  wikiLastEdit?: string;
  wikiEditDaysAgo?: number;
  wikiEditedPost1_0?: boolean;
};

/**
 * Get priority for a discrepancy based on field type
 * - Level/Task requirements: High (blocks progression)
 * - Reputation: Medium-High (affects loyalty levels)
 * - Objectives: Medium
 * - XP/Money: Low (not strictly required for tracking)
 */
export function getPriority(field: string): Priority {
  // Handle trader-specific reputation fields like "reputation.Prapor"
  if (field.startsWith('reputation.')) {
    return 'medium';
  }

  switch (field) {
    case 'minPlayerLevel':
    case 'taskRequirements':
    case 'nextTasks':
    case 'objectives.description':
      return 'high';
    case 'reputation':
    case 'objectives.count':
    case 'objectives.maps':
    case 'objectives.items':
    case 'map':
      return 'medium';
    case 'experience':
    case 'money':
    default:
      return 'low';
  }
}

export const DEFAULT_TASK_NAME = 'Grenadier';
export const WIKI_API = 'https://escapefromtarkov.fandom.com/api.php';
export const RATE_LIMIT_MS = 500;

// Tarkov 1.0 launch date - wiki edits after this are more trustworthy
export const TARKOV_1_0_LAUNCH = new Date('2025-11-15T00:00:00Z');
