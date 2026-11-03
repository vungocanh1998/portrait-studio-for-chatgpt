import { randomUUID } from 'node:crypto';
import {
  closeSync, existsSync, fstatSync, fsyncSync, lstatSync, openSync,
  readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

// Offline/inactive PR4 proof of a CROSS-PROCESS renderer epoch. This is not
// wired to the PRIVATE V0.2.8 server and is not a live export authorization.
// Integration must bind this lock to actual session CAS and saved PNG checks.
const hashPattern = /^[a-f0-9]{64}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function refuse(code, detail) {
  const error = new Error(detail);
  error.code = code;
  throw error;
}

function exactKeys(record, expected) {
  if (!record || typeof record !== 'object' || Array.isArray(record) ||
      Object.keys(record).length !== expected.length ||
      Object.keys(record).some(key => !expected.includes(key)))
    refuse('invalid_renderer_identity', 'Renderer token contains unknown or missing fields.');
}

function canonicalStorePath(storePath) {
  if (typeof storePath !== 'string' || !isAbsolute(storePath) || basename(storePath) !== 'sessions.json')
    refuse('invalid_renderer_path', 'An explicit absolute sessions.json path is required.');
  const directory = dirname(storePath);
  if (resolve(directory) !== realpathSync(directory))
    refuse('invalid_renderer_path', 'The data directory must have a canonical, non-aliased path.');
  const dirStat = lstatSync(directory);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink())
    refuse('invalid_renderer_path', 'The data directory cannot be a symbolic link.');
  if (!existsSync(storePath))
    refuse('renderer_store_missing', 'An explicit synthetic store must exist.');
  const stat = lstatSync(storePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    refuse('invalid_renderer_path', 'The store must be a regular single-link file.');
  return storePath;
}

function validateToken(token) {
  const fields = ['sessionId', 'rendererId', 'sourceSha256', 'revision', 'pipelineId', 'sourceBuildHash', 'epoch'];
  exactKeys(token, fields);
  if (!uuidPattern.test(token.sessionId) || !uuidPattern.test(token.rendererId) ||
      !hashPattern.test(token.sourceSha256) || !hashPattern.test(token.sourceBuildHash) ||
      !Number.isSafeInteger(token.revision) || token.revision < 0 ||
      !Number.isSafeInteger(token.epoch) || token.epoch < 1 ||
      typeof token.pipelineId !== 'string' || !/^[a-z0-9._-]{1,100}$/.test(token.pipelineId))
    refuse('invalid_renderer_identity', 'Invalid renderer registration identity.');
  return token;
}

function readState(path) {
  if (!existsSync(path))
    return { version: 1, sessions: {} };
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)
    refuse('unsafe_renderer_state', 'Renderer authority cannot read a linked/non-regular state file.');
  const fd = openSync(path, 'r');
  let bytes;
  try {
    const opened = fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size)
      refuse('unsafe_renderer_state', 'Renderer state changed during open.');
    bytes = readFileSync(fd);
    const after = fstatSync(fd);
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs)
      refuse('unsafe_renderer_state', 'Renderer state changed during read.');
  } finally {
    closeSync(fd);
  }
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); }
  catch { refuse('invalid_renderer_state', 'Renderer authority state is unreadable.'); }
  exactKeys(value, ['version', 'sessions']);
  if (value.version !== 1 || !value.sessions || typeof value.sessions !== 'object' ||
      Array.isArray(value.sessions) || Object.getPrototypeOf(value.sessions) !== Object.prototype)
    refuse('invalid_renderer_state', 'Renderer state schema mismatch.');
  if (Object.keys(value.sessions).length > 20)
    refuse('renderer_capacity', 'Renderer authority session capacity exceeded.');
  for (const [id, token] of Object.entries(value.sessions)) {
    validateToken(token);
    if (id !== token.sessionId)
      refuse('invalid_renderer_state', 'Renderer authority session identity mismatch.');
  }
  return value;
}

function fsyncDirectory(path) {
  let descriptor;
  try {
    descriptor = openSync(path, 'r');
    fsyncSync(descriptor);
  } catch (error) {
    // Node/Windows cannot reliably fsync directories. The epoch remains
    // conservative: a restart must freshly register before confirmation.
    if (process.platform !== 'win32')
      throw error;
  } finally {
    if (descriptor !== undefined)
      closeSync(descriptor);
  }
}

function writeState(path, value) {
  const temp = path + '.' + randomUUID() + '.tmp';
  const bytes = Buffer.from(JSON.stringify(value));
  const fd = openSync(temp, 'wx', 0o600);
  let published = false;
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(temp, path);
    published = true;
    fsyncDirectory(dirname(path));
  } finally {
    if (!published && existsSync(temp))
      unlinkSync(temp);
  }
}

function underLock(storePath, callback) {
  const canonical = canonicalStorePath(storePath);
  const lockPath = canonical + '.renderer-epoch.lock';
  const statePath = canonical + '.renderer-epoch.json';
  let lock;
  try {
    lock = openSync(lockPath, 'wx', 0o600);
  } catch (error) {
    refuse('renderer_authority_busy', 'A renderer authority lock exists; refuse competing writers or orphan locks.');
  }
  try {
    const state = readState(statePath);
    return callback(state, statePath);
  } finally {
    closeSync(lock);
    unlinkSync(lockPath);
  }
}

export function registerRenderer({ storePath, sessionId, sourceSha256, revision, pipelineId, sourceBuildHash }) {
  const probe = {
    sessionId, rendererId: randomUUID(), sourceSha256,
    revision, pipelineId, sourceBuildHash, epoch: 1
  };
  validateToken(probe);
  return underLock(storePath, (state, path) => {
    const previous = state.sessions[sessionId];
    // Preserve the strict 20-session read contract: never publish a
    // 21st distinct session that would make every later read fail closed.
    // Re-registering an existing session at capacity is still permitted.
    if (!previous && Object.keys(state.sessions).length >= 20)
      refuse('renderer_capacity', 'Renderer authority cannot exceed 20 distinct sessions.');
    if (previous && previous.epoch === Number.MAX_SAFE_INTEGER)
      refuse('renderer_epoch_overflow', 'Renderer epoch cannot increment.');
    const token = Object.freeze({ ...probe, epoch: previous ? previous.epoch + 1 : 1 });
    state.sessions[sessionId] = token;
    writeState(path, state);
    return token;
  });
}

export function isCurrentRenderer({ storePath, token }) {
  validateToken(token);
  return underLock(storePath, state => {
    const current = state.sessions[token.sessionId];
    return Boolean(current && Object.keys(token).every(key => token[key] === current[key]));
  });
}

// PR5 code-only integration primitive: hold the SAME shared renderer lock
// throughout a synchronous session-bound export transaction. The caller must
// take the EditorSessions store lock first; registration only takes this lock.
export function withCurrentRenderer({ storePath, token }, callback) {
  validateToken(token);
  if (typeof callback !== 'function')
    refuse('invalid_renderer_transaction', 'A synchronous renderer transaction is required.');
  const pinned = Object.freeze({ ...token });
  return underLock(storePath, state => {
    const current = state.sessions[pinned.sessionId];
    if (!current || Object.keys(pinned).some(key => current[key] !== pinned[key]))
      refuse('stale_renderer', 'The renderer registration is no longer current.');
    const result = callback(pinned);
    if (result && typeof result.then === 'function')
      refuse('async_renderer_transaction', 'Renderer transactions must not yield while locked.');
    return result;
  });
}

export function assertCurrentRenderer(options) {
  if (!isCurrentRenderer(options))
    refuse('stale_renderer', 'The renderer registration is no longer current.');
  return true;
}
