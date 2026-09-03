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
  taskRequirementGroups?: TaskRequirementGroup[];
  traderRequirements?: TraderRequirement[];
  otherRequirements?: TaskOtherRequirement[];
  neededKeys?: TaskKeyRequirement[];
  availableDelaySecondsMin?: number;
  availableDelaySecondsMax?: number;
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
  /** Traders unlocked by the task. json.tarkov.dev serves this as an array. */
  traderUnlock?: Array<{ id: string; name: string }>;
  /** Trader dialogue made available by the task. */
  traderDialogueUnlock?: Array<{ id: string; name: string }>;
  /** Maps/locations unlocked by the task. */
  locationUnlock?: Array<{ id: string; name: string }>;
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

export interface ObjectiveZoneAdd extends Omit<ObjectiveZone, 'map' | 'outline'> {
  map: { id: string; name: string };
  outline: Array<{ x: number; y?: number; z: number }>;
}

export interface ObjectivePossibleLocation {
  map?: { id: string; name: string };
  positions?: Array<{ x: number; y?: number; z: number }>;
}

export interface ObjectivePossibleLocationAdd extends Omit<
  ObjectivePossibleLocation,
  'map' | 'positions'
> {
  map: { id: string; name: string };
  positions: Array<{ x: number; y?: number; z: number }>;
}

/** Objective override for nested corrections */
export interface ObjectiveOverride extends Omit<Partial<TaskObjective>, 'id'> {}

/** Objective addition for missing objectives */
/** Task item reference for added objectives (allows name-only references) */
export interface TaskItemRefAdd {
  id?: string;
  name: string;
  shortName?: string;
}

/** Objective addition for missing objectives */
export interface ObjectiveAdd extends Omit<
  Partial<TaskObjective>,
  'id' | 'description' | 'items' | 'zones' | 'possibleLocations'
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
  /** Optional upstream explanation/provenance for the requirement. */
  notes?: string;
}

/**
 * An OR group of task requirements. Entries in the normal `taskRequirements`
 * array are ANDed; a group is used when one of several task IDs satisfies the
 * same slot in an unlock path. The status array on each entry is itself an OR
 * over the accepted statuses for that task.
 */
export type TaskRequirementGroup = TaskRequirement[];

/** A map/key pair needed to enter a raid for a task objective. */
export interface TaskKeyRequirement {
  map: { id: string; name: string };
  keys: TaskItemRef[];
}

/** A task's dialogue flag requirement as served by json.tarkov.dev. */
export interface TaskDialogueRequirement {
  id: string;
  type: 'dialogue';
  traders: Array<{ id: string; name: string }>;
}

/** A task's persistent numeric global-variable requirement. */
export interface TaskGlobalVariableRequirement {
  id: string;
  type: 'globalVariable';
  variableId: string;
  compareMethod: TraderRequirementCompareMethod;
  value: number;
}

/**
 * Future/unknown upstream requirement types are retained instead of being
 * silently discarded. The unlock evaluator treats them as unknown until a
 * consumer supplies a state adapter for that type.
 */
export interface TaskUnknownOtherRequirement {
  id: string;
  type: string;
  [key: string]: unknown;
}

export type TaskOtherRequirement =
  TaskDialogueRequirement | TaskGlobalVariableRequirement | TaskUnknownOtherRequirement;

/**
 * Comparison methods json.tarkov.dev serves for trader requirements. Loyalty
 * Level (`level`) entries use `>=`; reputation entries use `>=`, `<=`, and `<`.
 */
export type TraderRequirementCompareMethod = '>=' | '<=' | '>' | '<' | '=';

/**
 * The discriminated trader-requirement semantics served by json.tarkov.dev:
 * `level` is a trader Loyalty Level (LL1-LL4); `reputation` is a trader
 * reputation threshold (scav karma / trader rep). Consumers must switch their
 * requirement evaluation on this field - the value range alone is ambiguous
 * (reputation serves positive, zero, and negative values).
 */
export type TraderRequirementType = 'level' | 'reputation';

/** Shared fields for trader requirements in json.tarkov.dev's discriminated shape. */
interface TraderRequirementBase {
  id: string;
  trader: { id: string; name: string };
}

/** Trader Loyalty Level requirement (LL1-LL4). */
export interface TraderLevelRequirement extends TraderRequirementBase {
  requirementType: 'level';
  compareMethod: '>=';
  value: 1 | 2 | 3 | 4;
}

