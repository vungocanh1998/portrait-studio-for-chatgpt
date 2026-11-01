import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  fstatSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readV1Store } from './edit-document.mjs';

const digestPattern = /^[a-f0-9]{64}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const v2SessionKeys = [
  'schemaVersion', 'sessionId', 'createdAt', 'updatedAt', 'revision', 'source', 'adjustments',
  'preset', 'crop', 'history', 'historyIndex', 'preview', 'export'
];
const v1SessionKeys = v2SessionKeys.slice(1);
const rollbackLossNotice = 'Rollback restores the original V1 backup. Edits made after V2 activation are lost; the current V2 file was preserved in an immutable archive.';
const windowsMoveScript = fileURLToPath(new URL('../scripts/offline-atomic-move.ps1', import.meta.url));

export class OfflineMigrationError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'OfflineMigrationError';
    this.code = code;
  }
}

function fail(code, message, cause) {
  throw new OfflineMigrationError(code, message, cause ? { cause } : undefined);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function samePath(left, right) {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function requireAbsolutePath(value, name) {
  if (typeof value !== 'string' || !isAbsolute(value))
    fail('invalid_path', `${name} must be an explicit absolute path.`);
}

function resolveStorePath(options) {
  requireAbsolutePath(options.storePath, 'storePath');
  requireAbsolutePath(options.expectedStorePath, 'expectedStorePath');
  if (!Array.isArray(options.runtimeStorePaths) || options.runtimeStorePaths.length !== 2)
    fail('invalid_path', 'Both local and packaged runtime store paths are required.');
  for (const path of options.runtimeStorePaths)
    requireAbsolutePath(path, 'runtimeStorePaths entry');

  let canonicalPath;
  try {
    canonicalPath = realpathSync(options.storePath);
  } catch (error) {
    fail('store_path_unverifiable', 'The canonical session store path could not be resolved.', error);
  }
  if (!samePath(options.storePath, canonicalPath) || !samePath(options.expectedStorePath, canonicalPath))
    fail('store_path_mismatch', 'The supplied session store does not match its independently verified canonical path.');
  for (const path of options.runtimeStorePaths) {
    let runtimePath;
    try {
      runtimePath = realpathSync(path);
    } catch (error) {
      fail('runtime_path_unverifiable', 'A local or packaged runtime store path could not be resolved.', error);
    }
    if (!samePath(runtimePath, canonicalPath))
      fail('runtime_path_mismatch', 'Local, packaged, and migration paths do not resolve to one canonical store.');
  }
  return canonicalPath;
}

function identity(stat) {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: stat.size,
    mtimeMs: stat.mtimeMs
  };
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino &&
    left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function requireRegularFile(path, name) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.ino === 0)
    fail('unsafe_file_identity', `${name} must be a regular, single-link file with a verifiable identity.`);
  return stat;
}

function readStable(path, name) {
  let descriptor;
  try {
    const beforePath = identity(requireRegularFile(path, name));
    descriptor = openSync(path, 'r');
    const beforeOpen = identity(fstatSync(descriptor));
    if (!sameIdentity(beforePath, beforeOpen))
      fail('file_identity_changed', `${name} changed while it was being opened.`);
    const bytes = readFileSync(descriptor);
    const afterRead = identity(fstatSync(descriptor));
    if (!sameIdentity(beforeOpen, afterRead))
      fail('file_changed_during_read', `${name} changed while it was being read.`);
    return { bytes, identity: afterRead, sha256: sha256(bytes) };
  } catch (error) {
    if (error instanceof OfflineMigrationError)
      throw error;
    fail('file_read_failed', `${name} could not be read safely.`, error);
  } finally {
    if (descriptor !== undefined)
      closeSync(descriptor);
  }
}

function parseCanonicalJson(bytes, name) {
  let text;
  let value;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    value = JSON.parse(text);
  } catch (error) {
    fail('invalid_json', `${name} is not valid UTF-8 JSON.`, error);
  }
  if (JSON.stringify(value) !== text)
    fail('noncanonical_json', `${name} must use the exact JSON encoding produced by the session writer.`);
  return value;
}

