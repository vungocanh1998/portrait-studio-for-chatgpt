# Portrait Studio for ChatGPT

Version 0.2.8 source for the existing PRIVATE, local-first Portrait Studio plugin. This repository publishes source; it does not publish or change the plugin's privacy settings.

## Supported editing

- Open JPEG and PNG images in the local editor.
- Apply deterministic global color adjustments and presets, crop, undo, and redo from chat or the editor.
- Use the manual clone brush in the editor. It is UI-only and is not part of chat Undo/Redo.
- Keep the source image in browser memory and leave the source file unchanged. An explicit Save writes a verified PNG copy to Downloads through the local MCP process.
- Optionally send a reduced, metadata-free reference preview for color analysis after choosing that action.

## Limits

- Canvas editing operates on 8-bit-per-channel pixels.
- RAW and CR3 input and 16-bit editing are unsupported.
- ICC/wide-gamut fidelity and EXIF retention are not guaranteed.
- Color edits are global; selective skin masks, generative face edits, and automatic healing are unsupported.
- The plugin uses local stdio MCP and is for ChatGPT Desktop local threads. No Remote MCP deployment is included or verified.

## Gate 0

Gate 0 was accepted on 2026-10-25 with a synthetic image in the existing v0.2.8 Desktop runtime. Revisions 34–36 were confirmed; the final 4:5 crop rendered at 240 × 300, the saved PNG was validated, and the synthetic source remained unchanged. No real portraits, session data, or image files are included in this source snapshot.

## Local preview

Requires Node.js and uses built-in modules only.

```powershell
node scripts/preview.mjs
```

Open `http://127.0.0.1:4173`. Run the stdio MCP process through `.mcp.json` with `node server/index.mjs`.

## Source checks

Run the five source suites listed in [testing and release status](docs/TESTING-AND-RELEASE.md). Desktop runtime verification is documented there separately.

## License

MIT. See [LICENSE](LICENSE).