/** Trader reputation threshold requirement (trader rep / scav karma). */
export interface TraderReputationRequirement extends TraderRequirementBase {
  requirementType: 'reputation';
  compareMethod: TraderRequirementCompareMethod;
  value: number;
}

/**
 * Trader requirement in json.tarkov.dev's discriminated shape.
 *
 * `id` is an upstream requirement id or a deterministic synthetic id (see
 * `SYNTHETIC_REQUIREMENT_ID_PREFIX`). The adapter also assigns synthetic ids
 * when an upstream requirement has no id. The id is the merge identity
 * consumers use to patch-by-id rather than replace the whole array.
 */
export type TraderRequirement = TraderLevelRequirement | TraderReputationRequirement;

/**
 * Prefix identifying deterministic synthetic requirement ids. Synthetic ids
 * may be authored in overlay data or assigned by the API adapter when an
 * upstream requirement omits its id.
 */
export const SYNTHETIC_REQUIREMENT_ID_PREFIX = 'overlay.';

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
  taskRequirementGroups?: TaskRequirementGroup[];
  traderRequirements?: TraderRequirement[];
  otherRequirements?: TaskOtherRequirement[];
  neededKeys?: TaskKeyRequirement[];
  availableDelaySecondsMin?: number;
  availableDelaySecondsMax?: number;
  experience?: number;
  startRewards?: TaskRewards;
  finishRewards?: TaskRewards;
  kappaRequired?: boolean;
  lightkeeperRequired?: boolean;
  disabled?: boolean;
}

/** Objective definition for task additions */
export interface TaskObjectiveAdd extends Omit<
  Partial<TaskObjective>,
  'id' | 'description' | 'zones' | 'possibleLocations'
> {
  id: string;
  description: string;
  zones?: ObjectiveZoneAdd[];
  possibleLocations?: ObjectivePossibleLocationAdd[];
}

