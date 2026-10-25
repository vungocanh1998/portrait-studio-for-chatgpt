import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Engine = require('../ui/engine.js');
const adjustmentKeys = Object.keys(Engine.DEFAULT_ADJUSTMENTS);
const hashPattern = /^[a-f0-9]{64}$/i;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const maxSessions = 20;
const maxHistory = 50;
const lockWaitCell = new Int32Array(new SharedArrayBuffer(4));

export class EditorSessionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EditorSessionError';
    this.code = code;
  }
}

const clone = (value) => JSON.parse(JSON.stringify(value));
const validId = (value) => typeof value === 'string' && uuidPattern.test(value);

function syncDirectory(path) {
  let descriptor = null;
  try {
    descriptor = openSync(path, 'r');
    fsyncSync(descriptor);
    return true;
  } catch {
    return false;
  } finally {
    if (descriptor !== null) {
      try { closeSync(descriptor); } catch {}
    }
  }
}

function editState(state) {
  return { adjustments: clone(state.adjustments), preset: clone(state.preset), crop: clone(state.crop) };
}

function initialSession(sessionId, now) {
  const state = {
    sessionId,
    createdAt: now(),
    updatedAt: now(),
    revision: 0,
    source: null,
    adjustments: { ...Engine.DEFAULT_ADJUSTMENTS },
    preset: null,
    crop: { x: 0, y: 0, width: 100, height: 100, aspectRatio: 'free' },
    history: [],
    historyIndex: 0,
    preview: null,
    export: null
  };
  state.history.push(editState(state));
  return state;
}

function snapshot(state, status = 'ok', errors = []) {
  const adjustments = clone(state.adjustments);
  const warnings = adjustments.temperature || adjustments.tint || adjustments.vibrance || adjustments.saturation
    ? ['Color adjustments are global; no automatic skin mask is applied.']
    : [];
  return {
    ok: status === 'ok' || status === 'unchanged',
    status,
    sessionId: state.sessionId,
    revision: state.revision,
    source: clone(state.source),
    adjustments,
    preset: clone(state.preset),
    crop: clone(state.crop),
    history: {
      canUndo: state.historyIndex > 0,
      canRedo: state.historyIndex < state.history.length - 1
    },
    preview: state.preview && state.preview.revision === state.revision
      ? { ...clone(state.preview), status: 'confirmed' }
      : { status: state.source ? 'pending' : 'awaiting_source', revision: null, rendererId: null, width: null, height: null, sha256: null },
    export: state.export
      ? { ...clone(state.export), status: state.export.revision === state.revision ? 'saved' : 'stale' }
      : { status: 'none', revision: null, path: null, fileName: null, width: null, height: null, bytes: null, sha256: null, pixelSha256: null },
    warnings,
    errors: clone(errors)
  };
}

function normalizeSource(source) {
  const allowed = new Set(['fileName', 'mimeType', 'width', 'height', 'byteSize', 'sha256']);
  if (!source || typeof source !== 'object' || Array.isArray(source) || Object.keys(source).some((key) => !allowed.has(key)))
    throw new EditorSessionError('invalid_source', 'Source metadata is invalid. Image bytes are not accepted by this tool.');
  if (typeof source.fileName !== 'string' || !source.fileName.length || source.fileName.length > 240 || /[\\/\u0000-\u001f\u007f]/.test(source.fileName) ||
      !['image/jpeg', 'image/png'].includes(source.mimeType) ||
      !Number.isSafeInteger(source.width) || source.width < 1 ||
      !Number.isSafeInteger(source.height) || source.height < 1 || source.width * source.height > Engine.MAX_PIXELS ||
      !Number.isSafeInteger(source.byteSize) || source.byteSize < 1 || source.byteSize > Engine.MAX_INPUT_BYTES ||
      typeof source.sha256 !== 'string' || !hashPattern.test(source.sha256))
    throw new EditorSessionError('invalid_source', 'Source metadata must include a valid SHA-256 and describe a supported JPEG or PNG within the editor limits.');
  return {
    fileName: source.fileName,
    mimeType: source.mimeType,
    width: source.width,
    height: source.height,
    byteSize: source.byteSize,
    sha256: source.sha256.toLowerCase()
  };
}

