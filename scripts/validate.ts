/**
 * Validation script for tarkov-data-overlay
 *
 * Validates JSON5 source files against their respective JSON Schema definitions.
 * Uses a schema configuration map for extensibility.
 */

import Ajv from 'ajv';
import { existsSync } from 'fs';
import { join } from 'path';
import {
  isDirectExecution,
  getProjectPaths,
  loadJson5File,
  loadJsonFile,
  listJson5Files,
  SCHEMA_CONFIGS,
  SUPPORTED_GAME_MODES,
  type LocaleOverlay,
  type SchemaValidationResult,
} from '../src/lib/index.js';

const { srcDir, schemasDir } = getProjectPaths();

/** Compiled schema validators cache */
type ValidatorCache = Map<string, ReturnType<Ajv['compile']>>;

type LocaleEntityType = keyof LocaleOverlay;

export type LocaleEntityIdIndex = Record<LocaleEntityType, Set<string>>;

const LOCALE_ENTITY_TYPES: LocaleEntityType[] = [
  'tasks',
  'items',
  'traders',
  'maps',
  'prestige',
  'storyChapters',
];

function createLocaleEntityIdIndex(): LocaleEntityIdIndex {
  return Object.fromEntries(
    LOCALE_ENTITY_TYPES.map((type) => [type, new Set<string>()])
  ) as LocaleEntityIdIndex;
}

function mergeLocaleEntityIdIndex(
  target: LocaleEntityIdIndex,
  source: Partial<Record<LocaleEntityType, Iterable<string>>>
): void {
  for (const type of LOCALE_ENTITY_TYPES) {
    for (const id of source[type] ?? []) target[type].add(id);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function initializeAjv(): Ajv {
  const ajv = new Ajv({ allErrors: true, strict: false });
  ajv.addFormat('uri', {
    type: 'string',
    validate: (value: string) => {
      if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) return false;
      try {
        new URL(value);
        return true;
      } catch {
        return false;
      }
    },
  });
  return ajv;
}

/**
 * Initialize AJV and compile schemas
 */
export function initializeValidators(): ValidatorCache {
  const ajv = initializeAjv();
  const cache: ValidatorCache = new Map();
  const schemaCache = new Map<string, ReturnType<Ajv['compile']>>();

  for (const config of SCHEMA_CONFIGS) {
    let validator = schemaCache.get(config.schemaFile);
    if (!validator) {
      const schema = loadJsonFile(join(schemasDir, config.schemaFile));
      validator = ajv.compile(schema as object);
      schemaCache.set(config.schemaFile, validator);
    }
    cache.set(config.pattern, validator);
  }

  return cache;
}

/**
 * Get the validator for a given filename
 *
 * Matches exact patterns first, then directory wildcards like
 * `overrides/locales/*.json5` (used for per-locale files whose names are
 * not known ahead of time).
 */
export function getValidator(
  relativePath: string,
  validators: ValidatorCache
): ReturnType<Ajv['compile']> | null {
  const exact = validators.get(relativePath);
  if (exact) return exact;

  const separatorIndex = relativePath.lastIndexOf('/');
  if (separatorIndex === -1) return null;

  const wildcardPattern = `${relativePath.slice(0, separatorIndex)}/*.json5`;
  return validators.get(wildcardPattern) ?? null;
}

/**
 * Validate a single file against its schema
 */
export function validateFile(
  filePath: string,
  displayPath: string,
  validators: ValidatorCache
): SchemaValidationResult {
  try {
    const data = loadJson5File(filePath);

    // Skip empty plain objects - they're valid by convention.
    // Arrays/primitives/null should still be validated against schema.
    if (isRecord(data) && Object.keys(data).length === 0) {
      return { file: displayPath, valid: true };
    }

    const validator = getValidator(displayPath, validators);

    // No schema for this file type - consider valid
    if (!validator) {
      return { file: displayPath, valid: true };
    }

    const valid = validator(data) as boolean;
    const errors = valid
      ? undefined
      : validator.errors?.map((e) => `${e.instancePath}: ${e.message}`);

    return { file: displayPath, valid, errors };
  } catch (error) {
    return {
      file: displayPath,
      valid: false,
      errors: [(error as Error).message],
    };
  }
}

function addJson5Keys(index: Set<string>, relPath: string): void {
  const filePath = join(srcDir, relPath);
  if (!existsSync(filePath)) return;
  const data = loadJson5File(filePath);
  if (isRecord(data)) {
    for (const id of Object.keys(data)) index.add(id);
  }
}

/** Build the local entity ID set locale overrides are allowed to patch. */
export function buildLocalLocaleEntityIdIndex(): LocaleEntityIdIndex {
  const index = createLocaleEntityIdIndex();

  addJson5Keys(index.tasks, 'overrides/tasks.json5');
  addJson5Keys(index.tasks, 'additions/tasksAdd.json5');
  addJson5Keys(index.items, 'overrides/items.json5');
  addJson5Keys(index.items, 'additions/itemsAdd.json5');
  addJson5Keys(index.traders, 'overrides/traders.json5');
  addJson5Keys(index.prestige, 'overrides/prestige.json5');
  addJson5Keys(index.storyChapters, 'additions/storyChapters.json5');

  for (const mode of SUPPORTED_GAME_MODES) {
    addJson5Keys(index.tasks, `overrides/modes/${mode}/tasks.json5`);
    addJson5Keys(index.tasks, `additions/modes/${mode}/tasksAdd.json5`);
  }

  return index;
}

function addRecordIds(index: Set<string>, value: unknown): void {
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    index.add(key);
    if (isRecord(entry) && typeof entry.id === 'string') index.add(entry.id);
  }
}