function exactKeys(value, keys, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key)))
    fail('invalid_schema', `${name} has unknown or missing fields.`);
}

function validateV1(bytes) {
  parseCanonicalJson(bytes, 'V1 sessions.json');
  try {
    return readV1Store(bytes);
  } catch (error) {
    fail('invalid_v1_schema', 'The V1 session store failed strict schema validation.', error);
  }
}

function validateV2(bytes) {
  const value = parseCanonicalJson(bytes, 'V2 sessions.json');
  exactKeys(value, ['version', 'sessions'], 'V2 store');
  if (value.version !== 2 || !Array.isArray(value.sessions) || value.sessions.length > 20)
    fail('invalid_v2_schema', 'The V2 session store has an unsupported version or session count.');
  const v1Sessions = value.sessions.map((document) => {
    exactKeys(document, v2SessionKeys, 'V2 EditDocument');
    if (document.schemaVersion !== 2)
      fail('invalid_v2_schema', 'Every V2 EditDocument must use schemaVersion 2.');
    const { schemaVersion, ...session } = document;
    return session;
  });
  let documents;
  try {
    documents = readV1Store(JSON.stringify({ version: 1, sessions: v1Sessions }));
  } catch (error) {
    fail('invalid_v2_schema', 'A V2 EditDocument failed strict field validation.', error);
  }
  const canonical = Buffer.from(JSON.stringify({ version: 2, sessions: documents }));
  if (!canonical.equals(bytes))
    fail('noncanonical_v2', 'V2 sessions.json does not match its strictly validated canonical schema.');
  return documents;
}

function digestPath(storePath, version, digest, suffix) {
  return `${storePath}.${version}-${digest}.${suffix}`;
}

function journalPath(storePath) {
  return `${storePath}.migration.json`;
}

function legacyLockPath(storePath) {
  return `${storePath}.lock`;
}

function migrationLockPath(storePath) {
  return `${storePath}.migration.lock`;
}

function classifyPid(pid) {
  try {
    process.kill(pid, 0);
    return 'active';
  } catch (error) {
    if (error.code === 'ESRCH')
      return 'orphaned';
    if (error.code === 'EPERM')
      return 'active';
    return 'unknown';
  }
}

function inspectLock(path) {
  let bytes;
  try {
    requireRegularFile(path, 'Writer lock');
    bytes = readFileSync(path);
  } catch (error) {
    if (error.code === 'ENOENT')
      return { status: 'absent', ownerPid: null };
    return { status: 'unreadable', ownerPid: null };
  }
  const text = bytes.toString('utf8').trim();
  let owner;
  try {
    owner = /^\d+$/.test(text) ? { pid: Number(text) } : JSON.parse(text);
  } catch {
    return { status: 'unreadable', ownerPid: null };
  }
  if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid < 1)
    return { status: 'unreadable', ownerPid: null };
  return { status: classifyPid(owner.pid), ownerPid: owner.pid };
}

function requireNoLegacyWriter(storePath) {
  const lock = inspectLock(legacyLockPath(storePath));
  if (lock.status !== 'absent')
    fail(`legacy_writer_lock_${lock.status}`, `The V1 writer lock is ${lock.status}; it was preserved and migration stopped.`);
}

async function acquireLease(options, storePath, operation) {
  if (typeof options.acquireQuiescence !== 'function')
    fail('quiescence_required', 'An external offline quiescence lease that prevents writer and reader relaunch is required.');
  let lease;
  try {
    lease = await options.acquireQuiescence({ storePath, operation });
  } catch (error) {
    fail('quiescence_unavailable', 'Offline quiescence could not be established; no session files were changed.', error);
  }
  if (!lease || typeof lease.assertHeld !== 'function' || typeof lease.release !== 'function')
    fail('invalid_quiescence_lease', 'The quiescence provider must return assertHeld() and release() methods.');
  try {
    await lease.assertHeld();
  } catch (error) {
    try { await lease.release(); } catch {}
    fail('quiescence_unavailable', 'The offline quiescence lease is not held; no session files were changed.', error);
  }
  return lease;
}

