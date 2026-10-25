# Testing and release

## V0.2.8 release and verification — 2026-10-25

V0.2.8 is the current PRIVATE release. It adds cross-process locking/reload, a canonical Windows data root, preview-preserving resume, orphan-lock fail-closed diagnostics, and runtime provenance for renderer confirmations. It does not change the session format or image-byte handling.


All five source regression suites passed under Node.js 24.18.0 on Windows on 2026-10-25:

- `node tests/editor-state.mjs`
- `node tests/mcp-contract.mjs`
- `node tests/portrait-engine.mjs`
- `node tests/safety-contract.mjs`
- `node tests/cross-process-state.mjs` starts two MCP processes with different Windows `LOCALAPPDATA` values, checks shared state and confirmation, stale-write conflicts, history, resume, runtime provenance and orphan-lock preservation.

The writer fsyncs file contents before atomic replacement. The Windows runtime does not allow directory fsync (`EPERM`), so directory-entry durability after power loss cannot be asserted there; the diagnostic reports that limitation. Orphaned locks fail closed and require explicit operator recovery.

These automated source suites do not exercise ChatGPT Desktop. Gate 0 was verified separately against the existing v0.2.8 Desktop runtime, as recorded below.

## Chat-to-UI synchronization correction — first shipped in 0.2.6

The current private 0.2.5 package was inspected before editing. Its tool definitions attached `_meta.ui.resourceUri` to `get_editor_state`, `set_color_adjustments`, presets, crop, undo/redo, reset, and export-status calls as well as the explicit open action. OpenAI's MCP App guidance warns that attaching a widget template to every tool call can re-render the iframe too often and recommends resource URIs only on render tools. Since the source bitmap exists only in iframe memory, another mount has metadata but cannot render until the same source is selected again. The host's exact choice between remounting the iframe and notifying an existing one was not exposed by this local MCP result, so the revision-33 pending state proves the renderer did not confirm but does not alone identify which host route occurred.

The source investigation used a synthetic 300 × 300 image only. No session state or image bytes are part of this public source snapshot.

The correction leaves the resource URI on `open_portrait_studio` only, adds an observable `Sync from Chat` action that calls the authoritative `get_editor_state`, rejects stale revisions and other sessions, verifies the selected source hash, deduplicates in-flight renders, and accepts preview confirmation only when the current render's session, revision, renderer, source hash, and pixel hash match. A stale same-revision pending tool notification cannot downgrade a preview already confirmed by the active renderer. No polling was added. `tests/ui-host.mjs` includes a no-notification chat edit followed by a manual Sync control for local browser regression.

The source checks validate tool metadata, stale-revision conflicts, UI script syntax, render/hash guards, session safety, engine pixel operations, export validation and the unchanged synthetic source fixture. Automated source suites do not exercise the production ChatGPT Desktop host. The existing Desktop plugin's source selection, preview confirmation, and saved synthetic PNG were verified separately during Gate 0, recorded below.

## Prior 0.2.5 synthetic local-host evidence

The isolated loopback host ran the actual local MCP server and editor iframe with generated 50 × 50 JPEG and PNG fixtures. It simulates the MCP App result bridge; it is not the ChatGPT production host.

- Chat exposure at +0.3 EV changed the synthetic sample from `[100, 64, 40, 255]` to `[123, 79, 49, 255]`. The PNG and JPEG fixture source SHA-256 values were unchanged (`d6cfe7988c5fde959a9c575cda8e7cc2c6ae7df5fb21b82b345f419cfb5b43c7` and `1fc6cf1336c588a1ba9908b3e3d95ce42d69dc12f6af260931c0ea50af31cff5`).
- A UI exposure change from 0.3 to 0.8 updated the same session at revision 3, changed the sample to `[174, 111, 70, 255]`, and the current preview was confirmed.
- Chat and UI crop controls both set 4:5 on the same session. The 50 × 50 source produced a 40 × 50 preview/export; the original source hash remained unchanged.
- UI Undo and Redo changed the crop state back and forward at new revisions and each resulting preview was confirmed.
- Remount/resume preserved the session ID, edit values, crop, revision, and valid stored preview confirmation. Save still required the active renderer to render and confirm its own preview. Reselecting the exact source matched its SHA-256; a new renderer then confirmed the same revision and 40 × 50 output.
- Local PNG outputs from both input formats existed, had the expected byte counts, matched their reported SHA-256 and decoded pixel SHA-256, and decoded to 40 × 50. The PNG fixture output was 213 bytes; the JPEG fixture output was 1,073 bytes.
- Source registration sent only filename, MIME type, dimensions, byte size and SHA-256 to the MCP process; no image bytes were sent in the registration call.

One browser console entry reported `MutationObserver.observe: parameter 1 is not of type Node` without a source URL. The project contains no `MutationObserver` call, and this entry did not stop the tested UI flows; its origin remains unresolved and must be rechecked in the Desktop host. Tests used synthetic images only. No real portrait or high-resolution image was used.

## Desktop acceptance — Gate 0

Gate 0 was accepted on 2026-10-25 in the existing PRIVATE v0.2.8 Desktop plugin using only a synthetic image. Runtime diagnostics verified the loaded v0.2.8 build/release and confirmed revisions 34, 35, and 36. The final confirmed 4:5 crop rendered at 240 × 300. The actual saved PNG was validated for integrity, dimensions, byte hash, and pixel hash; the synthetic source remained unchanged.

Runtime identifiers, local paths, session IDs, and file hashes are omitted here. Gate 0 covers this synthetic acceptance path only; it does not claim real-image, high-resolution, RAW/CR3, 16-bit, ICC, or EXIF support.

The plugin is local stdio. OpenAI documents local plugins as Desktop-only and scoped to local threads. Ordinary ChatGPT conversations need a separately deployed Remote MCP server; no Remote service has been deployed or verified. See [Desktop-only plugin documentation](https://developers.openai.com/plugins/deploy/desktop-only).

## Scope and privacy limits

- Chat edit calls transfer parameters and source metadata only. On iframe resume the user must reselect the source; its SHA-256 is checked locally before rendering.
- Source/reference image bytes stay in browser memory. The only MCP image transfer is the edited PNG after an explicit Save action. Optional reference analysis separately uploads a reduced reference preview only after the user presses its button.
- Color operations are global and deterministic; there is no selective skin mask, generative face editing, or automatic healing. The manual clone brush is UI-only and is not part of chat Undo/Redo.
- Canvas processing does not guarantee ICC/wide-gamut fidelity or EXIF retention. CR3/RAW and 16-bit editing are out of scope.
- Keep the plugin PRIVATE. Do not describe ordinary ChatGPT MCP Remote as operational until a separate Remote deployment has been verified end to end.