/** Task data from tarkov.dev API */
export interface TaskData {
  id: string;
  name: string;
  /** Trader that offers the task. */
  trader?: { id: string; name: string };
  minPlayerLevel?: number;
  wikiLink?: string;
  map?: { id: string; name: string } | null;
  kappaRequired?: boolean;
  lightkeeperRequired?: boolean;
  factionName?: string;
  requiredPrestige?: { id?: string; name: string; prestigeLevel: number };
  taskRequirements?: TaskRequirement[];
  taskRequirementGroups?: TaskRequirementGroup[];
  traderRequirements?: TraderRequirement[];
  /** Hidden start conditions (dialogue flags and global variables). */
  otherRequirements?: TaskOtherRequirement[];
  /** Keys needed for the task's raid/objective, not a task-unlock condition. */
  neededKeys?: TaskKeyRequirement[];
  /** Timing metadata for delayed availability after the start gate is met. */
  availableDelaySecondsMin?: number;
  availableDelaySecondsMax?: number;
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
export type ValidationStatus = 'NEEDED' | 'FIXED' | 'NOT_FOUND' | 'REMOVED_FROM_API';

/** Detail about a specific field validation */
export interface ValidationDetail {
  field: string;
  status: 'needed' | 'fixed' | 'check' | 'info';
  message: string;
}

/** Individual objective within a story chapter */
export type StoryEndingId = 'savior' | 'survivor' | 'fallen' | 'debtor';

export interface StoryObjectiveUnlock {
  type: 'achievement' | 'barter' | 'map' | 'quest' | 'trader' | 'other';
  id?: string;
  name: string;
  note?: string;
}

export interface StoryObjectiveMapRef {
  id: string;
  name: string;
}

export interface StoryObjectiveItemRef {
  id: string;
  name: string;
  shortName?: string;
}

export interface StoryObjectiveMapPosition {
  x: number;
  y?: number;
  z: number;
}

export interface StoryObjectiveZone {
  map: StoryObjectiveMapRef;
  outline?: StoryObjectiveMapPosition[];
  position?: StoryObjectiveMapPosition;
  top?: number;
  bottom?: number;
}

export interface StoryObjectiveLocation {
  map: StoryObjectiveMapRef;
  positions: StoryObjectiveMapPosition[];
}

export interface StoryObjective {
  id: string;
  type: 'main' | 'optional';
  description: string;
  /** EFT sub-quest id backing this objective (source traceability) */
  sourceQuestId?: string;
  notes?: string | null;
  mutuallyExclusiveWith?: string[];
  endingId?: StoryEndingId;
  unlocks?: StoryObjectiveUnlock[];
  maps?: StoryObjectiveMapRef[];
  count?: number;
  foundInRaid?: boolean;
  item?: StoryObjectiveItemRef;
  items?: StoryObjectiveItemRef[];
  markerItem?: StoryObjectiveItemRef;
  questItem?: StoryObjectiveItemRef;
  requiredKeys?: StoryObjectiveItemRef[][];
  zones?: StoryObjectiveZone[];
  possibleLocations?: StoryObjectiveLocation[];
}

/** Reward summary for a story chapter */
export interface StoryRewards {
  description: string;
}

export interface StoryChapterActivationLocation {
  map: string;
  detail: string;
}

export interface StoryChapterActivation {
  summary: string;
  locations?: StoryChapterActivationLocation[];
}

/** Story chapter structure for additions */
export interface StoryChapter {
  id: string;
  name: string;
  normalizedName: string;
  wikiLink: string;
  order: number;
  /** EFT/tarkov.dev story quest id this chapter maps to (source traceability) */
  chapterQuestId: string;
  autoStart?: boolean;
  chapterRequirements?: Array<{ id: string; name: string }>;
  activation?: StoryChapterActivation;
  mapUnlocks?: Array<{ id: string; name: string }>;
  traderUnlocks?: Array<{ id: string; name: string }>;
  /** Quests unlocked by progressing through this chapter (alternative to taskRequirements) */
  questUnlocks?: Array<{ id: string; name: string }>;
  description?: string | null;
  notes?: string | null;
  objectives?: StoryObjective[];
  rewards?: StoryRewards | null;
}

/** Entry rules exposed by json.tarkov.dev for one map. */
export interface MapAccessData {
  id: string;
  name: string;
  minPlayerLevel?: number;
  maxPlayerLevel?: number;
  accessKeys?: string[];
  accessKeysMinPlayerLevel?: number;
}

/** Loyalty-level thresholds exposed by json.tarkov.dev for one trader. */
export interface TraderAccessLevel {
  level: number;
  requiredPlayerLevel?: number;
  requiredReputation?: number;
  requiredCommerce?: number;
}

/** Static trader data; account-specific unlock state is intentionally absent. */
export interface TraderAccessData {
  id: string;
  name: string;
  levels: TraderAccessLevel[];
}

/** Mode-scoped map/trader entry metadata used by the availability report. */
export interface ModeAccessData {
  maps: Record<string, MapAccessData>;
  traders: Record<string, TraderAccessData>;
}

/**
 * Game modes tarkov.dev serves upstream data for.
 *
 * json.tarkov.dev exposes these under `/{mode}/...` and its `/endpoints`
 * listing reports them in `gameModes`. `pvp-season` is BSG's Seasonal Character
 * mode (EFT patch 1.1.0.0); tarkov.dev serves it like any other mode (tasks,
 * items, maps, traders, hideout, ...). Everything that fetches or compares
 * against tarkov.dev iterates this list.
 */
export const SUPPORTED_GAME_MODES = ['regular', 'pve', 'pvp-season'] as const;

/** A game mode tarkov.dev serves upstream data for. */
export type GameMode = (typeof SUPPORTED_GAME_MODES)[number];

/**
 * Modes the mode-divergence registry adjudicates.
 *
 * Divergence is the artifact of tarkov.dev deriving one mode's numbers from the
 * other, historically between `regular` and `pve`; the registry is
 * intentionally scoped to that pair. Extend only with proof of a third-mode
 * mirror.
 */
export const DIVERGENCE_MODES = SUPPORTED_GAME_MODES;

/** A game mode the divergence registry records per-mode values for. */
export type DivergenceMode = GameMode;

/**
 * Canonical tarkov.dev map IDs mapped to their English names.
 *
 * Map references in overrides and additions are `{ id, name }` pairs, but only
 * `id` is the join key a consumer resolves. A pair whose name reads correctly
 * while its ID points at a different map is therefore silently wrong: the schema
 * only type-checks both as strings, so nothing else catches it.
 * `tests/map-references.test.ts` validates every map reference in `src/` against
 * this registry, which is why a corrected map must be looked up rather than
 * copied from a nearby entry.
 *
 * Captured from `json.tarkov.dev/regular/maps` + `/regular/maps_en` (v1.81).
 * When upstream adds a map the guard fails with the unknown ID; verify the new
 * ID against those endpoints and add it here.
 */
export const TARKOV_MAP_NAMES_BY_ID: Readonly<Record<string, string>> = {
  '56f40101d2720b2a4d8b45d6': 'Customs',
  '55f2d3fd4bdc2d5f408b4567': 'Factory',
  '653e6760052c01c1c805532f': 'Ground Zero',
  '65b8d6f5cdde2479cb2a3125': 'Ground Zero 21+',
  '68236e8153654e8c1200798a': 'Ground Zero Tutorial',
  '69af492a4819ea4ba10a69c5': 'Icebreaker',
  '5714dbc024597771384a510d': 'Interchange',
  '5704e4dad2720bb55b8b4567': 'Lighthouse',
  '59fc81d786f774390775787e': 'Night Factory',
  '5704e5fad2720bc05b8b4567': 'Reserve',
  '5704e554d2720bac5b8b456e': 'Shoreline',
  '5714dc692459777137212e12': 'Streets of Tarkov',
  '65cc8f81a9aac3e77d0cfd3e': 'Terminal',
  '5b0fc42d86f7744a585f9105': 'The Lab',
  '6a294a5b5eb5f9a1700417b7': 'The Lab (Dark)',
  '6733700029c367a3d40b02af': 'The Labyrinth',
  '5704e3c2d2720bac5b8b4567': 'Woods',
} as const;

/** Mode-specific overlay data */
export interface ModeOverlay {
  tasks?: Record<string, TaskOverride>;
  tasksAdd?: Record<string, TaskAddition>;
  prestige?: Record<string, PrestigeOverride>;
}

/**
 * Items/categories a seasonal-perk effect applies to, matching tarkov.dev's
 * served `ItemFilters` shape: arrays of tarkov.dev ids (item template ids for
 * items, item-category node ids for categories). Ids only - names resolve via
 * tarkov.dev's locale system, so no strings are hard-coded here.
 */
export interface SeasonalPerkItemFilter {
  allowedCategories?: string[];
  allowedItems?: string[];
  excludedCategories?: string[];
  excludedItems?: string[];
}

/** A single effect granted or imposed by a seasonal perk. */
export interface SeasonalPerkEffect {
  /** BSG effect identifier, e.g. "pmc_experience_multiplicator". */
  effectId: string;
  /** Multiplier applied by the effect, when it is multiplicative. */
  multiplicator?: number;
  multiplicatorPrimary?: number;
  multiplicatorSecondary?: number;
  /** Integer magnitude for effects like skill_level_preset. */
  intValue?: number;
  /** Skills the effect targets (skill_* effects). */
  skillIds?: string[];
  /** Items/categories the effect applies to (tarkov.dev ItemFilters shape). */
  itemFilter?: SeasonalPerkItemFilter;
  /** Pass any other BSG effect fields through untouched. */
  [key: string]: unknown;
}

/**
 * A seasonal perk (BSG "Seasonal Character" mechanic, used by the `pvp-season`
 * mode). tarkov.dev serves the pvp-season mode but not its perks (there is no
 * perks endpoint), so this ships as an overlay addition keyed by the perk id.
 */
export interface SeasonalPerk {
  id: string;
  /** Perk tier as reported in-game (e.g. "common", "personal"). */
  type: string;
  name: string;
  description?: string;
  /** Perk-point cost/refund; null when the perk has no point value. */
  points?: number | null;
  /** Perk ids that cannot be selected alongside this one. */
  mutuallyExclusiveSeasonalPerkIds?: string[];
  effects?: SeasonalPerkEffect[];
}

/** An input or output item of a craft (tarkov.dev item id + count). */
export interface CraftItemRef {
  item: string;
  count: number;
  /** e.g. `{ tool: true }` for a returned tool. */
  attributes?: Record<string, unknown>;
}

/**
 * A hideout craft missing from tarkov.dev, in tarkov.dev's craft shape so it can
 * be merged into the crafts list and adopted upstream directly.
 */
export interface CraftAddition {
  id: string;
  /** tarkov.dev hideout station id. */
  station: string;
  /** Required station level. */
  level: number;
  /**
   * Id of the task that unlocks the craft. `null` on quest-gated crafts whose
   * unlocking task id is not yet known (fillable placeholder); omitted when the
   * craft has no task unlock, matching tarkov.dev.
   */
  taskUnlock?: string | null;
  /** Production time in seconds. */
  duration: number;
  requiredItems: CraftItemRef[];
  requiredQuestItems?: unknown[];
  gameEditions?: string[];
  productItem: CraftItemRef;
}

/** Locale patch for a single objective's locale-sensitive text */
export interface ObjectiveLocaleOverride {
  description?: string;
}

/** Locale patch for a single task's locale-sensitive fields */
export interface TaskLocaleOverride {
  name?: string;
  wikiLink?: string;
  /** ID-keyed objective locale patches */
  objectives?: Record<string, ObjectiveLocaleOverride>;
}

/** Locale patch for a single item's locale-sensitive fields */
export interface ItemLocaleOverride {
  name?: string;
  shortName?: string;
  description?: string;
  wikiLink?: string;
}

/** Locale patch for a single trader's locale-sensitive fields */
export interface TraderLocaleOverride {
  name?: string;
  description?: string;
}

/** Locale patch for a single map's locale-sensitive fields */
export interface MapLocaleOverride {
  name?: string;
  description?: string;
}

/** Locale patch for a single prestige level's locale-sensitive fields */
export interface PrestigeLocaleOverride {
  name?: string;
}

/** Locale patch for a single story chapter's locale-sensitive fields */
export interface StoryChapterLocaleOverride {
  name?: string;
  description?: string;
  /** ID-keyed objective locale patches */
  objectives?: Record<string, ObjectiveLocaleOverride>;
}

/**
 * Corrections for a single broken locale bundle, keyed by entity type then
 * entity ID. Distinct from data overrides: these apply only when the consumer
 * renders the matching locale. Not mode-specific (locale bundles are shared
 * across game modes).
 */
export interface LocaleOverlay {
  tasks?: Record<string, TaskLocaleOverride>;
  items?: Record<string, ItemLocaleOverride>;
  traders?: Record<string, TraderLocaleOverride>;
  maps?: Record<string, MapLocaleOverride>;
  prestige?: Record<string, PrestigeLocaleOverride>;
  storyChapters?: Record<string, StoryChapterLocaleOverride>;
}

/** Correction to a single condition within a prestige level's requirements */
export interface PrestigeConditionOverride {
  type?: string;
  /** Corrected task reference for a taskStatus condition (tarkov.dev task id or overlay tasksAdd id) */
  task?: string;
  status?: string[];
  playerLevel?: number;
  skill?: string;
  level?: number;
}

/** Storyline requirement shown by the in-game prestige screen */
export type PrestigeStoryRequirement =
  | {
      type: 'storyChapterStatus';
      /** Story chapter id from storyChapters, e.g. tour */
      storyChapter: string;
      /** Display name from the in-game prestige screen */
      name: string;
      /** Required status for the story chapter */
      status: string[];
    }
  | {
      type: 'storyObjectiveStatus';
      /** Story chapter id from storyChapters, e.g. the-ticket */
      storyChapter: string;
      /** Objective id inside the story chapter when only one objective is required */
      objective: string;
      /** Display name from the in-game prestige screen */
      name: string;
      /** Required status for the story objective */
      status: string[];
    };

/** Correction to a single prestige level, keyed by tarkov.dev prestige id */
export interface PrestigeOverride {
  prestigeLevel?: number;
  name?: string;
  /** Per-condition patches keyed by the prestige condition id */
  conditions?: Record<string, PrestigeConditionOverride>;
  /** Authoritative story-chapter requirements; empty array means none */
  storyRequirements?: PrestigeStoryRequirement[];
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
  /** Seasonal perks (BSG Seasonal Character mechanic); absent from tarkov.dev. */
  seasonalPerks?: Record<string, SeasonalPerk>;
  /** Hideout crafts missing from tarkov.dev, in tarkov.dev's craft shape. */
  craftsAdd?: Record<string, CraftAddition>;
  /** One sparse overlay section for every mode advertised by tarkov.dev. */
  modes: Record<GameMode, ModeOverlay>;
  /** Per-locale corrections keyed by tarkov.dev locale code (en, de, fr, ...) */
  locales?: Record<string, LocaleOverlay>;
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
  /** Relative file path to match from src/ (e.g., "overrides/tasks.json5") */
  pattern: string;
  /** Path to schema file relative to schemas directory */
  schemaFile: string;
}

// ---------------------------------------------------------------------------
// Mode-divergence registry (src/divergences/tasks.json5)
// ---------------------------------------------------------------------------

/** How much we trust the recorded per-mode values */
export type DivergenceConfidence = 'high' | 'medium' | 'low';

/** Where a recorded per-mode value came from */
export type DivergenceSource = 'wiki' | 'tarkov.dev' | 'in-game' | 'patch-notes';

/**
 * Whether the two modes genuinely differ, currently agree, or the task only
 * exists in one mode.
 */
export type DivergenceStatus = 'divergent' | 'converged' | 'mode-exclusive';

/** Recorded true values for a single field across both game modes */
export interface DivergenceField {
  /** True regular/PvP value. Omitted when the task does not exist in regular. */
  regular?: number | string | boolean | null;
  /** True PvE value. Omitted when it has not been independently verified. */
  pve?: number | string | boolean | null;
  /** True Seasonal Character value. Omitted until independently verified. */
  'pvp-season'?: number | string | boolean | null;
  confidence: DivergenceConfidence;
  regularSource?: DivergenceSource;
  pveSource?: DivergenceSource;
  pvpSeasonSource?: DivergenceSource;
  /** Coarse reference to the data the values were last verified against (e.g. '1.1-pve'); dates are deliberately not recorded. */
  verified: string;
  note?: string;
}

/** A registry entry: one task, one or more divergent fields */
export interface TaskDivergence {
  name: string;
  proof: string;
  status: DivergenceStatus;
  note?: string;
  fields: Record<string, DivergenceField>;
}

/** Per-mode verdict for one registered field */
export type DivergenceVerdict =
  /** Upstream already serves the true value; no override needed */
  | 'UPSTREAM_CORRECT'
  /** Override supplies the true value and upstream does not - load-bearing */
  | 'OVERRIDE_ACTIVE'
  /** Override matches the true value but upstream does too - intentional guard */
  | 'OVERRIDE_REDUNDANT'
  /** Upstream is wrong and no override corrects it - data is being served wrong */
  | 'OVERRIDE_MISSING'
  /** An override exists but supplies a value that is not the recorded truth */
  | 'OVERRIDE_WRONG'
  /** Task absent from this mode's API data */
  | 'NOT_IN_MODE';

/** Result of checking one registered field in one mode */
export interface DivergenceResult {
  taskId: string;
  taskName: string;
  field: string;
  mode: DivergenceMode;
  verdict: DivergenceVerdict;
  expected: unknown;
  upstream: unknown;
  /** Value the override supplies, or undefined when no override covers it */
  override: unknown;
  confidence: DivergenceConfidence;
  proof: string;
  /** True when upstream serves an identical value in both modes but the
   * registry says they should differ - i.e. upstream is mirroring. */
  mirrored: boolean;
}

/** Default schema configurations */
export const SCHEMA_CONFIGS: SchemaConfig[] = [
  { pattern: 'overrides/tasks.json5', schemaFile: 'task-override.schema.json' },
  { pattern: 'overrides/modes/regular/tasks.json5', schemaFile: 'task-override.schema.json' },
  { pattern: 'overrides/modes/pve/tasks.json5', schemaFile: 'task-override.schema.json' },
  { pattern: 'overrides/modes/pvp-season/tasks.json5', schemaFile: 'task-override.schema.json' },
  { pattern: 'additions/tasksAdd.json5', schemaFile: 'task-additions.schema.json' },
  { pattern: 'additions/editions.json5', schemaFile: 'edition.schema.json' },
  { pattern: 'additions/seasonalPerks.json5', schemaFile: 'seasonal-perk.schema.json' },
  { pattern: 'additions/craftsAdd.json5', schemaFile: 'craft-additions.schema.json' },
  { pattern: 'additions/storyChapters.json5', schemaFile: 'story-chapter.schema.json' },
  { pattern: 'additions/itemsAdd.json5', schemaFile: 'item-additions.schema.json' },
  {
    pattern: 'overrides/modes/regular/prestige.json5',
    schemaFile: 'prestige-override.schema.json',
  },
  { pattern: 'overrides/locales/*.json5', schemaFile: 'locale-override.schema.json' },
  { pattern: 'suppressions/tasks.json5', schemaFile: 'task-suppressions.schema.json' },
  { pattern: 'divergences/tasks.json5', schemaFile: 'task-divergence.schema.json' },
];
