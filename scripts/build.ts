/**
 * Build script for tarkov-data-overlay
 *
 * Compiles JSON5 source files from src/ into a single dist/overlay.json
 * with metadata including version, timestamp, and SHA256 hash.
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import {
  getProjectPaths,
  loadAllJson5FromDir,
  getPackageVersion,
  type OverlayOutput,
} from '../src/lib/index.js';

const { rootDir, srcDir, distDir } = getProjectPaths(import.meta.url);

/**
 * Load all source files from overrides and additions directories
 */
function loadSourceFiles(): Omit<OverlayOutput, '$meta'> {
  const output: Omit<OverlayOutput, '$meta'> = {};

  // Load overrides (corrections to tarkov.dev data)
  const overrides = loadAllJson5FromDir(join(srcDir, 'overrides'));
  Object.assign(output, overrides);

  // Load additions (new data not in tarkov.dev)
  const additions = loadAllJson5FromDir(join(srcDir, 'additions'), false);
  Object.assign(output, additions);

  return output;
}

/**
 * Generate SHA256 hash of content
 */
function generateSha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Build the overlay.json file
 */
function build(): void {
  console.log('Building overlay...\n');

  // Load all source files
  const data = loadSourceFiles();

  // Create output with metadata
  const output: OverlayOutput = {
    ...data,
    $meta: {
      version: getPackageVersion(rootDir),
      generated: new Date().toISOString(),
    },
  };

  // Generate JSON output (without sha256 first)
  const jsonContent = JSON.stringify(output, null, 2);

  // Add sha256 of the data (excluding $meta.sha256)
  output.$meta.sha256 = generateSha256(jsonContent);

  // Final output with sha256
  const finalContent = JSON.stringify(output, null, 2);

  // Ensure dist directory exists
  if (!existsSync(distDir)) {
    mkdirSync(distDir, { recursive: true });
  }

  // Write output
  const outputPath = join(distDir, 'overlay.json');
  writeFileSync(outputPath, finalContent);

  // Summary
  const entityCounts = Object.entries(data)
    .map(([key, value]) => `${key}: ${Object.keys(value as object).length}`)
    .join(', ');

  console.log('✅ Built overlay.json');
  console.log(`   Entities: ${entityCounts}`);
  console.log(`   Version: ${output.$meta.version}`);
  console.log(`   Generated: ${output.$meta.generated}`);
  console.log(`   SHA256: ${output.$meta.sha256?.substring(0, 16)}...`);
  console.log(`\nOutput: ${outputPath}`);
}

build();
