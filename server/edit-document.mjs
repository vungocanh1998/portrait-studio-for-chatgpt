import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Engine = require('../ui/engine.js');
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hashPattern = /^[a-f0-9]{64}$/i;
const sessionKeys = ['sessionId', 'createdAt', 'updatedAt', 'revision', 'source', 'adjustments', 'preset', 'crop', 'history', 'historyIndex', 'preview', 'export'];
const sourceKeys = ['fileName', 'mimeType', 'width', 'height', 'byteSize', 'sha256'];
const cropKeys = ['x', 'y', 'width', 'height', 'aspectRatio'];
const adjustmentKeys = Object.keys(Engine.DEFAULT_ADJUSTMENTS);
const stateKeys = ['adjustments', 'preset', 'crop'];
const previewKeys = ['revision', 'rendererId', 'width', 'height', 'sha256', 'confirmedBy'];
const exportKeys = ['revision', 'path', 'fileName', 'width', 'height', 'bytes', 'sha256', 'pixelSha256'];
const confirmedByKeys = ['serverVersion', 'sourceBuildHash', 'pid', 'instanceId', 'executablePath', 'scriptPath', 'pluginRoot', 'sessionStorePath', 'confirmedAt'];
const sourceIdentityKeys = ['mimeType', 'width', 'height', 'byteSize', 'sha256'];
const maxSessions = 20;
const maxHistory = 50;

function record(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
    throw new TypeError(name + ' must be a JSON object.');
}

function exactKeys(value, keys, name) {
  record(value, name);
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key)))
    throw new TypeError(name + ' has unknown or missing fields.');
}

function timestamp(value, name) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value)
    throw new TypeError(name + ' must be a canonical ISO timestamp.');
}

function revision(value, name) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new TypeError(name + ' must be a non-negative safe integer.');
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new TypeError(name + ' must be a positive safe integer.');
}

function nonEmptyString(value, name, maximum = 4096) {
  if (typeof value !== 'string' || !value.length || value.length > maximum)
    throw new TypeError(name + ' must be a non-empty string.');
}

function sha256(value, name) {
  if (typeof value !== 'string' || !hashPattern.test(value))
    throw new TypeError(name + ' must be a SHA-256 digest.');
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value))
      deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function normalizeV1Source(source) {
  if (source === null)
    return null;
  exactKeys(source, sourceKeys, 'V1 source');
  nonEmptyString(source.fileName, 'V1 source fileName', 240);
  if (source.fileName.includes('/') || source.fileName.includes('\\') || /[\u0000-\u001f\u007f]/.test(source.fileName) ||
      !['image/jpeg', 'image/png'].includes(source.mimeType) ||
      !Number.isSafeInteger(source.width) || source.width < 1 ||
      !Number.isSafeInteger(source.height) || source.height < 1 ||
      source.width * source.height > Engine.MAX_PIXELS ||
      !Number.isSafeInteger(source.byteSize) || source.byteSize < 1 || source.byteSize > Engine.MAX_INPUT_BYTES)
    throw new TypeError('V1 source metadata is invalid.');
  sha256(source.sha256, 'V1 source SHA-256');
  if (source.sha256 !== source.sha256.toLowerCase())
    throw new TypeError('V1 source SHA-256 must be canonical lowercase.');
  return clone(source);
}

function normalizeV1Adjustments(value) {
  exactKeys(value, adjustmentKeys, 'V1 adjustments');
  const normalized = Engine.normalizeAdjustments(value);
  if (adjustmentKeys.some((key) => normalized[key] !== value[key]))
    throw new TypeError('V1 adjustments are not in canonical form.');
  return normalized;
}

function normalizeV1Preset(value) {
  if (value === null)
    return null;
  exactKeys(value, ['name', 'intensity'], 'V1 preset');
  if (!Engine.presetNames.includes(value.name) || !Number.isFinite(value.intensity) ||
      value.intensity < 0 || value.intensity > 100 ||
      Number(Number(value.intensity).toFixed(1)) !== value.intensity)
    throw new TypeError('V1 preset is invalid.');
  return { name: value.name, intensity: value.intensity };
}

function normalizeV1Crop(value, source) {
  exactKeys(value, cropKeys, 'V1 crop');
  const normalized = source
    ? Engine.normalizeCrop(value, source.width, source.height)
    : Engine.normalizeCrop(value);
  if (cropKeys.some((key) => normalized[key] !== value[key]))
    throw new TypeError('V1 crop is not in canonical form.');
  return normalized;
}

function normalizeV1State(value, source) {
  exactKeys(value, stateKeys, 'V1 history snapshot');
  return {
    adjustments: normalizeV1Adjustments(value.adjustments),
    preset: normalizeV1Preset(value.preset),
    crop: normalizeV1Crop(value.crop, source)
  };
}