export class EditorSessions {
  constructor({ filePath = null, now = () => new Date().toISOString(), id = randomUUID, instanceId = randomUUID() } = {}) {
    this.filePath = filePath ? resolve(filePath) : null;
    this.now = now;
    this.id = id;
    this.instanceId = instanceId;
    this.sessions = this.load();
    this.lastWriteDurability = null;
  }

  load() {
    if (!this.filePath || !existsSync(this.filePath))
      return new Map();
    try {
      const stored = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (stored.version !== 1 || !Array.isArray(stored.sessions))
        throw new TypeError('Invalid session store format.');
      const sessions = new Map();
      for (const raw of stored.sessions) {
        if (!raw || !validId(raw.sessionId) || !Number.isSafeInteger(raw.revision) || raw.revision < 0 ||
            !Array.isArray(raw.history) || raw.history.length < 1 || raw.history.length > maxHistory ||
            !Number.isSafeInteger(raw.historyIndex) || raw.historyIndex < 0 || raw.historyIndex >= raw.history.length)
          continue;
        const source = raw.source === null ? null : normalizeSource(raw.source);
        const adjustments = Engine.normalizeAdjustments(raw.adjustments);
        const crop = source
          ? Engine.normalizeCrop(raw.crop, source.width, source.height)
          : Engine.normalizeCrop(raw.crop);
        if (raw.preset !== null && (!raw.preset || !Engine.presetNames.includes(raw.preset.name) || !Number.isFinite(raw.preset.intensity)))
          continue;
        const history = raw.history.map((edit) => ({
          adjustments: Engine.normalizeAdjustments(edit.adjustments),
          preset: edit.preset === null ? null : clone(edit.preset),
          crop: source ? Engine.normalizeCrop(edit.crop, source.width, source.height) : Engine.normalizeCrop(edit.crop)
        }));
        sessions.set(raw.sessionId, {
          sessionId: raw.sessionId,
          createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : this.now(),
          updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : this.now(),
          revision: raw.revision,
          source,
          adjustments,
          preset: raw.preset === null ? null : clone(raw.preset),
          crop,
          history,
          historyIndex: raw.historyIndex,
          preview: raw.preview && Number.isSafeInteger(raw.preview.revision) ? clone(raw.preview) : null,
          export: raw.export && Number.isSafeInteger(raw.export.revision) ? clone(raw.export) : null
        });
      }
      return sessions;
    } catch (error) {
      throw new Error('The local Portrait Studio session store is unreadable; the file was left unchanged.', { cause: error });
    }
  }

  persist() {
    if (!this.filePath)
      return;
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporaryPath = this.filePath + '.' + this.id() + '.tmp';
    let descriptor = null;
    try {
      descriptor = openSync(temporaryPath, 'wx', 0o600);
      writeFileSync(descriptor, JSON.stringify({ version: 1, sessions: [...this.sessions.values()] }));
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;
      renameSync(temporaryPath, this.filePath);
      this.lastWriteDurability = {
        fileFsyncBeforeRename: true,
        directoryFsyncAfterRename: syncDirectory(dirname(this.filePath))
      };
    } catch (error) {
      if (descriptor !== null) {
        try { closeSync(descriptor); } catch {}
      }
      try { unlinkSync(temporaryPath); } catch {}
      throw error;
    }
  }

