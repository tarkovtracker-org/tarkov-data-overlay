import { describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { writeFileAtomicSync } from '../scripts/lib/atomic-write.js';

const writer = fileURLToPath(new URL('../scripts/eft-story-write.ts', import.meta.url));

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
});

describe('story artifact and provenance write failures', () => {
  it.each(['storyChapters.json5', 'story-reference.lock.json'])(
    'preserves both committed files when a partial write to %s fails',
    (failingFile) => {
      const dir = mkdtempSync(join(tmpdir(), 'story-partial-write-'));
      const artifact = join(dir, 'src', 'additions', 'storyChapters.json5');
      const lock = join(dir, 'scripts', 'story-reference.lock.json');
      const sidecar = join(dir, 'data', 'eft', 'story-reference.lock.pending.json');
      const input = join(dir, 'story-final.json');
      const previousArtifact = '{ /* previous artifact */ }\n';
      const previousLock = '{ "file": "eft/original.json" }\n';
      const payload = '{}'; // Empty maps are schema-valid; the test concerns publication only.
      try {
        for (const path of ['src/additions', 'src/schemas', 'scripts', 'data/eft']) {
          mkdirSync(join(dir, path), { recursive: true });
        }
        writeFileSync(
          join(dir, 'src', 'schemas', 'story-chapter.schema.json'),
          readFileSync(new URL('../src/schemas/story-chapter.schema.json', import.meta.url))
        );
        writeFileSync(artifact, previousArtifact);
        writeFileSync(lock, previousLock);
        writeFileSync(input, payload);
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
          outputSha256: createHash('sha256').update(payload).digest('hex'),
        });
        writeFileSync(sidecar, pending);

        // Simulate ENOSPC after bytes have already reached disk. Throwing before
        // the real write would miss truncation of the previous committed file.
        // Run in a child so patching the built-in cannot affect another test.
        const bootstrap = `
          import fs from 'node:fs';
          import { syncBuiltinESMExports } from 'node:module';
          const write = fs.writeFileSync;
          let failed = false;
          fs.writeFileSync = (file, data, ...args) => {
            if (!failed && String(file).includes(${JSON.stringify(failingFile)})) {
              failed = true;
              write(file, '{ partial', ...args);
              throw new Error('ENOSPC: simulated partial write');
            }
            return write(file, data, ...args);
          };
          syncBuiltinESMExports();
          process.argv = [process.execPath, ${JSON.stringify(writer)}, ${JSON.stringify(input)}];
          await import(${JSON.stringify(new URL('../scripts/eft-story-write.ts', import.meta.url).href)});
        `;
        expect(() =>
          execFileSync(
            process.execPath,
            ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', bootstrap],
            { cwd: dir, stdio: 'pipe' }
          )
        ).toThrow(/ENOSPC: simulated partial write/);

        expect(readFileSync(artifact, 'utf8')).toBe(previousArtifact);
        expect(readFileSync(lock, 'utf8')).toBe(previousLock);
        expect(readFileSync(sidecar, 'utf8')).toBe(pending);
        expect(readdirSync(join(dir, 'src', 'additions'))).toEqual(['storyChapters.json5']);
        expect(readdirSync(join(dir, 'scripts'))).toEqual(['story-reference.lock.json']);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  );
});
