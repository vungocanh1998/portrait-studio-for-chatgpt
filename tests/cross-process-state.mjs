import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve, sep, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testRoot = mkdtempSync(join(root, '.cross-process-state-test-'));
const localAppData = join(testRoot, 'AppData', 'Local');
const packagedLocalAppData = join(localAppData, 'Packages', 'OpenAI.Codex_test', 'LocalCache', 'Local');
const dataDir = join(localAppData, '.portrait-studio-for-chatgpt');
const sourceSha256 = createHash('sha256').update('cross-process test image').digest('hex');
const clients = [];

function startServer(appDataRoot) {
  const child = spawn(process.execPath, [resolve(root, 'server/index.mjs')], {
    cwd: root,
    env: { ...process.env, USERPROFILE: testRoot, HOME: testRoot, LOCALAPPDATA: appDataRoot },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  let requestId = 0;
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000); });
  lines.on('line', (line) => {
    const response = JSON.parse(line);
    const waiter = pending.get(response.id);
    if (!waiter)
      return;
    clearTimeout(waiter.timeout);
    pending.delete(response.id);
    waiter.resolve(response);
  });
  child.on('exit', (code) => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error(`MCP server exited (${code}): ${stderr}`));
    }
    pending.clear();
  });
  const client = {
    child,
    request(method, params = {}) {
      const id = ++requestId;
      return new Promise((resolveResponse, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error('MCP request timed out: ' + method));
        }, 5000);
        pending.set(id, { resolve: resolveResponse, reject, timeout });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    },
    async call(name, args = {}) {
      const response = await this.request('tools/call', { name, arguments: args });
      assert.ok(response.result, JSON.stringify(response));
      return response.result;
    },
    async close() {
      lines.close();
      if (child.exitCode !== null || child.signalCode !== null)
        return;
      child.kill();
      await new Promise((resolveExit) => child.once('exit', resolveExit));
    }
  };
  clients.push(client);
  return client;
}

async function initialize(client) {
  const response = await client.request('initialize', { protocolVersion: '2025-11-25' });
  assert.equal(response.result.protocolVersion, '2025-11-25');
}

