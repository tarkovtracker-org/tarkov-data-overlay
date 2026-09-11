/**
 * Tests for the TypeScript story pipeline
 * (scripts/eft-story-wiki.ts, scripts/eft-story-generate.ts,
 * scripts/eft-story-write.ts, scripts/lib/sequence-matcher.ts)
 */

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { fileURLToPath } from 'node:url';
import { join } from 'path';
import JSON5 from 'json5';
import { sequenceRatio } from '../scripts/lib/sequence-matcher.js';
import { cleanObjectiveLine, parseObjectives } from '../scripts/eft-story-wiki.js';
import {
  bareId,
  exclusiveCounterparts,
  expandChapterObjectives,
  indexQuests,
  matchOptional,
  normalizeStoryText,
  storyReferenceCandidates,
  unwrapAnnotatedText,
} from '../scripts/eft-story-generate.js';
import { renderStoryChaptersJson5 } from '../scripts/eft-story-write.js';
import { getProjectPaths, STORY_ENDINGS } from '../src/lib/index.js';

/**
 * A complete provenance record, matching what `commitStoryReferenceLock` stages
 * from `fingerprint()`. Promotion requires every field, so partial locks in these
 * fixtures would be refused as unusable rather than exercising the path intended.
 */
const FULL_LOCK = {
  file: 'eft/capture.json',
  sha256: 'a'.repeat(64),
  bytes: 4096,
  clientVersion: 'test-client',
  gameMode: 'pve',
  capturedAt: '2026-06-30T12:00:00Z',
  quests: 12,
  chapterQuests: 3,
  objectiveTexts: 7,
};

