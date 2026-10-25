import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, sep, dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const expectedBuildHash = createHash('sha256');
for (const file of ['plugin.json', '.codex-plugin/plugin.json', 'server/editor-state.mjs', 'server/index.mjs', 'ui/engine.js', 'ui/studio.html'])
  expectedBuildHash.update(file + '\0').update(readFileSync(resolve(root, file))).update('\0');
const expectedSourceBuildHash = expectedBuildHash.digest('hex');
const tempHome = mkdtempSync(join(root, '.mcp-contract-test-'));
const child = spawn(process.execPath, [resolve(root, 'server/index.mjs')], {
  cwd: root,
  env: { ...process.env, USERPROFILE: tempHome, HOME: tempHome, PORTRAIT_STUDIO_DATA_DIR: join(tempHome, 'local-data') },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true
});
const lines = createInterface({ input: child.stdout });
const pending = new Map();
let requestId = 0;

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++)
    crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
  return crc >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes)
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, payload) {
  const kind = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(payload.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([kind, payload])));
  return Buffer.concat([length, kind, payload, checksum]);
}

function syntheticPng(width, height, rgba = [100, 80, 60, 255]) {
  const pixels = Buffer.from(Array.from({ length: width }, () => rgba).flat());
  const rows = Buffer.alloc(height * (width * 4 + 1));
  for (let row = 0; row < height; row++)
    pixels.copy(rows, row * (width * 4 + 1) + 1);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(rows)),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

lines.on('line', (line) => {
  const response = JSON.parse(line);
  const waiter = pending.get(response.id);
  if (!waiter)
    return;
  clearTimeout(waiter.timeout);
  pending.delete(response.id);
  waiter.resolve(response);
});

function request(method, params = {}) {
  const id = ++requestId;
  return new Promise((resolveResponse, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error('MCP request timed out: ' + method));
    }, 3000);
    pending.set(id, { resolve: resolveResponse, timeout });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

