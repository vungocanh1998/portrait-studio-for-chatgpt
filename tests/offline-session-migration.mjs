import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Engine from '../ui/engine.js';
import {
  migrateV1ToV2,
  recoverMigration,
  rollbackV2ToV1
} from '../server/offline-session-migration.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testRoot = mkdtempSync(join(tmpdir(), 'portrait-studio-migration-'));
const hostileRoot = join(testRoot, 'hostile-data-root');
const sentinelPath = join(hostileRoot, 'sentinel.bin');
const sentinelBytes = Buffer.from('synthetic offline-migration sentinel\n');
const sentinelHash = digest(sentinelBytes);
const sentinelEntries = ['sentinel.bin'];
const migrationCrashPoints = [
  'journal-prepared', 'backup-temp-fsynced', 'backup-durable', 'migration-temp-fsynced',
  'before-migration-rename', 'after-migration-rename', 'migration-directory-fsynced', 'migration-committed'
];
const rollbackCrashPoints = [
  'rollback-started', 'rollback-archive-temp-fsynced', 'rollback-archive-durable',
  'rollback-temp-fsynced', 'before-rollback-rename', 'after-rollback-rename',
  'rollback-directory-fsynced', 'rollback-committed'
];

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function isWithin(base, target) {
  const rel = relative(resolve(base), resolve(target));
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep));
}

function assertSyntheticPath(path) {
  assert.ok(isWithin(testRoot, path), `refusing to touch a path outside synthetic temp root: ${path}`);
}

function v1Bytes() {
  const state = {
    adjustments: Object.fromEntries(Object.keys(Engine.DEFAULT_ADJUSTMENTS).map((key) => [key, 0])),
    preset: null,
    crop: { x: 0, y: 0, width: 100, height: 100, aspectRatio: 'free' }
  };
  return Buffer.from(JSON.stringify({
    version: 1,
    sessions: [{
      sessionId: '00000000-0000-4000-8000-000000000001',
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
      revision: 0,
      source: null,
      ...state,
      history: [state],
      historyIndex: 0,
      preview: null,
      export: null
    }]
  }));
}

function makeStore(name) {
  const root = join(testRoot, name);
  mkdirSync(root, { recursive: true });
  const storePath = join(root, 'sessions.json');
  assertSyntheticPath(storePath);
  const bytes = v1Bytes();
  writeFileSync(storePath, bytes, { flag: 'wx' });
  return { root, storePath, bytes };
}

function options(storePath, overrides = {}) {
  assertSyntheticPath(storePath);
  return {
    storePath,
    expectedStorePath: storePath,
    runtimeStorePaths: [storePath, storePath],
    acquireQuiescence: async () => ({ assertHeld() {}, release() {} }),
    ...overrides
  };
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, (error) => error?.code === code, `expected migration error ${code}`);
}

function assertNoStoreMutation(storePath, originalBytes) {
  assert.deepEqual(readFileSync(storePath), originalBytes);
  assert.equal(existsSync(`${storePath}.migration.json`), false);
  assert.equal(existsSync(`${storePath}.migration.lock`), false);
}

function assertSentinel() {
  assert.deepEqual(readdirSync(hostileRoot).sort(), sentinelEntries);
  assert.equal(digest(readFileSync(sentinelPath)), sentinelHash);
  assert.deepEqual(readFileSync(sentinelPath), sentinelBytes);
}

function childEnv(storeRoot) {
  assertSyntheticPath(storeRoot);
  return {
    ...process.env,
    PORTRAIT_STUDIO_DATA_DIR: hostileRoot,
    USERPROFILE: storeRoot,
    HOME: storeRoot,
    APPDATA: join(storeRoot, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(storeRoot, 'AppData', 'Local')
  };
}

function runCrashChild(storePath, operation, checkpoint) {
  const moduleUrl = pathToFileURL(resolve(repo, 'server/offline-session-migration.mjs')).href;
  const call = operation === 'migrate'
    ? `await migrateV1ToV2(base);`
    : `await rollbackV2ToV1({ ...base, acknowledgeV2EditLoss: true });`;
  const source = [
    `import { migrateV1ToV2, rollbackV2ToV1 } from ${JSON.stringify(moduleUrl)};`,
    `const storePath = ${JSON.stringify(storePath)};`,
    `const base = { storePath, expectedStorePath: storePath, runtimeStorePaths: [storePath, storePath],`,
    `  acquireQuiescence: async () => ({ assertHeld() {}, release() {} }),`,
    `  onCheckpoint(name) { if (name === ${JSON.stringify(checkpoint)}) process.exit(86); } };`,
    call,
    `process.exit(0);`
  ].join('\n');
  return spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    encoding: 'utf8',
    env: childEnv(dirname(storePath)),
    windowsHide: true
  });
}

