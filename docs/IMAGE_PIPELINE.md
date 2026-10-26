# Image pipeline

This document separates the V0.2.8 pipeline from proposed future processing. The M1–M8 pipeline work is planned, not implemented.

## Current V0.2.8 flow

1. The user selects a JPEG or PNG in the editor. The source bytes are decoded and kept in browser memory.
2. The local MCP process receives source metadata, dimensions, and a SHA-256 source identifier for session checks. Normal editing does not send source pixels to the process.
3. Chat and editor changes update the same local session using an expected revision. A stale revision is rejected.
4. The browser renders deterministic global color adjustments and crop. A preview remains pending until the active renderer confirms the matching session, source, revision, and pixel hash.
5. Reference analysis is a separate action. Only after the user asks for a suggestion does the editor send a reduced, metadata-free preview of the selected reference to ChatGPT.
6. Only after an explicit Save action does the editor send the edited PNG to the local process. The process writes a new non-overwriting file, reads it back, validates its bytes and pixels, and reports success only after those checks.

Canvas processing uses the browser’s 8-bit display color path. Current source editing does not provide RAW/CR3 processing, 16-bit depth, guaranteed ICC/wide-gamut fidelity, or EXIF retention. Crop changes output dimensions to the selected area; the editor does not silently resize the export.

## Planned pipeline work

- **M1 — Shared Editing Engine:** replace isolated control behavior with a shared non-destructive edit state, layer and mask engine, history, and professional color processing pipeline.
- **M2 — Color Studio:** add advanced exposure and tone, HSL, Tone Curves, Creative Grading, and local highlight recovery with the roadmap defaults.
- **M3 — Quality & Enhance Studio:** add quality diagnostics and evaluated enhancement operations, print sizing, ICC, bit depth, and export quality controls.
- **M4 — Retouch Studio:** add healing and retouch operations with the roadmap’s texture and facial identity protections enabled by default.
- **M5 — Chat Guidance & Reference Match:** connect optional references and suggested settings while requiring user review and reliable state synchronization.
- **M6 — Creative Lighting:** add directional lighting effects with subject protection.
- **M7 — Crop & Composition:** extend transforms and guides while preserving exact native-resolution output.
- **M8 — Remote MCP:** design the transport, authentication, privacy, session, and export boundaries for remote use.

Do not describe these planned stages as available in V0.2.8. See [Master roadmap](MASTER_ROADMAP.md) and [Acceptance](ACCEPTANCE.md).