function normalizeV1ConfirmedBy(value) {
  if (value === null)
    return null;
  exactKeys(value, confirmedByKeys, 'V1 preview confirmation metadata');
  nonEmptyString(value.serverVersion, 'V1 confirmation serverVersion', 80);
  sha256(value.sourceBuildHash, 'V1 confirmation sourceBuildHash');
  positiveInteger(value.pid, 'V1 confirmation pid');
  if (typeof value.instanceId !== 'string' || !uuidPattern.test(value.instanceId))
    throw new TypeError('V1 confirmation instanceId is invalid.');
  for (const key of ['executablePath', 'scriptPath', 'pluginRoot', 'sessionStorePath'])
    nonEmptyString(value[key], 'V1 confirmation ' + key);
  timestamp(value.confirmedAt, 'V1 confirmation confirmedAt');
  return clone(value);
}

function normalizeV1Preview(value, currentRevision, source) {
  if (value === null)
    return null;
  exactKeys(value, previewKeys, 'V1 preview');
  revision(value.revision, 'V1 preview revision');
  if (!source || value.revision > currentRevision ||
      typeof value.rendererId !== 'string' || !uuidPattern.test(value.rendererId))
    throw new TypeError('V1 preview identity is invalid.');
  positiveInteger(value.width, 'V1 preview width');
  positiveInteger(value.height, 'V1 preview height');
  sha256(value.sha256, 'V1 preview SHA-256');
  normalizeV1ConfirmedBy(value.confirmedBy);
  return clone(value);
}

function normalizeV1Export(value, currentRevision, source) {
  if (value === null)
    return null;
  exactKeys(value, exportKeys, 'V1 export');
  revision(value.revision, 'V1 export revision');
  if (!source || value.revision > currentRevision)
    throw new TypeError('V1 export revision is invalid.');
  nonEmptyString(value.path, 'V1 export path');
  nonEmptyString(value.fileName, 'V1 export fileName', 240);
  positiveInteger(value.width, 'V1 export width');
  positiveInteger(value.height, 'V1 export height');
  positiveInteger(value.bytes, 'V1 export bytes');
  sha256(value.sha256, 'V1 export SHA-256');
  sha256(value.pixelSha256, 'V1 export pixel SHA-256');
  return clone(value);
}

function adaptV1Store(store) {
  exactKeys(store, ['version', 'sessions'], 'V1 store');
  if (store.version !== 1 || !Array.isArray(store.sessions) || store.sessions.length > maxSessions)
    throw new TypeError('Unsupported or invalid V1 session store.');
  const ids = new Set();
  const documents = store.sessions.map((raw) => {
    exactKeys(raw, sessionKeys, 'V1 session');
    if (typeof raw.sessionId !== 'string' || !uuidPattern.test(raw.sessionId) || ids.has(raw.sessionId))
      throw new TypeError('V1 session ID is invalid or duplicated.');
    ids.add(raw.sessionId);
    timestamp(raw.createdAt, 'V1 createdAt');
    timestamp(raw.updatedAt, 'V1 updatedAt');
    revision(raw.revision, 'V1 revision');
    const source = normalizeV1Source(raw.source);
    const state = {
      adjustments: normalizeV1Adjustments(raw.adjustments),
      preset: normalizeV1Preset(raw.preset),
      crop: normalizeV1Crop(raw.crop, source)
    };
    if (!Array.isArray(raw.history) || raw.history.length < 1 || raw.history.length > maxHistory ||
        !Number.isSafeInteger(raw.historyIndex) || raw.historyIndex < 0 || raw.historyIndex >= raw.history.length)
      throw new TypeError('V1 history or cursor is invalid.');
    const history = raw.history.map((entry) => normalizeV1State(entry, source));
    if (JSON.stringify(history[raw.historyIndex]) !== JSON.stringify(state))
      throw new TypeError('V1 current state does not match its history cursor.');
    const preview = normalizeV1Preview(raw.preview, raw.revision, source);
    const exported = normalizeV1Export(raw.export, raw.revision, source);
    return deepFreeze({
      schemaVersion: 2,
      sessionId: raw.sessionId,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      revision: raw.revision,
      source,
      ...state,
      history,
      historyIndex: raw.historyIndex,
      preview,
      export: exported
    });
  });
  return Object.freeze(documents);
}

export function readV1Store(bytes) {
  const json = typeof bytes === 'string'
    ? bytes
    : bytes instanceof Uint8Array
      ? new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      : null;
  if (json === null)
    throw new TypeError('V1 store input must be UTF-8 bytes or a string.');
  return adaptV1Store(JSON.parse(json));
}

function assertEditDocument(document) {
  if (!document || typeof document !== 'object' || !Object.isFrozen(document) || document.schemaVersion !== 2 ||
      !Number.isSafeInteger(document.revision) || !Array.isArray(document.history) ||
      !Number.isSafeInteger(document.historyIndex) || document.historyIndex < 0 ||
      document.historyIndex >= document.history.length)
    throw new TypeError('A version 2 EditDocument is required.');
}