function runHardlinkCrashChild(storePath, operation, crashTarget) {
  assertSyntheticPath(crashTarget);
  const moduleUrl = pathToFileURL(resolve(repo, 'server/offline-session-migration.mjs')).href;
  const call = operation === 'migrate'
    ? `await migrateV1ToV2(base);`
    : `await rollbackV2ToV1({ ...base, acknowledgeV2EditLoss: true });`;
  const source = [
    `import fs from 'node:fs';`,
    `import { syncBuiltinESMExports } from 'node:module';`,
    `const crashTarget = ${JSON.stringify(crashTarget)};`,
    `const link = fs.linkSync;`,
    `fs.linkSync = (source, published) => { link(source, published); if (published === crashTarget) process.exit(86); };`,
    `syncBuiltinESMExports();`,
    `const { migrateV1ToV2, rollbackV2ToV1 } = await import(${JSON.stringify(moduleUrl)});`,
    `const storePath = ${JSON.stringify(storePath)};`,
    `const base = { storePath, expectedStorePath: storePath, runtimeStorePaths: [storePath, storePath],`,
    `  acquireQuiescence: async () => ({ assertHeld() {}, release() {} }) };`,
    call,
    `process.exit(0);`
  ].join('\n');
  return spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    encoding: 'utf8',
    env: childEnv(dirname(storePath)),
    windowsHide: true
  });
}

function assertHardlinkPair(temporary, published) {
  assertSyntheticPath(temporary);
  assertSyntheticPath(published);
  const temporaryStat = statSync(temporary);
  const publishedStat = statSync(published);
  assert.equal(temporaryStat.nlink, 2);
  assert.equal(publishedStat.nlink, 2);
  assert.equal(temporaryStat.dev, publishedStat.dev);
  assert.equal(temporaryStat.ino, publishedStat.ino);
}

function clearSyntheticOrphanLock(storePath, childPid) {
  const path = `${storePath}.migration.lock`;
  assertSyntheticPath(path);
  const lock = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(lock.pid, childPid, 'the orphan lock must belong to the crashed synthetic child');
  assert.ok(lock.transactionId);
  assert.throws(() => process.kill(childPid, 0), (error) => error.code === 'ESRCH');
  unlinkSync(path);
}

function addSyntheticV2Edit(storePath) {
  const value = JSON.parse(readFileSync(storePath, 'utf8'));
  const document = value.sessions[0];
  const changed = structuredClone(document.history[0]);
  changed.adjustments.exposureEV = 1;
  document.revision = 1;
  document.updatedAt = '2026-11-01T00:00:01.000Z';
  document.adjustments.exposureEV = 1;
  document.history.push(changed);
  document.historyIndex = 1;
  const bytes = Buffer.from(JSON.stringify(value));
  writeFileSync(storePath, bytes);
  return bytes;
}

function addSecondSyntheticV2Edit(storePath) {
  const value = JSON.parse(readFileSync(storePath, 'utf8'));
  const document = value.sessions[0];
  const changed = structuredClone(document.history[document.historyIndex]);
  changed.adjustments.exposureEV = 2;
  document.revision += 1;
  document.updatedAt = '2026-11-01T00:00:02.000Z';
  document.adjustments.exposureEV = 2;
  document.history.push(changed);
  document.historyIndex = document.history.length - 1;
  const bytes = Buffer.from(JSON.stringify(value));
  writeFileSync(storePath, bytes);
  return bytes;
}

