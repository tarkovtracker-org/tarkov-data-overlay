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

export function fetchCached<T>(
  cache: EndpointCache<T>,
  path: string,
  load: (path: string) => Promise<T>
): Promise<T>;

export function resolveReferenceMatrix<T>(
  value: unknown,
  resolveReference: (value: unknown) => T | undefined
): T[][] | undefined;

export function adaptReward<T, TContext>(
  raw: unknown,
  context: TContext,
  helpers: {
    isRecord: (value: unknown) => value is JsonRecord;
    compact: (value: JsonRecord) => JsonRecord;
    resolveItemRef: (value: unknown, context: TContext) => unknown;
    resolveTraderRef: (value: unknown, context: TContext) => unknown;
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
