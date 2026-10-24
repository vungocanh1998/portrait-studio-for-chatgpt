import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const child = spawn(process.execPath, [resolve(root, 'server/index.mjs')], {
  cwd: root,
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true
});
const lines = createInterface({ input: child.stdout });
const pending = new Map();
let requestId = 0;

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

  const tools = await request('tools/list');
  assert.equal(tools.result.tools.length, 1);
  assert.equal(tools.result.tools[0].name, 'open_portrait_studio');
  assert.equal(tools.result.tools[0]._meta.ui.resourceUri, 'ui://portrait-studio-for-chatgpt/studio.html');
  assert.equal(tools.result.tools[0]._meta['openai/fileParams'], undefined);

  const resources = await request('resources/list');
  assert.equal(resources.result.resources[0].mimeType, 'text/html;profile=mcp-app');

  const ui = await request('resources/read', { uri: resources.result.resources[0].uri });
  assert.match(ui.result.contents[0].text, /Portrait Studio for ChatGPT/);
  assert.match(ui.result.contents[0].text, /uploadFile/);

  const opened = await request('tools/call', { name: 'open_portrait_studio', arguments: {} });
  assert.match(opened.result.content[0].text, /separate PNG/);

  const unknown = await request('resources/read', { uri: 'file:///private/photo.jpg' });
  assert.equal(unknown.error.code, -32602);
} finally {
  lines.close();
  child.kill();
}

console.log('Portrait Studio MCP contract checks passed.');
