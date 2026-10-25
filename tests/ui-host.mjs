import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { inflateSync } from 'node:zlib';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tempHome = mkdtempSync(join(root, '.ui-host-test-'));
const template = readFileSync(resolve(root, 'ui/studio.html'), 'utf8');
const engine = readFileSync(resolve(root, 'ui/engine.js'), 'utf8');
const marker = '<!-- PORTRAIT_STUDIO_ENGINE -->';
const appHtml = template.replace(marker, engine);
const workspaceRoot = resolve(root) + sep;
if (!resolve(tempHome).startsWith(workspaceRoot))
  throw new Error('Test output directory must stay inside the workspace.');
const mcp = spawn(process.execPath, [resolve(root, 'server/index.mjs')], {
  cwd: root,
  env: { ...process.env, USERPROFILE: tempHome, HOME: tempHome, PORTRAIT_STUDIO_DATA_DIR: join(tempHome, 'local-data') },
  stdio: ['pipe', 'pipe', 'inherit'],
  windowsHide: true
});
const mcpLines = createInterface({ input: mcp.stdout });
const pending = new Map();
let lastExport;
let rpcId = 0;

mcpLines.on('line', (line) => {
  const response = JSON.parse(line);
  const waiter = pending.get(response.id);
  if (!waiter)
    return;
  clearTimeout(waiter.timer);
  pending.delete(response.id);
  waiter.resolve(response);
});

function requestMcp(message) {
  return new Promise((resolveResponse, reject) => {
    const timer = setTimeout(() => {
      pending.delete(message.id);
      reject(new Error('Local MCP test request timed out.'));
    }, 30000);
    pending.set(message.id, { resolve: resolveResponse, timer });
    mcp.stdin.write(JSON.stringify(message) + '\n');
  });
}

