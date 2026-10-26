import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const version = JSON.parse(read('plugin.json')).version;

assert.equal(JSON.parse(read('.codex-plugin/plugin.json')).version, version);
assert.equal(JSON.parse(read('SBOM.cdx.json')).metadata.component.version, version);

const server = read('server/index.mjs');
const serverInfo = server.match(/serverInfo:\s*\{[^}]*\bversion:\s*(['"])([^'"]+)\1/);
assert.ok(serverInfo, 'MCP serverInfo.version must be present');
assert.equal(serverInfo[2], version);

const ui = read('ui/studio.html');
const appInfo = ui.match(/appInfo:\s*\{[^}]*\bversion:\s*(['"])([^'"]+)\1/);
assert.ok(appInfo, 'MCP App appInfo.version must be present');
assert.equal(appInfo[2], version);

const readme = read('README.md');
assert.ok(readme.includes(version), 'README.md must state the current source version');

console.log('Version consistency passed: ' + version);
