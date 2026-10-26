# Testing and release

## Current baseline and release status

V0.2.8 is the current accepted PRIVATE plugin baseline. Gate 0 was accepted on 2026-10-25 using a synthetic image in ChatGPT Desktop: revisions 34–36 were confirmed, a 4:5 crop rendered at 240 × 300, the saved PNG was validated, and the source remained unchanged.

This repository update aligns the MCP server and editor host version fields with the existing 0.2.8 manifests, adds a version-consistency check, makes the safety test work when the ignored synthetic fixture is absent, and reorganizes source documentation. It does not create a plugin release. Source metadata changes alter the runtime source build hash, so this commit does not claim byte-level identity with the existing PRIVATE release.

## Source syntax and regression checks

The project uses Node.js built-ins and has no test-runner dependency. Run from the repository root:

~~~powershell
$syntaxFiles = @(
  'server/index.mjs',
  'server/editor-state.mjs',
  'scripts/preview.mjs',
  'ui/engine.js',
  'tests/editor-state.mjs',
  'tests/mcp-contract.mjs',
  'tests/portrait-engine.mjs',
  'tests/safety-contract.mjs',
  'tests/cross-process-state.mjs',
  'tests/ui-host.mjs',
  'tests/version-consistency.mjs'
)
foreach ($file in $syntaxFiles) {
  node --check $file
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

$testFiles = @(
  'tests/editor-state.mjs',
  'tests/mcp-contract.mjs',
  'tests/portrait-engine.mjs',
  'tests/safety-contract.mjs',
  'tests/cross-process-state.mjs',
  'tests/version-consistency.mjs'
)
foreach ($file in $testFiles) {
  node $file
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
~~~

The safety contract validates the known 300 × 300 synthetic fixture and its approved hash when that ignored file is present locally. It also passes when the fixture is absent, so clean public checkouts do not need to contain an image.

## Local browser harness

tests/ui-host.mjs starts a local MCP process and an interactive loopback page. It is not a one-shot test: keep the server running while the browser is open, then stop it with Ctrl+C. Select a free port if the default port 4174 is already in use:

~~~powershell
$env:PORTRAIT_STUDIO_TEST_PORT = '54123'
node tests/ui-host.mjs
~~~

Open http://127.0.0.1:54123 and exercise the synthetic PNG flow: open a session, load the image, change color through chat without a widget notification, use Sync from Chat, crop to 4:5, apply the synthetic clone stroke, save, and verify the saved file. The harness displays the saved PNG’s dimensions, byte count, byte hash, pixel hash, and whether the source stayed unchanged. It simulates the local MCP app bridge; it is not the production ChatGPT Desktop host.

## Verification performed for this source update

On 2026-10-26 under Node.js 24.18.0 on Windows:

- Node syntax checks passed for server, UI engine, preview script, and all test scripts.
- Editor-state, MCP contract, portrait engine, safety contract, cross-process state, and version-consistency checks passed.
- The safety contract passed both without the ignored image fixture and with the local approved synthetic fixture.
- The browser harness passed in headless Chrome with a generated 50 × 50 synthetic PNG. A no-notification chat edit synchronized at revision 3; crop output was 40 × 50; the clone stroke changed the target pixel; the saved 319-byte PNG passed byte and pixel hash checks; no browser page errors were reported.

These checks do not repeat Gate 0 or certify a newly loaded Desktop plugin release. No production Desktop release or Remote MCP deployment was performed.

## Earlier V0.2.5 local-host evidence

A prior isolated local-host run used generated 50 × 50 JPEG and PNG images to check color changes, crop, undo/redo, save integrity, and source preservation. That harness simulated the MCP app bridge and did not establish production ChatGPT Desktop behavior.

## Scope and privacy limits

- Keep the plugin PRIVATE. Public source documentation and repository changes do not change plugin privacy or publish a release.
- Do not commit user portraits, credentials, session stores, source images, or local exports. The automated UI harness generates synthetic pixels in memory.
- The current Canvas pipeline is 8-bit and does not guarantee ICC/wide-gamut fidelity or EXIF retention. RAW/CR3 and 16-bit editing are out of scope.
- The existing plugin is local stdio for supported ChatGPT Desktop local threads. Ordinary ChatGPT conversations require a separately verified Remote MCP deployment; none is included here.