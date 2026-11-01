import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

const testRoot = mkdtempSync(join(tmpdir(), 'portrait-studio-check-'));
const hostileParentRoot = mkdtempSync(join(testRoot, 'hostile-parent-'));
const sentinelPath = join(hostileParentRoot, 'sentinel.txt');
const sentinelBytes = Buffer.from('synthetic check-runner sentinel\n');
writeFileSync(sentinelPath, sentinelBytes, { flag: 'wx' });
const sentinelEntries = readdirSync(hostileParentRoot).sort();
const inheritedDataRoot = process.env.PORTRAIT_STUDIO_DATA_DIR;
process.env.PORTRAIT_STUDIO_DATA_DIR = hostileParentRoot;

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
  const dataRoot = mkdtempSync(join(testRoot, 'child-'));
  try {
    const result = spawnSync(process.execPath, args, {
      stdio: 'inherit',
      env: { ...process.env, PORTRAIT_STUDIO_DATA_DIR: dataRoot }
    });
    if (result.error)
      throw result.error;
    if (result.status !== 0)
      throw new Error(`node ${args.join(' ')} exited with status ${result.status ?? 1}`);
  } finally {
    if (!resolve(dataRoot).startsWith(resolve(testRoot) + sep))
      throw new Error('Refusing to clean a test data path outside the generated test root.');
    rmSync(dataRoot, { recursive: true, force: true });
  }
}

try {
  for (const file of syntaxFiles)
    run(['--check', file]);

  for (const file of testFiles)
    run([file]);
} finally {
  try {
    assert.deepEqual(readdirSync(hostileParentRoot).sort(), sentinelEntries, 'test children must not touch an inherited data directory');
    assert.deepEqual(readFileSync(sentinelPath), sentinelBytes, 'the inherited data sentinel must remain unchanged');
  } finally {
    if (inheritedDataRoot === undefined)
      delete process.env.PORTRAIT_STUDIO_DATA_DIR;
    else
      process.env.PORTRAIT_STUDIO_DATA_DIR = inheritedDataRoot;
    if (!resolve(testRoot).startsWith(resolve(tmpdir()) + sep))
      throw new Error('Refusing to clean a test root outside the system temp directory.');
    rmSync(testRoot, { recursive: true, force: true });
  }
}