async function fetchJsonData(path: string): Promise<Record<string, unknown>> {
  const response = await fetch(`https://json.tarkov.dev/${path}`, {
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) {
    throw new Error(`tarkov.dev request failed: ${response.status} ${response.statusText} (${path})`);
  }
  const payload = await response.json() as unknown;
  if (!isRecord(payload) || !isRecord(payload.data)) {
    throw new Error(`Invalid json.tarkov.dev response for ${path}: missing data object`);
  }
  return payload.data;
}

async function buildTarkovLocaleEntityIdIndex(): Promise<LocaleEntityIdIndex> {
  const index = createLocaleEntityIdIndex();

  for (const mode of SUPPORTED_GAME_MODES) {
    const [tasksData, itemsData, mapsData, tradersData] = await Promise.all([
      fetchJsonData(`${mode}/tasks`),
      fetchJsonData(`${mode}/items`),
      fetchJsonData(`${mode}/maps`),
      fetchJsonData(`${mode}/traders`),
    ]);

    addRecordIds(index.tasks, tasksData.tasks);
    addRecordIds(index.prestige, tasksData.prestige);
    addRecordIds(index.items, itemsData.items);
    addRecordIds(index.maps, mapsData.maps);
    addRecordIds(index.traders, tradersData);
  }

  return index;
}

export async function buildLocaleEntityIdIndex(): Promise<LocaleEntityIdIndex> {
  const index = buildLocalLocaleEntityIdIndex();
  mergeLocaleEntityIdIndex(index, await buildTarkovLocaleEntityIdIndex());
  return index;
}

export function validateLocaleEntityIds(
  filePath: string,
  displayPath: string,
  index: LocaleEntityIdIndex
): SchemaValidationResult {
  try {
    const data = loadJson5File<LocaleOverlay>(filePath);
    if (!isRecord(data)) return { file: displayPath, valid: true };

    const errors: string[] = [];
    for (const type of LOCALE_ENTITY_TYPES) {
      const patches = data[type];
      if (!isRecord(patches)) continue;
      for (const id of Object.keys(patches)) {
        if (!index[type].has(id)) {
          errors.push(`/${type}/${id}: locale override references unknown entity ID`);
        }
      }
    }

    return { file: displayPath, valid: errors.length === 0, errors: errors.length ? errors : undefined };
  } catch (error) {
    return {
      file: displayPath,
      valid: false,
      errors: [(error as Error).message],
    };
  }
}

/**
 * Validate all source files
 */
export async function validateSourceFiles(): Promise<SchemaValidationResult[]> {
  const validators = initializeValidators();
  const results: SchemaValidationResult[] = [];

  // Validate overrides directory
  const overridesDir = join(srcDir, 'overrides');
  for (const file of listJson5Files(overridesDir)) {
    const filePath = join(overridesDir, file);
    results.push(validateFile(filePath, `overrides/${file}`, validators));
  }

  // Validate additions directory
  const additionsDir = join(srcDir, 'additions');
  for (const file of listJson5Files(additionsDir)) {
    const filePath = join(additionsDir, file);
    results.push(validateFile(filePath, `additions/${file}`, validators));
  }

  // Validate per-locale overrides (one file per locale, filename = locale code)
  const localeIdIndex = await buildLocaleEntityIdIndex();
  const localesDir = join(srcDir, 'overrides', 'locales');
  for (const file of listJson5Files(localesDir)) {
    const filePath = join(localesDir, file);
    const displayPath = `overrides/locales/${file}`;
    const result = validateFile(filePath, displayPath, validators);
    if (result.valid) {
      const idResult = validateLocaleEntityIds(filePath, displayPath, localeIdIndex);
      result.valid = idResult.valid;
      result.errors = idResult.errors;
    }
    results.push(result);
  }

  const suppressionsFile = join(srcDir, 'suppressions', 'tasks.json5');
  results.push(
    validateFile(suppressionsFile, 'suppressions/tasks.json5', validators)
  );

  // Validate mode-specific overrides
  for (const mode of SUPPORTED_GAME_MODES) {
    const modeOverridesDir = join(srcDir, 'overrides', 'modes', mode);
    for (const file of listJson5Files(modeOverridesDir)) {
      const filePath = join(modeOverridesDir, file);
      results.push(validateFile(filePath, `overrides/modes/${mode}/${file}`, validators));
    }

    const modeAdditionsDir = join(srcDir, 'additions', 'modes', mode);
    for (const file of listJson5Files(modeAdditionsDir)) {
      const filePath = join(modeAdditionsDir, file);
      results.push(validateFile(filePath, `additions/modes/${mode}/${file}`, validators));
    }
  }

  return results;
}

/**
 * Print validation results
 */
export function printResults(results: SchemaValidationResult[]): boolean {
  let hasErrors = false;

  for (const result of results) {
    if (result.valid) {
      console.log(`✅ ${result.file}`);
    } else {
      console.log(`❌ ${result.file}`);
      for (const error of result.errors || []) {
        console.log(`   ${error}`);
      }
      hasErrors = true;
    }
  }

  return hasErrors;
}

/**
 * Main entry point
 */
export async function main(): Promise<void> {
  console.log('Validating source files...\n');

  const results = await validateSourceFiles();
  const hasErrors = printResults(results);

  console.log('');

  if (hasErrors) {
    console.log('Validation failed!');
    process.exit(1);
  } else {
    console.log('All files valid!');
  }
}

if (isDirectExecution(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
