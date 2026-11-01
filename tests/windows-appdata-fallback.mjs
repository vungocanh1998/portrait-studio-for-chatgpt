import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

if (process.platform !== 'win32') {
  console.log('Windows app-data fallback behavior: skipped on non-Windows host.');
} else {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const testRoot = mkdtempSync(join(tmpdir(), 'portrait-studio-win-fallback-'));
  const fakeProfile = join(testRoot, 'SyntheticProfile');
  const plainAppData = join(fakeProfile, 'AppData', 'Local');
  const packagedAppData = join(plainAppData, 'Packages', 'Synthetic.Editor_test', 'LocalCache', 'Local');
  const expectedStore = join(plainAppData, '.portrait-studio-for-chatgpt', 'sessions.json');
  const packagedAlternative = join(packagedAppData, '.portrait-studio-for-chatgpt', 'sessions.json');
  const sentinelRoot = join(testRoot, 'hostile-parent');
  const sentinelPath = join(sentinelRoot, 'sentinel.txt');
  const sentinelBytes = Buffer.from('isolated Windows fallback sentinel\n');
  const clients = [];

  mkdirSync(fakeProfile, { recursive: true });
  mkdirSync(sentinelRoot, { recursive: true });
  writeFileSync(sentinelPath, sentinelBytes, { flag: 'wx' });
  const sentinelEntries = readdirSync(sentinelRoot).sort();

  function assertGeneratedPath(path) {
    assert.ok(resolve(path).startsWith(resolve(testRoot) + sep), 'refusing a path outside the generated temp root');
  }

  function childEnvironment(appData) {
    assertGeneratedPath(appData);
    // The parent may have an unsafe override: remove it ONLY for this synthetic child.
    const env = {
      ...process.env,
      USERPROFILE: fakeProfile,
      HOME: fakeProfile,
      LOCALAPPDATA: appData,
      PORTRAIT_STUDIO_DATA_DIR: sentinelRoot
    };
    delete env.PORTRAIT_STUDIO_DATA_DIR;
    return env;
  }

  function preflightHome(appData) {
    const result = spawnSync(process.execPath, [
      '--input-type=module', '-e',
      'import { homedir } from "node:os"; process.stdout.write(homedir());'
    ], { env: childEnvironment(appData), encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, 'isolated homedir preflight must succeed');
    assert.equal(resolve(result.stdout.trim()), resolve(fakeProfile),
      'refusing to start an MCP server if Windows home cannot be isolated');
    assertGeneratedPath(result.stdout.trim());
    assert.equal(resolve(plainAppData), resolve(join(fakeProfile, 'AppData', 'Local')));
  }

  function startClient(appData) {
    const child = spawn(process.execPath, [join(repo, 'server', 'index.mjs')], {
      cwd: repo,
      env: childEnvironment(appData),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    const pending = new Map();
    let seq = 0;
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (part) => { stderr = (stderr + part).slice(-2000); });
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      let packet;
      try { packet = JSON.parse(line); } catch { return; }
      const waiter = pending.get(packet.id);
      if (!waiter) return;
      clearTimeout(waiter.timer);
      pending.delete(packet.id);
      waiter.resolve(packet);
    });
    child.on('exit', (code) => {
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('synthetic MCP server exited ' + code + ': ' + stderr));
      }
      pending.clear();
    });
    const client = {
      child,
      request(method, params = {}) {
        return new Promise((resolveReply, rejectReply) => {
          const id = ++seq;
          const timer = setTimeout(() => {
            pending.delete(id);
            rejectReply(new Error('synthetic MCP timeout on ' + method));
          }, 8000);
          pending.set(id, { resolve: resolveReply, reject: rejectReply, timer });
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
        });
      },
      async call(name, args = {}) {
        const packet = await this.request('tools/call', { name, arguments: args });
        assert.ok(packet.result && !packet.result.isError, JSON.stringify(packet));
        return packet.result.structuredContent;
      },
      async close() {
        lines.close();
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill();
        await new Promise((done) => child.once('exit', done));
      }
    };
    clients.push(client);
    return client;
  }

  try {
    // No plugin process starts until the HOME/USERPROFILE resolution has been proven synthetic.
    preflightHome(plainAppData);
    preflightHome(packagedAppData);
    assertGeneratedPath(expectedStore);
    assertGeneratedPath(packagedAlternative);
    assert.ok(resolve(packagedAppData).toLowerCase().startsWith(
      resolve(join(plainAppData, 'Packages')).toLowerCase() + sep
    ), 'synthetic packaged path must exercise the real Windows fallback branch');

    const plain = startClient(plainAppData);
    const initialPlain = await plain.request('initialize', { protocolVersion: '2025-11-25' });
    assert.ok(initialPlain.result);
    const opened = await plain.call('open_portrait_studio');
    const sessionId = opened.sessionId;
    const packaged = startClient(packagedAppData);
    const initialPackaged = await packaged.request('initialize', { protocolVersion: '2025-11-25' });
    assert.ok(initialPackaged.result);

    const diagA = await plain.call('get_runtime_diagnostics', { sessionId });
    const diagB = await packaged.call('get_runtime_diagnostics', { sessionId });
    assert.notEqual(diagA.pid, diagB.pid);
    assert.equal(resolve(diagA.sessionStorePath), resolve(expectedStore));
    assert.equal(resolve(diagB.sessionStorePath), resolve(expectedStore));
    assert.equal(diagA.session.revision, 0);
    assert.equal(diagB.session.revision, 0);

    const sourceHash = createHash('sha256').update('synthetic fallback test metadata').digest('hex');
    const bound = await plain.call('set_active_image', {
      sessionId,
      expectedRevision: 0,
      source: { fileName: 'synthetic.png', mimeType: 'image/png', width: 4, height: 3, byteSize: 64, sha256: sourceHash }
    });
    assert.equal(bound.revision, 1);
    const viaPackaged = await packaged.call('get_editor_state', { sessionId });
    assert.equal(viaPackaged.revision, 1, 'packaged process must see plain process state');
    const edited = await packaged.call('set_color_adjustments', {
      sessionId, expectedRevision: 1, adjustments: { exposureEV: 0.3 }
    });
    assert.equal(edited.revision, 2);
    const viaPlain = await plain.call('get_editor_state', { sessionId });
    assert.equal(viaPlain.revision, 2, 'plain process must see packaged process state');
    assert.equal(viaPlain.adjustments.exposureEV, 0.3);
    assert.equal(existsSync(packagedAlternative), false, 'packaged alternate store must not exist');
    assert.equal(existsSync(expectedStore), true, 'canonical synthetic store must exist');
    assert.deepEqual(readdirSync(sentinelRoot).sort(), sentinelEntries);
    assert.deepEqual(readFileSync(sentinelPath), sentinelBytes);
    console.log('Windows packaged/plain fallback path resolution checks passed.');
  } finally {
    try {
      await Promise.all(clients.map((client) => client.close()));
      assert.deepEqual(readdirSync(sentinelRoot).sort(), sentinelEntries);
      assert.deepEqual(readFileSync(sentinelPath), sentinelBytes);
    } finally {
      assertGeneratedPath(fakeProfile);
      assert.ok(resolve(testRoot).startsWith(resolve(tmpdir()) + sep),
        'refusing cleanup outside generated system-temp location');
      rmSync(testRoot, { recursive: true, force: true });
    }
  }
}
