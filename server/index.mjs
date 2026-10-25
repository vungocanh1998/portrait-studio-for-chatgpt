import { readFileSync } from 'node:fs';
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync as readBinaryFileSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { dirname, resolve, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import readline from 'node:readline';
import { EditorSessions } from './editor-state.mjs';

const protocolVersion = '2025-11-25';
const resourceUri = 'ui://portrait-studio-for-chatgpt/studio-chat-control.html';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pluginManifest = JSON.parse(readFileSync(resolve(root, 'plugin.json'), 'utf8'));
const serverVersion = pluginManifest.version;
const instanceId = randomUUID();
const buildHash = createHash('sha256');
for (const file of ['plugin.json', '.codex-plugin/plugin.json', 'server/editor-state.mjs', 'server/index.mjs', 'ui/engine.js', 'ui/studio.html'])
  buildHash.update(file + '\0').update(readFileSync(resolve(root, file))).update('\0');
const sourceBuildHash = buildHash.digest('hex');
const executablePath = resolve(process.execPath);
const scriptPath = resolve(process.argv[1] || 'server/index.mjs');
const localAppData = process.env.LOCALAPPDATA || homedir();
const standardLocalAppData = resolve(homedir(), 'AppData', 'Local');
const packageRoot = resolve(standardLocalAppData, 'Packages').toLowerCase();
const resolvedLocalAppData = resolve(localAppData).toLowerCase();
const isPackagedWindowsApp = process.platform === 'win32' &&
  (resolvedLocalAppData === packageRoot || resolvedLocalAppData.startsWith(packageRoot + sep));
// A packaged Desktop sandbox and the plain local MCP process must share one path before atomic renames.
const dataRoot = process.env.PORTRAIT_STUDIO_DATA_DIR || resolve(
  isPackagedWindowsApp ? standardLocalAppData : localAppData,
  '.portrait-studio-for-chatgpt'
);
const sessions = new EditorSessions({ filePath: join(dataRoot, 'sessions.json'), instanceId });
const confirmationEvents = [];
const template = readFileSync(resolve(root, 'ui/studio.html'), 'utf8');
const engine = readFileSync(resolve(root, 'ui/engine.js'), 'utf8');
const marker = '<!-- PORTRAIT_STUDIO_ENGINE -->';
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const maxExportBytes = 256 * 1024 * 1024;
const maxPixels = 80_000_000;
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++)
    crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  return crc >>> 0;
});

if (!template.includes(marker)) {
  process.stderr.write('Portrait Studio UI template is invalid.\n');
  process.exit(1);
}

const studioHtml = template.replace(marker, engine);

function stateOutputSchema() {
  const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] };
  const nullableInteger = { anyOf: [{ type: 'integer' }, { type: 'null' }] };
  const confirmedBy = { type: 'object', properties: {
    serverVersion: { type: 'string' }, sourceBuildHash: { type: 'string' }, pid: { type: 'integer' }, instanceId: { type: 'string' },
    executablePath: { type: 'string' }, scriptPath: { type: 'string' }, pluginRoot: { type: 'string' }, sessionStorePath: { type: 'string' }, confirmedAt: { type: 'string' }
  }, required: ['serverVersion', 'sourceBuildHash', 'pid', 'instanceId', 'executablePath', 'scriptPath', 'pluginRoot', 'sessionStorePath', 'confirmedAt'], additionalProperties: false };
  return {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      status: { type: 'string', enum: ['ok', 'unchanged', 'conflict', 'error'] },
      sessionId: { type: 'string' },
      revision: { type: 'integer' },
      source: { anyOf: [
        { type: 'object', properties: {
          fileName: { type: 'string' }, mimeType: { type: 'string', enum: ['image/jpeg', 'image/png'] },
          width: { type: 'integer' }, height: { type: 'integer' }, byteSize: { type: 'integer' }, sha256: { type: 'string' }
        }, required: ['fileName', 'mimeType', 'width', 'height', 'byteSize', 'sha256'], additionalProperties: false },
        { type: 'null' }
      ] },
      adjustments: { type: 'object', properties: {
        exposureEV: { type: 'number', minimum: -5, maximum: 5 },
        contrast: { type: 'number', minimum: -100, maximum: 100 }, highlights: { type: 'number', minimum: -100, maximum: 100 },
        shadows: { type: 'number', minimum: -100, maximum: 100 }, temperature: { type: 'number', minimum: -100, maximum: 100 },
        tint: { type: 'number', minimum: -100, maximum: 100 }, vibrance: { type: 'number', minimum: -100, maximum: 100 },
        saturation: { type: 'number', minimum: -100, maximum: 100 }
      }, required: EditorSessions.adjustmentKeys, additionalProperties: false },
      preset: { anyOf: [
        { type: 'object', properties: { name: { type: 'string', enum: ['natural', 'warm', 'cool', 'monochrome'] }, intensity: { type: 'number', minimum: 0, maximum: 100 } }, required: ['name', 'intensity'], additionalProperties: false },
        { type: 'null' }
      ] },
      crop: { type: 'object', properties: {
        x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' },
        aspectRatio: { type: 'string', enum: ['free', '1:1', '4:5', '5:4', '3:2', '2:3', '16:9', '9:16', '3:4', '4:3'] }
      }, required: ['x', 'y', 'width', 'height', 'aspectRatio'], additionalProperties: false },
      history: { type: 'object', properties: { canUndo: { type: 'boolean' }, canRedo: { type: 'boolean' } }, required: ['canUndo', 'canRedo'], additionalProperties: false },
      preview: { type: 'object', properties: {
        status: { type: 'string', enum: ['awaiting_source', 'pending', 'confirmed'] }, revision: nullableInteger,
        rendererId: nullableString, width: nullableInteger, height: nullableInteger, sha256: nullableString,
        confirmedBy: { anyOf: [confirmedBy, { type: 'null' }] }
      }, required: ['status', 'revision', 'rendererId', 'width', 'height', 'sha256'], additionalProperties: false },
      export: { type: 'object', properties: {
        status: { type: 'string', enum: ['none', 'saved', 'stale'] }, revision: nullableInteger, path: nullableString,
        fileName: nullableString, width: nullableInteger, height: nullableInteger, bytes: nullableInteger,
        sha256: nullableString, pixelSha256: nullableString
      }, required: ['status', 'revision', 'path', 'fileName', 'width', 'height', 'bytes', 'sha256', 'pixelSha256'], additionalProperties: false },
      warnings: { type: 'array', items: { type: 'string' } },
      errors: { type: 'array', items: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' } }, required: ['code', 'message'], additionalProperties: false } }
    },
    required: ['ok', 'status', 'sessionId', 'revision', 'source', 'adjustments', 'preset', 'crop', 'history', 'preview', 'export', 'warnings', 'errors'],
    additionalProperties: false
  };
}

