'use strict';

const { spawnSync } = require('node:child_process');

// npm 11.17 exports .npmrc's allow-scripts into lifecycle environments, then
// rejects that same policy as an environment override in the nested npm audit.
// Let npm reload the original configuration instead. Leave every other setting
// (including registry/auth configuration) and the user's .npmrc untouched.
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (key.toLowerCase() === 'npm_config_allow_scripts') delete env[key];
}

if (!process.env.npm_execpath) {
  console.error('Run this launcher with npm run audit:dependencies.');
  process.exitCode = 1;
} else {
  const result = spawnSync(
    process.execPath,
    [process.env.npm_execpath, 'audit', '--audit-level=high', ...process.argv.slice(2)],
    { env, stdio: 'inherit' }
  );
  if (result.error) console.error(result.error.message);
  // A spawn error or signal must never turn a failed audit into a green check.
  process.exitCode = result.status ?? 1;
}
