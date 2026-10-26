# Portrait Studio for ChatGPT

Version 0.2.8 source for the existing PRIVATE, local-first Portrait Studio plugin. This public repository documents and maintains source; it does not publish a plugin release or change the plugin’s privacy scope.

## Current editing

- Open JPEG and PNG images in the local editor.
- Apply deterministic global color adjustments and presets, crop, undo, and redo from chat or the editor.
- Use the manual clone brush in the editor.
- Keep the source image in browser memory and leave the source file unchanged. An explicit Save writes a verified PNG copy to Downloads through the local MCP process.
- Optionally share a reduced, metadata-free preview of a user-selected reference with ChatGPT for color suggestions.

## Limits

- Canvas editing uses an 8-bit-per-channel display color pipeline.
- RAW and CR3 input, 16-bit editing, guaranteed ICC or wide-gamut fidelity, and EXIF retention are unsupported.
- Color edits are global. Selective skin masks, automatic healing, and generative face edits are not part of V0.2.8.
- The plugin uses local stdio MCP in supported ChatGPT Desktop local threads. Remote MCP deployment is not included.

## Status

Gate 0 was accepted on 2026-10-25 using a synthetic image in the existing V0.2.8 Desktop runtime. The final 4:5 crop rendered at 240 × 300, the saved PNG was validated, and the synthetic source remained unchanged. This evidence does not claim support for real portraits, high-resolution files, RAW/CR3, 16-bit, ICC, or EXIF workflows.

M1 — Shared Editing Engine + White Balance — is the next planned milestone. All M1–M8 items are plans; they are not implemented features. See the [master roadmap](docs/MASTER_ROADMAP.md), [architecture](docs/architecture.md), and [testing and release policy](docs/TESTING-AND-RELEASE.md).

## Local preview and checks

Requires Node.js and uses built-in modules for the MCP server. Run the local preview with:

~~~powershell
node scripts/preview.mjs
~~~

Open http://127.0.0.1:4173. The full source checks and the interactive UI-host harness are documented in [Testing and release](docs/TESTING-AND-RELEASE.md).

## License

MIT. See [LICENSE](LICENSE).