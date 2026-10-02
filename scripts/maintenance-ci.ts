/** CI base selection, regression gate, and categorized maintenance summary. */
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { isDirectExecution } from '../src/lib/script-utils.js';

interface CiEvent {
  before?: string;
  pull_request?: { base: { sha: string }; head: { sha: string } };
}

type Git = (...args: string[]) => string;
const git: Git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

function commitSha(value: string | undefined, gitCommand: Git): string {
  if (!value || !/^[a-f0-9]{40}$/.test(value) || /^0+$/.test(value)) {
    throw new Error('Missing or invalid event commit SHA');
  }
  return gitCommand('rev-parse', '--verify', `${value}^{commit}`);
}

/** A PR merge checkout includes the latest base as parent one, unlike its event payload. */
export function resolveMaintenanceBase(
  eventName: string,
  ref: string,
  event: CiEvent,
  gitCommand: Git = git
): string {
  if (eventName === 'push') return commitSha(event.before, gitCommand);
  if (eventName !== 'pull_request' || !event.pull_request) {
    throw new Error(`Unsupported maintenance event: ${eventName}`);
  }
  const base = commitSha(event.pull_request.base.sha, gitCommand);
  const head = commitSha(event.pull_request.head.sha, gitCommand);
  if (/^refs\/pull\/\d+\/merge$/.test(ref)) {
    if (gitCommand('rev-parse', '--verify', 'HEAD^2') !== head) {
      throw new Error('PR merge checkout does not match the event head');
    }
    return gitCommand('rev-parse', '--verify', 'HEAD^1');
  }
  return gitCommand('merge-base', base, 'HEAD');
}

const CATEGORIES = ['source', 'schemas', 'tests', 'data', 'generated', 'other'] as const;
type Category = (typeof CATEGORIES)[number];
interface LineCounts {
  added: number;
  removed: number;
  binaryFiles: number;
}

export function classifyMaintenancePath(path: string): Category {
  if (path.startsWith('dist/')) return 'generated';
  if (path.startsWith('tests/')) return 'tests';
  if (path.startsWith('src/schemas/')) return 'schemas';
  if (/^src\/(?:additions|overrides|divergences|suppressions)\//.test(path)) return 'data';
  if (/\.(?:[cm]?[jt]sx?|css|html)$/.test(path)) return 'source';
  return 'other';
}

/** Parse --numstat -z --no-renames; tabs/newlines in filenames remain intact. */
export function countMaintenanceLines(numstat: string): Record<Category, LineCounts> {
  const counts = Object.fromEntries(
    CATEGORIES.map((category) => [category, { added: 0, removed: 0, binaryFiles: 0 }])
  ) as Record<Category, LineCounts>;
  for (const entry of numstat.split('\0').filter(Boolean)) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(entry);
    if (!match) throw new Error('Invalid git numstat output');
    const count = counts[classifyMaintenancePath(match[3])];
    if (match[1] === '-' || match[2] === '-') count.binaryFiles++;
    else {
      count.added += Number(match[1]);
      count.removed += Number(match[2]);
    }
  }
  return counts;
}

const FINDING_CATEGORIES = ['dead_code', 'complexity', 'duplication', 'styling'] as const;

/** Fail closed if Fallow drops attribution or changes its new-only report contract. */
export function readAuditCounts(report: unknown) {
  if (!report || typeof report !== 'object') throw new Error('Invalid Fallow audit report');
  const audit = report as Record<string, unknown>;
  const attribution = audit.attribution as Record<string, unknown> | undefined;
  if (audit.kind !== 'audit' || attribution?.gate !== 'new-only') {
    throw new Error('Expected an attributed new-only Fallow audit');
  }
  if (!['pass', 'warn', 'fail'].includes(String(audit.verdict))) {
    throw new Error('Invalid Fallow audit verdict');
  }
  return FINDING_CATEGORIES.map((category) => {
    const introduced = attribution[`${category}_introduced`];
    const inherited = attribution[`${category}_inherited`];
    if (
      !Number.isSafeInteger(introduced) ||
      Number(introduced) < 0 ||
      !Number.isSafeInteger(inherited) ||
      Number(inherited) < 0
    )
      throw new Error(`Invalid Fallow ${category} counts`);
    return { category, introduced: Number(introduced), inherited: Number(inherited) };
  });
}

export function renderMaintenanceSummary(base: string, numstat: string, audit: unknown): string {
  const lines = countMaintenanceLines(numstat);
  const findings = readAuditCounts(audit);
  return [
    '### Maintenance regression report',
    '',
    `Compared with \`${base}\`. LOC deltas are informational; no size target is enforced.`,
    '',
    '| Category | Added lines | Removed lines | Net | Binary files |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...CATEGORIES.map((category) => {
      const { added, removed, binaryFiles } = lines[category];
      return `| ${category} | ${added} | ${removed} | ${added - removed} | ${binaryFiles} |`;
    }),
    '',
    '| Fallow category | New findings | Inherited findings |',
    '| --- | ---: | ---: |',
    ...findings.map(
      ({ category, introduced, inherited }) => `| ${category} | ${introduced} | ${inherited} |`
    ),
    '',
    'New dead-code, complexity, or duplication findings fail this gate. Inherited findings remain visible for follow-up.',
    '',
  ].join('\n');
}

export function maintenanceAuditFailed(report: unknown): boolean {
  const findings = readAuditCounts(report);
  return (
    (report as { verdict: string }).verdict === 'fail' ||
    findings.some(({ category, introduced }) => category !== 'styling' && introduced > 0)
  );
}

function writeComparisonBase(): void {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error('Missing GITHUB_EVENT_PATH');
  const sha = resolveMaintenanceBase(
    process.env.GITHUB_EVENT_NAME ?? '',
    process.env.GITHUB_REF ?? '',
    JSON.parse(readFileSync(eventPath, 'utf8'))
  );
  if (!process.env.GITHUB_OUTPUT) throw new Error('Missing GITHUB_OUTPUT');
  appendFileSync(process.env.GITHUB_OUTPUT, `sha=${sha}\n`);
  console.log(`Maintenance comparison base: ${sha}`);
}

function writeAuditReport(base: string, reportPath: string): void {
  const verifiedBase = commitSha(base, git);
  const report: unknown = JSON.parse(readFileSync(reportPath, 'utf8'));
  // Deliberately disable rename compression so each filename has one numstat entry.
  const numstat = execFileSync(
    'git',
    ['diff', '--numstat', '-z', '--no-renames', verifiedBase, 'HEAD'],
    { encoding: 'utf8' }
  );
  const summary = renderMaintenanceSummary(verifiedBase, numstat, report);
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  if (maintenanceAuditFailed(report)) process.exitCode = 1;
}

function main(): void {
  const [command, base, reportPath] = process.argv.slice(2);
  if (command === 'base') return writeComparisonBase();
  if (command === 'report' && base && reportPath) return writeAuditReport(base, reportPath);
  throw new Error('Usage: maintenance-ci.ts base | report <base SHA> <audit JSON>');
}

if (isDirectExecution(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}