  withStoreLock(operation) {
    if (!this.filePath)
      return operation();
    const lockPath = this.filePath + '.lock';
    mkdirSync(dirname(this.filePath), { recursive: true });
    const startedAt = Date.now();
    const deadline = startedAt + 60_000;
    let descriptor;
    while (descriptor === undefined) {
      try {
        descriptor = openSync(lockPath, 'wx', 0o600);
      } catch (error) {
        if (error.code !== 'EEXIST')
          throw error;
        const owner = this.inspectStoreLock();
        if (owner.status === 'orphaned')
          throw new EditorSessionError('orphaned_store_lock', `Session store lock belongs to stopped process PID ${owner.ownerPid}; the lock was preserved for explicit recovery.`);
        if (owner.status === 'unreadable' && Date.now() - startedAt >= 500)
          throw new EditorSessionError('unreadable_store_lock', 'Session store lock metadata is unreadable; the lock was preserved for explicit recovery.');
        if (Date.now() >= deadline)
          throw new EditorSessionError('store_busy', 'The local Portrait Studio session store is busy; no session changes were applied.');
        Atomics.wait(lockWaitCell, 0, 0, 10);
      }
    }
    try {
      writeFileSync(descriptor, JSON.stringify({ pid: process.pid, instanceId: this.instanceId, acquiredAt: this.now() }));
      fsyncSync(descriptor);
      this.sessions = this.load();
      try {
        return operation();
      } catch (error) {
        this.sessions = this.load();
        throw error;
      }
    } finally {
      try { closeSync(descriptor); } finally {
        try { unlinkSync(lockPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
  }

  inspectStoreLock() {
    if (!this.filePath)
      return { status: 'disabled', ownerPid: null, ownerInstanceId: null };
    let text;
    try {
      text = readFileSync(this.filePath + '.lock', 'utf8').trim();
    } catch (error) {
      if (error.code === 'ENOENT')
        return { status: 'absent', ownerPid: null, ownerInstanceId: null };
      return { status: 'unreadable', ownerPid: null, ownerInstanceId: null };
    }
    if (!text)
      return { status: 'initializing', ownerPid: null, ownerInstanceId: null };
    let owner;
    try {
      owner = JSON.parse(text);
    } catch {
      owner = /^\d+$/.test(text) ? { pid: Number(text) } : null;
    }
    if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid < 1)
      return { status: 'unreadable', ownerPid: null, ownerInstanceId: null };
    let status = 'unknown';
    try {
      process.kill(owner.pid, 0);
      status = 'active';
    } catch (error) {
      status = error.code === 'ESRCH' ? 'orphaned' : error.code === 'EPERM' ? 'active' : 'unknown';
    }
    return {
      status,
      ownerPid: owner.pid,
      ownerInstanceId: typeof owner.instanceId === 'string' ? owner.instanceId : null,
      acquiredAt: typeof owner.acquiredAt === 'string' ? owner.acquiredAt : null
    };
  }

  getDiagnosticState(sessionId) {
    if (!validId(sessionId))
      throw new EditorSessionError('invalid_session_id', 'A valid session ID is required.');
    const state = this.load().get(sessionId);
    if (!state)
      return { revision: null, preview: { status: 'missing', revision: null, rendererId: null, width: null, height: null, sha256: null, confirmedBy: null } };
    const preview = snapshot(state).preview;
    return { revision: state.revision, preview: { ...preview, confirmedBy: preview.confirmedBy ?? null } };
  }

  requireSession(sessionId) {
    if (!validId(sessionId) || !this.sessions.has(sessionId))
      throw new EditorSessionError('session_not_found', 'Editor session not found. Open Portrait Studio or choose a listed local session.');
    return this.sessions.get(sessionId);
  }

  requireRevision(state, expectedRevision) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
      throw new EditorSessionError('invalid_revision', 'expectedRevision must be a non-negative integer from the latest editor state.');
    if (expectedRevision !== state.revision)
      return snapshot(state, 'conflict', [{ code: 'revision_conflict', message: 'The editor changed after this command was prepared. Read the latest state and retry.' }]);
    return null;
  }

  requireSource(state) {
    if (!state.source)
      throw new EditorSessionError('source_required', 'Choose a JPEG or PNG in the editor before applying edits.');
  }

  create() {
    const sessionId = this.id();
    if (!validId(sessionId) || this.sessions.has(sessionId))
      throw new Error('Could not create a unique editor session.');
    const state = initialSession(sessionId, this.now);
    this.sessions.set(sessionId, state);
    while (this.sessions.size > maxSessions) {
      const oldest = [...this.sessions.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
      this.sessions.delete(oldest.sessionId);
    }
    this.persist();
    return snapshot(state);
  }

  getState(sessionId) {
    return snapshot(this.requireSession(sessionId));
  }

  resume(sessionId) {
    const state = this.requireSession(sessionId);
    state.updatedAt = this.now();
    this.persist();
    return snapshot(state);
  }

  list() {
    return [...this.sessions.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((state) => ({
        sessionId: state.sessionId,
        updatedAt: state.updatedAt,
        revision: state.revision,
        source: clone(state.source),
        previewStatus: state.preview?.revision === state.revision ? 'confirmed' : state.source ? 'pending' : 'awaiting_source',
        exportStatus: state.export?.revision === state.revision ? 'saved' : state.export ? 'stale' : 'none'
      }));
  }

  bindSource(sessionId, expectedRevision, sourceInput) {
    const state = this.requireSession(sessionId);
    const conflict = this.requireRevision(state, expectedRevision);
    if (conflict)
      return conflict;
    const source = normalizeSource(sourceInput);
    if (state.source) {
      if (state.source.sha256 !== source.sha256 || state.source.width !== source.width || state.source.height !== source.height)
        throw new EditorSessionError('source_mismatch', 'This session is bound to a different source image. Open a new editor session to edit another image.');
      return snapshot(state, 'unchanged');
    }
    state.source = source;
    state.revision++;
    state.updatedAt = this.now();
    state.preview = null;
    this.persist();
    return snapshot(state);
  }

  recordMutation(state, changes) {
    const next = { ...editState(state), ...clone(changes) };
    state.adjustments = next.adjustments;
    state.preset = next.preset;
    state.crop = next.crop;
    state.history = state.history.slice(0, state.historyIndex + 1);
    state.history.push(editState(state));
    if (state.history.length > maxHistory) {
      state.history.shift();
    }
    state.historyIndex = state.history.length - 1;
    state.revision++;
    state.updatedAt = this.now();
    state.preview = null;
    this.persist();
    return snapshot(state);
  }

  setColorAdjustments(sessionId, expectedRevision, patch) {
    const state = this.requireSession(sessionId);
    const conflict = this.requireRevision(state, expectedRevision);
    if (conflict)
      return conflict;
    this.requireSource(state);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length)
      throw new EditorSessionError('invalid_adjustments', 'Provide at least one color adjustment.');
    const adjustments = Engine.normalizeAdjustments(patch, state.adjustments);
    if (JSON.stringify(adjustments) === JSON.stringify(state.adjustments) && state.preset === null)
      return snapshot(state, 'unchanged');
    return this.recordMutation(state, { adjustments, preset: null });
  }

  applyColorPreset(sessionId, expectedRevision, name, intensity) {
    const state = this.requireSession(sessionId);
    const conflict = this.requireRevision(state, expectedRevision);
    if (conflict)
      return conflict;
    this.requireSource(state);
    const adjustments = Engine.presetAdjustments(name, intensity);
    const preset = { name, intensity: Number(Number(intensity).toFixed(1)) };
    if (JSON.stringify(adjustments) === JSON.stringify(state.adjustments) && JSON.stringify(preset) === JSON.stringify(state.preset))
      return snapshot(state, 'unchanged');
    return this.recordMutation(state, { adjustments, preset });
  }

  setCrop(sessionId, expectedRevision, cropPatch) {
    const state = this.requireSession(sessionId);
    const conflict = this.requireRevision(state, expectedRevision);
    if (conflict)
      return conflict;
    this.requireSource(state);
    const allowed = new Set(['x', 'y', 'width', 'height', 'aspectRatio']);
    if (!cropPatch || typeof cropPatch !== 'object' || Array.isArray(cropPatch) || !Object.keys(cropPatch).length ||
        Object.keys(cropPatch).some((key) => !allowed.has(key)))
      throw new EditorSessionError('invalid_crop', 'Provide crop coordinates or an aspect ratio.');
    const crop = Engine.normalizeCrop({ ...state.crop, ...cropPatch }, state.source.width, state.source.height);
    if (JSON.stringify(crop) === JSON.stringify(state.crop))
      return snapshot(state, 'unchanged');
    return this.recordMutation(state, { crop });
  }

  resetAdjustments(sessionId, expectedRevision, fields = ['color']) {
    const state = this.requireSession(sessionId);
    const conflict = this.requireRevision(state, expectedRevision);
    if (conflict)
      return conflict;
    this.requireSource(state);
    if (!Array.isArray(fields) || !fields.length)
      throw new EditorSessionError('invalid_reset_fields', 'Choose at least one reset field.');
    const allowed = new Set(['color', 'crop', ...adjustmentKeys]);
    if (fields.some((field) => !allowed.has(field)))
      throw new EditorSessionError('invalid_reset_fields', 'Reset fields must be color, crop, or a named adjustment.');
    const resetColor = fields.includes('color');
    const resetCrop = fields.includes('crop');
    const resetFields = resetColor ? adjustmentKeys : fields.filter((field) => adjustmentKeys.includes(field));
    const adjustments = resetFields.length
      ? Engine.normalizeAdjustments(Object.fromEntries(resetFields.map((key) => [key, 0])), state.adjustments)
      : state.adjustments;
    const crop = resetCrop
      ? { x: 0, y: 0, width: 100, height: 100, aspectRatio: 'free' }
      : state.crop;
    const preset = resetFields.length ? null : state.preset;
    if (JSON.stringify(adjustments) === JSON.stringify(state.adjustments) && JSON.stringify(crop) === JSON.stringify(state.crop) && preset === state.preset)
      return snapshot(state, 'unchanged');
    return this.recordMutation(state, { adjustments, crop, preset });
  }

  navigateHistory(sessionId, expectedRevision, direction) {
    const state = this.requireSession(sessionId);
    const conflict = this.requireRevision(state, expectedRevision);
    if (conflict)
      return conflict;
    this.requireSource(state);
    const nextIndex = state.historyIndex + direction;
    if (nextIndex < 0 || nextIndex >= state.history.length)
      return snapshot(state, 'unchanged');
    state.historyIndex = nextIndex;
    const edit = state.history[nextIndex];
    state.adjustments = clone(edit.adjustments);
    state.preset = clone(edit.preset);
    state.crop = clone(edit.crop);
    state.revision++;
    state.updatedAt = this.now();
    state.preview = null;
    this.persist();
    return snapshot(state);
  }

  undo(sessionId, expectedRevision) {
    return this.navigateHistory(sessionId, expectedRevision, -1);
  }

  redo(sessionId, expectedRevision) {
    return this.navigateHistory(sessionId, expectedRevision, 1);
  }

  confirmPreview(sessionId, expectedRevision, rendererId, sourceSha256, width, height, sha256, confirmedBy = null) {
    const state = this.requireSession(sessionId);
    const conflict = this.requireRevision(state, expectedRevision);
    if (conflict)
      return conflict;
    this.requireSource(state);
    if (!validId(rendererId) || sourceSha256 !== state.source.sha256 || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || !hashPattern.test(sha256))
      throw new EditorSessionError('invalid_preview', 'Preview acknowledgement is invalid or does not match the selected source.');
    const crop = Engine.cropPixels(state.source.width, state.source.height, state.crop);
    const scale = Math.min(1, Engine.MAX_PREVIEW_EDGE / Math.max(crop.width, crop.height));
    const expectedWidth = Math.max(1, Math.round(crop.width * scale));
    const expectedHeight = Math.max(1, Math.round(crop.height * scale));
    if (width !== expectedWidth || height !== expectedHeight)
      throw new EditorSessionError('invalid_preview_dimensions', 'Preview dimensions do not match the current crop.');
    state.preview = { revision: state.revision, rendererId, width, height, sha256: sha256.toLowerCase(), confirmedBy: clone(confirmedBy) };
    this.persist();
    return snapshot(state);
  }

  prepareExport(sessionId, expectedRevision, rendererId, width, height) {
    const state = this.requireSession(sessionId);
    if (expectedRevision !== state.revision)
      throw new EditorSessionError('revision_conflict', 'The edit changed before export. Render the latest revision and try again.');
    this.requireSource(state);
    if (!validId(rendererId) || state.preview?.rendererId !== rendererId || state.preview.revision !== state.revision)
      throw new EditorSessionError('preview_not_confirmed', 'The current edit preview has not been confirmed by the renderer.');
    const crop = Engine.cropPixels(state.source.width, state.source.height, state.crop);
    if (width !== crop.width || height !== crop.height)
      throw new EditorSessionError('export_dimensions_mismatch', 'Export dimensions must match the current crop at native pixel size.');
    return { sessionId, revision: state.revision, width: crop.width, height: crop.height };
  }

  recordExport(sessionId, expectedRevision, rendererId, exported) {
    this.prepareExport(sessionId, expectedRevision, rendererId, exported.width, exported.height);
    const state = this.requireSession(sessionId);
    state.export = { revision: state.revision, ...clone(exported) };
    state.updatedAt = this.now();
    this.persist();
    return snapshot(state);
  }

  static get adjustmentKeys() {
    return [...adjustmentKeys];
  }
}