function runtimeDiagnosticsOutputSchema() {
  const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] };
  const nullableInteger = { anyOf: [{ type: 'integer' }, { type: 'null' }] };
  const confirmedBy = { type: 'object', properties: {
    serverVersion: { type: 'string' }, sourceBuildHash: { type: 'string' }, pid: { type: 'integer' }, instanceId: { type: 'string' },
    executablePath: { type: 'string' }, scriptPath: { type: 'string' }, pluginRoot: { type: 'string' }, sessionStorePath: { type: 'string' }, confirmedAt: { type: 'string' }
  }, required: ['serverVersion', 'sourceBuildHash', 'pid', 'instanceId', 'executablePath', 'scriptPath', 'pluginRoot', 'sessionStorePath', 'confirmedAt'], additionalProperties: false };
  return { type: 'object', properties: {
    serverVersion: { type: 'string' }, sourceBuildHash: { type: 'string' }, pid: { type: 'integer' }, instanceId: { type: 'string' },
    executablePath: { type: 'string' }, scriptPath: { type: 'string' }, pluginRoot: { type: 'string' }, sessionStorePath: { type: 'string' },
    writeDurability: { type: 'object', properties: {
      strategy: { type: 'string', enum: ['fsync-temp-file-then-atomic-replace'] },
      lastPersist: { anyOf: [{ type: 'object', properties: {
        fileFsyncBeforeRename: { type: 'boolean' }, directoryFsyncAfterRename: { type: 'boolean' }
      }, required: ['fileFsyncBeforeRename', 'directoryFsyncAfterRename'], additionalProperties: false }, { type: 'null' }] }
    }, required: ['strategy', 'lastPersist'], additionalProperties: false },
    storeLock: { type: 'object', properties: {
      status: { type: 'string', enum: ['disabled', 'absent', 'active', 'orphaned', 'initializing', 'unreadable', 'unknown'] },
      ownerPid: nullableInteger, ownerInstanceId: nullableString, acquiredAt: nullableString
    }, required: ['status', 'ownerPid', 'ownerInstanceId', 'acquiredAt'], additionalProperties: false },
    session: { type: 'object', properties: {
      revision: nullableInteger,
      preview: { type: 'object', properties: {
        status: { type: 'string', enum: ['awaiting_source', 'pending', 'confirmed', 'missing'] }, revision: nullableInteger,
        rendererId: nullableString, width: nullableInteger, height: nullableInteger, sha256: nullableString,
        confirmedBy: { anyOf: [confirmedBy, { type: 'null' }] }
      }, required: ['status', 'revision', 'rendererId', 'width', 'height', 'sha256', 'confirmedBy'], additionalProperties: false }
    }, required: ['revision', 'preview'], additionalProperties: false },
    confirmationEvents: { type: 'array', items: { type: 'object', properties: {
      timestamp: { type: 'string' }, sessionId: { type: 'string' }, expectedRevision: nullableInteger, rendererId: nullableString,
      result: { type: 'string', enum: ['attempted', 'confirmed', 'conflict', 'error'] }, previewRevision: nullableInteger,
      errorCode: nullableString, pid: { type: 'integer' }, instanceId: { type: 'string' }, sourceBuildHash: { type: 'string' }, sessionStorePath: { type: 'string' }
    }, required: ['timestamp', 'sessionId', 'expectedRevision', 'rendererId', 'result', 'previewRevision', 'errorCode', 'pid', 'instanceId', 'sourceBuildHash', 'sessionStorePath'], additionalProperties: false } }
  }, required: ['serverVersion', 'sourceBuildHash', 'pid', 'instanceId', 'executablePath', 'scriptPath', 'pluginRoot', 'sessionStorePath', 'writeDurability', 'storeLock', 'session', 'confirmationEvents'], additionalProperties: false };
}

