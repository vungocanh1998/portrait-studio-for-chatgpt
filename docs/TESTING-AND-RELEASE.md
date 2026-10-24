# Testing and release

## Current validation — 2026-10-24

- Verified the project source is based on commit 7932e42 from vungocanh1998/affinity-portrait-studio.
- Added dependency-free checks for crop bounds, color filter values, the MCP tool/resource contract, and the repository safety contract.
- Plugin Creator's latest release is version 0.2.2 with PRIVATE user scope. The registered `open_portrait_studio` launch tool responds.
- The ChatGPT-hosted editor UI, JPEG/PNG visual round-trip, browser download, manual clone strokes, and ChatGPT reference suggestions are not yet runtime verified. The Codex browser could not reach the loopback preview, and its security policy blocked local file URLs, so do not claim those checks passed.

## Local browser smoke test

Use a synthetic or disposable JPEG/PNG file. Do not put photos or EXIF samples in the repository.

1. Start node scripts/preview.mjs and open http://127.0.0.1:4173.
2. Select a JPEG and a PNG in separate runs. Confirm both render, color changes update the After preview, and Before remains unchanged.
3. Set a crop and confirm the displayed output dimensions match the selected region.
4. In Retouch, choose a clone source, paint a short stroke, undo it, and clear strokes. Confirm no face geometry changes are automated.
5. Download PNG and compare its dimensions with the crop readout. Confirm the source file's byte hash is unchanged.
6. In ChatGPT Desktop, install and launch the private plugin. Confirm the MCP tool opens the same UI and repeat a JPEG/PNG round trip.
7. Select a reference image, use the explicit ChatGPT suggestion action, and confirm ChatGPT receives a reduced PNG copy of the reference only. Confirm the model suggests values without editing pixels automatically.
8. Check that the app displays unsupported type, size, and image-dimension errors without changing the existing source.

Record the browser and ChatGPT Desktop versions, test image dimensions, export dimensions, and observed results. Do not attach real portrait files or screenshots containing personal information to the repository.

## Release gates

### 0.2.2 — private ChatGPT Desktop MVP

- [x] Source, local plugin manifest, MCP UI resource, dependency-free checks, privacy boundary, and README are prepared.
- [x] Create the private plugin and verify the registered launch tool responds.
- [ ] Render the app UI in ChatGPT Desktop.
- [ ] Complete the JPEG/PNG browser round trip and inspect a downloaded PNG.
- [ ] Verify explicit reference upload and AI suggestion behavior in ChatGPT.

### 0.3.0 — evaluated image workflow

- Exercise representative JPEG/PNG dimensions and orientation cases on the supported desktop runtime.
- Decide whether ICC profile preservation and TIFF export are needed before adding them.
- Keep CR3/16-bit support out of scope until a suitable RAW engine is selected and tested.

### Public distribution

Do not submit this local MCP package publicly without the partner approval and review required for desktop-only local MCP plugins. Public distribution would also require a separate owner decision and a stable hosting plan if the architecture changes to remote hosting.
