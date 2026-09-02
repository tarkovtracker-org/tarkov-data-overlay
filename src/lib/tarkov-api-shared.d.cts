type JsonRecord = Record<string, unknown>;

type EndpointCache<T> = Map<string, Promise<T>>;

type TaskContext = {
  itemsById: Map<string, JsonRecord>;
  questItemsById: Map<string, JsonRecord>;
  tasksById: Map<string, JsonRecord>;
  mapsById: Map<string, JsonRecord>;
  tradersById: Map<string, JsonRecord>;
  prestigeById: Map<string, JsonRecord>;
  itemsEn: Record<string, string>;
  tasksEn: Record<string, string>;
  mapsEn: Record<string, string>;
  tradersEn: Record<string, string>;
};

export const MAX_RESPONSE_BYTES: number;

export function fetchCached<T>(
  cache: EndpointCache<T>,
  path: string,
  load: (path: string) => Promise<T>
): Promise<T>;

export function getLatestTagVersion(cwd?: string): string | undefined;

export function indexTaskAdditions<T extends object & { id: string }>(
  additions: Record<string, T> | undefined,
  scope: string
): Map<string, T>;

export function mapOptionalArray<T>(
  value: unknown,
  mapper: (entry: unknown) => T | undefined
): Array<T | null> | undefined;

export function mergeTaskOverride<T extends object>(base?: T, next?: T): T;

export function resolveReferenceMatrix<T>(
  value: unknown,
  resolveReference: (value: unknown) => T | undefined
): T[][] | undefined;

export function normalizeRequiredPrestige(
  id: string | undefined,
  name: string | undefined,
  raw: Record<string, unknown> | undefined
): { id?: string; name: string; prestigeLevel: number } | undefined;

export function readResponseJson(
  response: Response,
  path: string,
  maxBytes?: number,
  source?: string
): Promise<unknown>;

export function resolveDialogueTraderRefs<TContext>(
  value: unknown,
  context: TContext,
  resolveTraderRef: (value: unknown, context: TContext) => { id: string; name: string } | undefined
): Array<{ id: string; name: string }> | undefined;

export function verifyOverlaySha256(value: unknown): boolean;

export function selectTaskAdditions<T extends object & { id: string }>(
  shared: Record<string, T> | undefined,
  modeSpecific: Record<string, T> | undefined,
  includeDisabled?: boolean
): Map<string, T>;

export function adaptReward<T, TContext>(
  raw: unknown,
  context: TContext,
  helpers: {
    isRecord: (value: unknown) => value is JsonRecord;
    compact: (value: JsonRecord) => JsonRecord;
    resolveItemRef: (value: unknown, context: TContext) => unknown;
    resolveTraderRef: (value: unknown, context: TContext) => unknown;
    resolveMapRef?: (value: unknown, context: TContext) => unknown;
  }
): T | undefined;

export function buildTaskContext<TEnvelope extends { data: unknown }, TMode extends string>(
  cache: EndpointCache<TEnvelope>,
  mode: TMode,
  tasksData: JsonRecord,
  helpers: {
    fetchEnvelope: (cache: EndpointCache<TEnvelope>, path: string) => Promise<TEnvelope>;
    fetchTranslations: (
      cache: EndpointCache<TEnvelope>,
      mode: TMode,
      endpoint: string
    ) => Promise<Record<string, string>>;
    isRecord: (value: unknown) => value is JsonRecord;
    toLookup: (value: unknown) => Map<string, JsonRecord>;
  }
): Promise<TaskContext>;