function toolDefinition(name, title, description, properties, required, outputSchema, options = {}) {
  const visibility = options.visibility || ['model', 'app'];
  return {
    name,
    title,
    description,
    inputSchema: { type: 'object', properties, required, additionalProperties: false },
    outputSchema,
    annotations: { readOnlyHint: !!options.readOnly, destructiveHint: false, openWorldHint: false, idempotentHint: !!options.idempotent },
    _meta: { ui: { ...(options.render ? { resourceUri } : {}), visibility } }
  };
}

// Keep the widget resource on the explicit open action; data-tool templates can remount the iframe and lose browser-only pixels.
function toolDefinitions() {
  const session = { type: 'string', minLength: 36, maxLength: 36, description: 'Exact Portrait Studio session ID.' };
  const revision = { type: 'integer', minimum: 0, description: 'Latest revision from get_editor_state or the last successful tool result.' };
  const numeric = (minimum, maximum) => ({ type: 'number', minimum, maximum });
  const state = stateOutputSchema();
  return [
    toolDefinition('open_portrait_studio', 'Open Portrait Studio', 'Open the editor and create a local edit session. Pass sessionId only to resume a listed session. A resumed UI must reselect and verify the exact source before preview confirmation. The user selects the source image in the UI; source image bytes never enter ChatGPT.', { sessionId: session }, [], state, { render: true }),
    toolDefinition('list_editor_sessions', 'List local editor sessions', 'List recent local session metadata so the user can resume a specific image. This returns filenames, dimensions, hashes, revisions and export status only; it contains no image bytes. If more than one session exists, ask which one to resume.', {}, [], { type: 'object', properties: { sessions: { type: 'array', items: { type: 'object', properties: {
      sessionId: { type: 'string' }, updatedAt: { type: 'string' }, revision: { type: 'integer' }, source: { anyOf: [state.properties.source.anyOf[0], { type: 'null' }] },
      previewStatus: { type: 'string', enum: ['awaiting_source', 'pending', 'confirmed'] }, exportStatus: { type: 'string', enum: ['none', 'saved', 'stale'] }
    }, required: ['sessionId', 'updatedAt', 'revision', 'source', 'previewStatus', 'exportStatus'], additionalProperties: false } } }, required: ['sessions'], additionalProperties: false }, { readOnly: true }),
    toolDefinition('get_editor_state', 'Get editor state', 'Read the authoritative state for this exact session. The editor’s Sync from Chat action uses this tool to reconcile its active renderer. Returns source metadata and native dimensions, adjustment values, crop, history, preview confirmation, export status, and revision.', { sessionId: session }, ['sessionId'], state, { readOnly: true }),
    toolDefinition('set_color_adjustments', 'Set color adjustments', 'Set explicit deterministic color values on the selected session. Inspect get_editor_state first and pass its sessionId and latest revision. exposureEV is an absolute value in stops (-5 to +5); contrast, highlights, shadows, temperature, tint, vibrance, and saturation are absolute values from -100 to +100. For a spoken change such as “increase by 0.3 EV” or “reduce highlights by 20%”, add that delta to the inspected value and clamp to the documented range. Positive temperature warms; positive tint shifts magenta; negative tint shifts green. These are global pixel adjustments: they preserve geometry and existing texture, but do not mask skin. The tool only records parameters; do not report an edit as complete until get_editor_state confirms the latest revision preview.', { sessionId: session, expectedRevision: revision, adjustments: { type: 'object', properties: {
      exposureEV: numeric(-5, 5), contrast: numeric(-100, 100), highlights: numeric(-100, 100), shadows: numeric(-100, 100), temperature: numeric(-100, 100),
      tint: numeric(-100, 100), vibrance: numeric(-100, 100), saturation: numeric(-100, 100)
    }, minProperties: 1, additionalProperties: false } }, ['sessionId', 'expectedRevision', 'adjustments'], state),
    toolDefinition('apply_color_preset', 'Apply color preset', 'Apply one deterministic preset at the requested intensity (0 to 100). It replaces current color values and leaves crop unchanged. Inspect current state and use its revision first. Tool acceptance is not completion; verify the preview revision with get_editor_state.', { sessionId: session, expectedRevision: revision, preset: { type: 'string', enum: ['natural', 'warm', 'cool', 'monochrome'] }, intensity: numeric(0, 100) }, ['sessionId', 'expectedRevision', 'preset', 'intensity'], state),
    toolDefinition('set_crop', 'Set crop', 'Set crop coordinates as percentages of the source and/or choose a standard aspect ratio (free, 1:1, 4:5, 5:4, 3:2, 2:3, 16:9, 9:16, 3:4, 4:3). A ratio-only request keeps the current crop center and fits the selected ratio without resampling. Inspect the session and revision first, then verify the preview revision before saying it completed.', { sessionId: session, expectedRevision: revision, crop: { type: 'object', properties: {
      x: numeric(0, 100), y: numeric(0, 100), width: numeric(0, 100), height: numeric(0, 100), aspectRatio: { type: 'string', enum: ['free', '1:1', '4:5', '5:4', '3:2', '2:3', '16:9', '9:16', '3:4', '4:3'] }
    }, minProperties: 1, additionalProperties: false } }, ['sessionId', 'expectedRevision', 'crop'], state),
    toolDefinition('undo_edit', 'Undo edit', 'Undo the most recent color or crop edit in this exact session. Use the latest revision returned by get_editor_state or the prior action.', { sessionId: session, expectedRevision: revision }, ['sessionId', 'expectedRevision'], state),
    toolDefinition('redo_edit', 'Redo edit', 'Redo the next color or crop edit in this exact session. Use the latest revision returned by get_editor_state or the prior action.', { sessionId: session, expectedRevision: revision }, ['sessionId', 'expectedRevision'], state),
    toolDefinition('reset_adjustments', 'Reset selected adjustments', 'Reset only the selected adjustment fields. Omit fields or pass ["color"] to reset all color settings while retaining crop; pass ["crop"] only when crop should reset. Source pixels are never changed.', { sessionId: session, expectedRevision: revision, fields: { type: 'array', uniqueItems: true, items: { type: 'string', enum: ['color', 'crop', ...EditorSessions.adjustmentKeys] } } }, ['sessionId', 'expectedRevision'], state),
    toolDefinition('get_export_status', 'Get export status', 'Check whether the latest revision has a verified local PNG export. This reports local file metadata and pixel SHA-256; it does not upload the file.', { sessionId: session }, ['sessionId'], state, { readOnly: true }),
    toolDefinition('get_runtime_diagnostics', 'Get local runtime diagnostics', 'Read the active MCP executable, source build, process instance, canonical session-store path, lock owner, latest session preview metadata, and recent renderer confirmation attempts. Returns no source image bytes or source file contents.', { sessionId: session }, ['sessionId'], runtimeDiagnosticsOutputSchema(), { readOnly: true, idempotent: true }),
    toolDefinition('set_active_image', 'Register active source metadata', 'Internal UI action. Registers only the selected source filename, MIME type, dimensions, byte size, and SHA-256 with the local server. It never accepts or transfers image bytes.', { sessionId: session, expectedRevision: revision, source: { type: 'object', properties: {
      fileName: { type: 'string', maxLength: 240 }, mimeType: { type: 'string', enum: ['image/jpeg', 'image/png'] }, width: { type: 'integer', minimum: 1, maximum: maxPixels },
      height: { type: 'integer', minimum: 1, maximum: maxPixels }, byteSize: { type: 'integer', minimum: 1, maximum: 60 * 1024 * 1024 }, sha256: { type: 'string', minLength: 64, maxLength: 64 }
    }, required: ['fileName', 'mimeType', 'width', 'height', 'byteSize', 'sha256'], additionalProperties: false } }, ['sessionId', 'expectedRevision', 'source'], state, { visibility: ['app'], idempotent: true }),
    toolDefinition('confirm_preview', 'Confirm rendered preview', 'Internal UI action. Confirms that this renderer produced the After preview for the current source and revision.', { sessionId: session, expectedRevision: revision, rendererId: session, sourceSha256: { type: 'string', minLength: 64, maxLength: 64 }, width: { type: 'integer', minimum: 1 }, height: { type: 'integer', minimum: 1 }, sha256: { type: 'string', minLength: 64, maxLength: 64 } }, ['sessionId', 'expectedRevision', 'rendererId', 'sourceSha256', 'width', 'height', 'sha256'], state, { visibility: ['app'], idempotent: true }),
    toolDefinition('save_edited_png', 'Save edited PNG locally', 'Internal UI action called only after the user presses Save edited PNG. Writes a new file in Downloads, never overwrites, and verifies that the saved PNG can be decoded and that its bytes and pixels match. Receives only the finished edited PNG; source and reference images are never sent.', { baseName: { type: 'string', maxLength: 200 }, width: { type: 'integer', minimum: 1, maximum: maxPixels }, height: { type: 'integer', minimum: 1, maximum: maxPixels }, pngBase64: { type: 'string', maxLength: Math.ceil(maxExportBytes / 3) * 4 }, sessionId: session, revision, rendererId: session }, ['baseName', 'width', 'height', 'pngBase64'], { type: 'object', properties: {
      saved: { type: 'boolean' }, path: { type: 'string' }, fileName: { type: 'string' }, width: { type: 'integer' }, height: { type: 'integer' }, bytes: { type: 'integer' }, sha256: { type: 'string' }, pixelSha256: { type: 'string' }, sessionId: { type: 'string' }, revision: { type: 'integer' }, exportStatus: { type: 'string' }, warning: { type: 'string' }
    }, required: ['saved', 'path', 'fileName', 'width', 'height', 'bytes', 'sha256', 'pixelSha256'], additionalProperties: false }, { visibility: ['app'] })
  ];
}

