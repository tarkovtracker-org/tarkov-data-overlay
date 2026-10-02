import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  classifyMaintenancePath,
  countMaintenanceLines,
  maintenanceAuditFailed,
  readAuditCounts,
  renderMaintenanceSummary,
  resolveMaintenanceBase,
} from '../scripts/maintenance-ci.js';

const base = 'a'.repeat(40);
const head = 'b'.repeat(40);
const currentBase = 'c'.repeat(40);
const mergeBase = 'd'.repeat(40);
const event = { pull_request: { base: { sha: base }, head: { sha: head } } };
const report = {
  kind: 'audit',
  verdict: 'pass',
  attribution: {
    gate: 'new-only',
    dead_code_introduced: 0,
    dead_code_inherited: 2,
    complexity_introduced: 0,
    complexity_inherited: 8,
    duplication_introduced: 0,
    duplication_inherited: 3,
    styling_introduced: 0,
    styling_inherited: 0,
  },
};

function fakeGit(...args: string[]): string {
  if (args[0] === 'merge-base') return mergeBase;
  if (args[2] === 'HEAD^1') return currentBase;
  if (args[2] === 'HEAD^2') return head;
  return args[2].split('^')[0];
}

describe('maintenance comparison base', () => {
  it('uses the current first parent for a verified GitHub PR merge checkout', () => {
    expect(resolveMaintenanceBase('pull_request', 'refs/pull/12/merge', event, fakeGit)).toBe(
      currentBase
    );
  });

  it('uses merge-base for a PR head checkout, including a branch with its own merge', () => {
    const git = vi.fn(fakeGit);
    expect(resolveMaintenanceBase('pull_request', 'refs/heads/topic', event, git)).toBe(mergeBase);
    expect(git).not.toHaveBeenCalledWith('rev-parse', '--verify', 'HEAD^1');
  });

  it('uses the exact before SHA on pushes', () => {
    expect(resolveMaintenanceBase('push', 'refs/heads/main', { before: base }, fakeGit)).toBe(base);
  });

  it.each([undefined, '0'.repeat(40), 'main', '--bad-option'])(
    'rejects invalid push base %s',
    (before) => {
      expect(() =>
        resolveMaintenanceBase('push', 'refs/heads/main', { before }, fakeGit)
      ).toThrow();
    }
  );

  it('fails closed on missing commits and mismatched merge parents', () => {
    expect(() =>
      resolveMaintenanceBase('push', '', { before: base }, () => {
        throw new Error('missing commit');
      })
    ).toThrow('missing commit');
    expect(() =>
      resolveMaintenanceBase('pull_request', 'refs/pull/12/merge', event, (...args) =>
        args[2] === 'HEAD^2' ? base : fakeGit(...args)
      )
    ).toThrow('does not match');
    expect(() => resolveMaintenanceBase('workflow_dispatch', '', {}, fakeGit)).toThrow(
      'Unsupported'
    );
  });
});

describe('maintenance category accounting', () => {
  it.each([
    ['src/lib/tool.ts', 'source'],
    ['scripts/tool.cjs', 'source'],
    ['monitor/public/app.js', 'source'],
    ['src/schemas/task.schema.json', 'schemas'],
    ['tests/fixture.json', 'tests'],
    ['src/additions/tasksAdd.json5', 'data'],
    ['src/overrides/tasks.json5', 'data'],
    ['src/divergences/tasks.json5', 'data'],
    ['src/suppressions/tasks.json5', 'data'],
    ['dist/overlay.json', 'generated'],
    ['docs/guide.md', 'other'],
  ])('classifies %s separately as %s', (path, category) => {
    expect(classifyMaintenancePath(path)).toBe(category);
  });

  it('counts added/deleted lines, binary files, and unusual filenames without conflating categories', () => {
    const counts = countMaintenanceLines(
      '3\t5\tsrc/lib/a.ts\0' +
        '2\t1\tsrc/schemas/a.json\0' +
        '8\t0\ttests/a.test.ts\0' +
        '1\t6\tsrc/additions/a.json5\0' +
        '100\t99\tdist/overlay.json\0' +
        '-\t-\tdocs/image.png\0' +
        '2\t0\tdocs/name\twith\nspaces.md\0'
    );
    expect(counts.source).toEqual({ added: 3, removed: 5, binaryFiles: 0 });
    expect(counts.schemas.added).toBe(2);
    expect(counts.tests.added).toBe(8);
    expect(counts.data.removed).toBe(6);
    expect(counts.generated.added).toBe(100);
    expect(counts.other).toEqual({ added: 2, removed: 0, binaryFiles: 1 });
    expect(() => countMaintenanceLines('broken\0')).toThrow('Invalid git numstat');
  });
});

describe('maintenance audit gates', () => {
  it('keeps inherited findings visible without blocking', () => {
    expect(maintenanceAuditFailed(report)).toBe(false);
    expect(readAuditCounts(report)[1]).toEqual({
      category: 'complexity',
      introduced: 0,
      inherited: 8,
    });
    const summary = renderMaintenanceSummary(base, '2\t5\tsrc/lib/tool.ts\0', report);
    expect(summary).toContain('| source | 2 | 5 | -3 | 0 |');
    expect(summary).toContain('| complexity | 0 | 8 |');
  });

  it.each(['dead_code', 'complexity', 'duplication'])(
    'fails on new %s even when Fallow only warns',
    (category) => {
      expect(
        maintenanceAuditFailed({
          ...report,
          verdict: 'warn',
          attribution: { ...report.attribution, [`${category}_introduced`]: 1 },
        })
      ).toBe(true);
    }
  );

  it('preserves native Fallow failure verdicts', () => {
    expect(maintenanceAuditFailed({ ...report, verdict: 'fail' })).toBe(true);
  });

  it.each([
    {},
    { ...report, verdict: 'unknown' },
    { ...report, attribution: { ...report.attribution, gate: 'all' } },
    { ...report, attribution: { ...report.attribution, complexity_introduced: -1 } },
    { ...report, attribution: { ...report.attribution, complexity_inherited: undefined } },
  ])('fails closed on incomplete/invalid audit output', (invalid) => {
    expect(() => maintenanceAuditFailed(invalid)).toThrow();
  });
});

const temporaryDirs: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirs.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function runReport(audit: unknown) {
  const directory = mkdtempSync(join(tmpdir(), 'maintenance-ci-'));
  temporaryDirs.push(directory);
  const reportPath = join(directory, 'audit.json');
  const summaryPath = join(directory, 'summary.md');
  writeFileSync(reportPath, JSON.stringify(audit));
  const actualBase = spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', resolve('scripts/maintenance-ci.ts'), 'report', actualBase, reportPath],
    {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_STEP_SUMMARY: summaryPath },
    }
  );
  return { result, summaryPath };
}

describe('maintenance report CLI', () => {
  it('writes inherited counts to stdout and the Actions summary', () => {
    const { result, summaryPath } = runReport(report);
    expect(result.status).toBe(0);
    expect(readFileSync(summaryPath, 'utf8').trim()).toBe(result.stdout.trim());
    expect(result.stdout).toContain('| complexity | 0 | 8 |');
  });

  it('writes the report before exiting nonzero for a regression', () => {
    const { result, summaryPath } = runReport({
      ...report,
      attribution: { ...report.attribution, duplication_introduced: 1 },
    });
    expect(result.status).toBe(1);
    expect(readFileSync(summaryPath, 'utf8')).toContain('| duplication | 1 | 3 |');
  });

  it('fails closed for malformed Fallow output', () => {
    const { result } = runReport({});
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Expected an attributed new-only Fallow audit');
  });
});
