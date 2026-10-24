import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = (name) => readFileSync(join(root, 'legacy', 'affinity', 'scripts', name), 'utf8');
const color = source('color-studio.js');
const retouch = source('retouch-studio.js');
const quality = source('quality-guard.js');

assert.match(color, /\\\.afphoto\$\/i/, 'Color Studio must reject paths outside .afphoto');
assert.match(color, /VibranceAdjustmentParameters/);
assert.match(color, /VibranceAdjustmentRasterNodeDefinition/);
assert.match(color, /Math\.max\(-1, Math\.min\(1,/);
assert.match(color, /doc\.executeCommand\(builder\.createCommand\(true\)\)/);
assert.doesNotMatch(color, /\b(?:fetch|XMLHttpRequest)\b|require\(['"]\/(?:fs|filesystem)/i);
assert.doesNotMatch(color, /\bdoc\.(?:save|saveAs|export)\s*\(/i);

assert.match(retouch, /\\\.afphoto\$\/i/, 'Retouch Studio must reject paths outside .afphoto');
assert.match(retouch, /ContainerNodeDefinition\.create/);
assert.match(retouch, /CompoundCommandBuilder/);
assert.match(retouch, /doc\.executeCommand\(command\)/);
assert.doesNotMatch(retouch, /\b(?:blur|smooth(?:ing)?|liquify|warp|reshape)\b/i);
assert.doesNotMatch(retouch, /\bdoc\.(?:save|saveAs|export)\s*\(|\bfetch\s*\(/i);

assert.match(quality, /read-only/i);
assert.match(quality, /doc\.colourProfile\.name/);
assert.match(quality, /doc\.currentSpread\.getSpreadBaseBox/);
assert.match(quality, /16-bit \(inferred from format token\)/);
assert.match(quality, /8-bit \(inferred from format token\)/);
assert.match(quality, /Unknown — verify in Document Setup/);
assert.doesNotMatch(quality, /executeCommand|DocumentCommand|\bdoc\.(?:save|saveAs|export)\s*\(|require\(['"]\/(?:fs|filesystem|commands)/i);
assert.doesNotMatch(quality, /console\.log\(path\)/i, 'Quality Guard must not log a full private path');

const forbiddenExtensions = new Set(['.afphoto', '.afdesign', '.afpub', '.cr3', '.dng', '.jpg', '.jpeg', '.png', '.tif', '.tiff']);
function visit(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === '.git')
      continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory())
      visit(path);
    else
      assert.equal(forbiddenExtensions.has(extname(entry.name).toLowerCase()), false, `Private photo/document asset found: ${path}`);
  }
}
visit(root);

const sbom = JSON.parse(readFileSync(join(root, 'SBOM.cdx.json'), 'utf8'));
assert.equal(sbom.bomFormat, 'CycloneDX');
assert.equal(sbom.metadata.component.name, 'Portrait Studio for ChatGPT');
assert.equal(sbom.metadata.component.version, '0.2.2');
assert.deepEqual(sbom.components, [], 'No third-party code or runtime package should be bundled');

const manifest = JSON.parse(readFileSync(join(root, 'plugin.json'), 'utf8'));
assert.equal(manifest.name, 'portrait-studio-for-chatgpt');
assert.equal(manifest.version, '0.2.2');
assert.equal(manifest.extensions['com.openai'].interface.displayName, 'Portrait Studio for ChatGPT');
const mcp = JSON.parse(readFileSync(join(root, 'mcp.json'), 'utf8'));
assert.equal(mcp.mcpServers['portrait-studio'].type, 'stdio');
assert.equal(mcp.mcpServers['portrait-studio'].command, 'node');
const server = readFileSync(join(root, 'server', 'index.mjs'), 'utf8');
const ui = readFileSync(join(root, 'ui', 'studio.html'), 'utf8');
assert.doesNotMatch(server, /\b(?:fetch|XMLHttpRequest)\b|https?:\/\//i);
assert.match(ui, /accept="image\/jpeg,image\/png/);
assert.match(ui, /Download full-resolution PNG/);
assert.match(ui, /uploadFile\(/, 'AI upload must be an explicit UI action');

console.log('Safety contract passed. This does not test the ChatGPT host runtime.');