function errorSnapshot(sessionId, error) {
  const id = typeof sessionId === 'string' ? sessionId : '';
  try {
    const current = sessions.getState(id);
    return {
      ...current,
      ok: false,
      status: 'error',
      errors: [{ code: error.code || 'invalid_request', message: error instanceof Error ? error.message : 'Portrait Studio action failed.' }]
    };
  } catch {
    return {
      ok: false,
      status: 'error',
      sessionId: id,
      revision: -1,
      source: null,
      adjustments: { exposureEV: 0, contrast: 0, highlights: 0, shadows: 0, temperature: 0, tint: 0, vibrance: 0, saturation: 0 },
      preset: null,
      crop: { x: 0, y: 0, width: 100, height: 100, aspectRatio: 'free' },
      history: { canUndo: false, canRedo: false },
      preview: { status: 'awaiting_source', revision: null, rendererId: null, width: null, height: null, sha256: null },
      export: { status: 'none', revision: null, path: null, fileName: null, width: null, height: null, bytes: null, sha256: null, pixelSha256: null },
      warnings: [],
      errors: [{ code: error.code || 'invalid_request', message: error instanceof Error ? error.message : 'Portrait Studio action failed.' }]
    };
  }
}

function stateText(state) {
  return `Portrait Studio session ${state.sessionId}, revision ${state.revision}; preview ${state.preview.status}; export ${state.export.status}.`;
}

