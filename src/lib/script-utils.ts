/**
 * Shared utilities for CLI scripts
 *
 * Small helpers every script needs, centralized so they are not copy-pasted
 * into each entry point.
 */

import { pathToFileURL } from 'url';

/**
 * True when the module identified by `importMetaUrl` is the process entry
 * point (i.e. it was executed directly rather than imported).
 *
 * Usage: `if (isDirectExecution(import.meta.url)) main();`
 */
export function isDirectExecution(importMetaUrl: string): boolean {
  const entryFile = process.argv[1];
  if (!entryFile) return false;
  return importMetaUrl === pathToFileURL(entryFile).href;
}

/** Run an async CLI entry point and convert failures into a nonzero exit. */
export function runDirectly(importMetaUrl: string, main: () => Promise<void>): void {
  if (!isDirectExecution(importMetaUrl)) return;
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

/** Promise-based sleep, used for polite rate limiting and retry backoff. */
export function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
