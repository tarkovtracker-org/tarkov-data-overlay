import { describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { writeFileAtomicSync, writeFileExclusiveSync } from '../scripts/lib/atomic-write.js';
import { pendingLockSidecar } from '../scripts/eft-story-generate.js';

const writer = fileURLToPath(new URL('../scripts/eft-story-write.ts', import.meta.url));
const PREVIOUS_ARTIFACT = '{ /* previous artifact */ }\n';
const PREVIOUS_LOCK = '{ "file": "eft/original.json" }\n';
const PAYLOAD = '{}'; // Empty maps are schema-valid; these tests concern publication only.

/** Committed artifact + provenance, a generator input, and its matching staged binding. */
function setupWorkspace(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const artifact = join(dir, 'src', 'additions', 'storyChapters.json5');
  const lock = join(dir, 'scripts', 'story-reference.lock.json');
  const input = join(dir, 'story-final.json');
  const outputSha256 = createHash('sha256').update(PAYLOAD).digest('hex');
  const sidecar = join(dir, pendingLockSidecar(outputSha256));
  for (const path of ['src/additions', 'src/schemas', 'scripts', 'data/eft']) {
    mkdirSync(join(dir, path), { recursive: true });
  }
  writeFileSync(
    join(dir, 'src', 'schemas', 'story-chapter.schema.json'),
    readFileSync(new URL('../src/schemas/story-chapter.schema.json', import.meta.url))
  );
  writeFileSync(artifact, PREVIOUS_ARTIFACT);
  writeFileSync(lock, PREVIOUS_LOCK);
  writeFileSync(input, PAYLOAD);
  const pending = JSON.stringify({
    lock: {
      file: 'eft/new.json',
      sha256: 'b'.repeat(64),
      bytes: 100,
      clientVersion: 'test',
      gameMode: 'regular',
      capturedAt: null,
      quests: 2,
      chapterQuests: 1,
      objectiveTexts: 1,
    },
    outputSha256,
  });
  writeFileSync(sidecar, pending);
  return { dir, artifact, lock, sidecar, input, pending, outputSha256 };
}

/**
 * Run the writer in a child whose `fs.writeFileSync` follows `inject`.
 *
 * The injection runs inside the child so patching the built-in cannot affect
 * another test, and returns `throw` to propagate an ENOSPC-style error.
 */
function runWriter(dir: string, input: string, inject: string): void {
  const bootstrap = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const write = fs.writeFileSync;
    ${inject}
    syncBuiltinESMExports();
    process.argv = [process.execPath, ${JSON.stringify(writer)}, ${JSON.stringify(input)}];
    await import(${JSON.stringify(new URL('../scripts/eft-story-write.ts', import.meta.url).href)});
  `;
  execFileSync(
    process.execPath,
    ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', bootstrap],
    {
      cwd: dir,
      stdio: 'pipe',
    }
  );
}

describe('writeFileAtomicSync', () => {
  it('creates and replaces a file with complete UTF-8 or buffer content without leftovers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atomic-write-'));
    const dest = join(dir, 'output.json');
    try {
      for (const data of ['story → chapter', Buffer.from('replacement'), '']) {
        writeFileAtomicSync(dest, data);
        expect(readFileSync(dest)).toEqual(Buffer.from(data));
        expect(readdirSync(dir)).toEqual(['output.json']);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cleans up after a refused rename without changing the destination', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atomic-rename-'));
    const dest = join(dir, 'existing-directory');
    try {
      mkdirSync(dest);
      writeFileSync(join(dest, 'keep'), 'original');
      expect(() => writeFileAtomicSync(dest, 'new')).toThrow();
      expect(readFileSync(join(dest, 'keep'), 'utf8')).toBe('original');
      expect(readdirSync(dir)).toEqual(['existing-directory']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates exclusively and leaves an occupied path untouched', () => {
    const dir = mkdtempSync(join(tmpdir(), 'atomic-exclusive-'));
    const dest = join(dir, 'binding.json');
    try {
      expect(writeFileExclusiveSync(dest, 'first')).toBe(true);
      expect(readFileSync(dest, 'utf8')).toBe('first');
      // The second write must not clobber another run's binding.
      expect(writeFileExclusiveSync(dest, 'second')).toBe(false);
      expect(readFileSync(dest, 'utf8')).toBe('first');
      expect(readdirSync(dir)).toEqual(['binding.json']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('story artifact and provenance write failures', () => {
  it.each(['EACCES', 'ENOENT', 'ENOSPC'])(
    'aborts publication without changing committed files when the snapshot fails with %s',
    (code) => {
      const { dir, artifact, lock, sidecar, input, pending } = setupWorkspace('story-snapshot-');
      try {
        expect(() =>
          runWriter(
            dir,
            input,
            `
            const link = fs.linkSync;
            fs.linkSync = (source, destination) => {
              if (String(destination).includes('-rollback-')) {
                const error = new Error('${code}: simulated snapshot failure');
                error.code = '${code}';
                throw error;
              }
              return link(source, destination);
            };
            `
          )
        ).toThrow(/simulated snapshot failure/);
        expect(readFileSync(artifact, 'utf8')).toBe(PREVIOUS_ARTIFACT);
        expect(readFileSync(lock, 'utf8')).toBe(PREVIOUS_LOCK);
        expect(readFileSync(sidecar, 'utf8')).toBe(pending);
        expect(readdirSync(join(dir, 'src', 'additions'))).toEqual(['storyChapters.json5']);
        expect(existsSync(join(dir, 'data', 'eft', 'story-write.lock'))).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  );

  it('keeps the artifact present when interrupted immediately before atomic replacement', () => {
    const { dir, artifact, lock, sidecar, input, pending } = setupWorkspace('story-interrupt-');
    // Keep a stable handle to the original inode while the child writer runs.
    const originalArtifact = openSync(artifact, 'r');
    const previousInode = fstatSync(originalArtifact).ino;
    try {
      expect(() =>
        runWriter(
          dir,
          input,
          `
          const rename = fs.renameSync;
          fs.renameSync = (source, destination) => {
            if (String(destination) === 'src/additions/storyChapters.json5') {
              if (fs.readFileSync(destination, 'utf8') !== ${JSON.stringify(PREVIOUS_ARTIFACT)}) {
                throw new Error('artifact missing or changed before atomic replacement');
              }
              process.stderr.write('interrupted before atomic replacement');
              process.exit(86);
            }
            return rename(source, destination);
          };
          `
        )
      ).toThrow(/interrupted before atomic replacement/);
      const publishedArtifact = openSync(artifact, 'r');
      try {
        expect(readFileSync(publishedArtifact, 'utf8')).toBe(PREVIOUS_ARTIFACT);
        expect(fstatSync(publishedArtifact).ino).toBe(previousInode);
      } finally {
        closeSync(publishedArtifact);
      }
      expect(readFileSync(lock, 'utf8')).toBe(PREVIOUS_LOCK);
      expect(readFileSync(sidecar, 'utf8')).toBe(pending);
      const rollbackDir = readdirSync(join(dir, 'src', 'additions')).find((name) =>
        name.includes('-rollback-')
      );
      expect(rollbackDir).toBeDefined();
      const snapshot = join(dir, 'src', 'additions', rollbackDir!, 'previous');
      const snapshotStats = statSync(snapshot);
      expect(snapshotStats.ino).toBe(previousInode);
      expect(snapshotStats.nlink).toBe(2);
      // A crash retains the exclusive lock, so the next writer cannot silently
      // publish over a run whose provenance promotion might have been interrupted.
      expect(existsSync(join(dir, 'data', 'eft', 'story-write.lock'))).toBe(true);
    } finally {
      closeSync(originalArtifact);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(['storyChapters.json5', 'story-reference.lock.json'])(
    'preserves both committed files when a partial write to %s fails',
    (failingFile) => {
      const { dir, artifact, lock, sidecar, input, pending } =
        setupWorkspace('story-partial-write-');
      try {
        // Simulate ENOSPC after bytes have already reached disk. Throwing before
        // the real write would miss truncation of the previous committed file.
        expect(() =>
          runWriter(
            dir,
            input,
            `
            let failed = false;
            fs.writeFileSync = (file, data, ...args) => {
              if (!failed && String(file).includes(${JSON.stringify(failingFile)})) {
                failed = true;
                write(file, '{ partial', ...args);
                throw new Error('ENOSPC: simulated partial write');
              }
              return write(file, data, ...args);
            };
            `
          )
        ).toThrow(/ENOSPC: simulated partial write/);

        expect(readFileSync(artifact, 'utf8')).toBe(PREVIOUS_ARTIFACT);
        expect(readFileSync(lock, 'utf8')).toBe(PREVIOUS_LOCK);
        expect(readFileSync(sidecar, 'utf8')).toBe(pending);
        expect(readdirSync(join(dir, 'src', 'additions'))).toEqual(['storyChapters.json5']);
        expect(readdirSync(join(dir, 'scripts'))).toEqual(['story-reference.lock.json']);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  );

  it('restores the previous artifact without another allocation when the disk stays full', () => {
    // The lock write fails, and every later write to the artifact fails too, as a
    // genuinely full disk would. Rollback must therefore not need to write the
    // previous artifact back: it renames a hard-link snapshot. A byte-copy
    // rollback fails here and leaves the new artifact beside the old lock.
    const { dir, artifact, lock, sidecar, input, pending, outputSha256 } =
      setupWorkspace('story-enospc-');
    try {
      expect(() =>
        runWriter(
          dir,
          input,
          `
          let failedLock = false;
          fs.writeFileSync = (file, data, ...args) => {
            const target = String(file);
            if (target.includes('story-reference.lock.json')) {
              failedLock = true;
              write(file, '{ partial', ...args);
              throw new Error('ENOSPC: simulated partial write');
            }
            if (failedLock && target.includes('storyChapters.json5')) {
              throw new Error('ENOSPC: simulated partial write');
            }
            return write(file, data, ...args);
          };
          `
        )
      ).toThrow(/ENOSPC: simulated partial write/);

      expect(readFileSync(artifact, 'utf8')).toBe(PREVIOUS_ARTIFACT);
      expect(readFileSync(lock, 'utf8')).toBe(PREVIOUS_LOCK);
      expect(readFileSync(sidecar, 'utf8')).toBe(pending);
      expect(readdirSync(join(dir, 'src', 'additions'))).toEqual(['storyChapters.json5']);
      expect(readdirSync(join(dir, 'scripts'))).toEqual(['story-reference.lock.json']);
      expect(readdirSync(join(dir, 'data', 'eft'))).toEqual([
        `story-reference.lock.pending.${outputSha256}.json`,
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('retains the rollback snapshot if the restoration rename itself fails', () => {
    const { dir, artifact, lock, sidecar, input, pending } = setupWorkspace('story-rollback-');
    try {
      expect(() =>
        runWriter(
          dir,
          input,
          `
          const rename = fs.renameSync;
          fs.renameSync = (source, destination) => {
            if (String(source).includes('-rollback-')) {
              throw new Error('EACCES: simulated rollback failure');
            }
            return rename(source, destination);
          };
          fs.writeFileSync = (file, data, ...args) => {
            if (String(file).includes('story-reference.lock.json')) {
              throw new Error('ENOSPC: simulated lock failure');
            }
            return write(file, data, ...args);
          };
          `
        )
      ).toThrow(/simulated rollback failure/);
      expect(readFileSync(artifact, 'utf8')).not.toBe(PREVIOUS_ARTIFACT);
      expect(readFileSync(lock, 'utf8')).toBe(PREVIOUS_LOCK);
      expect(readFileSync(sidecar, 'utf8')).toBe(pending);
      const rollbackDir = readdirSync(join(dir, 'src', 'additions')).find((name) =>
        name.includes('-rollback-')
      );
      expect(rollbackDir).toBeDefined();
      expect(readFileSync(join(dir, 'src', 'additions', rollbackDir!, 'previous'), 'utf8')).toBe(
        PREVIOUS_ARTIFACT
      );
      expect(existsSync(join(dir, 'data', 'eft', 'story-write.lock'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('removes an initial artifact if provenance promotion fails with no previous artifact', () => {
    const { dir, artifact, lock, sidecar, input, pending } = setupWorkspace('story-initial-');
    try {
      rmSync(artifact);
      expect(() =>
        runWriter(
          dir,
          input,
          `
          fs.writeFileSync = (file, data, ...args) => {
            if (String(file).includes('story-reference.lock.json')) {
              throw new Error('ENOSPC: simulated lock failure');
            }
            return write(file, data, ...args);
          };
          `
        )
      ).toThrow(/simulated lock failure/);
      expect(existsSync(artifact)).toBe(false);
      expect(readFileSync(lock, 'utf8')).toBe(PREVIOUS_LOCK);
      expect(readFileSync(sidecar, 'utf8')).toBe(pending);
      expect(readdirSync(join(dir, 'src', 'additions'))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves another run's artifact in place when rolling back", () => {
    // If the destination no longer holds the bytes this run published, restoring
    // this run's backup would clobber the other run's artifact while the lock may
    // already name its capture. The rollback keeps its hands off in that case.
    const { dir, artifact, lock, sidecar, input, pending } = setupWorkspace('story-foreign-');
    const foreign = "{ /* another run's artifact */ }\n";
    try {
      expect(() =>
        runWriter(
          dir,
          input,
          `
          fs.writeFileSync = (file, data, ...args) => {
            const target = String(file);
            if (target.includes('story-reference.lock.json')) {
              write(${JSON.stringify(artifact)}, ${JSON.stringify(foreign)});
              write(file, '{ partial', ...args);
              throw new Error('ENOSPC: simulated partial write');
            }
            return write(file, data, ...args);
          };
          `
        )
      ).toThrow(/ENOSPC: simulated partial write/);

      expect(readFileSync(artifact, 'utf8')).toBe(foreign);
      expect(readFileSync(lock, 'utf8')).toBe(PREVIOUS_LOCK);
      expect(readFileSync(sidecar, 'utf8')).toBe(pending);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to publish while another run holds the write lock', () => {
    const { dir, artifact, lock, sidecar, input, pending } = setupWorkspace('story-locked-');
    try {
      writeFileSync(join(dir, 'data', 'eft', 'story-write.lock'), '12345\n');
      expect(() => runWriter(dir, input, '')).toThrow(/another story run/);
      expect(readFileSync(artifact, 'utf8')).toBe(PREVIOUS_ARTIFACT);
      expect(readFileSync(lock, 'utf8')).toBe(PREVIOUS_LOCK);
      expect(readFileSync(sidecar, 'utf8')).toBe(pending);
      expect(existsSync(join(dir, 'data', 'eft', 'story-write.lock'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('releases the write lock after a successful publication', () => {
    const { dir, artifact, lock, sidecar, input } = setupWorkspace('story-unlocked-');
    try {
      expect(() => runWriter(dir, input, '')).not.toThrow();
      expect(readFileSync(artifact, 'utf8')).not.toBe(PREVIOUS_ARTIFACT);
      expect(readFileSync(lock, 'utf8')).not.toBe(PREVIOUS_LOCK);
      expect(existsSync(sidecar)).toBe(false);
      expect(existsSync(join(dir, 'data', 'eft', 'story-write.lock'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