function runtimeIdentity() {
  return {
    serverVersion,
    sourceBuildHash,
    pid: process.pid,
    instanceId,
    executablePath,
    scriptPath,
    pluginRoot: root,
    sessionStorePath: sessions.filePath
  };
}

function runtimeConfirmation() {
  return { ...runtimeIdentity(), confirmedAt: new Date().toISOString() };
}

function recordConfirmationAttempt(args) {
  const event = {
    timestamp: new Date().toISOString(),
    sessionId: typeof args.sessionId === 'string' ? args.sessionId.slice(0, 36) : '',
    expectedRevision: Number.isSafeInteger(args.expectedRevision) ? args.expectedRevision : null,
    rendererId: typeof args.rendererId === 'string' ? args.rendererId.slice(0, 64) : null,
    result: 'attempted',
    previewRevision: null,
    errorCode: null,
    pid: process.pid,
    instanceId,
    sourceBuildHash,
    sessionStorePath: sessions.filePath
  };
  confirmationEvents.push(event);
  if (confirmationEvents.length > 100)
    confirmationEvents.shift();
  return event;
}

function runtimeDiagnostics(sessionId) {
  return {
    ...runtimeIdentity(),
    writeDurability: {
      strategy: 'fsync-temp-file-then-atomic-replace',
      lastPersist: sessions.lastWriteDurability
    },
    storeLock: sessions.inspectStoreLock(),
    session: sessions.getDiagnosticState(sessionId),
    confirmationEvents: confirmationEvents.filter((event) => event.sessionId === sessionId).slice(-20)
  };
}

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function fail(id, code, message) {
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: { code, message }
  }) + '\n');
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes)
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function validatePng(bytes, expectedWidth, expectedHeight) {
  if (bytes.length < 57 || !bytes.subarray(0, 8).equals(pngSignature))
    throw new TypeError('The edited image is not a valid PNG.');

  let offset = 8;
  let dimensions;
  let idatStarted = false;
  let idatEnded = false;
  let ended = false;
  const idat = [];

  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length)
      throw new TypeError('The edited PNG is incomplete.');
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const payload = bytes.subarray(offset + 8, offset + 8 + length);
    const crc = bytes.readUInt32BE(offset + 8 + length);
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== crc)
      throw new TypeError('The edited PNG failed its integrity check.');

    if (!dimensions && type !== 'IHDR')
      throw new TypeError('The edited PNG has no valid header.');
    if (type === 'IHDR') {
      if (dimensions || length !== 13 || offset !== 8)
        throw new TypeError('The edited PNG has an invalid header.');
      const width = payload.readUInt32BE(0);
      const height = payload.readUInt32BE(4);
      const bitDepth = payload[8];
      const colorType = payload[9];
      if (!width || !height || width !== expectedWidth || height !== expectedHeight ||
          bitDepth !== 8 || (colorType !== 2 && colorType !== 6) ||
          payload[10] !== 0 || payload[11] !== 0 || payload[12] !== 0 ||
          width * height > maxPixels)
        throw new TypeError('The edited PNG dimensions or format do not match the export.');
      dimensions = { width, height, channels: colorType === 6 ? 4 : 3 };
    } else if (type === 'IDAT') {
      if (idatEnded)
        throw new TypeError('The edited PNG data is not contiguous.');
      idatStarted = true;
      idat.push(payload);
    } else if (type === 'IEND') {
      if (length !== 0 || !idatStarted)
        throw new TypeError('The edited PNG is incomplete.');
      ended = true;
      offset = end;
      break;
    } else if (idatStarted) {
      idatEnded = true;
    }
    offset = end;
  }

  if (!ended || offset !== bytes.length || !dimensions)
    throw new TypeError('The edited PNG is incomplete.');
  const rowBytes = dimensions.width * dimensions.channels;
  const expectedDecodedBytes = (rowBytes + 1) * dimensions.height;
  let decoded;
  try {
    decoded = inflateSync(Buffer.concat(idat), { maxOutputLength: expectedDecodedBytes });
  } catch {
    throw new TypeError('The edited PNG pixel data could not be decoded.');
  }
  if (decoded.length !== expectedDecodedBytes)
    throw new TypeError('The edited PNG pixel data has an invalid size.');
  const pixelHash = createHash('sha256');
  let previous = Buffer.alloc(rowBytes);
  let current = Buffer.alloc(rowBytes);
  const rgbaRow = dimensions.channels === 4 ? current : Buffer.alloc(dimensions.width * 4);
  for (let row = 0; row < dimensions.height; row++) {
    const inputOffset = row * (rowBytes + 1);
    const filter = decoded[inputOffset];
    if (filter > 4)
      throw new TypeError('The edited PNG contains an invalid scanline.');
    for (let column = 0; column < rowBytes; column++) {
      const left = column >= dimensions.channels ? current[column - dimensions.channels] : 0;
      const above = row ? previous[column] : 0;
      const upperLeft = row && column >= dimensions.channels ? previous[column - dimensions.channels] : 0;
      const estimate = left + above - upperLeft;
      const paethLeft = Math.abs(estimate - left);
      const paethAbove = Math.abs(estimate - above);
      const paethUpperLeft = Math.abs(estimate - upperLeft);
      const predictor = filter === 1 ? left : filter === 2 ? above : filter === 3 ? Math.floor((left + above) / 2) :
        filter === 4 ? (paethLeft <= paethAbove && paethLeft <= paethUpperLeft ? left : paethAbove <= paethUpperLeft ? above : upperLeft) : 0;
      current[column] = (decoded[inputOffset + column + 1] + predictor) & 0xff;
    }
    if (dimensions.channels === 4) {
      pixelHash.update(current);
    } else {
      for (let x = 0, out = 0; x < dimensions.width; x++, out += 4) {
        rgbaRow[out] = current[x * 3];
        rgbaRow[out + 1] = current[x * 3 + 1];
        rgbaRow[out + 2] = current[x * 3 + 2];
        rgbaRow[out + 3] = 255;
      }
      pixelHash.update(rgbaRow);
    }
    [previous, current] = [current, previous];
  }
  return { ...dimensions, pixelSha256: pixelHash.digest('hex') };
}