async function testBasicMigrationAndRollback() {
  const { storePath, bytes } = makeStore('basic');
  const migration = await migrateV1ToV2(options(storePath));
  assert.equal(migration.state, 'migrated');
  assert.equal(migration.v1Sha256, digest(bytes));
  assert.deepEqual(readFileSync(migration.backupPath), bytes);
  assert.equal(statSync(migration.backupPath).mode & 0o222, 0, 'the preserved V1 backup is read-only');
  assert.equal(JSON.parse(readFileSync(storePath, 'utf8')).version, 2);
  const currentV2 = addSyntheticV2Edit(storePath);
  const rollback = await rollbackV2ToV1(options(storePath, { acknowledgeV2EditLoss: true }));
  assert.equal(rollback.state, 'rolled-back');
  assert.deepEqual(readFileSync(storePath), bytes);
  assert.deepEqual(readFileSync(rollback.archivePath), currentV2);
  assert.match(rollback.lossNotice, /edits made after V2 activation are lost/i);
  const result = await recoverMigration(options(storePath));
  assert.equal(result.state, 'rolled-back');
  assertSentinel();
}

async function testQuiescenceAndPaths() {
  const { storePath, bytes } = makeStore('path-mismatch');
  const alternate = makeStore('alternate-path').storePath;
  await rejectsCode(migrateV1ToV2(options(storePath, { runtimeStorePaths: [storePath, alternate] })), 'runtime_path_mismatch');
  await rejectsCode(migrateV1ToV2(options(storePath, { expectedStorePath: alternate })), 'store_path_mismatch');
  assertNoStoreMutation(storePath, bytes);
  await rejectsCode(migrateV1ToV2(options(storePath, {
    acquireQuiescence: async () => { throw new Error('old host can relaunch'); }
  })), 'quiescence_unavailable');
  assertNoStoreMutation(storePath, bytes);

  let held = true;
  await rejectsCode(migrateV1ToV2(options(storePath, {
    acquireQuiescence: async () => ({
      assertHeld() { if (!held) throw new Error('the stopped V1 reader was relaunched'); },
      release() {}
    }),
    onCheckpoint(name) { if (name === 'migration-temp-fsynced') held = false; }
  })), 'quiescence_lost');
  assert.deepEqual(readFileSync(storePath), bytes);
  assert.equal(existsSync(`${storePath}.migration.json`), true);
  const recovered = await recoverMigration(options(storePath));
  assert.equal(recovered.state, 'migrated');
  assertSentinel();
}

