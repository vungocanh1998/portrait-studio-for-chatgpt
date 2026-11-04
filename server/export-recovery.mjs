import { createHash } from 'node:crypto';
import {
  closeSync, constants, existsSync, fstatSync, lstatSync, openSync,
  readSync, readdirSync, realpathSync, statSync
} from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { readV1Store } from './edit-document.mjs';
import { inspectPng } from './png-integrity.mjs';

// M1-AR-PR2: read-only, explicitly scoped inventory for inactive PR5 exports.
// No default paths, no V1 writer, no cleanup, no auto-relink and no live import.
const hash = value => createHash('sha256').update(value).digest('hex');
const digestPattern = /^[a-f0-9]{64}$/;
const exportPngPattern = /^[A-Za-z0-9_-]{1,80}-portrait-studio(?: \([1-9][0-9]{0,3}\))?\.png$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const provenanceKeys = [
  'schemaVersion', 'sessionId', 'revision', 'sourceSha256',
  'rendererId', 'rendererEpoch', 'pipelineId', 'sourceBuildHash',
  'previewSha256', 'width', 'height', 'bytes', 'pngSha256',
  'pixelSha256', 'fileName'
];
const maxStoreBytes = 8 * 1024 * 1024;
const maxPngBytes = 256 * 1024 * 1024;
const maxProvenanceBytes = 16 * 1024;
const maxEntries = 10000;
const maxPairs = 1000;

function reject(code) {
  const error = new Error('Read-only export recovery inventory refused: ' + code);
  error.code = code;
  throw error;
}

function identity(stat) {
  return { dev: stat.dev, ino: stat.ino };
}

function sameIdentity(a, b) {
  return a.dev !== 0n && a.ino !== 0n && a.dev === b.dev && a.ino === b.ino;
}

function canonicalDirectory(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path)
    reject('recovery_invalid_directory');
  let stat;
  try {
    if (realpathSync(path) !== path) reject('recovery_noncanonical_path');
    stat = lstatSync(path, { bigint: true });
  } catch (error) {
    if (error.code?.startsWith('recovery_')) throw error;
    reject('recovery_invalid_directory');
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.ino === 0n)
    reject('recovery_invalid_directory');
  return identity(stat);
}

function assertDirectoryUnchanged(path, descriptor, expected) {
  try {
    const live = canonicalDirectory(path);
    if (!sameIdentity(fstatSync(descriptor, { bigint: true }), expected) ||
        !sameIdentity(live, expected))
      reject('recovery_directory_changed');
  } catch (error) {
    if (error.code === 'recovery_directory_changed') throw error;
    reject('recovery_directory_changed');
  }
}