function saveEditedPng(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args) ||
      Object.keys(args).some((key) => !['baseName', 'width', 'height', 'pngBase64', 'sessionId', 'revision', 'rendererId'].includes(key)) ||
      typeof args.baseName !== 'string' || args.baseName.length > 200 ||
      !Number.isSafeInteger(args.width) || !Number.isSafeInteger(args.height) ||
      args.width < 1 || args.height < 1 || args.width * args.height > maxPixels ||
      typeof args.pngBase64 !== 'string' || !args.pngBase64.length ||
      args.pngBase64.length > Math.ceil(maxExportBytes / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(args.pngBase64))
    throw new TypeError('The edited PNG export request is invalid or too large.');

  const sessionFields = ['sessionId', 'revision', 'rendererId'];
  const hasSessionFields = sessionFields.some((key) => Object.hasOwn(args, key));
  if (hasSessionFields && !sessionFields.every((key) => Object.hasOwn(args, key)))
    throw new TypeError('A session export must include sessionId, revision, and rendererId.');
  if (hasSessionFields)
    sessions.prepareExport(args.sessionId, args.revision, args.rendererId, args.width, args.height);

  const bytes = Buffer.from(args.pngBase64, 'base64');
  if (bytes.length > maxExportBytes || bytes.toString('base64') !== args.pngBase64)
    throw new TypeError('The edited PNG export request is invalid or too large.');
  const decoded = validatePng(bytes, args.width, args.height);

  const baseName = args.baseName.normalize('NFKC')
    .replace(/\.(?:png|jpe?g)$/i, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'portrait';
  const downloads = resolve(homedir(), 'Downloads');
  if (!existsSync(downloads))
    mkdirSync(downloads, { recursive: true });
  if (!statSync(downloads).isDirectory())
    throw new Error('The Downloads location is not available.');

  let outputPath;
  let descriptor;
  for (let suffix = 0; suffix < 10000; suffix++) {
    const fileName = `${baseName}-portrait-studio${suffix ? ` (${suffix})` : ''}.png`;
    outputPath = resolve(downloads, fileName);
    try {
      descriptor = openSync(outputPath, 'wx');
      break;
    } catch (error) {
      if (error.code !== 'EEXIST')
        throw error;
    }
  }
  if (descriptor === undefined)
    throw new Error('Could not find a new filename in Downloads.');

  try {
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
  } catch (error) {
    closeSync(descriptor);
    unlinkSync(outputPath);
    throw error;
  }
  closeSync(descriptor);

  const saved = readBinaryFileSync(outputPath);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  let savedPixels;
  try {
    savedPixels = validatePng(saved, args.width, args.height).pixelSha256;
  } catch (error) {
    unlinkSync(outputPath);
    throw error;
  }
  if (saved.length !== bytes.length || createHash('sha256').update(saved).digest('hex') !== sha256 || savedPixels !== decoded.pixelSha256) {
    unlinkSync(outputPath);
    throw new Error('The saved PNG did not match the exported bytes.');
  }

  const result = {
    saved: true,
    path: outputPath,
    fileName: outputPath.slice(downloads.length + 1),
    width: args.width,
    height: args.height,
    bytes: saved.length,
    sha256,
    pixelSha256: savedPixels
  };
  if (hasSessionFields) {
    result.sessionId = args.sessionId;
    result.revision = args.revision;
    try {
      sessions.recordExport(args.sessionId, args.revision, args.rendererId, {
        path: result.path,
        fileName: result.fileName,
        width: result.width,
        height: result.height,
        bytes: result.bytes,
        sha256: result.sha256,
        pixelSha256: result.pixelSha256
      });
      result.exportStatus = 'saved';
    } catch {
      result.exportStatus = 'not_persisted';
      result.warning = 'The PNG file was verified, but its session export status could not be persisted locally.';
    }
  }
  return result;
}