async function testFinalSafetyAfterAsyncCheckpoints() {
  for (const scenario of ['quiescence', 'source', 'writer-lock']) {
    const { storePath, bytes } = makeStore(`final-migration-${scenario}`);
    let held = true;
    let expectedStoreBytes = bytes;
    const errorCode = scenario === 'quiescence' ? 'quiescence_lost'
      : scenario === 'source' ? 'source_changed' : 'legacy_writer_lock_active';
    await rejectsCode(migrateV1ToV2(options(storePath, {
      acquireQuiescence: async () => ({
        assertHeld() { if (!held) throw new Error('synthetic lease was invalidated'); },
        release() {}
      }),
      async onCheckpoint(name) {
        if (name !== 'before-migration-rename') return;
        await Promise.resolve();
        if (scenario === 'quiescence') held = false;
        if (scenario === 'source') {
          const changed = JSON.parse(bytes.toString('utf8'));
          changed.sessions[0].updatedAt = '2026-11-01T00:00:02.000Z';
          expectedStoreBytes = Buffer.from(JSON.stringify(changed));
          writeFileSync(storePath, expectedStoreBytes);
        }
        if (scenario === 'writer-lock')
          writeFileSync(`${storePath}.lock`, JSON.stringify({ pid: process.pid }), { flag: 'wx' });
      }
    })), errorCode);
    assert.deepEqual(readFileSync(storePath), expectedStoreBytes, scenario);
    const journal = JSON.parse(readFileSync(`${storePath}.migration.json`, 'utf8'));
    assert.deepEqual(readFileSync(journal.backupPath), bytes, scenario);
    assert.equal(JSON.parse(readFileSync(storePath, 'utf8')).version, 1, scenario);
    if (scenario === 'writer-lock')
      assert.equal(existsSync(`${storePath}.lock`), true);
  }

  for (const scenario of ['quiescence', 'source', 'writer-lock']) {
    const { storePath, bytes } = makeStore(`final-rollback-${scenario}`);
    const migration = await migrateV1ToV2(options(storePath));
    const archivedV2Bytes = addSyntheticV2Edit(storePath);
    let held = true;
    let expectedStoreBytes = archivedV2Bytes;
    const errorCode = scenario === 'quiescence' ? 'quiescence_lost'
      : scenario === 'source' ? 'v2_changed_during_rollback' : 'legacy_writer_lock_active';
    await rejectsCode(rollbackV2ToV1(options(storePath, {
      acknowledgeV2EditLoss: true,
      acquireQuiescence: async () => ({
        assertHeld() { if (!held) throw new Error('synthetic lease was invalidated'); },
        release() {}
      }),
      async onCheckpoint(name) {
        if (name !== 'before-rollback-rename') return;
        await Promise.resolve();
        if (scenario === 'quiescence') held = false;
        if (scenario === 'source')
          expectedStoreBytes = addSecondSyntheticV2Edit(storePath);
        if (scenario === 'writer-lock')
          writeFileSync(`${storePath}.lock`, JSON.stringify({ pid: process.pid }), { flag: 'wx' });
      }
    })), errorCode);
    assert.deepEqual(readFileSync(storePath), expectedStoreBytes, scenario);
    const journal = JSON.parse(readFileSync(`${storePath}.migration.json`, 'utf8'));
    assert.deepEqual(readFileSync(journal.rollbackArchivePath), archivedV2Bytes, scenario);
    assert.deepEqual(readFileSync(migration.backupPath), bytes, scenario);
    if (scenario === 'writer-lock')
      assert.equal(existsSync(`${storePath}.lock`), true);
  }
  assertSentinel();
}

async function testLegacyLocksAndWriterRelaunch() {
  const exitedChild = spawnSync(process.execPath, ['-e', 'process.exit(0)'], {
    windowsHide: true,
    env: childEnv(testRoot)
  });
  assert.equal(exitedChild.status, 0);
  assert.throws(() => process.kill(exitedChild.pid, 0), (error) => error.code === 'ESRCH');
  const lockCases = [
    ['active', JSON.stringify({ pid: process.pid, instanceId: 'synthetic', acquiredAt: '2026-11-01T00:00:00.000Z' })],
    ['orphaned', JSON.stringify({ pid: exitedChild.pid, instanceId: 'synthetic', acquiredAt: '2026-11-01T00:00:00.000Z' })],
    ['unreadable', '{ invalid lock metadata']
  ];
  for (const [name, lockBytes] of lockCases) {
    const { storePath, bytes } = makeStore(`legacy-lock-${name}`);
    writeFileSync(`${storePath}.lock`, lockBytes, { flag: 'wx' });
    await rejectsCode(migrateV1ToV2(options(storePath)), `legacy_writer_lock_${name}`);
    assert.deepEqual(readFileSync(storePath), bytes);
    assert.equal(existsSync(`${storePath}.lock`), true, 'ambiguous V1 locks must be preserved');
    assert.equal(existsSync(`${storePath}.migration.json`), false);
    assert.equal(existsSync(`${storePath}.migration.lock`), false);
  }
  const { storePath, bytes } = makeStore('old-reader-relaunch');
  await rejectsCode(migrateV1ToV2(options(storePath, {
    acquireQuiescence: async () => ({
      assertHeld() { throw new Error('the old V1 reader was relaunched'); },
      release() {}
    })
  })), 'quiescence_unavailable');
  assertNoStoreMutation(storePath, bytes);
  assertSentinel();
}