try {
  const processA = startServer(localAppData);
  await initialize(processA);
  const opened = await processA.call('open_portrait_studio');
  const sessionId = opened.structuredContent.sessionId;

  const processB = startServer(packagedLocalAppData);
  await initialize(processB);
  assert.notEqual(processA.child.pid, processB.child.pid, 'the test must exercise separate MCP processes');

  const runtimeA = (await processA.call('get_runtime_diagnostics', { sessionId: opened.structuredContent.sessionId })).structuredContent;
  const runtimeB = (await processB.call('get_runtime_diagnostics', { sessionId: opened.structuredContent.sessionId })).structuredContent;
  assert.equal(runtimeA.pid, processA.child.pid);
  assert.equal(runtimeB.pid, processB.child.pid);
  assert.equal(runtimeA.serverVersion, '0.2.8');
  assert.equal(runtimeB.serverVersion, '0.2.8');
  assert.notEqual(runtimeA.instanceId, runtimeB.instanceId);
  assert.equal(runtimeA.executablePath, process.execPath);
  assert.equal(runtimeB.executablePath, process.execPath);
  assert.equal(runtimeA.scriptPath, resolve(root, 'server/index.mjs'));
  assert.equal(runtimeB.scriptPath, resolve(root, 'server/index.mjs'));
  assert.equal(runtimeA.sessionStorePath, join(dataDir, 'sessions.json'));
  assert.equal(runtimeB.sessionStorePath, join(dataDir, 'sessions.json'));
  assert.match(runtimeA.sourceBuildHash, /^[a-f0-9]{64}$/);
  assert.equal(runtimeA.sourceBuildHash, runtimeB.sourceBuildHash);
  assert.equal(runtimeA.session.revision, 0);
  assert.equal(runtimeA.session.preview.status, 'awaiting_source');
  assert.equal(runtimeA.writeDurability.lastPersist.fileFsyncBeforeRename, true);
  assert.equal(typeof runtimeA.writeDurability.lastPersist.directoryFsyncAfterRename, 'boolean');

  const source = {
    fileName: 'cross-process-source.png',
    mimeType: 'image/png',
    width: 40,
    height: 50,
    byteSize: 128,
    sha256: sourceSha256
  };
  const bound = await processA.call('set_active_image', { sessionId, expectedRevision: 0, source });
  assert.equal(bound.structuredContent.revision, 1);
  const edited = await processA.call('set_color_adjustments', {
    sessionId,
    expectedRevision: 1,
    adjustments: { exposureEV: 0.3 }
  });
  assert.equal(edited.structuredContent.revision, 2);

  const observedByB = await processB.call('get_editor_state', { sessionId });
  assert.equal(observedByB.structuredContent.revision, 2, 'process B must read process A\'s committed revision');
  assert.equal(observedByB.structuredContent.adjustments.exposureEV, 0.3);
  assert.equal(
    existsSync(join(packagedLocalAppData, '.portrait-studio-for-chatgpt', 'sessions.json')),
    false,
    'packaged and plain Windows app roots must resolve to one session file'
  );

  const rendererId = 'b0000000-0000-4000-8000-000000000000';
  const confirmed = await processB.call('confirm_preview', {
    sessionId,
    expectedRevision: 2,
    rendererId,
    sourceSha256,
    width: 40,
    height: 50,
    sha256: 'c'.repeat(64)
  });
  assert.equal(confirmed.structuredContent.preview.status, 'confirmed');
  assert.equal(confirmed.structuredContent.preview.rendererId, rendererId);
  assert.equal(confirmed.structuredContent.preview.confirmedBy.pid, processB.child.pid);
  assert.equal(confirmed.structuredContent.preview.confirmedBy.instanceId, runtimeB.instanceId);
  assert.equal(confirmed.structuredContent.preview.confirmedBy.sessionStorePath, join(dataDir, 'sessions.json'));
  const confirmationTrace = (await processB.call('get_runtime_diagnostics', { sessionId })).structuredContent;
  assert.equal(confirmationTrace.session.preview.revision, 2);
  assert.equal(confirmationTrace.confirmationEvents.at(-1).rendererId, rendererId);
  assert.equal(confirmationTrace.confirmationEvents.at(-1).result, 'confirmed');
  assert.equal(JSON.stringify(confirmationTrace).includes(sourceSha256), false, 'diagnostics must not log the source hash');

  const observedByA = await processA.call('get_editor_state', { sessionId });
  assert.equal(observedByA.structuredContent.preview.status, 'confirmed', 'process A must read process B\'s confirmation');
  const staleWrite = await processA.call('set_color_adjustments', {
    sessionId,
    expectedRevision: 1,
    adjustments: { exposureEV: 0.6 }
  });
  assert.equal(staleWrite.structuredContent.status, 'conflict');
  assert.equal(staleWrite.structuredContent.preview.status, 'confirmed', 'a stale write must preserve the committed confirmation');

  const persisted = JSON.parse(readFileSync(join(dataDir, 'sessions.json'), 'utf8'));
  const stored = persisted.sessions.find((session) => session.sessionId === sessionId);
  assert.equal(stored.revision, 2);
  assert.equal(stored.preview.rendererId, rendererId);

  const resumed = await processB.call('open_portrait_studio', { sessionId });
  assert.equal(resumed.structuredContent.preview.status, 'confirmed', 'resume must not erase a confirmed preview at the same revision');

  const undone = await processB.call('undo_edit', { sessionId, expectedRevision: 2 });
  assert.equal(undone.structuredContent.revision, 3);
  assert.equal(undone.structuredContent.adjustments.exposureEV, 0);
  const undoObservedByA = await processA.call('get_editor_state', { sessionId });
  assert.equal(undoObservedByA.structuredContent.revision, 3);
  assert.equal(undoObservedByA.structuredContent.history.canRedo, true);

  const redone = await processA.call('redo_edit', { sessionId, expectedRevision: 3 });
  assert.equal(redone.structuredContent.revision, 4);
  assert.equal(redone.structuredContent.adjustments.exposureEV, 0.3);
  const redoObservedByB = await processB.call('get_editor_state', { sessionId });
  assert.equal(redoObservedByB.structuredContent.revision, 4);
  assert.equal(redoObservedByB.structuredContent.adjustments.exposureEV, 0.3);

  const remountRendererId = 'c0000000-0000-4000-8000-000000000000';
  const remountConfirmation = await processB.call('confirm_preview', {
    sessionId,
    expectedRevision: 4,
    rendererId: remountRendererId,
    sourceSha256,
    width: 40,
    height: 50,
    sha256: 'd'.repeat(64)
  });
  assert.equal(remountConfirmation.structuredContent.preview.status, 'confirmed');
  const remount = await processA.call('open_portrait_studio', { sessionId });
  assert.equal(remount.structuredContent.revision, 4);
  assert.equal(remount.structuredContent.preview.rendererId, remountRendererId);
  assert.equal(remount.structuredContent.preview.confirmedBy.instanceId, runtimeB.instanceId);
  assert.equal(remount.structuredContent.history.canUndo, true);

  const competingWrites = await Promise.all([
    processA.call('set_color_adjustments', { sessionId, expectedRevision: 4, adjustments: { exposureEV: 0.4 } }),
    processB.call('set_color_adjustments', { sessionId, expectedRevision: 4, adjustments: { exposureEV: 0.6 } })
  ]);
  assert.deepEqual(
    competingWrites.map((result) => result.structuredContent.status).sort(),
    ['conflict', 'ok'],
    'only one process may commit a mutation from the same expected revision'
  );
  const afterRace = await processA.call('get_editor_state', { sessionId });
  assert.equal(afterRace.structuredContent.revision, 5);
  assert.ok([0.4, 0.6].includes(afterRace.structuredContent.adjustments.exposureEV));
  assert.equal(afterRace.structuredContent.preview.status, 'pending');

  const storePath = join(dataDir, 'sessions.json');
  const lockPath = storePath + '.lock';
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, instanceId: 'test-owner' }), { flag: 'wx' });
  const activeLock = (await processB.call('get_runtime_diagnostics', { sessionId })).structuredContent.storeLock;
  assert.equal(activeLock.status, 'active');
  assert.equal(activeLock.ownerPid, process.pid);
  assert.equal(activeLock.ownerInstanceId, 'test-owner');
  unlinkSync(lockPath);

  const deadPid = processA.child.pid;
  await processA.close();
  assert.throws(() => process.kill(deadPid, 0), (error) => error.code === 'ESRCH');
  const storedBeforeOrphan = readFileSync(storePath);
  writeFileSync(lockPath, JSON.stringify({ pid: deadPid, instanceId: runtimeA.instanceId }), { flag: 'wx' });
  const blockedByOrphan = await processB.call('get_editor_state', { sessionId });
  assert.equal(blockedByOrphan.isError, true);
  assert.equal(blockedByOrphan.structuredContent.errors[0].code, 'orphaned_store_lock');
  assert.equal(existsSync(lockPath), true, 'orphaned locks must be preserved for explicit recovery');
  assert.deepEqual(readFileSync(storePath), storedBeforeOrphan, 'orphan handling must not modify committed session data');
  const orphanDiagnostics = (await processB.call('get_runtime_diagnostics', { sessionId })).structuredContent;
  assert.equal(orphanDiagnostics.storeLock.status, 'orphaned');
  assert.equal(orphanDiagnostics.storeLock.ownerPid, deadPid);
  assert.equal(orphanDiagnostics.session.revision, 5);
  unlinkSync(lockPath);
} finally {
  await Promise.all(clients.map((client) => client.close()));
  assert.ok(resolve(testRoot).startsWith(root + sep), 'test cleanup target must stay inside the workspace');
  rmSync(testRoot, { recursive: true, force: true });
}

console.log(`Portrait Studio cross-process state checks passed (MCP PIDs ${clients[0].child.pid} and ${clients[1].child.pid}, shared store ${join(dataDir, 'sessions.json')}).`);
