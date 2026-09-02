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
  getLatestTagVersion,
  getProjectPaths,
  loadAllJson5FromDir,
  loadJsonFile,
  getPackageVersion,
  isDirectExecution,
  SUPPORTED_GAME_MODES,
  icons,
  verifyOverlaySha256,
  type OverlayOutput,
} from '../src/lib/index.js';

const { rootDir, srcDir, distDir } = getProjectPaths();

/**
 * Load mode-specific override and addition files
 */
function loadModeFiles(): Record<string, Record<string, Record<string, unknown>>> {
  const modes: Record<string, Record<string, Record<string, unknown>>> = {};

  for (const mode of SUPPORTED_GAME_MODES) {
    const modeData: Record<string, Record<string, unknown>> = {};

    // loadAllJson5FromDir no-ops on missing directories (listJson5Files returns []).
    Object.assign(modeData, loadAllJson5FromDir(join(srcDir, 'overrides', 'modes', mode)));
    Object.assign(modeData, loadAllJson5FromDir(join(srcDir, 'additions', 'modes', mode), false));

    // Emit every upstream mode, even when its overlay is currently empty. This
    // keeps the compiled contract aligned with json.tarkov.dev/endpoints and
    // prevents consumers from treating pvp-season as an optional special case.
    modes[mode] = modeData;
  }

  return modes;
}

/**
 * Load all source files from overrides and additions directories
 */
function loadSourceFiles(): Omit<OverlayOutput, '$meta'> {
  const output = { modes: loadModeFiles() } as Omit<OverlayOutput, '$meta'>;

  // Load overrides (corrections to tarkov.dev data)
  const overrides = loadAllJson5FromDir(join(srcDir, 'overrides'));
  Object.assign(output, overrides);

  // Load additions (new data not in tarkov.dev)
  const additions = loadAllJson5FromDir(join(srcDir, 'additions'), false);
  Object.assign(output, additions);

  // Load per-locale corrections (one file per locale, filename = locale code)
  const locales = loadAllJson5FromDir(join(srcDir, 'overrides', 'locales'));
  if (Object.keys(locales).length > 0) {
    output.locales = locales;
  }

  return output;
}

/**
 * Generate SHA256 hash of content
 */
function generateSha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Return a stable representation for semantic generated-output comparison. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonicalize(entry)])
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasValidBuildMetadata(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.$meta)) return false;
  const { version, generated } = value.$meta;
  return (
    typeof version === 'string' &&
    version.length > 0 &&
    typeof generated === 'string' &&
    Number.isFinite(Date.parse(generated))
  );
}

interface BuildVersion {
  value: string;
  isAuthoritative: boolean;
}

/** Resolve the build version and record whether it came from a release source. */
export function resolveBuildVersion(
  rootDir: string,
  findLatestTag: () => string | undefined = getLatestTagVersion
): BuildVersion {
  if (process.env.OVERLAY_VERSION) {
    return { value: process.env.OVERLAY_VERSION, isAuthoritative: true };
  }
  const latestTag = findLatestTag();
  if (latestTag) return { value: latestTag, isAuthoritative: true };
  return { value: getPackageVersion(rootDir), isAuthoritative: false };
}

/** Compare an existing committed overlay with the freshly generated content. */
function checkGeneratedOutput(
  output: OverlayOutput,
  outputPath: string,
  checkVersion: boolean
): void {
  if (!existsSync(outputPath)) {
    throw new Error(`Generated overlay is missing: ${outputPath}`);
  }

  const existing = loadJsonFile<unknown>(outputPath);
  if (!verifyOverlaySha256(existing)) {
    throw new Error(`Generated overlay has an invalid or missing digest: ${outputPath}`);
  }

  if (!hasValidBuildMetadata(existing)) {
    throw new Error(`Generated overlay has invalid build metadata: ${outputPath}`);
  }
  if (
    checkVersion &&
    isRecord(existing) &&
    isRecord(existing.$meta) &&
    existing.$meta.version !== output.$meta.version
  ) {
    throw new Error(
      `Generated overlay has version '${String(existing.$meta.version)}', expected '${output.$meta.version}'`
    );
  }

  const withoutMetadata = (value: unknown): unknown => {
    // The generated timestamp is intentionally volatile; source data is
    // compared below while the digest and metadata shape are checked above.
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const { $meta: _metadata, ...data } = value as Record<string, unknown>;
    return data;
  };
  const expected = JSON.stringify(canonicalize(withoutMetadata(output)));
  const actual = JSON.stringify(canonicalize(withoutMetadata(existing)));
  if (expected !== actual) {
    throw new Error(`Generated overlay is stale: run 'npm run build' and commit ${outputPath}`);
  }
}

/**
 * Build the overlay.json file
 */
function build(): void {
  console.log('Building overlay...\n');

  const { value: version, isAuthoritative: versionIsAuthoritative } = resolveBuildVersion(rootDir);

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
  const outputPath = join(distDir, 'overlay.json');
  if (process.argv.includes('--check')) {
    checkGeneratedOutput(output, outputPath, versionIsAuthoritative);
    console.log(`Generated overlay is current: ${outputPath}`);
    return;
  }
  if (!existsSync(distDir)) mkdirSync(distDir, { recursive: true });

  // Write output
  writeFileSync(outputPath, finalContent);

  // Summary
  const entityCounts = Object.entries(data)
    .filter(([key]) => key !== 'modes' && key !== 'locales')
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

  const localeCounts = data.locales
    ? Object.entries(data.locales)
        .map(([locale, localeData]) => {
          const inner = Object.entries(localeData as Record<string, Record<string, unknown>>)
            .map(([k, v]) => `${k}: ${Object.keys(v).length}`)
            .join(', ');
          return `${locale}(${inner})`;
        })
        .join(', ')
    : undefined;

  console.log(`Build overlay.json : ${icons.checkmark}`);
  console.log(`   Entities: ${entityCounts}`);
  if (modeCounts) {
    console.log(`   Modes: ${modeCounts}`);
  }
  if (localeCounts) {
    console.log(`   Locales: ${localeCounts}`);
  }
  console.log(`   Version: ${output.$meta.version}`);
  console.log(`   Generated: ${output.$meta.generated}`);
  console.log(`   SHA256: ${output.$meta.sha256?.substring(0, 16)}...`);
  console.log(`\nOutput: ${outputPath}`);
}

if (isDirectExecution(import.meta.url)) {
  build();
}
