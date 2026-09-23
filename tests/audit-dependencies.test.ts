import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const temporaryDirs: string[] = [];
const launcher = resolve('scripts/audit-dependencies.cjs');

afterEach(() => {
  for (const directory of temporaryDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function runLauncher(exitCode = 0) {
  const directory = mkdtempSync(join(tmpdir(), 'overlay-audit-'));
  temporaryDirs.push(directory);
  const npmPath = join(directory, 'npm cli.cjs');
  // Exercise the real launcher in a subprocess. The stand-in observes the
  // invocation contract, not dependency auditing (which is checked separately
  // with npm run audit:dependencies against the real registry).
  writeFileSync(
    npmPath,
    `console.log(JSON.stringify({
      args: process.argv.slice(2),
      inheritedPolicy: Object.keys(process.env).filter(
        key => key.toLowerCase() === 'npm_config_allow_scripts'
      ),
      registry: process.env.npm_config_registry,
      userconfig: process.env.npm_config_userconfig,
      ignoreScripts: process.env.npm_config_ignore_scripts
    }));
    process.exitCode = ${exitCode};`
  );
  return spawnSync(process.execPath, [launcher, '--json'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      npm_execpath: npmPath,
      npm_config_allow_scripts: '@stripe/cli',
      NPM_CONFIG_ALLOW_SCRIPTS: 'another-package',
      npm_config_registry: 'https://registry.npmjs.org/',
      npm_config_userconfig: join(directory, 'user npmrc'),
      npm_config_ignore_scripts: 'true',
    },
  });
}

describe('dependency audit launcher', () => {
  it('removes only the inherited allow-scripts policy and forwards audit arguments', () => {
    const result = runLauncher();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      args: ['audit', '--audit-level=high', '--json'],
      inheritedPolicy: [],
      registry: 'https://registry.npmjs.org/',
      userconfig: expect.stringContaining('user npmrc'),
      ignoreScripts: 'true',
    });
  });

  it.each([1, 2])('propagates npm failure status %s', (status) => {
    expect(runLauncher(status).status).toBe(status);
  });

  it('fails closed when not launched by npm', () => {
    const env = { ...process.env };
    delete env.npm_execpath;
    const result = spawnSync(process.execPath, [launcher], { encoding: 'utf8', env });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('npm run audit:dependencies');
  });

  it('fails closed when the npm entry point cannot run', () => {
    const directory = mkdtempSync(join(tmpdir(), 'overlay-audit-'));
    temporaryDirs.push(directory);
    const result = spawnSync(process.execPath, [launcher], {
      encoding: 'utf8',
      env: { ...process.env, npm_execpath: join(directory, 'missing.cjs') },
    });
    expect(result.status).toBe(1);
  });
});
