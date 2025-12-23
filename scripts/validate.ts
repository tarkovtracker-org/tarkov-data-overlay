/**
 * Validation script for tarkov-data-overlay
 *
 * Validates JSON5 source files against their respective JSON Schema definitions.
 * Uses a schema configuration map for extensibility.
 */

import Ajv from 'ajv';
import { join, basename } from 'path';
import {
  getProjectPaths,
  loadJson5File,
  loadJsonFile,
  listJson5Files,
  SCHEMA_CONFIGS,
  type SchemaValidationResult,
} from '../src/lib/index.js';

const { srcDir, schemasDir } = getProjectPaths(import.meta.url);

/** Compiled schema validators cache */
type ValidatorCache = Map<string, ReturnType<Ajv['compile']>>;

/**
 * Initialize AJV and compile schemas
 */
function initializeValidators(): ValidatorCache {
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
function getValidator(
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
function validateFile(
  filePath: string,
  displayPath: string,
  validators: ValidatorCache
): SchemaValidationResult {
  const filename = basename(filePath);

  try {
    const data = loadJson5File(filePath);

    // Skip empty objects - they're valid by convention
    if (Object.keys(data).length === 0) {
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
      : validator.errors?.map(e => `${e.instancePath}: ${e.message}`);

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
function validateSourceFiles(): SchemaValidationResult[] {
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

  return results;
}

/**
 * Print validation results
 */
function printResults(results: SchemaValidationResult[]): boolean {
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
function main(): void {
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

main();