function normalizeSourceIdentity(value) {
  exactKeys(value, sourceIdentityKeys, 'Expected source identity');
  if (!['image/jpeg', 'image/png'].includes(value.mimeType))
    throw new TypeError('Expected source MIME type is invalid.');
  positiveInteger(value.width, 'Expected source width');
  positiveInteger(value.height, 'Expected source height');
  positiveInteger(value.byteSize, 'Expected source byteSize');
  if (value.width * value.height > Engine.MAX_PIXELS || value.byteSize > Engine.MAX_INPUT_BYTES)
    throw new TypeError('Expected source dimensions or byteSize exceed editor limits.');
  sha256(value.sha256, 'Expected source SHA-256');
  return {
    mimeType: value.mimeType,
    width: value.width,
    height: value.height,
    byteSize: value.byteSize,
    sha256: value.sha256.toLowerCase()
  };
}

function normalizeOperationAdjustments(value) {
  exactKeys(value, adjustmentKeys, 'Operation adjustments');
  return Engine.normalizeAdjustments(value);
}

function normalizeOperationPreset(value) {
  if (value === null)
    return null;
  exactKeys(value, ['name', 'intensity'], 'Operation preset');
  if (!Engine.presetNames.includes(value.name) || !Number.isFinite(value.intensity) ||
      value.intensity < 0 || value.intensity > 100)
    throw new TypeError('Operation preset is invalid.');
  return { name: value.name, intensity: Number(Number(value.intensity).toFixed(1)) };
}

function normalizeOperationState(value, source) {
  exactKeys(value, stateKeys, 'Operation state');
  const cropInput = value.crop;
  exactKeys(cropInput, cropKeys, 'Operation crop');
  return {
    adjustments: normalizeOperationAdjustments(value.adjustments),
    preset: normalizeOperationPreset(value.preset),
    crop: Engine.normalizeCrop(cropInput, source.width, source.height)
  };
}

export function normalizeEditOperation(document, input) {
  assertEditDocument(document);
  record(input, 'Edit operation');
  const type = input.type;
  const keys = type === 'setState'
    ? ['type', 'expectedRevision', 'expectedSource', 'timestamp', 'state']
    : type === 'undo' || type === 'redo'
      ? ['type', 'expectedRevision', 'expectedSource', 'timestamp']
      : null;
  if (!keys)
    throw new TypeError('Unknown edit operation.');
  exactKeys(input, keys, 'Edit operation');
  revision(input.expectedRevision, 'Operation expectedRevision');
  const expectedSource = normalizeSourceIdentity(input.expectedSource);
  timestamp(input.timestamp, 'Operation timestamp');
  if (!document.source)
    throw new TypeError('An edit operation requires a source-bound document.');
  return deepFreeze({
    type,
    expectedRevision: input.expectedRevision,
    expectedSource,
    timestamp: input.timestamp,
    ...(type === 'setState' ? { state: normalizeOperationState(input.state, document.source) } : {})
  });
}

function sourceMatches(source, expected) {
  return Boolean(source &&
    source.mimeType === expected.mimeType &&
    source.width === expected.width &&
    source.height === expected.height &&
    source.byteSize === expected.byteSize &&
    source.sha256.toLowerCase() === expected.sha256);
}

function result(status, document) {
  return Object.freeze({ status, document });
}

export function reduceEditDocument(document, input) {
  const operation = normalizeEditOperation(document, input);
  if (operation.expectedRevision !== document.revision || !sourceMatches(document.source, operation.expectedSource))
    return result('conflict', document);
  if (document.revision === Number.MAX_SAFE_INTEGER)
    throw new RangeError('EditDocument revision cannot be incremented safely.');

  if (operation.type === 'setState') {
    if (JSON.stringify(operation.state) === JSON.stringify({
      adjustments: document.adjustments,
      preset: document.preset,
      crop: document.crop
    }))
      return result('unchanged', document);
    const history = document.history.slice(0, document.historyIndex + 1);
    history.push(operation.state);
    if (history.length > maxHistory)
      history.shift();
    const next = {
      ...document,
      ...operation.state,
      revision: document.revision + 1,
      updatedAt: operation.timestamp,
      history,
      historyIndex: history.length - 1
    };
    return result('applied', deepFreeze(next));
  }

  const historyIndex = document.historyIndex + (operation.type === 'undo' ? -1 : 1);
  if (historyIndex < 0 || historyIndex >= document.history.length)
    return result('unchanged', document);
  const next = {
    ...document,
    ...document.history[historyIndex],
    revision: document.revision + 1,
    updatedAt: operation.timestamp,
    historyIndex
  };
  return result('applied', deepFreeze(next));
}

export function getPreviewStatus(document) {
  assertEditDocument(document);
  if (!document.preview)
    return document.source ? 'pending' : 'awaiting_source';
  return document.preview.revision === document.revision ? 'confirmed' : 'pending';
}

export function getExportStatus(document) {
  assertEditDocument(document);
  if (!document.export)
    return 'none';
  return document.export.revision === document.revision ? 'saved' : 'stale';
}
