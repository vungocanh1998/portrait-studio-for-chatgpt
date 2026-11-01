import { spawnSync } from 'node:child_process';

const syntaxFiles = [
  'server/index.mjs',
  'server/editor-state.mjs',
  'scripts/preview.mjs',
  'scripts/check.mjs',
  'ui/engine.js',
  'tests/editor-state.mjs',
  'tests/mcp-contract.mjs',
  'tests/portrait-engine.mjs',
  'tests/safety-contract.mjs',
  'tests/cross-process-state.mjs',
  'tests/ui-host.mjs',
  'tests/version-consistency.mjs'
];

const testFiles = [
  'tests/editor-state.mjs',
  'tests/mcp-contract.mjs',
  'tests/portrait-engine.mjs',
  'tests/safety-contract.mjs',
  'tests/cross-process-state.mjs',
  'tests/version-consistency.mjs'
];

function run(args) {
  console.log(`\n> node ${args.join(' ')}`);
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (result.error)
    throw result.error;
  if (result.status !== 0)
    process.exit(result.status ?? 1);
}

for (const file of syntaxFiles)
  run(['--check', file]);

for (const file of testFiles)
  run([file]);
