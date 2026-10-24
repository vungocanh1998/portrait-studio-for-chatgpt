# Portrait Studio for ChatGPT

**MVP 0.2.2 · private local MCP app · ChatGPT Desktop**

Portrait Studio for ChatGPT is a deterministic browser editor for JPEG and PNG portraits. It provides color preview, a manual clone brush, crop controls, before/after comparison, and full-resolution PNG export. The original file stays unchanged.

## Current scope

- **Color:** Natural, Warm, Cool, and Monochrome presets with an intensity slider.
- **Retouch:** Manual clone brush that copies existing pixels. There is no automatic skin smoothing, face reshaping, or image reconstruction.
- **Crop:** Percentage-based crop controls; export keeps the chosen crop at its native pixel dimensions.
- **Quality:** Preview is reduced for display only. Download is a separate PNG using lossless encoding, with no extra lossy compression or silent resizing.
- **AI reference suggestions:** Only the optional reference image is shared with ChatGPT, and only after the user clicks the suggestion button. The app creates a metadata-free PNG preview capped at 1200 pixels on its longest edge. ChatGPT suggests values in the conversation; the user decides whether to apply them.

The local MCP process serves the app UI and never receives image bytes, filenames, or filesystem paths. Browser Canvas exports omit EXIF metadata and use an 8-bit display color pipeline. JPEG and PNG files up to 60 MB and 80 megapixels are accepted. CR3, TIFF export, 16-bit workflows, and wide-gamut color fidelity are not supported or verified in this MVP.

## Run locally

1. Open the private **Portrait Studio for ChatGPT** plugin in ChatGPT Desktop.
2. Launch **Portrait Studio** in a conversation, then choose a JPEG or PNG.
3. Choose a JPEG or PNG, then adjust Color, Retouch, Crop, or Quality.
4. Use **Download full-resolution PNG** to save a separate result.

No external server, API key, or third-party image service is used. The included MCP server runs over local stdio and only returns the app UI. The AI suggestion button uses ChatGPT's built-in model and uploads only a reduced, metadata-free reference preview when clicked.

For a browser-only visual check before installing the plugin:

~~~powershell
node .\scripts\preview.mjs
~~~

Then open http://127.0.0.1:4173. This loopback preview server serves only the editor page and does not receive image files.

## Project files

- plugin.json and mcp.json — private plugin metadata and local stdio MCP configuration.
- server/index.mjs — small, dependency-free MCP process; serves a single UI resource and launch tool.
- ui/studio.html and ui/engine.js — interactive editor and deterministic crop/color calculations.
- scripts/preview.mjs — loopback-only UI preview for local testing.
- tests/portrait-engine.mjs, tests/mcp-contract.mjs, tests/safety-contract.mjs — crop/color, MCP, and safety checks.
- legacy/affinity/ — archived Affinity scripts and their original usage notes.
- docs/architecture.md — supported ChatGPT App architecture, privacy boundary, and verified limitations.
- docs/TESTING-AND-RELEASE.md — validation and release gates.
- SBOM.cdx.json, LICENSE, NOTICE — dependency inventory, license, and product notices.

## Checks

Run from this folder:

~~~powershell
node --check .\server\index.mjs
node --check .\ui\engine.js
node .\tests\portrait-engine.mjs
node .\tests\mcp-contract.mjs
node .\tests\safety-contract.mjs
~~~

The private plugin was created in Plugin Creator, and its launch tool responds. The ChatGPT-hosted editor UI and JPEG/PNG export still need a smoke test with disposable files. See [Testing and release](docs/TESTING-AND-RELEASE.md).

## License

Original project source is MIT-licensed. ChatGPT, OpenAI, Canva, and Affinity names and marks belong to their respective owners; this independent project is not affiliated with or endorsed by them. See [NOTICE](NOTICE).