async function testCompetingWriters() {
  const { storePath } = makeStore('competing-writers');
  let reached;
  let release;
  const atJournal = new Promise((resolveReady) => { reached = resolveReady; });
  const resumeFirst = new Promise((resolveResume) => { release = resolveResume; });
  const first = migrateV1ToV2(options(storePath, {
    onCheckpoint: async (name) => {
      if (name === 'journal-prepared') {
        reached();
        await resumeFirst;
      }
    }
  }));
  await atJournal;
  await rejectsCode(migrateV1ToV2(options(storePath)), 'migration_lock_present');
  release();
  assert.equal((await first).state, 'migrated');
  assertSentinel();
}

async function testDigestAndRecoveryFailures() {
  const { storePath, bytes } = makeStore('bad-existing-backup');
  const backupPath = `${storePath}.v1-${digest(bytes)}.backup`;
  writeFileSync(backupPath, Buffer.from('not the V1 backup'), { flag: 'wx' });
  await rejectsCode(migrateV1ToV2(options(storePath)), 'artifact_digest_mismatch');
  assert.deepEqual(readFileSync(storePath), bytes);

  const changedSource = makeStore('source-changed-before-replace');
  let changedV1 = JSON.parse(changedSource.bytes.toString('utf8'));
  changedV1.sessions[0].updatedAt = '2026-11-01T00:00:02.000Z';
  changedV1 = Buffer.from(JSON.stringify(changedV1));
  await rejectsCode(migrateV1ToV2(options(changedSource.storePath, {
    onCheckpoint(name) {
      if (name === 'migration-temp-fsynced')
        writeFileSync(changedSource.storePath, changedV1);
    }
  })), 'source_changed');
  assert.deepEqual(readFileSync(changedSource.storePath), changedV1);

  const changed = makeStore('changed-before-recovery');
  const child = runCrashChild(changed.storePath, 'migrate', 'migration-temp-fsynced');
  assert.equal(child.status, 86, child.stderr);
  clearSyntheticOrphanLock(changed.storePath, child.pid);
  const modified = Buffer.from(JSON.stringify({ version: 1, sessions: [] }));
  writeFileSync(changed.storePath, modified);
  await rejectsCode(recoverMigration(options(changed.storePath)), 'recovery_digest_mismatch');
  assert.deepEqual(readFileSync(changed.storePath), modified);

  const corruptTemp = makeStore('corrupt-migration-temp');
  const tempCrash = runCrashChild(corruptTemp.storePath, 'migrate', 'migration-temp-fsynced');
  assert.equal(tempCrash.status, 86, tempCrash.stderr);
  clearSyntheticOrphanLock(corruptTemp.storePath, tempCrash.pid);
  const journal = JSON.parse(readFileSync(`${corruptTemp.storePath}.migration.json`, 'utf8'));
  writeFileSync(journal.migrationTempPath, Buffer.from('corrupt synthetic temp'));
  await rejectsCode(recoverMigration(options(corruptTemp.storePath)), 'artifact_digest_mismatch');
  assert.deepEqual(readFileSync(corruptTemp.storePath), corruptTemp.bytes);

  const corruptJournal = makeStore('corrupt-journal');
  const journalCrash = runCrashChild(corruptJournal.storePath, 'migrate', 'journal-prepared');
  assert.equal(journalCrash.status, 86, journalCrash.stderr);
  clearSyntheticOrphanLock(corruptJournal.storePath, journalCrash.pid);
  writeFileSync(`${corruptJournal.storePath}.migration.json`, Buffer.from('{ invalid journal'));
  await rejectsCode(recoverMigration(options(corruptJournal.storePath)), 'invalid_json');
  assert.deepEqual(readFileSync(corruptJournal.storePath), corruptJournal.bytes);

  const corrupt = makeStore('corrupt-backup-rollback');
  const migration = await migrateV1ToV2(options(corrupt.storePath));
  const migratedBytes = readFileSync(corrupt.storePath);
  chmodSync(migration.backupPath, 0o600);
  unlinkSync(migration.backupPath);
  writeFileSync(migration.backupPath, Buffer.from('corrupt synthetic backup'), { flag: 'wx' });
  await rejectsCode(rollbackV2ToV1(options(corrupt.storePath, { acknowledgeV2EditLoss: true })), 'backup_digest_mismatch');
  assert.deepEqual(readFileSync(corrupt.storePath), migratedBytes);
  assertSentinel();
}

