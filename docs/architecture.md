# Architecture and supported platform

Current architecture: V0.2.8, the accepted local-first baseline. The milestone plan is documented in MASTER_ROADMAP.md; every M1–M8 feature remains planned until separately implemented and accepted.


## MCP tools and editor UI

The existing plugin source keeps one local stdio MCP server and one MCP App resource at `ui://portrait-studio-for-chatgpt/studio-chat-control.html`. The server publishes chat-facing actions for opening/listing a session, reading state, setting color values or a preset, cropping, resetting, undoing/redoing, and checking export status. The UI-only actions register the selected image metadata, confirm a rendered preview, and save an edited PNG; they are marked app-only in tool metadata.

Only `open_portrait_studio` attaches the MCP App resource URI; data and edit tools return state without asking the host to mount another widget. The editor can receive chat results through `ui/notifications/tool-result`, but correctness does not depend on those notifications being broadcast to every mounted iframe. `Sync from Chat` calls `get_editor_state` through the active editor bridge and reconciles against the local session. `window.openai.widgetState` is only a session hint. It is not authoritative and does not carry image pixels. See the [ChatGPT UI documentation](https://developers.openai.com/plugins/build/chatgpt-ui) and [MCP extensions specification](https://github.com/openai/mcp-extensions/blob/main/docs/spec.md).

## Session and edit flow

- The local MCP process persists session metadata, source SHA-256, dimensions, adjustment values, crop, history, revision, preview confirmation, and export metadata under `.portrait-studio-for-chatgpt/sessions.json` in the user's local application data directory. It does not persist source or reference bytes.
- Every MCP tool read or mutation reloads the persisted store while holding the adjacent exclusive lock. Mutations compare `expectedRevision` after that reload. Writes fsync a temporary file before atomic replacement and attempt to fsync the containing directory where supported. Packaged Windows `LOCALAPPDATA` paths resolve to the same canonical store as the plain Desktop process.
- Orphaned or unreadable lock files are reported and block writes. The server never removes a lock automatically; an operator must verify its owner is stopped before recovery. `get_runtime_diagnostics` reports the server version/build hash, executable and script paths, PID/instance ID, store path, lock owner, session revision/preview, and recent renderer confirmations without returning source bytes or file contents.
- A source is decoded and edited in the browser. When an iframe remounts, the UI asks the user to select the source again and checks its SHA-256 against the selected session before rendering. This avoids assuming iframe memory survives. Chat results for another session and older revisions are rejected; source hashes must match before a preview can render.
- Chat and UI edits use the same local session record. Every mutation includes the exact session ID and expected revision. A stale revision returns a conflict without applying the change.
- An edit tool result means parameters were accepted. The After preview remains pending until the active browser renderer produces the current revision and calls the internal preview confirmation action. Duplicate in-flight renders for a revision are shared, and confirmation must match the active render's pixel hash, session, renderer and revision. Resuming a session preserves a valid confirmation for its unchanged revision; a remounted renderer still must render and confirm its own preview before Save becomes available. `Sync from Chat` checks the latest server revision and runtime provenance before reporting success.
- The server returns structured state with `sessionId`, `revision`, source metadata, adjustment values, preset, crop, undo/redo availability, preview/export status, warnings, and errors. The app sends compact state to model context only when the host supports the update method.
- Natural-language deltas are translated by the model using the tool descriptions and the latest inspected values. For example, an exposure increase of 0.3 EV is current exposure plus 0.3, clamped to -5..+5. There is no separate nondeterministic edit engine or face-generation step.

Color controls use deterministic canvas pixel operations. They change pixels but not face geometry or the selected source file. Color is global: there is no skin mask, and this phase does not implement healing or generative retouching. The manual clone brush remains a UI-only operation and is not included in chat Undo/Redo history; chat history covers color and crop state.

## Local-first image and export flow

Source and reference images remain in browser memory during normal editing. The MCP process receives source metadata only. Reference analysis is a separate explicit action: pressing “Ask ChatGPT for a color suggestion” uploads a reduced, metadata-free preview of the user-selected reference. Chat edits do not upload source or reference pixels.

Only after the user presses “Save edited PNG” does the browser send the rendered output PNG to the local MCP process. The process validates PNG structure and dimensions, writes a new non-overwriting file in Downloads, reads it back, checks byte count and SHA-256, decodes its pixels, and records the pixel SHA-256. The UI also compares saved pixel data to the rendered canvas before showing success. The source file is not overwritten. Cropping changes the exported dimensions to the selected region; there is no silent resolution reduction.

This is a local stdio plugin. OpenAI documents local plugins as available in supported ChatGPT Desktop local threads. The source does not deploy an MCP Remote service; ordinary ChatGPT conversation availability must not be inferred from local Desktop behavior. See [Desktop-only plugins](https://developers.openai.com/plugins/deploy/desktop-only).

## Processing limits

The canvas path uses the browser's 8-bit display color pipeline and does not preserve EXIF metadata, 16-bit depth, or guaranteed wide-gamut/ICC fidelity. CR3/RAW processing is outside this task. Source and reference bytes are never stored in the local session file.

## Dependencies

The MCP process uses Node.js built-ins. The editor uses browser-standard Canvas, File, and Blob APIs. No new runtime dependency or hosted image service is required.


## Roadmap boundary

V0.2.8 uses the local MCP server, browser Canvas editor, deterministic global color controls, crop, manual clone brush, edit history, preview confirmation, and verified PNG export described above. M1 extends the current color/crop session state and history into a shared layer and mask engine. Expanded color and quality studios, guided retouch, lighting, composition tools, and Remote MCP are planned in the master roadmap, not current functionality. No empty future engine directories are part of this repository structure.