function safeRead(path, limit) {
  let descriptor = null;
  try {
    const before = lstatSync(path, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.ino === 0n ||
        before.size > BigInt(limit))
      reject('recovery_unsafe_file');
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const held = fstatSync(descriptor, { bigint: true });
    if (!held.isFile() || !sameIdentity(before, held))
      reject('recovery_unsafe_file');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const chunks = [];
    let total = 0;
    while (true) {
      const n = readSync(descriptor, buffer, 0, Math.min(buffer.length, limit + 1 - total), null);
      if (n === 0) break;
      total += n;
      if (total > limit) reject('recovery_unsafe_file');
      chunks.push(Buffer.from(buffer.subarray(0, n)));
    }
    const afterFd = fstatSync(descriptor, { bigint: true });
    const afterPath = lstatSync(path, { bigint: true });
    if (!sameIdentity(before, afterFd) || !sameIdentity(before, afterPath) ||
        afterFd.size !== BigInt(total) || afterPath.size !== BigInt(total))
      reject('recovery_file_changed');
    return Buffer.concat(chunks, total);
  } catch (error) {
    if (error.code?.startsWith('recovery_')) throw error;
    reject('recovery_unsafe_file');
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function validProvenance(value, fileName) {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === provenanceKeys.length &&
    provenanceKeys.every(key => Object.hasOwn(value, key)) &&
    value.schemaVersion === 1 && value.fileName === fileName &&
    exportPngPattern.test(fileName) && uuidPattern.test(value.sessionId) &&
    uuidPattern.test(value.rendererId) && Number.isSafeInteger(value.revision) &&
    value.revision >= 0 && Number.isSafeInteger(value.rendererEpoch) &&
    value.rendererEpoch >= 1 && typeof value.pipelineId === 'string' &&
    value.pipelineId.length >= 1 && value.pipelineId.length <= 128 &&
    Number.isSafeInteger(value.width) && value.width > 0 &&
    Number.isSafeInteger(value.height) && value.height > 0 &&
    value.width * value.height <= 80_000_000 &&
    Number.isSafeInteger(value.bytes) && value.bytes >= 57 &&
    value.bytes <= maxPngBytes &&
    ['sourceSha256', 'sourceBuildHash', 'previewSha256', 'pngSha256', 'pixelSha256']
      .every(key => typeof value[key] === 'string' && digestPattern.test(value[key]));
}

function matchRecord(document, provenance, path) {
  const record = document?.export;
  return !!record && record.path === path &&
    record.fileName === provenance.fileName &&
    record.revision === provenance.revision &&
    record.width === provenance.width &&
    record.height === provenance.height &&
    record.bytes === provenance.bytes &&
    record.sha256 === provenance.pngSha256 &&
    record.pixelSha256 === provenance.pixelSha256 &&
    document.source?.sha256 === provenance.sourceSha256;
}

// A valid-but-unreferenced pair is *not* permission to delete: V1 stores only
// the most recent export, so earlier legitimately saved pairs look unrecorded.
export function inspectExportRecovery({ storePath, outputDirectory } = {}) {
  if (typeof storePath !== 'string' || !isAbsolute(storePath) ||
      resolve(storePath) !== storePath || basename(storePath) !== 'sessions.json')
    reject('recovery_invalid_store_path');
  const dirIdentity = canonicalDirectory(outputDirectory);
  canonicalDirectory(resolve(storePath, '..'));
  if (existsSync(storePath + '.lock'))
    reject('recovery_store_busy');
  const storeBytes = safeRead(storePath, maxStoreBytes);
  let documents;
  try { documents = readV1Store(storeBytes); }
  catch { reject('recovery_invalid_v1_store'); }
  const bySession = new Map(documents.map(doc => [doc.sessionId, doc]));
  const descriptors = [];
  let directoryFd = null;
  try {
    directoryFd = openSync(outputDirectory, 'r');
    assertDirectoryUnchanged(outputDirectory, directoryFd, dirIdentity);
    const entries = readdirSync(outputDirectory, { withFileTypes: true });
    if (entries.length > maxEntries) reject('recovery_directory_too_large');
    const groups = new Map();
    let ignoredEntries = 0;
    for (const entry of entries) {
      const fileName = entry.name.endsWith('.provenance.json')
        ? entry.name.slice(0, -'.provenance.json'.length) : entry.name;
      if (!exportPngPattern.test(fileName)) {
        ignoredEntries++;
        continue;
      }
      if (!entry.isFile() || entry.isSymbolicLink())
        reject('recovery_unsafe_entry');
      if (!groups.has(fileName)) groups.set(fileName, { png: false, proof: false });
      const group = groups.get(fileName);
      if (entry.name === fileName) group.png = true;
      else if (entry.name === fileName + '.provenance.json') group.proof = true;
      else reject('recovery_unsafe_entry');
    }
    if (groups.size > maxPairs) reject('recovery_too_many_pairs');
    for (const [fileName, files] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
      const path = join(outputDirectory, fileName);
      if (!files.png || !files.proof) {
        descriptors.push(Object.freeze({ fileName, status: 'incomplete_pair' }));
        continue;
      }
      let provenance;
      try {
        const proofBytes = safeRead(path + '.provenance.json', maxProvenanceBytes);
        provenance = JSON.parse(proofBytes.toString('utf8'));
        if (!validProvenance(provenance, fileName)) throw new Error('invalid proof');
        const imageBytes = safeRead(path, maxPngBytes);
        if (imageBytes.length !== provenance.bytes) throw new Error('wrong length');
        const pixels = inspectPng(imageBytes, provenance.width, provenance.height);
        if (pixels.sha256 !== provenance.pngSha256 ||
            pixels.pixelSha256 !== provenance.pixelSha256)
          throw new Error('mismatched PNG or pixels');
      } catch (error) {
        if (error.code?.startsWith('recovery_')) throw error;
        descriptors.push(Object.freeze({ fileName, status: 'invalid_pair' }));
        continue;
      }
      const doc = bySession.get(provenance.sessionId);
      descriptors.push(Object.freeze({
        fileName, sessionId: provenance.sessionId, revision: provenance.revision,
        status: matchRecord(doc, provenance, path)
          ? 'recorded_verified' : 'unreferenced_verified'
      }));
    }
    const visited = new Set(groups.keys());
    for (const doc of documents) {
      const saved = doc.export;
      if (saved && exportPngPattern.test(saved.fileName) &&
          saved.path === join(outputDirectory, saved.fileName) &&
          !visited.has(saved.fileName)) {
        descriptors.push(Object.freeze({
          fileName: saved.fileName, sessionId: doc.sessionId,
          revision: saved.revision, status: 'recorded_missing_pair'
        }));
      }
    }
    if (existsSync(storePath + '.lock') ||
        hash(safeRead(storePath, maxStoreBytes)) !== hash(storeBytes))
      reject('recovery_store_changed');
    assertDirectoryUnchanged(outputDirectory, directoryFd, dirIdentity);
    const counts = Object.freeze(Object.fromEntries(
      ['recorded_verified', 'unreferenced_verified', 'incomplete_pair',
       'invalid_pair', 'recorded_missing_pair']
        .map(status => [status, descriptors.filter(row => row.status === status).length])
    ));
    return Object.freeze({
      schemaVersion: 1, mode: 'read_only_inventory',
      outputDirectory, sessionStoreSha256: hash(storeBytes),
      ignoredEntries, counts,
      entries: Object.freeze(descriptors),
      safeToAutoRecover: false, safeToAutoDelete: false,
      caveat: 'V1 is not an atomic publication journal; matches are observations, not authority to mutate.'
    });
  } finally {
    if (directoryFd !== null) closeSync(directoryFd);
  }
}
