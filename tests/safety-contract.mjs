import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path), 'utf8').replace(/^\uFEFF/, '');
const forbiddenExtensions = new Set(['.afphoto', '.afdesign', '.afpub', '.cr3', '.dng', '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.heic', '.avif', '.tif', '.tiff']);
const approvedFixture = join(root, 'test-fixtures', 'portrait-studio-synthetic.png');
const fixtureBytes = readFileSync(approvedFixture);
assert.equal(fixtureBytes.readUInt32BE(16), 300);
assert.equal(fixtureBytes.readUInt32BE(20), 300);
assert.equal(createHash('sha256').update(fixtureBytes).digest('hex'), 'f6feebd6c91a4162b85ef02819af827befdd8c3d5998230d8cc41bb26ef607fc');

function visit(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules')
      continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory())
      visit(path);
    else if (path !== approvedFixture)
      assert.equal(forbiddenExtensions.has(extname(entry.name).toLowerCase()), false, 'Image or private project asset found: ' + path);
  }
}

visit(root);

const manifest = JSON.parse(read('plugin.json'));
assert.equal(manifest.name, 'portrait-studio-for-chatgpt');
assert.equal(manifest.version, '0.2.8');
assert.match(manifest.extensions['com.openai'].interface.defaultPrompt, /calling open_portrait_studio/);
assert.equal(manifest.license, 'MIT');
assert.equal(manifest.extensions['com.openai'].interface.displayName, 'Portrait Studio for ChatGPT');

const codexManifest = JSON.parse(read('.codex-plugin/plugin.json'));
assert.equal(codexManifest.version, '0.2.8');
assert.equal(codexManifest.mcpServers, './.mcp.json');

const mcp = JSON.parse(read('.mcp.json'));
assert.equal(mcp.mcpServers['portrait-studio'].type, 'stdio');
assert.equal(mcp.mcpServers['portrait-studio'].command, 'node');
assert.deepEqual(mcp.mcpServers['portrait-studio'].args, ['${PLUGIN_ROOT}/server/index.mjs']);
assert.equal(mcp.mcpServers['portrait-studio'].cwd, '${PLUGIN_ROOT}');

const server = read('server/index.mjs');
const ui = read('ui/studio.html');
assert.doesNotMatch(server, /\b(?:fetch|XMLHttpRequest)\b|https?:\/\//i);
assert.match(ui, /accept="image\/jpeg,image\/png/);
assert.match(ui, /Save edited PNG to Downloads/);
assert.match(server, /toolDefinition\('save_edited_png'/);
assert.match(server, /PORTRAIT_STUDIO_DATA_DIR/);
assert.match(server, /visibility: \['app'\]/);
assert.match(ui, /ui\/notifications\/tool-result/);
assert.match(ui, /ui\/update-model-context/);
assert.match(server, /resolve\(homedir\(\), 'Downloads'\)/);
assert.match(server, /openSync\(outputPath, 'wx'\)/, 'exports must never overwrite an existing file');
const exportHandler = ui.slice(ui.indexOf("byId('download-png').addEventListener"), ui.indexOf("byId('fullscreen-button').addEventListener"));
assert.match(exportHandler, /callTool\('save_edited_png'/);
assert.doesNotMatch(exportHandler, /uploadFile/);
assert.match(ui, /uploadFile\(/, 'AI upload must remain an explicit UI action');

const ignore = read('.gitignore');
assert.match(ignore, /^\.env\.\*$/m);
assert.match(ignore, /^\.mcp\.local\.json$/m);
assert.match(ignore, /^\*\.jpg$/m);
assert.match(ignore, /^\*\.png$/m);
assert.match(read('LICENSE'), /^MIT License/m);

console.log('Portrait Studio publication safety checks passed.');