describe('story reference provenance enforcement', () => {
  it('requires a lock, verifies relocated bytes, and refreshes request provenance only on opt-in', () => {
    const dir = mkdtempSync(join(tmpdir(), 'story-pin-'));
    const capture = JSON.stringify({
      request: {
        timestamp: '2026-06-30T12:00:00Z',
        url: 'https://gw-pve.example/client/quest_list',
        headers: { 'App-Version': 'test-client' },
      },
      response: {
        timestamp: 'wrong-response-time',
        body_response: {
          data: [
            {
              _id: '68cbd33676fe74b1e80bfd91',
              conditions: {
                AvailableForFinish: [
                  { conditionType: 'Quest', target: 'aaaaaaaaaaaaaaaaaaaaaaaa' },
                ],
              },
            },
            {
              _id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
              conditions: { AvailableForFinish: [{ id: 'bbbbbbbbbbbbbbbbbbbbbbbb' }] },
              localization: { en: { bbbbbbbbbbbbbbbbbbbbbbbb: 'Visit the location' } },
            },
          ],
        },
      },
    });
    const file = join(dir, 'quest_list.json');
    const lockFile = join(dir, 'scripts/story-reference.lock.json');
    const run = (update = '0') =>
      execFileSync(
        process.execPath,
        [
          '--import',
          import.meta.resolve('tsx'),
          '--input-type=module',
          '-e',
          `import { loadReference, commitStoryReferenceLock, promoteStoryReferenceLock } from ${JSON.stringify(new URL('../scripts/eft-story-generate.ts', import.meta.url).href)}; loadReference(); commitStoryReferenceLock(); promoteStoryReferenceLock();`,
        ],
        {
          cwd: dir,
          env: { ...process.env, STORY_REFERENCE: file, STORY_REFERENCE_UPDATE_LOCK: update },
          stdio: 'pipe',
        }
      );
    try {
      mkdirSync(join(dir, 'scripts'));
      writeFileSync(file, capture);
      expect(() => run()).toThrow(/no scripts\/story-reference.lock.json/);
      run('1');
      const lock = JSON.parse(readFileSync(lockFile, 'utf-8'));
      expect(lock).toMatchObject({
        capturedAt: '2026-06-30T12:00:00Z',
        clientVersion: 'test-client',
        gameMode: 'pve',
        sha256: createHash('sha256').update(capture).digest('hex'),
      });
      writeFileSync(lockFile, JSON.stringify({ ...lock, clientVersion: 'wrong' }));
      expect(() => run()).toThrow(/provenance mismatch for clientVersion/);
      writeFileSync(lockFile, JSON.stringify({ ...lock, file: 'moved/original.json' }));
      expect(() => run()).not.toThrow();
      writeFileSync(file, `${capture}\n`);
      expect(() => run()).toThrow(/does not match/);
      const before = readFileSync(lockFile, 'utf-8');
      writeFileSync(file, JSON.stringify({ data: [{ _id: '68cbd33676fe74b1e80bfd91' }] }));
      expect(() => run('1')).toThrow(/no chapter quests or objective texts/);
      expect(readFileSync(lockFile, 'utf-8')).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stages a re-pin without writing it until generation is committed', () => {
    // A capture can resolve chapter data yet still fail a later per-chapter
    // validation. The lock is the only record of which capture produced the
    // committed chapters, so it must not be re-pinned by a run that never got
    // as far as emitting them.
    const dir = mkdtempSync(join(tmpdir(), 'story-pin-defer-'));
    const capture = JSON.stringify({
      request: {
        timestamp: '2026-06-30T12:00:00Z',
        url: 'https://gw-pve.example/client/quest_list',
        headers: { 'App-Version': 'test-client' },
      },
      response: {
        body_response: {
          data: [
            {
              _id: '68cbd33676fe74b1e80bfd91',
              conditions: {
                AvailableForFinish: [
                  { conditionType: 'Quest', target: 'aaaaaaaaaaaaaaaaaaaaaaaa' },
                ],
              },
            },
            {
              _id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
              conditions: { AvailableForFinish: [{ id: 'bbbbbbbbbbbbbbbbbbbbbbbb' }] },
              localization: { en: { bbbbbbbbbbbbbbbbbbbbbbbb: 'Visit the location' } },
            },
          ],
        },
      },
    });
    const file = join(dir, 'quest_list.json');
    const lockFile = join(dir, 'scripts/story-reference.lock.json');
    const runScript = (body: string) =>
      execFileSync(
        process.execPath,
        [
          '--import',
          import.meta.resolve('tsx'),
          '--input-type=module',
          '-e',
          `import { loadReference, commitStoryReferenceLock } from ${JSON.stringify(new URL('../scripts/eft-story-generate.ts', import.meta.url).href)}; ${body}`,
        ],
        {
          cwd: dir,
          env: { ...process.env, STORY_REFERENCE: file, STORY_REFERENCE_UPDATE_LOCK: '1' },
          stdio: 'pipe',
        }
      );
    try {
      mkdirSync(join(dir, 'scripts'));
      writeFileSync(file, capture);

      // loadReference alone stages the pin; nothing is written.
      runScript('loadReference();');
      expect(existsSync(lockFile)).toBe(false);

      // Simulating a validation failure after loadReference still writes nothing.
      expect(() =>
        runScript('loadReference(); throw new Error("late validation failed");')
      ).toThrow();
      expect(existsSync(lockFile)).toBe(false);

      // Only an explicit commit stages it, now to the sidecar the writer promotes.
      runScript('loadReference(); commitStoryReferenceLock();');
      expect(existsSync(lockFile)).toBe(false);
      const sidecar = join(dir, 'data', 'eft', 'story-reference.lock.pending.json');
      expect(existsSync(sidecar)).toBe(true);
      expect(JSON.parse(readFileSync(sidecar, 'utf-8')).lock).toMatchObject({
        sha256: createHash('sha256').update(capture).digest('hex'),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('discards a staged pin generated for different output', () => {
    // A sidecar can outlive a run whose write never happened. Promoting it beside
    // unrelated data would pin a capture that did not produce the artifact, so the
    // pin is bound to the payload hash the generator staged.
    const dir = mkdtempSync(join(tmpdir(), 'story-pin-mismatch-'));
    const sidecar = join(dir, 'data', 'eft', 'story-reference.lock.pending.json');
    const lockFile = join(dir, 'scripts', 'story-reference.lock.json');
    const promote = (hash: string) =>
      execFileSync(
        process.execPath,
        [
          '--import',
          import.meta.resolve('tsx'),
          '--input-type=module',
          '-e',
          `import { promoteStoryReferenceLock } from ${JSON.stringify(new URL('../scripts/eft-story-generate.ts', import.meta.url).href)}; console.log(promoteStoryReferenceLock(${JSON.stringify(hash)}));`,
        ],
        { cwd: dir, env: { ...process.env }, stdio: 'pipe' }
      )
        .toString()
        .trim();
    try {
      mkdirSync(join(dir, 'scripts'), { recursive: true });
      mkdirSync(join(dir, 'data', 'eft'), { recursive: true });
      writeFileSync(
        sidecar,
        `${JSON.stringify({
          lock: FULL_LOCK,
          outputSha256: 'b'.repeat(64),
        })}\n`
      );

      expect(promote('c'.repeat(64))).toBe('false');
      expect(existsSync(lockFile), 'lock written despite payload mismatch').toBe(false);
      // Provably stale, so it is removed rather than left to be applied later.
      expect(existsSync(sidecar)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves the committed lock intact when the sidecar carries no usable lock', () => {
    // The sidecar lives in the gitignored data/ tree, so an interrupted run or a
    // hand edit can leave JSON that parses but omits `lock`. Serializing that
    // straight through would write the literal `undefined` over the committed
    // lock and break every later run that parses it.
    const dir = mkdtempSync(join(tmpdir(), 'story-pin-unusable-'));
    const sidecar = join(dir, 'data', 'eft', 'story-reference.lock.pending.json');
    const lockFile = join(dir, 'scripts', 'story-reference.lock.json');
    const committed = `${JSON.stringify({ file: 'eft/original.json', sha256: 'a'.repeat(64) }, null, 2)}\n`;
    try {
      mkdirSync(join(dir, 'scripts'), { recursive: true });
      mkdirSync(join(dir, 'data', 'eft'), { recursive: true });
      writeFileSync(lockFile, committed);

      for (const payload of [
        JSON.stringify({ outputSha256: 'b'.repeat(64) }), // no lock at all
        JSON.stringify({ lock: { sha256: 'a'.repeat(64) }, outputSha256: null }), // no file
        JSON.stringify({ lock: 'not-an-object', outputSha256: null }),
        // Parses and names a capture, but drops the provenance the lock exists to
        // record, so promoting it would leave the committed chapters unauditable.
        JSON.stringify({
          lock: { file: 'eft/capture.json', sha256: 'a'.repeat(64) },
          outputSha256: 'b'.repeat(64),
        }),
        JSON.stringify({ lock: { ...FULL_LOCK, bytes: 'not-a-number' } }),
        '{ truncated', // never finished being written
      ]) {
        writeFileSync(sidecar, `${payload}\n`);
        const promoted = execFileSync(
          process.execPath,
          [
            '--import',
            import.meta.resolve('tsx'),
            '--input-type=module',
            '-e',
            `import { promoteStoryReferenceLock } from ${JSON.stringify(new URL('../scripts/eft-story-generate.ts', import.meta.url).href)}; console.log(promoteStoryReferenceLock('${'b'.repeat(64)}'));`,
          ],
          { cwd: dir, env: { ...process.env }, stdio: 'pipe' }
        )
          .toString()
          .trim();

        expect(promoted, `promoted an unusable sidecar: ${payload}`).toBe('false');
        expect(readFileSync(lockFile, 'utf-8'), `lock corrupted by: ${payload}`).toBe(committed);
        expect(existsSync(sidecar), `unusable sidecar kept: ${payload}`).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a committed lock that is not a complete provenance record', () => {
    // `{}` used to reach `existsSync(lock.file)` and fail as an opaque TypeError.
    // The committed lock is held to the same contract as a staged one, so it fails
    // by name with the remedy instead.
    const dir = mkdtempSync(join(tmpdir(), 'story-lock-shape-'));
    const lockFile = join(dir, 'scripts', 'story-reference.lock.json');
    const load = () =>
      execFileSync(
        process.execPath,
        [
          '--import',
          import.meta.resolve('tsx'),
          '--input-type=module',
          '-e',
          `import { loadReference } from ${JSON.stringify(new URL('../scripts/eft-story-generate.ts', import.meta.url).href)}; try { loadReference(); } catch (error) { console.log(error.message); }`,
        ],
        { cwd: dir, env: { ...process.env }, stdio: 'pipe' }
      )
        .toString()
        .trim();
    try {
      mkdirSync(join(dir, 'scripts'), { recursive: true });

      writeFileSync(lockFile, '{}\n');
      expect(load()).toMatch(/not a complete provenance record/);

      // A digest-shaped check too: a hand-edited stub must not pass for a real hash.
      writeFileSync(lockFile, `${JSON.stringify({ ...FULL_LOCK, sha256: 'x' })}\n`);
      expect(load()).toMatch(/not a complete provenance record/);

      writeFileSync(lockFile, '{ truncated\n');
      expect(load()).toMatch(/is not valid JSON/);

      // The error names re-pinning as the remedy, so that remedy has to work: an
      // explicit update run treats the unusable lock as absent and replaces it
      // rather than failing before the update path is reached.
      const loadUpdating = () =>
        execFileSync(
          process.execPath,
          [
            '--import',
            import.meta.resolve('tsx'),
            '--input-type=module',
            '-e',
            `import { loadReference } from ${JSON.stringify(new URL('../scripts/eft-story-generate.ts', import.meta.url).href)}; try { loadReference(); } catch (error) { console.log(error.message); }`,
          ],
          {
            cwd: dir,
            env: { ...process.env, STORY_REFERENCE_UPDATE_LOCK: '1' },
            stdio: 'pipe',
          }
        )
          .toString()
          .trim();
      for (const broken of ['{}\n', '{ truncated\n']) {
        writeFileSync(lockFile, broken);
        // Gets past readLock to the ordinary "no capture here" failure.
        expect(loadUpdating(), `re-pin blocked by ${broken.trim()}`).not.toMatch(
          /provenance record|not valid JSON/
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a staged pin that is not bound to the payload being committed', () => {
    // `outputSha256: null` used to act as a wildcard, so a sidecar that never
    // recorded which payload it was staged for could be promoted beside unrelated
    // data. A caller that supplies a hash is asserting what it is committing, so
    // an unbound pin is refused rather than trusted.
    const dir = mkdtempSync(join(tmpdir(), 'story-pin-unbound-'));
    const sidecar = join(dir, 'data', 'eft', 'story-reference.lock.pending.json');
    const lockFile = join(dir, 'scripts', 'story-reference.lock.json');
    const promote = (arg: string) =>
      execFileSync(
        process.execPath,
        [
          '--import',
          import.meta.resolve('tsx'),
          '--input-type=module',
          '-e',
          `import { promoteStoryReferenceLock } from ${JSON.stringify(new URL('../scripts/eft-story-generate.ts', import.meta.url).href)}; console.log(promoteStoryReferenceLock(${arg}));`,
        ],
        { cwd: dir, env: { ...process.env }, stdio: 'pipe' }
      )
        .toString()
        .trim();
    const stage = () =>
      writeFileSync(sidecar, `${JSON.stringify({ lock: FULL_LOCK, outputSha256: null })}\n`);
    try {
      mkdirSync(join(dir, 'scripts'), { recursive: true });
      mkdirSync(join(dir, 'data', 'eft'), { recursive: true });

      stage();
      expect(promote(JSON.stringify('b'.repeat(64))), 'promoted an unbound sidecar').toBe('false');
      expect(existsSync(lockFile), 'lock written from an unbound sidecar').toBe(false);

      // Omitting the hash is the "not committing an artifact" path, where there is
      // nothing to bind to and the pin still applies.
      stage();
      expect(promote('')).toBe('true');
      expect(JSON.parse(readFileSync(lockFile, 'utf-8'))).toMatchObject({ file: FULL_LOCK.file });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to replace the story artifact when a staged re-pin does not match it', () => {
    // Promotion is deliberately attempted after the artifact write so a failed
    // write cannot advance the pin. That ordering must not let a *refused*
    // promotion pass silently: the result would be freshly generated chapters
    // described by the previous capture's lock.
    const dir = mkdtempSync(join(tmpdir(), 'story-write-refuse-'));
    const sidecar = join(dir, 'data', 'eft', 'story-reference.lock.pending.json');
    const lockFile = join(dir, 'scripts', 'story-reference.lock.json');
    const dest = join(dir, 'src', 'additions', 'storyChapters.json5');
    const input = join(dir, 'story-final.json');
    const committed = `${JSON.stringify({ file: 'eft/original.json', sha256: 'a'.repeat(64) }, null, 2)}\n`;
    const previousArtifact = '{ /* previous */ }\n';
    try {
      mkdirSync(join(dir, 'scripts'), { recursive: true });
      mkdirSync(join(dir, 'data', 'eft'), { recursive: true });
      mkdirSync(join(dir, 'src', 'additions'), { recursive: true });
      mkdirSync(join(dir, 'src', 'schemas'), { recursive: true });
      writeFileSync(
        join(dir, 'src', 'schemas', 'story-chapter.schema.json'),
        readFileSync(join(getProjectPaths().schemasDir, 'story-chapter.schema.json'))
      );
      writeFileSync(lockFile, committed);
      writeFileSync(dest, previousArtifact);
      writeFileSync(
        input,
        JSON.stringify({
          'test-chapter': {
            id: 'test-chapter',
            name: 'Test Chapter',
            normalizedName: 'test-chapter',
            wikiLink: 'https://example.test/',
            order: 1,
            chapterQuestId: '68cbd33676fe74b1e80bfd91',
            referenceCoverage: {
              referencedSubquests: 0,
              resolvedSubquests: 0,
              partial: false,
            },
          },
        })
      );
      // Staged for output that is not what the writer is about to read.
      writeFileSync(
        sidecar,
        `${JSON.stringify({
          lock: { ...FULL_LOCK, file: 'eft/newer.json', sha256: 'c'.repeat(64) },
          outputSha256: 'b'.repeat(64),
        })}\n`
      );

      const run = () => {
        let status = 0;
        let stderr = '';
        try {
          execFileSync(
            process.execPath,
            [
              '--import',
              import.meta.resolve('tsx'),
              fileURLToPath(new URL('../scripts/eft-story-write.ts', import.meta.url)),
              input,
            ],
            { cwd: dir, env: { ...process.env }, stdio: 'pipe' }
          );
        } catch (error: any) {
          status = error.status ?? 1;
          stderr = error.stderr?.toString() ?? '';
        }
        return { status, stderr };
      };

      const mismatched = run();
      expect(mismatched.status, 'writer exited successfully despite a refused re-pin').not.toBe(0);
      expect(mismatched.stderr).toMatch(/refusing to write/);
      // Neither side moved, so the pin still describes the committed artifact.
      expect(readFileSync(dest, 'utf-8')).toBe(previousArtifact);
      expect(readFileSync(lockFile, 'utf-8')).toBe(committed);

      // Same refusal for a sidecar that cannot be read as a lock at all: the
      // artifact must not be replaced on the strength of a pin that cannot land.
      writeFileSync(sidecar, '{ truncated\n');
      const unusable = run();
      expect(unusable.status, 'writer accepted an unusable staged re-pin').not.toBe(0);
      expect(unusable.stderr).toMatch(/refusing to write/);
      expect(readFileSync(dest, 'utf-8')).toBe(previousArtifact);
      expect(readFileSync(lockFile, 'utf-8')).toBe(committed);

      // With no sidecar there is no pin to move, so generation proceeds.
      rmSync(sidecar, { force: true });
      const clean = run();
      expect(clean.status, clean.stderr).toBe(0);
      expect(readFileSync(dest, 'utf-8')).not.toBe(previousArtifact);
      expect(readFileSync(lockFile, 'utf-8'), 'lock moved without a staged re-pin').toBe(committed);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to pin a capture from a mode the storyline is not shared with', () => {
    // The committed addition is stamped "shared between PVP and PVE". A seasonal
    // character is a separate progression with independently divergent quest
    // data, and an advanced one can out-score every other capture on chapter
    // coverage, so discovery and explicit replacement both have to exclude it.
    const dir = mkdtempSync(join(tmpdir(), 'story-pin-mode-'));
    const seasonal = JSON.stringify({
      request: {
        timestamp: '2026-06-30T12:00:00Z',
        url: 'https://gw-pvp-season.example/client/quest_list',
        headers: { 'App-Version': 'test-client' },
      },
      response: {
        body_response: {
          data: [
            {
              _id: '68cbd33676fe74b1e80bfd91',
              conditions: {
                AvailableForFinish: [
                  { conditionType: 'Quest', target: 'aaaaaaaaaaaaaaaaaaaaaaaa' },
                ],
              },
            },
            {
              _id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
              conditions: { AvailableForFinish: [{ id: 'bbbbbbbbbbbbbbbbbbbbbbbb' }] },
              localization: { en: { bbbbbbbbbbbbbbbbbbbbbbbb: 'Visit the location' } },
            },
          ],
        },
      },
    });
    const file = join(dir, 'quest_list.json');
    try {
      mkdirSync(join(dir, 'scripts'));
      mkdirSync(join(dir, 'data', 'eft'), { recursive: true });
      writeFileSync(file, seasonal);
      expect(() =>
        execFileSync(
          process.execPath,
          [
            '--import',
            import.meta.resolve('tsx'),
            '--input-type=module',
            '-e',
            `import { loadReference } from ${JSON.stringify(new URL('../scripts/eft-story-generate.ts', import.meta.url).href)}; loadReference();`,
          ],
          {
            cwd: dir,
            env: { ...process.env, STORY_REFERENCE: file, STORY_REFERENCE_UPDATE_LOCK: '1' },
            stdio: 'pipe',
          }
        )
      ).toThrow(/pvp-season.*shared between regular and pve|shared between regular and pve/s);
      expect(existsSync(join(dir, 'scripts/story-reference.lock.json'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to pin a capture whose mode cannot be identified', () => {
    // "Unknown" is not a safe default here: a capture with no recognizable
    // request URL cannot be shown to belong to the shared storyline's modes, and
    // accepting it would let a seasonal-derived capture through the same gap.
    const dir = mkdtempSync(join(tmpdir(), 'story-pin-unknown-'));
    const unknownMode = JSON.stringify({
      data: [
        {
          _id: '68cbd33676fe74b1e80bfd91',
          conditions: {
            AvailableForFinish: [{ conditionType: 'Quest', target: 'aaaaaaaaaaaaaaaaaaaaaaaa' }],
          },
        },
        {
          _id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
          conditions: { AvailableForFinish: [{ id: 'bbbbbbbbbbbbbbbbbbbbbbbb' }] },
          localization: { en: { bbbbbbbbbbbbbbbbbbbbbbbb: 'Visit the location' } },
        },
      ],
    });
    const file = join(dir, 'quest_list.json');
    try {
      mkdirSync(join(dir, 'scripts'));
      mkdirSync(join(dir, 'data', 'eft'), { recursive: true });
      writeFileSync(file, unknownMode);
      expect(() =>
        execFileSync(
          process.execPath,
          [
            '--import',
            import.meta.resolve('tsx'),
            '--input-type=module',
            '-e',
            `import { loadReference } from ${JSON.stringify(new URL('../scripts/eft-story-generate.ts', import.meta.url).href)}; loadReference();`,
          ],
          {
            cwd: dir,
            env: { ...process.env, STORY_REFERENCE: file, STORY_REFERENCE_UPDATE_LOCK: '1' },
            stdio: 'pipe',
          }
        )
      ).toThrow(/unknown/);
      expect(existsSync(join(dir, 'scripts/story-reference.lock.json'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('promotes a staged pin only once the artifact is written', () => {
    // The lock records which capture produced the committed chapters, so it must
    // move with the artifact: the generator stages it, and eft-story-write.ts
    // promotes it after storyChapters.json5 is on disk.
    const dir = mkdtempSync(join(tmpdir(), 'story-pin-promote-'));
    const sidecar = join(dir, 'data', 'eft', 'story-reference.lock.pending.json');
    const lockFile = join(dir, 'scripts', 'story-reference.lock.json');
    try {
      mkdirSync(join(dir, 'scripts'), { recursive: true });
      mkdirSync(join(dir, 'data', 'eft'), { recursive: true });
      const staged = `${JSON.stringify(
        {
          lock: FULL_LOCK,
          outputSha256: 'b'.repeat(64),
        },
        null,
        2
      )}\n`;
      writeFileSync(sidecar, staged);

      const promoted = execFileSync(
        process.execPath,
        [
          '--import',
          import.meta.resolve('tsx'),
          '--input-type=module',
          '-e',
          `import { promoteStoryReferenceLock } from ${JSON.stringify(new URL('../scripts/eft-story-generate.ts', import.meta.url).href)}; console.log(promoteStoryReferenceLock('${'b'.repeat(64)}'));`,
        ],
        { cwd: dir, env: { ...process.env }, stdio: 'pipe' }
      )
        .toString()
        .trim();

      expect(promoted).toBe('true');
      expect(JSON.parse(readFileSync(lockFile, 'utf-8'))).toMatchObject({
        file: 'eft/capture.json',
        sha256: 'a'.repeat(64),
      });
      // Sidecar consumed, so a later run cannot re-apply a stale pin.
      expect(existsSync(sidecar)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('sequenceRatio (difflib SequenceMatcher.ratio port)', () => {
  // Expected values computed with CPython difflib.SequenceMatcher(None, a, b).ratio()
  const vectors: Array<[string, string, number]> = [
    ['', '', 1.0],
    ['abc', '', 0.0],
    ['abc', 'abc', 1.0],
    [
      'locate the underground laboratory entrance',
      'locate the underground lab entrance',
      0.9090909090909091,
    ],
    ['hand over # golden neck chains', 'hand over # gp coins', 0.72],
    [
      'eliminate # pmc operatives',
      'eliminate # scav raiders while wearing a vest',
      0.5915492957746479,
    ],
    // long inputs exercise the autojunk (popular element) heuristic
    ['a'.repeat(250), 'a'.repeat(100) + 'b'.repeat(150), 0.4],
    [
      'survive and extract from the labyrinth '.repeat(8),
      'survive and extract from labyrinth '.repeat(8),
      0.08445945945945946,
    ],
  ];

  it('matches CPython difflib exactly', () => {
    for (const [a, b, expected] of vectors) {
      expect(sequenceRatio(a, b)).toBeCloseTo(expected, 12);
    }
  });

  it('is 1.0 for identical non-empty strings', () => {
    expect(sequenceRatio('tarkov', 'tarkov')).toBe(1.0);
  });
});

describe('cleanObjectiveLine', () => {
  it('strips wiki links, keeping the display text', () => {
    expect(cleanObjectiveLine('* Locate the [[Terminal|terminal entrance]]')).toEqual({
      text: 'Locate the terminal entrance',
      optional: false,
    });
    expect(cleanObjectiveLine('* Reach [[Streets of Tarkov]]')).toEqual({
      text: 'Reach Streets of Tarkov',
      optional: false,
    });
  });

  it('detects and strips the (optional) marker', () => {
    const result = cleanObjectiveLine("* Kill the boss (''Optional'')");
    expect(result.optional).toBe(true);
    expect(result.text).toBe('Kill the boss');
  });

  it('removes html tags and bold/italic quotes', () => {
    expect(cleanObjectiveLine("* <font color=red>'''Survive'''</font> the raid")).toEqual({
      text: 'Survive the raid',
      optional: false,
    });
  });

  it('does not let quote stripping rebuild a tag the tag pass missed', () => {
    // `<''script` has no closing bracket, so the tag pass leaves it alone and
    // removing the italic markers would otherwise yield `<script`.
    for (const line of ["<''script", "<'''script", "<''script alert(1)", "<''img src=x"]) {
      const { text } = cleanObjectiveLine(line);
      expect(text).not.toMatch(/[<>]/);
      expect(text.toLowerCase()).not.toContain('<script');
    }
    expect(cleanObjectiveLine("<''script").text).toBe('script');
  });

  it('keeps objective wording intact when brackets are unbalanced', () => {
    expect(cleanObjectiveLine('* Survive the raid <3').text).toBe('Survive the raid 3');
  });
});

describe('parseObjectives', () => {
  const wikitext = [
    '== Description ==',
    'Some intro text',
    '== Objectives ==',
    '* First objective',
    "* Second objective (''optional'')",
    "'''If you side with them:'''",
    '* Third objective',
    '',
    '== Rewards ==',
    '* Not an objective',
  ].join('\n');

  it('parses bullet lines and treats a conditional branch as not required', () => {
    const objectives = parseObjectives(wikitext);
    expect(objectives).toEqual([
      { text: 'First objective', optional: false },
      { text: 'Second objective', optional: true },
      // Under "'''If you side with them:'''", so it applies only to players who
      // took that branch. Marking it required would block everyone else.
      { text: 'Third objective', optional: true },
    ]);
  });

  it('closes a conditional branch at an unconditional header', () => {
    const branched = [
      '== Objectives ==',
      '* Always required',
      "'''If the case was given away'''",
      '* Branch only',
      "'''Once you have the case'''",
      '* Required again',
      '=== If you accept the offer ===',
      '* Ending branch',
      '== Rewards ==',
    ].join('\n');
    expect(parseObjectives(branched)).toEqual([
      { text: 'Always required', optional: false },
      { text: 'Branch only', optional: true },
      // "Once you have the case" states sequence, not a choice, so it ends the
      // branch rather than extending it.
      { text: 'Required again', optional: false },
      // Heading-delimited branches count too, not just bold ones.
      { text: 'Ending branch', optional: true },
    ]);
  });

  it('ends a group of branch alternatives at a horizontal rule', () => {
    // Shaped after the real Boreas Objectives section, where each `<hr/>` closes a
    // set of "If ..." variants and the universal storyline resumes after it.
    // Treating the rule as a no-op left the last branch open and published trunk
    // objectives as optional.
    const boreasShaped = [
      '== Objectives ==',
      '* Arrange a transport to the icebreaker',
      "'''If you gave the Armored case to Prapor'''",
      '* Hand over the AMG-10 fluid to Prapor',
      "'''If you have not completed Falling Skies'''",
      '* Eliminate any 30 targets on Reserve',
      '<hr/>',
      '* Find an alternative transport to the icebreaker',
      '* Board the smuggler hovercraft',
      '== Rewards ==',
    ].join('\n');
    expect(parseObjectives(boreasShaped)).toEqual([
      { text: 'Arrange a transport to the icebreaker', optional: false },
      { text: 'Hand over the AMG-10 fluid to Prapor', optional: true },
      { text: 'Eliminate any 30 targets on Reserve', optional: true },
      // Post-rule trunk: required for everyone regardless of the branch taken.
      { text: 'Find an alternative transport to the icebreaker', optional: false },
      { text: 'Board the smuggler hovercraft', optional: false },
    ]);
  });

  it('does not promote a nested convergence out of its enclosing ending', () => {
    // Convergence across nested alternatives only proves the step is unavoidable
    // *within* the enclosing branch. If that branch is itself conditional, players
    // who never enter the ending never see the step.
    const nested = [
      '== Objectives ==',
      '=== If you accept the offer ===',
      "'''If you have the case'''",
      '* Step A',
      '* Common step',
      "'''If you lack the case'''",
      '* Step B',
      '* Common step',
      '== Rewards ==',
    ].join('\n');
    expect(parseObjectives(nested)).toEqual([
      { text: 'Step A', optional: true },
      { text: 'Common step', optional: true },
      { text: 'Step B', optional: true },
      { text: 'Common step', optional: true },
    ]);
  });

  it('detects convergence across heading-delimited alternatives too', () => {
    // The Ticket's endings are `===If ...===` sections. Closing the group between
    // them would put each ending in its own group and make convergence undetectable,
    // so a step every ending requires would be published optional.
    const endings = [
      '== Objectives ==',
      '=== If you accept the offer ===',
      '* Accept it',
      '* Arrive at the Terminal',
      '=== If you refuse the offer ===',
      '* Refuse it',
      '* Arrive at the Terminal',
      '== Rewards ==',
    ].join('\n');
    expect(parseObjectives(endings)).toEqual([
      { text: 'Accept it', optional: true },
      { text: 'Arrive at the Terminal', optional: false },
      { text: 'Refuse it', optional: true },
      { text: 'Arrive at the Terminal', optional: false },
    ]);
  });

  it('keeps a step required when every branch alternative repeats it', () => {
    // Boreas converges: each "If ..." variant ends on the same closing step, so no
    // choice avoids it and publishing it optional would understate the storyline.
    const converging = [
      '== Objectives ==',
      "'''If you have completed The Price of Independence'''",
      '* Return to the Hideout',
      '* Tell Mechanic that you found transport',
      "'''If you have completed Choose Your Friends Wisely'''",
      '* Hand over 200 rounds',
      '* Tell Mechanic that you found transport',
      '== Rewards ==',
    ].join('\n');
    expect(parseObjectives(converging)).toEqual([
      // Present in one alternative only, so genuinely branch-specific.
      { text: 'Return to the Hideout', optional: true },
      { text: 'Tell Mechanic that you found transport', optional: false },
      { text: 'Hand over 200 rounds', optional: true },
      { text: 'Tell Mechanic that you found transport', optional: false },
    ]);
  });

  it('keeps a step required when it also appears outside any branch', () => {
    const alsoTrunk = [
      '== Objectives ==',
      "'''If you took the long way'''",
      '* Return to the BTR driver',
      '<hr/>',
      '* Return to the BTR driver',
      '== Rewards ==',
    ].join('\n');
    expect(parseObjectives(alsoTrunk)).toEqual([
      // Stated unconditionally later, so the branch occurrence is not a choice.
      { text: 'Return to the BTR driver', optional: false },
      { text: 'Return to the BTR driver', optional: false },
    ]);
  });

  it('never overrides an explicit optional marker with branch inference', () => {
    // Boreas uses "Reach the engine room" both as an (Optional) hint under one step
    // and as a required step later. Only the inline marker separates them, so the
    // trunk inference must not promote the marked one to required.
    const markedAndTrunk = [
      '== Objectives ==',
      '* Access the engine room',
      "** (''Optional'') Reach the engine room",
      '* Reach the engine room',
      '== Rewards ==',
    ].join('\n');
    expect(parseObjectives(markedAndTrunk)).toEqual([
      { text: 'Access the engine room', optional: false },
      { text: 'Reach the engine room', optional: true },
      { text: 'Reach the engine room', optional: false },
    ]);
  });

  it('does not let a bold sub-header close the ending it sits inside', () => {
    // The Ticket nests bold sub-headers under `===If ...===` ending sections. A
    // sub-header closing the outer branch would leak that ending's objectives out
    // as universally required.
    const nested = [
      '== Objectives ==',
      '* Contact Mr. Kerman',
      "=== If you accept Mr. Kerman's offer ===",
      '* Accept the offer',
      "'''After the completion of Prapor's tasks'''",
      '* Hand over the case to Prapor',
      '== Rewards ==',
    ].join('\n');
    expect(parseObjectives(nested)).toEqual([
      { text: 'Contact Mr. Kerman', optional: false },
      { text: 'Accept the offer', optional: true },
      // Still inside the ending branch, despite the unconditional sub-header.
      { text: 'Hand over the case to Prapor', optional: true },
    ]);
  });

  it('returns empty when no Objectives section exists', () => {
    expect(parseObjectives('== Rewards ==\n* something')).toEqual([]);
  });
});

describe('normalizeStoryText / matchOptional', () => {
  it('collapses numbers and punctuation', () => {
    expect(normalizeStoryText('Hand over 3,000 Roubles!')).toBe('hand over # roubles');
  });

  it('matches an objective to its wiki counterpart above the threshold', () => {
    const wiki = [
      { text: 'Hand over 5 golden neck chains', optional: true },
      { text: 'Eliminate 10 PMC operatives', optional: false },
    ];
    expect(matchOptional('Hand over 5 golden neck chains', wiki).optional).toBe(true);
    expect(matchOptional('Eliminate 10 PMC operatives on Customs', wiki).optional).toBe(false);
  });

  it('treats below-threshold matches as required', () => {
    const wiki = [{ text: 'Something entirely unrelated to anything', optional: true }];
    const result = matchOptional('Reach the safe room', wiki);
    expect(result.optional).toBe(false);
    expect(result.ratio).toBeLessThan(0.6);
  });
});

describe('bareId', () => {
  it('extracts a 24-hex id from wrapped values', () => {
    expect(bareId('[68cbd33676fe74b1e80bfd91] Tour')).toBe('68cbd33676fe74b1e80bfd91');
    expect(bareId('68cbd33676fe74b1e80bfd91')).toBe('68cbd33676fe74b1e80bfd91');
    expect(bareId('not an id')).toBeNull();
    expect(bareId(42)).toBeNull();
  });
});

describe('unwrapAnnotatedText', () => {
  it('recovers the client value from the enrichment wrapper', () => {
    // The enriched capture rewrites values as `[<original>] <resolved>`; the
    // plain 1.1 capture gives this objective id exactly "Escape from Tarkov".
    expect(unwrapAnnotatedText('[Escape from Tarkov] ESCAPE FROM TARKOV')).toBe(
      'Escape from Tarkov'
    );
    expect(unwrapAnnotatedText('[68da33fe00868edcb6025ac4 name] The Ticket')).toBe(
      '68da33fe00868edcb6025ac4 name'
    );
  });

  it('leaves plain text and unresolvable markers alone', () => {
    expect(unwrapAnnotatedText('Pass the security check')).toBe('Pass the security check');
    // Empty brackets are the tool's "could not resolve" marker: there is no
    // original to recover, and the tail is an unrelated string.
    expect(unwrapAnnotatedText('[] Experience bonus {0}')).toBe('[] Experience bonus {0}');
  });
});

describe('expandChapterObjectives', () => {
  const capture = [
    {
      _id: '[68da33fe00868edcb6025ac4] Chapter',
      conditions: {
        AvailableForFinish: [
          { conditionType: 'Quest', target: ['[aaaaaaaaaaaaaaaaaaaaaaaa] sub'] },
          { conditionType: 'Quest', target: '[aaaaaaaaaaaaaaaaaaaaaaaa] sub' }, // duplicate ref
          { conditionType: 'Quest', target: '67bdf8c066ca1d79a202463a' }, // ending gate
          { conditionType: 'Quest', target: 'cccccccccccccccccccccccc' }, // unresolved
          { conditionType: 'CounterCreator' }, // not a sub-quest ref
        ],
      },
    },
    {
      _id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
      localization: { en: { o1: 'First objective', o3: 'Third objective' } },
      conditions: {
        AvailableForFinish: [
          { id: 'o1' },
          { id: 'o2' }, // no localized text -> skipped
          {}, // no id -> skipped
          { id: 'o3' },
        ],
      },
    },
    {
      _id: '67bdf8c066ca1d79a202463a',
      localization: { en: { g1: 'Reach the evacuation area' } },
      conditions: {
        AvailableForFinish: [{ id: 'g1' }],
        // Only startable if the other resolved sub-quest failed -> exclusive.
        AvailableForStart: [
          { conditionType: 'Quest', target: 'aaaaaaaaaaaaaaaaaaaaaaaa', status: [5] },
        ],
        // The counterpart is not a resolved sub-quest of this chapter, so it
        // is outside the chapter-local completion-pair model.
        Fail: [{ conditionType: 'Quest', target: '67460662d0fbbc74ca0f7229', status: [4] }],
      },
    },
  ];

  it('collects objectives once per referenced sub-quest and tags ending gates', () => {
    const expansion = expandChapterObjectives(
      '68da33fe00868edcb6025ac4',
      indexQuests(capture as never)
    );
    expect(expansion.objectives.map((o) => o.id)).toEqual(['o1', 'o3', 'g1']);
    expect(expansion.objectives[0]).toEqual({
      id: 'o1',
      text: 'First objective',
      sourceQuestId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
    });
    // The gate sub-quest's objective carries the real ending id.
    expect(expansion.objectives[2].endingId).toBe(STORY_ENDINGS[0].id);
  });

  it('reports referenced vs resolved sub-quests for coverage', () => {
    const expansion = expandChapterObjectives(
      '68da33fe00868edcb6025ac4',
      indexQuests(capture as never)
    );
    // Three distinct refs (the duplicate collapses), one of which is missing.
    expect(expansion.referencedSubquests).toEqual([
      'aaaaaaaaaaaaaaaaaaaaaaaa',
      '67bdf8c066ca1d79a202463a',
      'cccccccccccccccccccccccc',
    ]);
    expect(expansion.resolvedSubquests).toEqual([
      'aaaaaaaaaaaaaaaaaaaaaaaa',
      '67bdf8c066ca1d79a202463a',
    ]);
  });

  it('returns nothing for a chapter quest the capture lacks', () => {
    const expansion = expandChapterObjectives('ffffffffffffffffffffffff', indexQuests([]));
    expect(expansion.objectives).toEqual([]);
    expect(expansion.referencedSubquests).toEqual([]);
    expect(expansion.resolvedSubquests).toEqual([]);
    expect(expansion.missingObjectiveTexts).toBe(0);
    expect(expansion.exclusivePairs).toEqual([]);
  });

  it('keeps exclusive pairs only between resolved sub-quests of the chapter', () => {
    const expansion = expandChapterObjectives(
      '68da33fe00868edcb6025ac4',
      indexQuests(capture as never)
    );
    expect(expansion.exclusivePairs).toEqual([
      ['67bdf8c066ca1d79a202463a', 'aaaaaaaaaaaaaaaaaaaaaaaa'],
    ]);
  });
});

describe('exclusiveCounterparts', () => {
  it('reads a fail-on-completion condition as exclusivity', () => {
    expect(
      exclusiveCounterparts({
        conditions: {
          Fail: [{ conditionType: 'Quest', target: 'aaaaaaaaaaaaaaaaaaaaaaaa', status: [4] }],
        },
      })
    ).toEqual(['aaaaaaaaaaaaaaaaaaaaaaaa']);
    // "fails once the other is even started" is stronger exclusivity, not weaker.
    expect(
      exclusiveCounterparts({
        conditions: {
          Fail: [{ conditionType: 'Quest', target: 'bbbbbbbbbbbbbbbbbbbbbbbb', status: [2, 4] }],
        },
      })
    ).toEqual(['bbbbbbbbbbbbbbbbbbbbbbbb']);
  });

  it('reads a start-only-if-failed condition as exclusivity', () => {
    expect(
      exclusiveCounterparts({
        conditions: {
          AvailableForStart: [
            { conditionType: 'Quest', target: '[cccccccccccccccccccccccc] Other', status: [5] },
          ],
        },
      })
    ).toEqual(['cccccccccccccccccccccccc']);
  });

  it.each([
    { status: [2, 5] },
    { status: [1, 5] },
    { status: [4, 5] },
    { status: [] },
    { status: [2] },
  ])(
    'does not infer exclusivity when failure is not the only accepted state: $status',
    ({ status }) => {
      expect(
        exclusiveCounterparts({
          conditions: {
            AvailableForStart: [
              { conditionType: 'Quest', target: 'aaaaaaaaaaaaaaaaaaaaaaaa', status },
            ],
          },
        })
      ).toEqual([]);
    }
  );

  it('does not treat cascade failure or ordinary prerequisites as exclusivity', () => {
    // Fails because its predecessor failed - the chain dies together, it is not
    // an alternative branch.
    expect(
      exclusiveCounterparts({
        conditions: {
          Fail: [{ conditionType: 'Quest', target: 'dddddddddddddddddddddddd', status: [5] }],
        },
      })
    ).toEqual([]);
    // Ordinary unlock edge.
    expect(
      exclusiveCounterparts({
        conditions: {
          AvailableForStart: [
            { conditionType: 'Quest', target: 'eeeeeeeeeeeeeeeeeeeeeeee', status: [4] },
          ],
        },
      })
    ).toEqual([]);
    // "completed or failed" accepts success, so it excludes nothing.
    expect(
      exclusiveCounterparts({
        conditions: {
          AvailableForStart: [
            { conditionType: 'Quest', target: 'ffffffffffffffffffffffff', status: [4, 5] },
          ],
        },
      })
    ).toEqual([]);
    // Non-Quest conditions and missing quests contribute nothing.
    expect(
      exclusiveCounterparts({
        conditions: { Fail: [{ conditionType: 'CounterCreator', status: [4] }] },
      })
    ).toEqual([]);
    expect(exclusiveCounterparts(undefined)).toEqual([]);
  });
});

describe('storyReferenceCandidates', () => {
  it('discovers captures in a filesystem-independent order', () => {
    // readdirSync order is not portable, so discovery sorts; enriched captures
    // still rank first because they carry the localization block.
    const root = mkdtempSync(join(tmpdir(), 'story-candidates-'));
    try {
      mkdirSync(join(root, 'zdir'));
      mkdirSync(join(root, 'adir'));
      for (const file of [
        'quest_list.b.json',
        'quest_list.a.json',
        'quest_list.rollinglatest.modified.json',
        'not-a-capture.json',
        'quest_list.txt',
      ]) {
        writeFileSync(join(root, file), '{}');
      }
      writeFileSync(join(root, 'zdir', 'quest-list.z.json'), '{}');
      writeFileSync(join(root, 'adir', 'quest_list.nested.json'), '{}');

      expect(storyReferenceCandidates(root)).toEqual([
        join(root, 'quest_list.rollinglatest.modified.json'),
        join(root, 'adir', 'quest_list.nested.json'),
        join(root, 'quest_list.a.json'),
        join(root, 'quest_list.b.json'),
        join(root, 'zdir', 'quest-list.z.json'),
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('renderStoryChaptersJson5', () => {
  it('round-trips the committed storyChapters.json5 byte-for-byte', () => {
    const { srcDir } = getProjectPaths();
    const committedPath = join(srcDir, 'additions', 'storyChapters.json5');
    const committed = readFileSync(committedPath, 'utf8');
    const data = JSON5.parse(committed);
    expect(renderStoryChaptersJson5(data)).toBe(committed);
  });
});