async function testMigrationCrashRecovery() {
  for (const checkpoint of migrationCrashPoints) {
    const { storePath, bytes } = makeStore(`crash-migrate-${checkpoint}`);
    const child = runCrashChild(storePath, 'migrate', checkpoint);
    assert.equal(child.status, 86, `${checkpoint}: ${child.stderr}`);
    clearSyntheticOrphanLock(storePath, child.pid);
    const recovered = await recoverMigration(options(storePath));
    assert.equal(recovered.state, 'migrated', checkpoint);
    assert.deepEqual(readFileSync(recovered.backupPath), bytes, checkpoint);
    assert.equal(JSON.parse(readFileSync(storePath, 'utf8')).version, 2, checkpoint);
  }
  assertSentinel();
}

async function testRollbackCrashRecovery() {
  for (const checkpoint of rollbackCrashPoints) {
    const { storePath, bytes } = makeStore(`crash-rollback-${checkpoint}`);
    const migration = await migrateV1ToV2(options(storePath));
    const currentV2 = addSyntheticV2Edit(storePath);
    const child = runCrashChild(storePath, 'rollback', checkpoint);
    assert.equal(child.status, 86, `${checkpoint}: ${child.stderr}`);
    clearSyntheticOrphanLock(storePath, child.pid);
    const recovered = await recoverMigration(options(storePath));
    assert.equal(recovered.state, 'rolled-back', checkpoint);
    assert.deepEqual(readFileSync(storePath), bytes, checkpoint);
    assert.deepEqual(readFileSync(recovered.archivePath), currentV2, checkpoint);
    const journal = JSON.parse(readFileSync(`${storePath}.migration.json`, 'utf8'));
    assert.match(journal.lossNotice, /edits made after V2 activation are lost/i);
    assert.deepEqual(readFileSync(migration.backupPath), bytes, checkpoint);
  }
  assertSentinel();
}

