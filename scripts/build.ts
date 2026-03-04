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
  SUPPORTED_GAME_MODES,
  type OverlayOutput,
} from '../src/lib/index.js';

const { rootDir, srcDir, distDir } = getProjectPaths();

/**
 * Load mode-specific override and addition files
 */
function loadModeFiles(): Partial<Record<string, Record<string, Record<string, unknown>>>> | undefined {
  const modes: Record<string, Record<string, Record<string, unknown>>> = {};

  for (const mode of SUPPORTED_GAME_MODES) {
    const modeData: Record<string, Record<string, unknown>> = {};

    const overridesDir = join(srcDir, 'overrides', 'modes', mode);
    if (existsSync(overridesDir)) {
      Object.assign(modeData, loadAllJson5FromDir(overridesDir));
    }

    const additionsDir = join(srcDir, 'additions', 'modes', mode);
    if (existsSync(additionsDir)) {
      Object.assign(modeData, loadAllJson5FromDir(additionsDir, false));
    }

    if (Object.keys(modeData).length > 0) {
      modes[mode] = modeData;
    }
  }

  return Object.keys(modes).length > 0 ? modes : undefined;
}

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

  const modes = loadModeFiles();
  if (modes) {
    output.modes = modes;
  }

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

  const version = process.env.OVERLAY_VERSION || getPackageVersion(rootDir);

  // Load all source files
  const data = loadSourceFiles();

  // Create output with metadata
  const output: OverlayOutput = {
    ...data,
    $meta: {
      version,
      generated: new Date().toISOString(),
    },
  };

  // Generate JSON output without sha256 field, then hash it.
  // To verify: parse overlay.json, delete $meta.sha256, re-serialize
  // with JSON.stringify(obj, null, 2), and compare SHA-256 of that string.
  const jsonContent = JSON.stringify(output, null, 2);
  output.$meta.sha256 = generateSha256(jsonContent);

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
    .filter(([key]) => key !== 'modes')
    .map(([key, value]) => `${key}: ${Object.keys(value as object).length}`)
    .join(', ');

  const modeCounts = data.modes
    ? Object.entries(data.modes)
        .map(([mode, modeData]) => {
          const inner = Object.entries(modeData as Record<string, Record<string, unknown>>)
            .map(([k, v]) => `${k}: ${Object.keys(v).length}`)
            .join(', ');
          return `${mode}(${inner})`;
        })
        .join(', ')
    : undefined;

  console.log('✅ Built overlay.json');
  console.log(`   Entities: ${entityCounts}`);
  if (modeCounts) {
    console.log(`   Modes: ${modeCounts}`);
  }
  console.log(`   Version: ${output.$meta.version}`);
  console.log(`   Generated: ${output.$meta.generated}`);
  console.log(`   SHA256: ${output.$meta.sha256?.substring(0, 16)}...`);
  console.log(`\nOutput: ${outputPath}`);
}

build();