function acquireMigrationLock(storePath, transactionId) {
  const path = migrationLockPath(storePath);
  const temporary = `${path}.${transactionId}.tmp`;
  try {
    writeDurableTemp(temporary, Buffer.from(JSON.stringify({ pid: process.pid, transactionId, acquiredAt: new Date().toISOString() })));
    moveAtomically(temporary, path);
    return { path, transactionId };
  } catch (error) {
    if (existsSync(path)) {
      if (existsSync(temporary))
        unlinkSync(temporary);
      fsyncDirectory(dirname(storePath));
      const lock = inspectLock(path);
      fail('migration_lock_present', `An existing migration lock is ${lock.status}; verify and recover it explicitly before retrying.`);
    }
    fail('migration_lock_failed', 'Could not durably write the offline migration lock.', error);
  }
}

function releaseMigrationLock(lock) {
  const current = inspectLock(lock.path);
  if (current.status !== 'active' || current.ownerPid !== process.pid)
    fail('migration_lock_changed', 'The offline migration lock no longer belongs to this process; it was preserved.');
  let metadata;
  try {
    metadata = JSON.parse(readFileSync(lock.path, 'utf8'));
  } catch (error) {
    fail('migration_lock_unreadable', 'The offline migration lock became unreadable and was preserved.', error);
  }
  if (metadata.transactionId !== lock.transactionId)
    fail('migration_lock_changed', 'The offline migration lock transaction identity changed; it was preserved.');
  const releasedPath = `${lock.path}.${lock.transactionId}.released`;
  moveAtomically(lock.path, releasedPath);
  unlinkSync(releasedPath);
  fsyncDirectory(dirname(lock.path));
}

function fsyncDirectory(path) {
  if (process.platform === 'win32')
    return;
  let descriptor;
  try {
    descriptor = openSync(path, 'r');
    fsyncSync(descriptor);
  } catch (error) {
    fail('directory_fsync_failed', 'The containing directory could not be fsynced; durable replacement is not established.', error);
  } finally {
    if (descriptor !== undefined)
      closeSync(descriptor);
  }
}