try {
  const initialized = await request('initialize', { protocolVersion: '2025-11-25' });
  assert.equal(initialized.result.protocolVersion, '2025-11-25');
  assert.ok(initialized.result.capabilities.tools);
  assert.ok(initialized.result.capabilities.resources);
  assert.match(initialized.result.instructions, /expectedRevision/);
  assert.match(initialized.result.instructions, /image bytes stay in the browser/);

  const tools = await request('tools/list');
  const definitions = new Map(tools.result.tools.map((tool) => [tool.name, tool]));
  assert.deepEqual([...definitions.keys()], [
    'open_portrait_studio', 'list_editor_sessions', 'get_editor_state', 'set_color_adjustments',
    'apply_color_preset', 'set_crop', 'undo_edit', 'redo_edit', 'reset_adjustments',
    'get_export_status', 'get_runtime_diagnostics', 'set_active_image', 'confirm_preview', 'save_edited_png'
  ]);
  const uiUri = 'ui://portrait-studio-for-chatgpt/studio-chat-control.html';
  assert.equal(definitions.get('open_portrait_studio')._meta.ui.resourceUri, uiUri);
  for (const name of [
    'list_editor_sessions', 'get_editor_state', 'set_color_adjustments', 'apply_color_preset',
    'set_crop', 'undo_edit', 'redo_edit', 'reset_adjustments', 'get_export_status', 'get_runtime_diagnostics'
  ])
    assert.equal(definitions.get(name)._meta.ui.resourceUri, undefined, `${name} must not remount the editor widget`);
  assert.deepEqual(definitions.get('set_active_image')._meta.ui.visibility, ['app']);
  assert.deepEqual(definitions.get('confirm_preview')._meta.ui.visibility, ['app']);
  assert.deepEqual(definitions.get('save_edited_png')._meta.ui.visibility, ['app']);
  assert.equal(definitions.get('save_edited_png').annotations.readOnlyHint, false);
  assert.equal(definitions.get('get_runtime_diagnostics').annotations.readOnlyHint, true);
  assert.equal(definitions.get('set_color_adjustments').outputSchema.properties.revision.type, 'integer');
  assert.deepEqual(definitions.get('set_color_adjustments').inputSchema.required, ['sessionId', 'expectedRevision', 'adjustments']);
  assert.match(definitions.get('set_color_adjustments').description, /do not mask skin/);
  assert.equal(definitions.get('set_active_image').inputSchema.properties.source.properties.imageBytes, undefined);

  const resources = await request('resources/list');
  assert.equal(resources.result.resources[0].uri, uiUri);
  assert.equal(resources.result.resources[0].mimeType, 'text/html;profile=mcp-app');

  const ui = await request('resources/read', { uri: resources.result.resources[0].uri });
  assert.match(ui.result.contents[0].text, /Portrait Studio for ChatGPT/);
  assert.match(ui.result.contents[0].text, /uploadFile/);
  assert.match(ui.result.contents[0].text, /sendRequest\('ui\/initialize'/);
  assert.match(ui.result.contents[0].text, /callEditorTool\('confirm_preview'/);
  assert.match(ui.result.contents[0].text, /callEditorTool\('set_color_adjustments'/);
  assert.match(ui.result.contents[0].text, /id="sync-from-chat"/);
  assert.match(ui.result.contents[0].text, /Sync from Chat/);
  assert.match(ui.result.contents[0].text, /async function syncFromChat\(\)/);
  assert.match(ui.result.contents[0].text, /callEditorTool\('get_editor_state', \{ sessionId \}\)/);
  assert.match(ui.result.contents[0].text, /callEditorTool\('get_runtime_diagnostics', \{ sessionId \}\)/);
  assert.match(ui.result.contents[0].text, /runtime provenance could not be matched/);
  assert.match(ui.result.contents[0].text, /confirmation trace matched/);
  assert.match(ui.result.contents[0].text, /Synced from Chat at revision/);
  assert.match(ui.result.contents[0].text, /toolName !== 'open_portrait_studio'/, 'stale same-revision pending notifications must not downgrade a confirmed preview');
  assert.match(ui.result.contents[0].text, /activeRender\.previewSha256 === snapshot\.preview\.sha256/, 'preview confirmation must match the active rendered pixels');
  assert.match(ui.result.contents[0].text, /state\.sourceHash !== latest\.source\.sha256/, 'manual sync must reject a different source hash');
  assert.match(ui.result.contents[0].text, /state\.preview\.rendererId !== state\.rendererId/, 'save readiness must require this renderer confirmation');
  const editorModule = ui.result.contents[0].text.match(/<script type="module">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(editorModule, 'the editor module script must be present');
  assert.doesNotThrow(() => new Function(editorModule), 'the editor module script must parse');
  assert.match(ui.result.contents[0].text, /only the finished edit is sent to the local process/);
  assert.match(ui.result.contents[0].text, /ui\/notifications\/initialized/);
  assert.doesNotMatch(ui.result.contents[0].text, /color-mode|color-intensity/);

  const opened = await request('tools/call', { name: 'open_portrait_studio', arguments: {} });
  const initial = opened.result.structuredContent;
  assert.equal(initial.revision, 0, JSON.stringify(opened.result));
  assert.equal(initial.preview.status, 'awaiting_source');
  assert.match(opened.result.content[0].text, /bytes remain in the browser/);

  const list = await request('tools/call', { name: 'list_editor_sessions', arguments: {} });
  assert.equal(list.result.structuredContent.sessions[0].sessionId, initial.sessionId);
  assert.equal(list.result.structuredContent.sessions[0].source, null);
  const emptyState = await request('tools/call', { name: 'get_editor_state', arguments: { sessionId: initial.sessionId } });
  assert.equal(emptyState.result.structuredContent.revision, 0);

  const sourceBytes = Buffer.from('synthetic source bytes must not enter MCP session metadata');
  const sourceSha256 = createHash('sha256').update(sourceBytes).digest('hex');
  const source = { fileName: 'synthetic-source.png', mimeType: 'image/png', width: 40, height: 50, byteSize: sourceBytes.length, sha256: sourceSha256 };
  const bound = await request('tools/call', { name: 'set_active_image', arguments: { sessionId: initial.sessionId, expectedRevision: 0, source } });
  assert.equal(bound.result.structuredContent.source.sha256, sourceSha256);
  assert.equal(bound.result.structuredContent.revision, 1);
  const metadataPath = join(tempHome, 'local-data', 'sessions.json');
  assert.ok(existsSync(metadataPath));
  const metadataText = readFileSync(metadataPath, 'utf8');
  assert.doesNotMatch(metadataText, /synthetic source bytes must not enter/);
  assert.match(metadataText, new RegExp(sourceSha256));

  const adjusted = await request('tools/call', { name: 'set_color_adjustments', arguments: {
    sessionId: initial.sessionId, expectedRevision: 1, adjustments: { exposureEV: 0.3, highlights: -20 }
  } });
  assert.equal(adjusted.result.structuredContent.revision, 2);
  assert.equal(adjusted.result.structuredContent.adjustments.exposureEV, 0.3);
  assert.equal(adjusted.result.structuredContent.adjustments.highlights, -20);
  assert.equal(adjusted.result.structuredContent.preview.status, 'pending');
  assert.equal(adjusted.result.isError, undefined);

  const stale = await request('tools/call', { name: 'set_color_adjustments', arguments: {
    sessionId: initial.sessionId, expectedRevision: 1, adjustments: { exposureEV: 1 }
  } });
  assert.equal(stale.result.isError, true);
  assert.equal(stale.result.structuredContent.status, 'conflict');
  assert.equal(stale.result.structuredContent.revision, 2);

  const preset = await request('tools/call', { name: 'apply_color_preset', arguments: {
    sessionId: initial.sessionId, expectedRevision: 2, preset: 'warm', intensity: 50
  } });
  assert.equal(preset.result.structuredContent.revision, 3);
  assert.equal(preset.result.structuredContent.crop.aspectRatio, 'free');
  assert.equal(preset.result.structuredContent.adjustments.temperature, 11);

  const crop = await request('tools/call', { name: 'set_crop', arguments: {
    sessionId: initial.sessionId, expectedRevision: 3, crop: { x: 0, y: 0, width: 80, height: 100, aspectRatio: '4:5' }
  } });
  assert.equal(crop.result.structuredContent.revision, 4);
  assert.deepEqual(crop.result.structuredContent.crop, { x: 0, y: 10, width: 80, height: 80, aspectRatio: '4:5' });
  assert.equal(crop.result.structuredContent.preview.status, 'pending');

  const reset = await request('tools/call', { name: 'reset_adjustments', arguments: {
    sessionId: initial.sessionId, expectedRevision: 4, fields: ['color']
  } });
  assert.equal(reset.result.structuredContent.revision, 5);
  assert.equal(reset.result.structuredContent.adjustments.exposureEV, 0);
  assert.equal(reset.result.structuredContent.preset, null);
  assert.equal(reset.result.structuredContent.crop.aspectRatio, '4:5');
  const undone = await request('tools/call', { name: 'undo_edit', arguments: { sessionId: initial.sessionId, expectedRevision: 5 } });
  assert.equal(undone.result.structuredContent.revision, 6);
  assert.equal(undone.result.structuredContent.adjustments.temperature, 11);
  assert.equal(undone.result.structuredContent.history.canRedo, true);
  const redone = await request('tools/call', { name: 'redo_edit', arguments: { sessionId: initial.sessionId, expectedRevision: 6 } });
  assert.equal(redone.result.structuredContent.revision, 7);
  assert.equal(redone.result.structuredContent.adjustments.temperature, 0);

  const rendererId = 'b0000000-0000-4000-8000-000000000000';
  const invalidPreview = await request('tools/call', { name: 'confirm_preview', arguments: {
    sessionId: initial.sessionId, expectedRevision: 7, rendererId, sourceSha256, width: 40, height: 50, sha256: 'c'.repeat(64)
  } });
  assert.equal(invalidPreview.result.isError, true);
  assert.equal(invalidPreview.result.structuredContent.errors[0].code, 'invalid_preview_dimensions');
  const preview = await request('tools/call', { name: 'confirm_preview', arguments: {
    sessionId: initial.sessionId, expectedRevision: 7, rendererId, sourceSha256, width: 32, height: 40, sha256: 'c'.repeat(64)
  } });
  assert.equal(preview.result.structuredContent.preview.status, 'confirmed');
  assert.equal(preview.result.structuredContent.preview.confirmedBy.pid, child.pid);
  assert.equal(preview.result.structuredContent.preview.confirmedBy.serverVersion, '0.2.8');
  assert.match(preview.result.structuredContent.preview.confirmedBy.sourceBuildHash, /^[a-f0-9]{64}$/);

  const diagnostics = await request('tools/call', { name: 'get_runtime_diagnostics', arguments: { sessionId: initial.sessionId } });
  assert.equal(diagnostics.result.structuredContent.pid, child.pid);
  assert.equal(diagnostics.result.structuredContent.serverVersion, '0.2.8');
  assert.equal(diagnostics.result.structuredContent.sourceBuildHash, expectedSourceBuildHash);
  assert.equal(diagnostics.result.structuredContent.executablePath, process.execPath);
  assert.equal(diagnostics.result.structuredContent.scriptPath, resolve(root, 'server/index.mjs'));
  assert.equal(diagnostics.result.structuredContent.pluginRoot, root);
  assert.equal(diagnostics.result.structuredContent.sessionStorePath, metadataPath);
  assert.equal(diagnostics.result.structuredContent.session.revision, 7);
  assert.equal(diagnostics.result.structuredContent.session.preview.status, 'confirmed');
  assert.equal(diagnostics.result.structuredContent.session.preview.rendererId, rendererId);
  assert.equal(diagnostics.result.structuredContent.session.preview.sha256, 'c'.repeat(64));
  assert.equal(diagnostics.result.structuredContent.session.preview.confirmedBy.instanceId, diagnostics.result.structuredContent.instanceId);
  assert.equal(diagnostics.result.structuredContent.writeDurability.lastPersist.fileFsyncBeforeRename, true);
  assert.equal(typeof diagnostics.result.structuredContent.writeDurability.lastPersist.directoryFsyncAfterRename, 'boolean');
  assert.equal(diagnostics.result.structuredContent.confirmationEvents.at(-1).result, 'confirmed');
  assert.equal(diagnostics.result.structuredContent.confirmationEvents.at(-1).rendererId, rendererId);
  assert.equal(JSON.stringify(diagnostics.result.structuredContent).includes(sourceSha256), false, 'diagnostics must not expose source hashes');
  assert.equal(JSON.stringify(diagnostics.result.structuredContent).includes(sourceBytes.toString()), false, 'diagnostics must not expose source contents');

  const png = syntheticPng(32, 40);
  const rgba = Buffer.from(Array.from({ length: 32 * 40 }, () => [100, 80, 60, 255]).flat());
  const exportArgs = { baseName: '..\\..\\Portrait Test.png', width: 32, height: 40, pngBase64: png.toString('base64') };
  const prematureExport = await request('tools/call', { name: 'save_edited_png', arguments: {
    ...exportArgs, sessionId: initial.sessionId, revision: 6, rendererId
  } });
  assert.equal(prematureExport.result.isError, true);
  assert.match(prematureExport.result.content[0].text, /revision/);
  const saved = await request('tools/call', { name: 'save_edited_png', arguments: {
    ...exportArgs, sessionId: initial.sessionId, revision: 7, rendererId
  } });
  assert.equal(saved.result.isError, undefined);
  assert.equal(saved.result.structuredContent.saved, true);
  assert.equal(saved.result.structuredContent.path, join(tempHome, 'Downloads', 'Portrait-Test-portrait-studio.png'));
  assert.equal(saved.result.structuredContent.width, 32);
  assert.equal(saved.result.structuredContent.height, 40);
  assert.equal(saved.result.structuredContent.bytes, png.length);
  assert.equal(saved.result.structuredContent.sha256, createHash('sha256').update(png).digest('hex'));
  assert.equal(saved.result.structuredContent.pixelSha256, createHash('sha256').update(rgba).digest('hex'));
  assert.equal(saved.result.structuredContent.sessionId, initial.sessionId);
  assert.equal(saved.result.structuredContent.revision, 7);
  const savedBytes = readFileSync(saved.result.structuredContent.path);
  assert.deepEqual(savedBytes, png);
  assert.equal(savedBytes.readUInt32BE(16), 32);
  assert.equal(savedBytes.readUInt32BE(20), 40);
  const idatOffset = 8 + 25;
  const idatLength = savedBytes.readUInt32BE(idatOffset);
  const decoded = inflateSync(savedBytes.subarray(idatOffset + 8, idatOffset + 8 + idatLength));
  assert.equal(decoded.length, (32 * 4 + 1) * 40);
  const exportStatus = await request('tools/call', { name: 'get_export_status', arguments: { sessionId: initial.sessionId } });
  assert.equal(exportStatus.result.structuredContent.export.status, 'saved');
  assert.equal(exportStatus.result.structuredContent.export.pixelSha256, saved.result.structuredContent.pixelSha256);

  const savedAgain = await request('tools/call', { name: 'save_edited_png', arguments: {
    ...exportArgs, sessionId: initial.sessionId, revision: 7, rendererId
  } });
  assert.equal(savedAgain.result.structuredContent.fileName, 'Portrait-Test-portrait-studio (1).png');
  assert.deepEqual(readFileSync(saved.result.structuredContent.path), png);

  const resumed = await request('tools/call', { name: 'open_portrait_studio', arguments: { sessionId: initial.sessionId } });
  assert.equal(resumed.result.structuredContent.revision, 7, 'resuming must preserve edit history');
  assert.equal(resumed.result.structuredContent.preview.status, 'confirmed', 'resume must preserve the latest confirmed preview for its unchanged revision');
  assert.equal(resumed.result.structuredContent.export.status, 'saved');

  const legacyPng = syntheticPng(2, 2, [255, 0, 0, 255]);
  const legacy = await request('tools/call', { name: 'save_edited_png', arguments: {
    baseName: 'legacy', width: 2, height: 2, pngBase64: legacyPng.toString('base64')
  } });
  assert.equal(legacy.result.structuredContent.saved, true);
  assert.equal(legacy.result.structuredContent.pixelSha256, createHash('sha256').update(Buffer.from(Array.from({ length: 4 }, () => [255, 0, 0, 255]).flat())).digest('hex'));

  const rejected = await request('tools/call', {
    name: 'save_edited_png', arguments: { baseName: 'invalid', width: 2, height: 2, pngBase64: 'not a png' }
  });
  assert.equal(rejected.result.isError, true);
  assert.match(rejected.result.content[0].text, /invalid or too large/);

  const unknown = await request('resources/read', { uri: 'file:///private/photo.jpg' });
  assert.equal(unknown.error.code, -32602);
} finally {
  lines.close();
  child.kill();
  assert.ok(resolve(tempHome).startsWith(root + sep), 'test cleanup target must stay inside the workspace');
  rmSync(tempHome, { recursive: true, force: true });
}

console.log('Portrait Studio MCP contract checks passed.');