function handle(message) {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string')
    return;
  if (!Object.hasOwn(message, 'id'))
    return;

  const id = message.id;
  const params = message.params || {};

  switch (message.method) {
    case 'initialize':
      respond(id, {
        protocolVersion,
        capabilities: {
          resources: { listChanged: false },
          tools: { listChanged: false }
        },
        serverInfo: {
          name: 'portrait-studio-for-chatgpt',
          version: '0.2.7'
        },
        instructions: 'For portrait edit requests, use the existing Portrait Studio session. If no session is known in this conversation, call list_editor_sessions and resume the user-selected session, or call open_portrait_studio to create one. Inspect get_editor_state before each edit and pass its exact sessionId and expectedRevision. Translate natural-language deltas into explicit numeric values using the inspected current state; exposure is EV and other color settings are -100 to +100. Use set_crop, apply_color_preset, reset_adjustments, undo_edit, or redo_edit as requested. Treat an edit tool result as accepted parameters only: the preview is pending until the UI renderer confirms it. If the revision advances without confirmation, tell the user to press Sync from Chat in the editor; do not stack edits or save until the latest preview is confirmed. Global color changes do not selectively protect skin, and automatic face edits/healing are unsupported. Source and reference image bytes stay in the browser; the local MCP process persists only source metadata and edit history. A remounted editor asks the user to reselect the exact source, verified by SHA-256. The local plugin is available only in supported ChatGPT Desktop local threads; ordinary ChatGPT conversations require a separately deployed Remote MCP server, which this project has not deployed.'
      });
      return;
    case 'ping':
      respond(id, {});
      return;
    case 'tools/list':
      respond(id, { tools: toolDefinitions() });
      return;
    case 'resources/list':
      respond(id, {
        resources: [{
          uri: resourceUri,
          name: 'Portrait Studio editor',
          description: 'Local browser UI for deterministic portrait edits.',
          mimeType: 'text/html;profile=mcp-app'
        }]
      });
      return;
    case 'resources/read':
      if (params.uri !== resourceUri) {
        fail(id, -32602, 'Unknown resource URI.');
        return;
      }
      respond(id, {
        contents: [{
          uri: resourceUri,
          mimeType: 'text/html;profile=mcp-app',
          text: studioHtml
        }]
      });
      return;
    case 'tools/call':
      if (typeof params.name !== 'string' || (params.arguments !== undefined && (!params.arguments || typeof params.arguments !== 'object' || Array.isArray(params.arguments)))) {
        fail(id, -32602, 'Tool name and object arguments are required.');
        return;
      }
      if (!toolDefinitions().some((tool) => tool.name === params.name)) {
        fail(id, -32602, 'Unknown tool.');
        return;
      }
      const args = params.arguments || {};
      if (params.name === 'get_runtime_diagnostics') {
        try {
          if (Object.keys(args).some((key) => key !== 'sessionId'))
            throw new TypeError('get_runtime_diagnostics accepts only sessionId.');
          const result = runtimeDiagnostics(args.sessionId);
          respond(id, {
            structuredContent: result,
            content: [{ type: 'text', text: `Portrait Studio ${result.serverVersion}, PID ${result.pid}, instance ${result.instanceId}, build ${result.sourceBuildHash}; session revision ${result.session.revision ?? 'missing'}, preview ${result.session.preview.status}.` }]
          });
        } catch (error) {
          respond(id, { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : 'Runtime diagnostics failed.' }] });
        }
        return;
      }
      const confirmationEvent = params.name === 'confirm_preview' ? recordConfirmationAttempt(args) : null;
      try {
        const output = sessions.withStoreLock(() => {
          let result;
          let text;
          switch (params.name) {
          case 'open_portrait_studio':
            if (Object.keys(args).some((key) => key !== 'sessionId'))
              throw new TypeError('open_portrait_studio accepts only an optional sessionId.');
            result = args.sessionId ? sessions.resume(args.sessionId) : sessions.create();
            text = `Portrait Studio opened for session ${result.sessionId} at revision ${result.revision}. Select a JPEG or PNG in the UI; its bytes remain in the browser.`;
            break;
          case 'list_editor_sessions':
            if (Object.keys(args).length)
              throw new TypeError('list_editor_sessions takes no arguments.');
            result = { sessions: sessions.list() };
            text = `Found ${result.sessions.length} local Portrait Studio session${result.sessions.length === 1 ? '' : 's'}; no image bytes were read.`;
            break;
          case 'get_editor_state':
            result = sessions.getState(args.sessionId);
            text = stateText(result);
            break;
          case 'set_active_image':
            result = sessions.bindSource(args.sessionId, args.expectedRevision, args.source);
            text = `Source metadata registered for session ${result.sessionId}; image bytes remain in the browser. Renderer confirmation is still required.`;
            break;
          case 'set_color_adjustments':
            result = sessions.setColorAdjustments(args.sessionId, args.expectedRevision, args.adjustments);
            text = result.status === 'conflict'
              ? 'The edit was not applied because the revision is stale. Read the returned current state before retrying.'
              : `Color parameters accepted at revision ${result.revision}; preview status is ${result.preview.status}. Do not report completion until the latest preview is confirmed.`;
            break;
          case 'apply_color_preset':
            result = sessions.applyColorPreset(args.sessionId, args.expectedRevision, args.preset, args.intensity);
            text = result.status === 'conflict'
              ? 'The preset was not applied because the revision is stale. Read the returned current state before retrying.'
              : `Preset parameters accepted at revision ${result.revision}; preview status is ${result.preview.status}. Verify preview confirmation before reporting completion.`;
            break;
          case 'set_crop':
            result = sessions.setCrop(args.sessionId, args.expectedRevision, args.crop);
            text = result.status === 'conflict'
              ? 'The crop was not applied because the revision is stale. Read the returned current state before retrying.'
              : `Crop parameters accepted at revision ${result.revision}; preview status is ${result.preview.status}. Verify preview confirmation before reporting completion.`;
            break;
          case 'undo_edit':
            result = sessions.undo(args.sessionId, args.expectedRevision);
            text = `Undo state is ${result.status} at revision ${result.revision}; preview status is ${result.preview.status}.`;
            break;
          case 'redo_edit':
            result = sessions.redo(args.sessionId, args.expectedRevision);
            text = `Redo state is ${result.status} at revision ${result.revision}; preview status is ${result.preview.status}.`;
            break;
          case 'reset_adjustments':
            result = sessions.resetAdjustments(args.sessionId, args.expectedRevision, args.fields);
            text = `Selected settings reset at revision ${result.revision}; crop is ${result.crop.aspectRatio}.`;
            break;
          case 'get_export_status':
            result = sessions.getState(args.sessionId);
            text = `Export status for session ${result.sessionId} is ${result.export.status} at revision ${result.export.revision ?? 'none'}.`;
            break;
          case 'confirm_preview':
            result = sessions.confirmPreview(args.sessionId, args.expectedRevision, args.rendererId, args.sourceSha256, args.width, args.height, args.sha256, runtimeConfirmation());
            confirmationEvent.result = result.status === 'conflict'
              ? 'conflict'
              : result.preview.status === 'confirmed' && result.preview.revision === args.expectedRevision && result.preview.rendererId === args.rendererId
                ? 'confirmed'
                : 'error';
            confirmationEvent.previewRevision = result.preview.revision;
            text = result.status === 'conflict'
              ? 'Preview confirmation was stale and not accepted.'
              : `After preview confirmed for revision ${result.revision} by PID ${process.pid}, instance ${instanceId}.`;
            break;
          case 'save_edited_png': {
            const saved = saveEditedPng(args);
            result = saved;
            text = `Saved and verified edited PNG locally: ${saved.path} (${saved.width} × ${saved.height} px, ${saved.bytes} bytes, pixel SHA-256 ${saved.pixelSha256}).`;
            if (saved.warning)
              text += ' ' + saved.warning;
            break;
          }
          default:
            throw new TypeError('Unknown tool.');
          }
          return { result, text };
        });
        respond(id, {
          ...(output.result?.ok === false ? { isError: true } : {}),
          structuredContent: output.result,
          content: [{ type: 'text', text: output.text }]
        });
      } catch (error) {
        if (confirmationEvent && confirmationEvent.result === 'attempted') {
          confirmationEvent.result = 'error';
          confirmationEvent.errorCode = typeof error.code === 'string' ? error.code : 'invalid_request';
        }
        const messageText = error instanceof Error ? error.message : 'Portrait Studio action failed.';
        const structuredContent = params.name === 'save_edited_png'
          ? undefined
          : errorSnapshot(args.sessionId, error);
        respond(id, {
          isError: true,
          ...(structuredContent ? { structuredContent } : {}),
          content: [{ type: 'text', text: messageText }]
        });
      }
      return;
    default:
      fail(id, -32601, 'Method not found.');
  }
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  try {
    handle(JSON.parse(line));
  } catch {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error.' }
    }) + '\n');
  }
});


