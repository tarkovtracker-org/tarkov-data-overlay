import { describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
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
    // previous artifact back: it restores a renameable backup. A byte-copy
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
