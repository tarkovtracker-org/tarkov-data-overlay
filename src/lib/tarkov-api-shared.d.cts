type JsonRecord = Record<string, unknown>;

type EndpointCache<T> = Map<string, Promise<T>>;

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

export function buildTaskContext<
  TEnvelope extends { data: unknown },
  TContext,
  TMode extends string,
>(
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
): Promise<TContext>;