function moveAtomically(source, target, replace = false) {
  if (process.platform === 'win32') {
    try {
      const childHome = dirname(target);
      if (typeof process.env.SystemRoot !== 'string' || !isAbsolute(process.env.SystemRoot))
        fail('windows_support_unavailable', 'A verified Windows system directory is required for write-through rename.');
      const powershellPath = resolve(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      if (!existsSync(powershellPath))
        fail('windows_support_unavailable', 'Windows PowerShell is unavailable for write-through rename.');
      execFileSync(powershellPath, [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', windowsMoveScript, source, target, String(replace)
      ], {
        windowsHide: true,
        stdio: 'pipe',
        env: {
          ...process.env,
          PORTRAIT_STUDIO_DATA_DIR: childHome,
          USERPROFILE: childHome,
          HOME: childHome,
          APPDATA: childHome,
          LOCALAPPDATA: childHome
        }
      });
    } catch (error) {
      fail('atomic_rename_failed', 'The Windows write-through atomic file move failed.', error);
    }
    return;
  }
  try {
    if (replace) {
      renameSync(source, target);
    } else {
      linkSync(source, target);
      unlinkSync(source);
    }
    fsyncDirectory(dirname(target));
  } catch (error) {
    if (error instanceof OfflineMigrationError)
      throw error;
    fail('atomic_rename_failed', 'The atomic file move failed.', error);
  }
}

function writeDurableTemp(path, bytes) {
  let descriptor;
  try {
    descriptor = openSync(path, 'wx', 0o600);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
  } catch (error) {
    fail('temp_write_failed', 'A migration temporary file could not be written and fsynced.', error);
  } finally {
    if (descriptor !== undefined)
      closeSync(descriptor);
  }
  const stored = readStable(path, 'Migration temporary file');
  if (!stored.bytes.equals(bytes))
    fail('temp_digest_mismatch', 'The fsynced migration temporary file failed byte verification.');
}

function writeJournal(storePath, journal, create = false) {
  const path = journalPath(storePath);
  if (create && existsSync(path))
    fail('journal_exists', 'A migration journal already exists; use recovery instead of starting another migration.');
  const bytes = Buffer.from(JSON.stringify(journal));
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeDurableTemp(temporary, bytes);
  try {
    moveAtomically(temporary, path, !create);
  } catch (error) {
    fail('journal_write_failed', 'The durable migration journal could not be atomically replaced.', error);
  }
}

function validateJournal(value, storePath) {
  const keys = [
    'format', 'transactionId', 'state', 'storePath', 'sourceIdentity', 'v1Sha256', 'v2Sha256',
    'backupPath', 'backupTempPath', 'migrationTempPath', 'rollbackArchivePath',
    'rollbackArchiveTempPath', 'rollbackTempPath', 'rollbackV2Sha256', 'lossNotice'
  ];
  exactKeys(value, keys, 'Migration journal');
  if (value.format !== 1 || !uuidPattern.test(value.transactionId) ||
      !['migrating', 'migrated', 'rolling-back', 'rolled-back'].includes(value.state) ||
      !samePath(value.storePath, storePath) || !digestPattern.test(value.v1Sha256) ||
      !digestPattern.test(value.v2Sha256))
    fail('invalid_journal', 'The migration journal identity or version is invalid.');
  exactKeys(value.sourceIdentity, ['dev', 'ino', 'size', 'mtimeMs'], 'Original file identity');
  if (typeof value.sourceIdentity.dev !== 'string' || typeof value.sourceIdentity.ino !== 'string' ||
      !Number.isSafeInteger(value.sourceIdentity.size) || value.sourceIdentity.size < 0 ||
      !Number.isFinite(value.sourceIdentity.mtimeMs))
    fail('invalid_journal', 'The migration journal file identity is invalid.');
  const expectedBackup = digestPath(storePath, 'v1', value.v1Sha256, 'backup');
  if (value.backupPath !== expectedBackup ||
      value.backupTempPath !== `${storePath}.migration-${value.transactionId}-backup.tmp` ||
      value.migrationTempPath !== `${storePath}.migration-${value.transactionId}-v2.tmp`)
    fail('invalid_journal', 'The migration journal contains an unexpected backup or temporary path.');
  const rollbackFields = [value.rollbackArchivePath, value.rollbackArchiveTempPath, value.rollbackTempPath, value.rollbackV2Sha256, value.lossNotice];
  if (value.state === 'migrating' || value.state === 'migrated') {
    if (rollbackFields.some((field) => field !== null))
      fail('invalid_journal', 'A non-rollback journal contains rollback state.');
  } else {
    if (!digestPattern.test(value.rollbackV2Sha256) ||
        value.rollbackArchivePath !== digestPath(storePath, 'v2', value.rollbackV2Sha256, 'archive') ||
        value.rollbackArchiveTempPath !== `${storePath}.migration-${value.transactionId}-archive.tmp` ||
        value.rollbackTempPath !== `${storePath}.migration-${value.transactionId}-rollback.tmp` ||
        (value.lossNotice !== null && value.lossNotice !== rollbackLossNotice) ||
        (value.state === 'rolled-back' && value.lossNotice !== rollbackLossNotice))
      fail('invalid_journal', 'The rollback journal identity or loss notice is invalid.');
  }
  return value;
}

function readJournal(storePath) {
  const path = journalPath(storePath);
  if (!existsSync(path))
    fail('journal_missing', 'No migration journal exists to recover.');
  let stored;
  try {
    stored = readStable(path, 'Migration journal');
  } catch (error) {
    if (error.code === 'ENOENT')
      fail('journal_missing', 'No migration journal exists to recover.');
    throw error;
  }
  const value = parseCanonicalJson(stored.bytes, 'Migration journal');
  return { value: validateJournal(value, storePath), sha256: stored.sha256 };
}

function verifyArtifact(path, expectedBytes, expectedDigest, name) {
  const stored = readStable(path, name);
  if (stored.sha256 !== expectedDigest || !stored.bytes.equals(expectedBytes))
    fail('artifact_digest_mismatch', `${name} failed exact byte and SHA-256 verification.`);
  return stored;
}

async function ensureBackup(journal, originalBytes, onCheckpoint) {
  const digest = journal.v1Sha256;
  if (existsSync(journal.backupPath)) {
    verifyArtifact(journal.backupPath, originalBytes, digest, 'Immutable V1 backup');
    chmodSync(journal.backupPath, 0o400);
    if (existsSync(journal.backupTempPath)) {
      unlinkSync(journal.backupTempPath);
      fsyncDirectory(dirname(journal.backupPath));
    }
    return;
  }
  if (!existsSync(journal.backupTempPath))
    writeDurableTemp(journal.backupTempPath, originalBytes);
  verifyArtifact(journal.backupTempPath, originalBytes, digest, 'V1 backup temporary file');
  await onCheckpoint('backup-temp-fsynced');
  try {
    moveAtomically(journal.backupTempPath, journal.backupPath);
  } catch (error) {
    if (!existsSync(journal.backupPath))
      fail('backup_create_failed', 'The immutable V1 backup could not be created without overwriting.', error);
    verifyArtifact(journal.backupPath, originalBytes, digest, 'Immutable V1 backup');
  }
  chmodSync(journal.backupPath, 0o400);
  fsyncDirectory(dirname(journal.backupPath));
  verifyArtifact(journal.backupPath, originalBytes, digest, 'Immutable V1 backup');
  await onCheckpoint('backup-durable');
}

function ensureMigrationTemp(journal, originalBytes, expectedV2Bytes) {
  if (existsSync(journal.migrationTempPath)) {
    verifyArtifact(journal.migrationTempPath, expectedV2Bytes, journal.v2Sha256, 'V2 migration temporary file');
    return;
  }
  writeDurableTemp(journal.migrationTempPath, expectedV2Bytes);
}

async function checkpoint(options, name) {
  if (typeof options.onCheckpoint === 'function')
    await options.onCheckpoint(name);
}

async function assertLease(lease) {
  try {
    await lease.assertHeld();
  } catch (error) {
    fail('quiescence_lost', 'The offline quiescence lease ended before replacement; recovery is required.', error);
  }
}

function makeJournal(storePath, original, v1Bytes, v2Bytes) {
  const transactionId = randomUUID();
  return {
    format: 1,
    transactionId,
    state: 'migrating',
    storePath,
    sourceIdentity: original.identity,
    v1Sha256: sha256(v1Bytes),
    v2Sha256: sha256(v2Bytes),
    backupPath: digestPath(storePath, 'v1', sha256(v1Bytes), 'backup'),
    backupTempPath: `${storePath}.migration-${transactionId}-backup.tmp`,
    migrationTempPath: `${storePath}.migration-${transactionId}-v2.tmp`,
    rollbackArchivePath: null,
    rollbackArchiveTempPath: null,
    rollbackTempPath: null,
    rollbackV2Sha256: null,
    lossNotice: null
  };
}

function encodeV2(v1Bytes) {
  const documents = validateV1(v1Bytes);
  const bytes = Buffer.from(JSON.stringify({ version: 2, sessions: documents }));
  validateV2(bytes);
  return bytes;
}

async function withOperation(options, operation, transactionId, body) {
  const storePath = resolveStorePath(options);
  const lease = await acquireLease(options, storePath, operation);
  let lock;
  try {
    lock = acquireMigrationLock(storePath, transactionId);
    requireNoLegacyWriter(storePath);
    return await body(storePath, lease);
  } finally {
    try {
      if (lock)
        releaseMigrationLock(lock);
    } finally {
      await lease.release();
    }
  }
}

export async function migrateV1ToV2(options) {
  const storePath = resolveStorePath(options);
  const transactionId = randomUUID();
  return withOperation(options, 'migrate', transactionId, async (canonicalPath, lease) => {
    if (existsSync(journalPath(canonicalPath)))
      fail('journal_exists', 'A migration journal already exists; use recoverMigration() instead.');
    const original = readStable(canonicalPath, 'V1 sessions.json');
    validateV1(original.bytes);
    const v2Bytes = encodeV2(original.bytes);
    const journal = makeJournal(canonicalPath, original, original.bytes, v2Bytes);
    writeJournal(canonicalPath, journal, true);
    await checkpoint(options, 'journal-prepared');
    await ensureBackup(journal, original.bytes, (name) => checkpoint(options, name));
    ensureMigrationTemp(journal, original.bytes, v2Bytes);
    await checkpoint(options, 'migration-temp-fsynced');
    requireNoLegacyWriter(canonicalPath);
    await assertLease(lease);
    const current = readStable(canonicalPath, 'V1 sessions.json');
    if (current.sha256 !== journal.v1Sha256 || !sameIdentity(current.identity, journal.sourceIdentity))
      fail('source_changed', 'The canonical V1 file changed after the verified backup; no replacement was made.');
    await checkpoint(options, 'before-migration-rename');
    moveAtomically(journal.migrationTempPath, canonicalPath, true);
    await checkpoint(options, 'after-migration-rename');
    fsyncDirectory(dirname(canonicalPath));
    await checkpoint(options, 'migration-directory-fsynced');
    const migrated = readStable(canonicalPath, 'V2 sessions.json');
    if (migrated.sha256 !== journal.v2Sha256)
      fail('migrated_digest_mismatch', 'The atomically replaced V2 file failed digest verification.');
    validateV2(migrated.bytes);
    journal.state = 'migrated';
    writeJournal(canonicalPath, journal);
    await checkpoint(options, 'migration-committed');
    return { state: journal.state, v1Sha256: journal.v1Sha256, v2Sha256: journal.v2Sha256, backupPath: journal.backupPath };
  });
}

function verifyBackup(journal) {
  const backup = readStable(journal.backupPath, 'Immutable V1 backup');
  if (backup.sha256 !== journal.v1Sha256)
    fail('backup_digest_mismatch', 'The immutable V1 backup does not match its journaled digest.');
  validateV1(backup.bytes);
  return backup;
}

async function installMigration(journal, originalBytes, expectedV2Bytes, lease) {
  await ensureBackup(journal, originalBytes, async () => {});
  ensureMigrationTemp(journal, originalBytes, expectedV2Bytes);
  requireNoLegacyWriter(journal.storePath);
  await assertLease(lease);
  const current = readStable(journal.storePath, 'V1 sessions.json');
  if (current.sha256 !== journal.v1Sha256 || !sameIdentity(current.identity, journal.sourceIdentity))
    fail('source_changed', 'Recovery found a V1 file with an unexpected digest or file identity.');
  moveAtomically(journal.migrationTempPath, journal.storePath, true);
}

function archivePathFromDigest(storePath, digest) {
  return digestPath(storePath, 'v2', digest, 'archive');
}

async function ensureArchive(journal, v2Bytes, onCheckpoint) {
  const path = journal.rollbackArchivePath;
  const temp = journal.rollbackArchiveTempPath;
  if (existsSync(path)) {
    verifyArtifact(path, v2Bytes, journal.rollbackV2Sha256, 'Immutable V2 rollback archive');
    chmodSync(path, 0o400);
    if (existsSync(temp)) {
      unlinkSync(temp);
      fsyncDirectory(dirname(path));
    }
    return;
  }
  if (!existsSync(temp))
    writeDurableTemp(temp, v2Bytes);
  verifyArtifact(temp, v2Bytes, journal.rollbackV2Sha256, 'V2 rollback archive temporary file');
  await onCheckpoint('rollback-archive-temp-fsynced');
  try {
    moveAtomically(temp, path);
  } catch (error) {
    if (!existsSync(path))
      fail('archive_create_failed', 'The current V2 store could not be archived without overwriting.', error);
    verifyArtifact(path, v2Bytes, journal.rollbackV2Sha256, 'Immutable V2 rollback archive');
  }
  chmodSync(path, 0o400);
  fsyncDirectory(dirname(path));
  verifyArtifact(path, v2Bytes, journal.rollbackV2Sha256, 'Immutable V2 rollback archive');
  await onCheckpoint('rollback-archive-durable');
}

function ensureRollbackTemp(journal, backupBytes) {
  if (existsSync(journal.rollbackTempPath)) {
    verifyArtifact(journal.rollbackTempPath, backupBytes, journal.v1Sha256, 'V1 rollback temporary file');
    return;
  }
  writeDurableTemp(journal.rollbackTempPath, backupBytes);
}

function finishRollback(journal) {
  const current = readStable(journal.storePath, 'Restored V1 sessions.json');
  if (current.sha256 !== journal.v1Sha256)
    fail('rollback_digest_mismatch', 'The restored V1 file failed its original digest check.');
  validateV1(current.bytes);
  const archive = readStable(journal.rollbackArchivePath, 'Immutable V2 rollback archive');
  if (archive.sha256 !== journal.rollbackV2Sha256)
    fail('archive_digest_mismatch', 'The V2 rollback archive failed its journaled digest check.');
  validateV2(archive.bytes);
  journal.state = 'rolled-back';
  journal.lossNotice = rollbackLossNotice;
  writeJournal(journal.storePath, journal);
}

export async function rollbackV2ToV1(options) {
  if (options.acknowledgeV2EditLoss !== true)
    fail('rollback_acknowledgement_required', 'Acknowledge that edits made after V2 activation will be lost before rollback.');
  const storePath = resolveStorePath(options);
  const read = readJournal(storePath);
  if (read.value.state !== 'migrated')
    fail('rollback_not_available', 'Rollback requires a completed V1-to-V2 migration journal.');
  return withOperation(options, 'rollback', read.value.transactionId, async (canonicalPath, lease) => {
    const { value: journal } = readJournal(canonicalPath);
    if (journal.state !== 'migrated' || journal.transactionId !== read.value.transactionId)
      fail('rollback_not_available', 'The migration journal changed before rollback began.');
    const current = readStable(canonicalPath, 'Current V2 sessions.json');
    validateV2(current.bytes);
    const backup = verifyBackup(journal);
    journal.state = 'rolling-back';
    journal.rollbackV2Sha256 = current.sha256;
    journal.rollbackArchivePath = archivePathFromDigest(canonicalPath, current.sha256);
    journal.rollbackArchiveTempPath = `${canonicalPath}.migration-${journal.transactionId}-archive.tmp`;
    journal.rollbackTempPath = `${canonicalPath}.migration-${journal.transactionId}-rollback.tmp`;
    writeJournal(canonicalPath, journal);
    await checkpoint(options, 'rollback-started');
    await ensureArchive(journal, current.bytes, (name) => checkpoint(options, name));
    ensureRollbackTemp(journal, backup.bytes);
    await checkpoint(options, 'rollback-temp-fsynced');
    requireNoLegacyWriter(canonicalPath);
    await assertLease(lease);
    const latest = readStable(canonicalPath, 'Current V2 sessions.json');
    if (latest.sha256 !== journal.rollbackV2Sha256 || !sameIdentity(latest.identity, current.identity))
      fail('v2_changed_during_rollback', 'The V2 store changed after it was archived; no V1 restore was made.');
    await checkpoint(options, 'before-rollback-rename');
    moveAtomically(journal.rollbackTempPath, canonicalPath, true);
    await checkpoint(options, 'after-rollback-rename');
    fsyncDirectory(dirname(canonicalPath));
    await checkpoint(options, 'rollback-directory-fsynced');
    finishRollback(journal);
    await checkpoint(options, 'rollback-committed');
    return { state: journal.state, archivePath: journal.rollbackArchivePath, lossNotice: journal.lossNotice };
  });
}

async function recoverUnderLock(options, storePath, lease, journal) {
  requireNoLegacyWriter(storePath);
  const current = readStable(storePath, 'Canonical sessions.json');
  if (journal.state === 'migrating') {
    if (current.sha256 === journal.v2Sha256) {
      verifyBackup(journal);
      validateV2(current.bytes);
      journal.state = 'migrated';
      writeJournal(storePath, journal);
    } else if (current.sha256 === journal.v1Sha256) {
      validateV1(current.bytes);
      if (!sameIdentity(current.identity, journal.sourceIdentity))
        fail('source_identity_mismatch', 'Recovery found V1 bytes at an unexpected file identity.');
      await ensureBackup(journal, current.bytes, async () => {});
      const backup = verifyBackup(journal);
      const v2Bytes = encodeV2(backup.bytes);
      if (sha256(v2Bytes) !== journal.v2Sha256)
        fail('v2_digest_mismatch', 'The recovered V2 serialization does not match the durable journal.');
      ensureMigrationTemp(journal, backup.bytes, v2Bytes);
      requireNoLegacyWriter(storePath);
      await assertLease(lease);
      await installMigration(journal, backup.bytes, v2Bytes, lease);
      const replaced = readStable(storePath, 'V2 sessions.json');
      if (replaced.sha256 !== journal.v2Sha256)
        fail('migrated_digest_mismatch', 'Recovery replacement failed its V2 digest check.');
      validateV2(replaced.bytes);
      journal.state = 'migrated';
      writeJournal(storePath, journal);
    } else {
      fail('recovery_digest_mismatch', 'Recovery found bytes that match neither the recorded V1 nor V2 digest.');
    }
  } else if (journal.state === 'rolling-back') {
    const backup = verifyBackup(journal);
    if (current.sha256 === journal.v1Sha256) {
      finishRollback(journal);
    } else if (current.sha256 === journal.rollbackV2Sha256) {
      validateV2(current.bytes);
      await ensureArchive(journal, current.bytes, async () => {});
      ensureRollbackTemp(journal, backup.bytes);
      requireNoLegacyWriter(storePath);
      await assertLease(lease);
      const latest = readStable(storePath, 'Current V2 sessions.json');
      if (latest.sha256 !== journal.rollbackV2Sha256 || !sameIdentity(latest.identity, current.identity))
        fail('v2_changed_during_recovery', 'The V2 store changed during rollback recovery.');
      moveAtomically(journal.rollbackTempPath, storePath, true);
      finishRollback(journal);
    } else {
      fail('recovery_digest_mismatch', 'Rollback recovery found bytes that match neither the journaled V1 nor V2 digest.');
    }
  } else if (journal.state === 'migrated') {
    verifyBackup(journal);
    validateV2(current.bytes);
  } else {
    if (current.sha256 !== journal.v1Sha256)
      fail('recovery_digest_mismatch', 'The rolled-back store does not match its verified V1 backup.');
    validateV1(current.bytes);
    const archive = readStable(journal.rollbackArchivePath, 'Immutable V2 rollback archive');
    if (archive.sha256 !== journal.rollbackV2Sha256)
      fail('archive_digest_mismatch', 'The V2 rollback archive failed its journaled digest check.');
    validateV2(archive.bytes);
  }
  return {
    state: journal.state,
    storeSha256: readStable(storePath, 'Canonical sessions.json').sha256,
    backupPath: journal.backupPath,
    archivePath: journal.rollbackArchivePath
  };
}

export async function recoverMigration(options) {
  const storePath = resolveStorePath(options);
  const initial = readJournal(storePath);
  return withOperation(options, 'recover', initial.value.transactionId, async (canonicalPath, lease) => {
    const latest = readJournal(canonicalPath);
    if (latest.sha256 !== initial.sha256)
      fail('journal_changed', 'The migration journal changed before recovery acquired its lock.');
    return recoverUnderLock(options, canonicalPath, lease, latest.value);
  });
}

