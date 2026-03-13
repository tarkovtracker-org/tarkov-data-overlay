/**
 * Validation script for tarkov-data-overlay
 *
 * Validates JSON5 source files against their respective JSON Schema definitions.
 * Uses a schema configuration map for extensibility.
 */

import Ajv from 'ajv';
import { join, basename } from 'path';
import { pathToFileURL } from 'url';
import {
  getProjectPaths,
  loadJson5File,
  loadJsonFile,
  listJson5Files,
  SCHEMA_CONFIGS,
  SUPPORTED_GAME_MODES,
  type SchemaValidationResult,
} from '../src/lib/index.js';

const { srcDir, schemasDir } = getProjectPaths();

/** Compiled schema validators cache */
type ValidatorCache = Map<string, ReturnType<Ajv['compile']>>;

/**
 * Initialize AJV and compile schemas
 */
export function initializeValidators(): ValidatorCache {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const cache: ValidatorCache = new Map();

  for (const config of SCHEMA_CONFIGS) {
    const schema = loadJsonFile(join(schemasDir, config.schemaFile));
    cache.set(config.pattern, ajv.compile(schema as object));
  }

  return cache;
}

/**
 * Get the validator for a given filename
 */
export function getValidator(
  filename: string,
  validators: ValidatorCache
): ReturnType<Ajv['compile']> | null {
  for (const [pattern, validator] of validators) {
    if (filename === pattern) {
      return validator;
    }
  }
  return null;
}

/**
 * Validate a single file against its schema
 */
export function validateFile(
  filePath: string,
  displayPath: string,
  validators: ValidatorCache
): SchemaValidationResult {
  const filename = basename(filePath);

  try {
    const data = loadJson5File(filePath);

    // Skip empty plain objects - they're valid by convention.
    // Arrays/primitives/null should still be validated against schema.
    if (data && typeof data === 'object' && !Array.isArray(data) && Object.keys(data).length === 0) {
      return { file: displayPath, valid: true };
    }

    const validator = getValidator(filename, validators);

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

/**
 * Validate all source files
 */
export function validateSourceFiles(): SchemaValidationResult[] {
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
export function main(): void {
  console.log('Validating source files...\n');

  const results = validateSourceFiles();
  const hasErrors = printResults(results);

  console.log('');

  if (hasErrors) {
    console.log('Validation failed!');
    process.exit(1);
  } else {
    console.log('All files valid!');
  }
}

function isDirectExecution(): boolean {
  const entryFile = process.argv[1];
  if (!entryFile) return false;
  return import.meta.url === pathToFileURL(entryFile).href;
}

if (isDirectExecution()) {
  main();
}