async function testInterruptedHardlinkPublication() {
  if (process.platform === 'win32') {
    console.log('POSIX link/unlink crash injection skipped on Windows; Windows atomic-move checkpoint tests remain active.');
    return;
  }

  const journalStore = makeStore('hardlink-journal-publication');
  const journalPath = `${journalStore.storePath}.migration.json`;
  const journalCrash = runHardlinkCrashChild(journalStore.storePath, 'migrate', journalPath);
  assert.equal(journalCrash.status, 86, journalCrash.stderr);
  const journalTemp = readdirSync(dirname(journalPath))
    .filter((name) => name.startsWith(`${basename(journalPath)}.`) && name.endsWith('.tmp'))
    .map((name) => join(dirname(journalPath), name));
  assert.equal(journalTemp.length, 1);
  assertHardlinkPair(journalTemp[0], journalPath);
  clearSyntheticOrphanLock(journalStore.storePath, journalCrash.pid);
  const journalRecovery = await recoverMigration(options(journalStore.storePath));
  assert.equal(journalRecovery.state, 'migrated');
  assert.equal(existsSync(journalTemp[0]), false);
  assert.equal(statSync(journalPath).nlink, 1);
  assert.deepEqual(readFileSync(journalRecovery.backupPath), journalStore.bytes);

  const backupStore = makeStore('hardlink-backup-publication');
  const backupPath = `${backupStore.storePath}.v1-${digest(backupStore.bytes)}.backup`;
  const backupCrash = runHardlinkCrashChild(backupStore.storePath, 'migrate', backupPath);
  assert.equal(backupCrash.status, 86, backupCrash.stderr);
  const backupJournal = JSON.parse(readFileSync(`${backupStore.storePath}.migration.json`, 'utf8'));
  assertHardlinkPair(backupJournal.backupTempPath, backupJournal.backupPath);
  clearSyntheticOrphanLock(backupStore.storePath, backupCrash.pid);
  const backupRecovery = await recoverMigration(options(backupStore.storePath));
  assert.equal(backupRecovery.state, 'migrated');
  assert.deepEqual(readFileSync(backupRecovery.backupPath), backupStore.bytes);
  assert.equal(existsSync(backupJournal.backupTempPath), false);
  assert.equal(statSync(backupRecovery.backupPath).nlink, 1);

  const archiveStore = makeStore('hardlink-archive-publication');
  const migration = await migrateV1ToV2(options(archiveStore.storePath));
  const currentV2Bytes = addSyntheticV2Edit(archiveStore.storePath);
  const archivePath = `${archiveStore.storePath}.v2-${digest(currentV2Bytes)}.archive`;
  const archiveCrash = runHardlinkCrashChild(archiveStore.storePath, 'rollback', archivePath);
  assert.equal(archiveCrash.status, 86, archiveCrash.stderr);
  const archiveJournal = JSON.parse(readFileSync(`${archiveStore.storePath}.migration.json`, 'utf8'));
  assertHardlinkPair(archiveJournal.rollbackArchiveTempPath, archiveJournal.rollbackArchivePath);
  clearSyntheticOrphanLock(archiveStore.storePath, archiveCrash.pid);
  const archiveRecovery = await recoverMigration(options(archiveStore.storePath));
  assert.equal(archiveRecovery.state, 'rolled-back');
  assert.deepEqual(readFileSync(archiveStore.storePath), archiveStore.bytes);
  assert.deepEqual(readFileSync(archiveRecovery.archivePath), currentV2Bytes);
  assert.deepEqual(readFileSync(migration.backupPath), archiveStore.bytes);
  assert.equal(existsSync(archiveJournal.rollbackArchiveTempPath), false);
  assert.equal(statSync(archiveRecovery.archivePath).nlink, 1);

  const untrustedStore = makeStore('untrusted-hardlink-alias');
  const untrustedCrash = runCrashChild(untrustedStore.storePath, 'migrate', 'journal-prepared');
  assert.equal(untrustedCrash.status, 86, untrustedCrash.stderr);
  clearSyntheticOrphanLock(untrustedStore.storePath, untrustedCrash.pid);
  const untrustedJournal = JSON.parse(readFileSync(`${untrustedStore.storePath}.migration.json`, 'utf8'));
  const aliasPath = join(dirname(untrustedStore.storePath), 'untrusted-backup-alias');
  assertSyntheticPath(aliasPath);
  writeFileSync(untrustedJournal.backupPath, untrustedStore.bytes, { flag: 'wx' });
  linkSync(untrustedJournal.backupPath, aliasPath);
  await rejectsCode(recoverMigration(options(untrustedStore.storePath)), 'unsafe_file_identity');
  assert.deepEqual(readFileSync(untrustedStore.storePath), untrustedStore.bytes);
  assert.equal(existsSync(aliasPath), true);
  assert.equal(statSync(untrustedJournal.backupPath).nlink, 2);
  assertSentinel();
}

async function testNoRuntimeActivation() {
  const runtime = readFileSync(resolve(repo, 'server/index.mjs'), 'utf8');
  const sessions = readFileSync(resolve(repo, 'server/editor-state.mjs'), 'utf8');
  assert.doesNotMatch(runtime, /offline-session-migration/);
  assert.doesNotMatch(sessions, /offline-session-migration/);
}

try {
  mkdirSync(hostileRoot, { recursive: true });
  writeFileSync(sentinelPath, sentinelBytes, { flag: 'wx' });
  await testBasicMigrationAndRollback();
  await testQuiescenceAndPaths();
  await testFinalSafetyAfterAsyncCheckpoints();
  await testLegacyLocksAndWriterRelaunch();
  await testCompetingWriters();
  await testDigestAndRecoveryFailures();
  await testMigrationCrashRecovery();
  await testRollbackCrashRecovery();
  await testInterruptedHardlinkPublication();
  await testNoRuntimeActivation();
  assertSentinel();
} finally {
  assertSyntheticPath(testRoot);
  rmSync(testRoot, { recursive: true, force: true });
}

console.log('Offline V1/V2 migration and rollback checks passed with synthetic temp stores.');

