import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';

const protocolVersion = '2025-11-25';
const resourceUri = 'ui://portrait-studio-for-chatgpt/studio.html';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const template = readFileSync(resolve(root, 'ui/studio.html'), 'utf8');
const engine = readFileSync(resolve(root, 'ui/engine.js'), 'utf8');
const marker = '<!-- PORTRAIT_STUDIO_ENGINE -->';

if (!template.includes(marker)) {
  process.stderr.write('Portrait Studio UI template is invalid.\n');
  process.exit(1);
}

const studioHtml = template.replace(marker, engine);

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
          version: '0.2.2'
        },
        instructions: 'Use open_portrait_studio to open the editing UI. Image editing runs in the UI browser; this local MCP process never receives image bytes or file paths.'
      });
      return;
    case 'ping':
      respond(id, {});
      return;
    case 'tools/list':
      respond(id, {
        tools: [{
          name: 'open_portrait_studio',
          title: 'Open Portrait Studio',
          description: 'Open the local portrait editor for JPEG or PNG files. The user selects images in the UI; this tool does not upload, read, alter, or save image files.',
          inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false
          },
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            openWorldHint: false
          },
          _meta: {
            ui: { resourceUri }
          }
        }]
      });
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
      if (params.name !== 'open_portrait_studio') {
        fail(id, -32602, 'Unknown tool.');
        return;
      }
      respond(id, {
        content: [{
          type: 'text',
          text: 'Portrait Studio is ready. Select a JPEG or PNG in the editor to preview changes; exporting creates a separate PNG and leaves the source untouched.'
        }]
      });
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