function decodePng(bytes) {
  let offset = 8;
  let width;
  let height;
  let channels;
  const idat = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > bytes.length)
      throw new Error('Saved PNG chunk is incomplete.');
    if (type === 'IHDR') {
      width = bytes.readUInt32BE(offset + 8);
      height = bytes.readUInt32BE(offset + 12);
      const bitDepth = bytes[offset + 16];
      const colorType = bytes[offset + 17];
      if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6))
        throw new Error('Saved PNG is not 8-bit RGB or RGBA.');
      channels = colorType === 6 ? 4 : 3;
    } else if (type === 'IDAT') {
      idat.push(bytes.subarray(offset + 8, offset + 8 + length));
    } else if (type === 'IEND') {
      break;
    }
    offset = end;
  }
  if (!width || !height || !idat.length)
    throw new Error('Saved PNG is incomplete.');
  const filtered = inflateSync(Buffer.concat(idat));
  const rowBytes = width * channels;
  if (filtered.length !== (rowBytes + 1) * height)
    throw new Error('Saved PNG pixel data has the wrong length.');
  const pixels = Buffer.alloc(rowBytes * height);
  const paeth = (left, above, upperLeft) => {
    const estimate = left + above - upperLeft;
    const leftDistance = Math.abs(estimate - left);
    const aboveDistance = Math.abs(estimate - above);
    const upperLeftDistance = Math.abs(estimate - upperLeft);
    return leftDistance <= aboveDistance && leftDistance <= upperLeftDistance ? left :
      (aboveDistance <= upperLeftDistance ? above : upperLeft);
  };
  for (let y = 0; y < height; y++) {
    const inputOffset = y * (rowBytes + 1);
    const outputOffset = y * rowBytes;
    const filter = filtered[inputOffset];
    if (filter > 4)
      throw new Error('Saved PNG contains an invalid row filter.');
    for (let x = 0; x < rowBytes; x++) {
      const raw = filtered[inputOffset + x + 1];
      const left = x >= channels ? pixels[outputOffset + x - channels] : 0;
      const above = y > 0 ? pixels[outputOffset - rowBytes + x] : 0;
      const upperLeft = y > 0 && x >= channels ? pixels[outputOffset - rowBytes + x - channels] : 0;
      const predictor = filter === 1 ? left : filter === 2 ? above : filter === 3 ? Math.floor((left + above) / 2) : filter === 4 ? paeth(left, above, upperLeft) : 0;
      pixels[outputOffset + x] = (raw + predictor) & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

const hostHtml = `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Portrait Studio local MCP host test</title>
<style>body{font:14px system-ui;margin:1rem;background:#20251f;color:#f0f2ec}button{margin:.25rem;padding:.5rem}.row{display:flex;gap:1rem;flex-wrap:wrap}iframe{width:100%;height:850px;border:1px solid #78836d;border-radius:8px}pre{white-space:pre-wrap}</style>
<h1>Portrait Studio local MCP host test</h1>
<p>This isolated harness uses synthetic PNG/JPEG fixtures and the local MCP server. Its Chat buttons simulate host tool-result delivery.</p>
<div class="row"><button id="load-png">Load synthetic PNG</button><button id="load-jpeg">Load synthetic JPEG</button><button id="new-session">Open a new session</button><button id="resume">Resume latest local session</button><button id="remount">Remount editor</button><button id="chat-exposure">Chat: increase exposure 0.3 EV</button><button id="chat-exposure-no-notify">Chat: +0.3 EV without widget notification</button><button id="sync-from-chat">Sync active editor from chat</button><button id="ui-exposure">UI: increase exposure 0.5 EV</button><button id="chat-crop">Chat: crop to 4:5</button><button id="retouch">Apply synthetic clone stroke</button><button id="inspect">Read pixels and session state</button><button id="save">Save PNG</button><button id="verify">Verify saved file from disk</button></div>
<pre id="results">Ready. Load a synthetic image to begin.</pre>
<iframe id="app" sandbox="allow-scripts allow-same-origin allow-forms" src="/app" title="Portrait Studio"></iframe>
<script>
  const frame = document.getElementById('app');
  const results = document.getElementById('results');
  let sourceFile;
  let sourceHash;
  let lastSave;
  let currentState;
  let modelContext = '';
  let rpcId = 0;
  const appCalls = [];
  let frameReady = frame.contentDocument?.readyState === 'complete';
  frame.addEventListener('load', () => { frameReady = true; });
  function log(value) { results.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2); }
  function hash(bytes) {
    return crypto.subtle.digest('SHA-256', bytes).then((digest) => Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(''));
  }
  async function requestTool(name, args = {}) {
    const response = await fetch('/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }) });
    const message = await response.json();
    if (message.error) throw new Error(message.error.message);
    const result = message.result;
    if (result?.structuredContent?.sessionId && Number.isInteger(result.structuredContent.revision)) currentState = result.structuredContent;
    if (result?.structuredContent?.saved) lastSave = result.structuredContent;
    return result;
  }
  function notifyToolResult(name, result) {
    frame.contentWindow.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { toolName: name, content: result.content, structuredContent: result.structuredContent } }, '*');
  }
  document.getElementById('new-session').addEventListener('click', async () => {
    try {
      const opened = await requestTool('open_portrait_studio');
      notifyToolResult('open_portrait_studio', opened);
      log({ newSession: opened.structuredContent.sessionId, revision: opened.structuredContent.revision });
    } catch (error) { log(String(error)); }
  });
  document.getElementById('remount').addEventListener('click', () => {
    frameReady = false;
    frame.src = '/app?remount=' + Date.now();
    log('Editor iframe remounted. The local session remains available through list_editor_sessions; select the exact source again to restore pixels.');
  });
  document.getElementById('resume').addEventListener('click', async () => {
    try {
      const listed = await requestTool('list_editor_sessions');
      const sessionId = currentState?.sessionId || listed.structuredContent.sessions[0]?.sessionId;
      if (!sessionId) throw new Error('No local session is available to resume.');
      const resumed = await requestTool('open_portrait_studio', { sessionId });
      notifyToolResult('open_portrait_studio', resumed);
      log({ resumedSession: resumed.structuredContent.sessionId, revision: resumed.structuredContent.revision, sourceMetadataOnly: resumed.structuredContent.source, preview: resumed.structuredContent.preview.status });
    } catch (error) { log(String(error)); }
  });
  window.addEventListener('message', async (event) => {
    if (event.source !== frame.contentWindow || !event.data || event.data.jsonrpc !== '2.0') return;
    const request = event.data;
    if (request.method === 'ui/initialize') {
      event.source.postMessage({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2026-01-26', hostInfo: { name: 'portrait-studio-test', version: '1' }, hostCapabilities: { updateModelContext: { text: {}, structuredContent: {} } }, hostContext: {} } }, '*');
    } else if (request.method === 'ui/update-model-context') {
      modelContext = request.params?.content?.map((item) => item.text || '').join('\\n') || '';
      event.source.postMessage({ jsonrpc: '2.0', id: request.id, result: { _meta: { 'openai/modelContext': { updateId: 'local-test-' + Date.now() } } } }, '*');
    } else if (request.method === 'tools/call') {
      try {
        const response = await fetch('/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
        const mcpResponse = await response.json();
        if (mcpResponse.error) event.source.postMessage({ jsonrpc: '2.0', id: request.id, error: mcpResponse.error }, '*');
        else {
          const result = mcpResponse.result;
          const structured = result?.structuredContent;
          if (structured?.sessionId && Number.isInteger(structured.revision)) currentState = structured;
          if (structured?.saved) lastSave = structured;
          const args = request.params?.arguments || {};
          appCalls.push({ name: request.params?.name, argumentKeys: Object.keys(args), sourceKeys: args.source ? Object.keys(args.source) : null, base64Length: args.pngBase64?.length || 0 });
          event.source.postMessage({ jsonrpc: '2.0', id: request.id, result }, '*');
        }
      } catch (error) {
        event.source.postMessage({ jsonrpc: '2.0', id: request.id, error: { message: String(error) } }, '*');
      }
    }
  });
  async function loadFixture(type) {
    if (!frameReady)
      await new Promise((resolve) => frame.addEventListener('load', resolve, { once: true }));
    const canvas = document.createElement('canvas');
    canvas.width = 50; canvas.height = 50;
    const context = canvas.getContext('2d');
    context.fillStyle = '#644028'; context.fillRect(0, 0, 25, 25);
    context.fillStyle = '#287850'; context.fillRect(25, 0, 25, 25);
    context.fillStyle = '#305078'; context.fillRect(0, 25, 25, 25);
    context.fillStyle = '#e0c8a0'; context.fillRect(25, 25, 25, 25);
    const mime = type === 'jpeg' ? 'image/jpeg' : 'image/png';
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, mime, .95));
    sourceFile = new File([blob], 'synthetic-' + type + (type === 'jpeg' ? '.jpg' : '.png'), { type: mime });
    sourceHash = await hash(await sourceFile.arrayBuffer());
    const transfer = new DataTransfer();
    transfer.items.add(sourceFile);
    const input = frame.contentDocument.getElementById('original-file');
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    log({ fixture: sourceFile.name, bytes: sourceFile.size, sha256: sourceHash, dimensions: '50 × 50' });
  }
  document.getElementById('load-png').addEventListener('click', () => loadFixture('png').catch((error) => log(String(error))));
  document.getElementById('load-jpeg').addEventListener('click', () => loadFixture('jpeg').catch((error) => log(String(error))));
  document.getElementById('chat-exposure').addEventListener('click', async () => {
    try {
      if (!currentState?.sessionId) throw new Error('Load a synthetic image first.');
      const latest = (await requestTool('get_editor_state', { sessionId: currentState.sessionId })).structuredContent;
      const value = Math.min(5, Math.round((latest.adjustments.exposureEV + .3) * 100) / 100);
      const result = await requestTool('set_color_adjustments', { sessionId: latest.sessionId, expectedRevision: latest.revision, adjustments: { exposureEV: value } });
      notifyToolResult('set_color_adjustments', result);
      log({ simulatedChatTool: 'set_color_adjustments', revision: result.structuredContent.revision, exposureEV: result.structuredContent.adjustments.exposureEV, preview: result.structuredContent.preview.status });
    } catch (error) { log(String(error)); }
  });
  document.getElementById('chat-exposure-no-notify').addEventListener('click', async () => {
    try {
      if (!currentState?.sessionId) throw new Error('Load a synthetic image first.');
      const latest = (await requestTool('get_editor_state', { sessionId: currentState.sessionId })).structuredContent;
      const value = Math.min(5, Math.round((latest.adjustments.exposureEV + .3) * 100) / 100);
      const result = await requestTool('set_color_adjustments', { sessionId: latest.sessionId, expectedRevision: latest.revision, adjustments: { exposureEV: value } });
      log({ simulatedChatTool: 'set_color_adjustments', widgetNotificationSent: false, revision: result.structuredContent.revision, exposureEV: result.structuredContent.adjustments.exposureEV, preview: result.structuredContent.preview.status });
    } catch (error) { log(String(error)); }
  });
  document.getElementById('sync-from-chat').addEventListener('click', () => {
    frame.contentDocument.getElementById('sync-from-chat').click();
    log('Requested an authoritative get_editor_state refresh from the active editor. Use Inspect to read the resulting revision and preview confirmation.');
  });
  document.getElementById('ui-exposure').addEventListener('click', () => {
    const input = frame.contentDocument.getElementById('adjust-exposureEV');
    input.value = String(Math.min(5, Number(input.value) + .5));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    log('Dispatched the UI exposure control; its revision and preview are committed by the local MCP calls.');
  });
  document.getElementById('chat-crop').addEventListener('click', async () => {
    try {
      if (!currentState?.sessionId) throw new Error('Load a synthetic image first.');
      const latest = (await requestTool('get_editor_state', { sessionId: currentState.sessionId })).structuredContent;
      const result = await requestTool('set_crop', { sessionId: latest.sessionId, expectedRevision: latest.revision, crop: { aspectRatio: '4:5' } });
      notifyToolResult('set_crop', result);
      log({ simulatedChatTool: 'set_crop', crop: result.structuredContent.crop, revision: result.structuredContent.revision, preview: result.structuredContent.preview.status });
    } catch (error) { log(String(error)); }
  });
  document.getElementById('retouch').addEventListener('click', () => {
    if (!sourceFile) return log('Load a fixture first.');
    const doc = frame.contentDocument;
    doc.getElementById('tab-retouch').click();
    const brush = doc.getElementById('brush-size');
    brush.value = '6';
    brush.dispatchEvent(new Event('input', { bubbles: true }));
    const canvas = doc.getElementById('after-canvas');
    const rect = canvas.getBoundingClientRect();
    const pointer = (type, x, y) => new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + x * rect.width / canvas.width,
      clientY: rect.top + y * rect.height / canvas.height,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true
    });
    doc.getElementById('set-clone-source').click();
    canvas.dispatchEvent(pointer('pointerdown', 5, 5));
    const before = Array.from(canvas.getContext('2d').getImageData(38, 12, 1, 1).data);
    canvas.setPointerCapture = () => {};
    canvas.dispatchEvent(pointer('pointerdown', 38, 12));
    canvas.dispatchEvent(pointer('pointermove', 39, 12));
    canvas.dispatchEvent(pointer('pointerup', 39, 12));
    const after = Array.from(canvas.getContext('2d').getImageData(38, 12, 1, 1).data);
    log({ beforeTargetPixel: before, afterTargetPixel: after, retouchChangedPixel: before.join(',') !== after.join(','), sourceSha256: sourceHash });
  });
  document.getElementById('inspect').addEventListener('click', async () => {
    if (!sourceFile) return log('Load a fixture first.');
    const doc = frame.contentDocument;
    const pixel = (id, x, y) => Array.from(doc.getElementById(id).getContext('2d').getImageData(x, y, 1, 1).data);
    const hashAfter = await hash(await sourceFile.arrayBuffer());
    if (currentState?.sessionId)
      currentState = (await requestTool('get_editor_state', { sessionId: currentState.sessionId })).structuredContent;
    log({
      beforePixel: pixel('before-canvas', 5, 5),
      afterPixel: pixel('after-canvas', 5, 5),
      outputDimensions: [doc.getElementById('after-canvas').width, doc.getElementById('after-canvas').height],
      sourceSha256Before: sourceHash,
      sourceSha256After: hashAfter,
      sourceUnchanged: sourceHash === hashAfter,
      editorRevision: currentState?.revision,
      colorInEditor: currentState?.adjustments,
      cropInEditor: currentState?.crop,
      preview: currentState?.preview,
      modelContext,
      metadataCall: appCalls.findLast((call) => call.name === 'set_active_image')
    });
  });
  document.getElementById('save').addEventListener('click', () => {
    const doc = frame.contentDocument;
    doc.getElementById('tab-quality').click();
    doc.getElementById('download-png').click();
  });
  document.getElementById('verify').addEventListener('click', async () => {
    if (!lastSave?.path) return log('Save a PNG first.');
    const response = await fetch('/status');
    log(await response.json());
  });
</script></html>`;

const server = createServer(async (request, response) => {
  const url = new URL(request.url || '/', 'http://127.0.0.1');
  if (request.method === 'GET' && url.pathname === '/') {
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'",
      'Cache-Control': 'no-store'
    }).end(hostHtml);
    return;
  }
  if (request.method === 'GET' && url.pathname === '/app') {
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; base-uri 'none'; form-action 'none'; object-src 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'no-store'
    }).end(appHtml);
    return;
  }
  if (request.method === 'POST' && url.pathname === '/rpc') {
    let body = '';
    for await (const chunk of request)
      body += chunk;
    const message = JSON.parse(body);
    message.id = ++rpcId;
    try {
      const mcpResponse = await requestMcp(message);
      if (mcpResponse.result?.structuredContent?.saved)
        lastExport = mcpResponse.result.structuredContent;
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(mcpResponse));
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: String(error) }));
    }
    return;
  }
  if (request.method === 'GET' && url.pathname === '/status') {
    if (!lastExport?.path) {
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ saved: false }));
      return;
    }
    const bytes = readFileSync(lastExport.path);
    const png = decodePng(bytes);
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({
      saved: true,
      exists: statSync(lastExport.path).isFile(),
      path: lastExport.path,
      bytes: bytes.length,
      byteCountMatches: bytes.length === lastExport.bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sha256Matches: createHash('sha256').update(bytes).digest('hex') === lastExport.sha256,
      pixelSha256: createHash('sha256').update(png.pixels).digest('hex'),
      pixelSha256Matches: createHash('sha256').update(png.pixels).digest('hex') === lastExport.pixelSha256,
      dimensions: [png.width, png.height],
      decodedPixelBytes: png.pixels.length,
      retouchSample: png.width > 24 && png.height > 8 ? Array.from(png.pixels.subarray(8 * png.width * png.channels + 24 * png.channels, 8 * png.width * png.channels + 25 * png.channels)) : null
    }));
    return;
  }
  response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
});

await requestMcp({ jsonrpc: '2.0', id: ++rpcId, method: 'initialize', params: { protocolVersion: '2025-11-25' } });
const port = Number(process.env.PORTRAIT_STUDIO_TEST_PORT || 4174);
server.listen(port, '127.0.0.1', () => process.stderr.write(`Local MCP UI test host: http://127.0.0.1:${port}\n`));

function cleanup() {
  server.close();
  mcpLines.close();
  mcp.kill();
  if (!resolve(tempHome).startsWith(workspaceRoot))
    throw new Error('Refusing to clean a path outside the workspace.');
  rmSync(tempHome, { recursive: true, force: true });
}
process.once('SIGINT', () => { cleanup(); process.exit(0); });
process.once('SIGTERM', () => { cleanup(); process.exit(0); });
process.once('exit', () => {
  if (resolve(tempHome).startsWith(workspaceRoot))
    rmSync(tempHome, { recursive: true, force: true });
});

