import { linkSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'fs';
import { basename, dirname, join } from 'path';

/**
 * Replace a generated file only after all bytes have been written successfully.
 *
 * A sibling temporary directory keeps the rename on the destination filesystem
 * and isolates the temporary file from other runs. Partial writes (e.g. ENOSPC)
 * cannot truncate the previous destination. This is atomic for one file, not a
 * multi-file transaction or a power-loss durability guarantee.
 */
export function writeFileAtomicSync(file: string, data: string | Buffer): void {
  const temporaryDir = mkdtempSync(join(dirname(file), `.${basename(file)}-`));
  try {
    const temporaryFile = join(temporaryDir, 'content');
    writeFileSync(temporaryFile, data, { flag: 'wx' });
    renameSync(temporaryFile, file);
  } finally {
    // After rename, the new destination is committed. A cleanup error must not
    // make callers roll back another file while this one stays advanced. Before
    // rename, it must not hide the original write/rename error either.
    try {
      rmSync(temporaryDir, { recursive: true, force: true });
    } catch (error) {
      console.error(`warning: could not remove temporary directory ${temporaryDir}: ${error}`);
    }
  }
}

/**
 * Create a file with the given bytes only when the path is free.
 *
 * The bytes go to a fully written temporary file first, and `linkSync` creates
 * the destination from it. Linking is atomic and refuses to replace an existing
 * path, so a reader sees either nothing or the complete content, and two runs
 * racing to stage the same path cannot clobber each other. Returns false when
 * the path already exists.
 */
export function writeFileExclusiveSync(file: string, data: string | Buffer): boolean {
  const temporaryDir = mkdtempSync(join(dirname(file), `.${basename(file)}-`));
  try {
    const temporaryFile = join(temporaryDir, 'content');
    writeFileSync(temporaryFile, data, { flag: 'wx' });
    try {
      linkSync(temporaryFile, file);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  } finally {
    try {
      rmSync(temporaryDir, { recursive: true, force: true });
    } catch (error) {
      console.error(`warning: could not remove temporary directory ${temporaryDir}: ${error}`);
    }
  }
}
