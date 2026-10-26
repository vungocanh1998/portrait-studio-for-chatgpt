# Acceptance criteria

## Gate 0 — V0.2.8 baseline — ACCEPTED

Accepted on 2026-10-25 in the existing PRIVATE Desktop plugin with a synthetic image. Revisions 34–36 were confirmed, the final 4:5 crop rendered at 240 × 300, the saved PNG was validated, and the source image remained unchanged. This acceptance is limited to that synthetic Desktop flow.

V0.2.8 source checks cover editor state, MCP contracts, image engine, publication safety, cross-process behavior, and the local UI-host harness. They do not certify real portraits, large files, RAW/CR3, 16-bit, ICC, EXIF, or Remote MCP.

## Planned milestone acceptance

### M1 — Shared Editing Engine + White Balance — PLANNED

- Edits preserve the source and can be undone and redone through one shared state.
- Extend the current color/crop session state and history to layers and masks; editor, chat, and rendered output stay consistent.
- The professional color pipeline has documented input and output behavior.
- Auto, As Shot, Custom, Eyedropper, Temperature, and Tint White Balance paths produce reviewable, repeatable results.

### M2 — Color Studio — PLANNED

- Advanced exposure and tone, HSL, Tone Curves, and Creative Grading changes render and participate in shared history.
- Local Highlight Recovery starts at strength 45% and feather 65%, with skin protection ON.
- Recovery changes preserve the user’s ability to review and undo the result.

### M3 — Quality & Enhance Studio — PLANNED

- Diagnostics identify supported source-quality conditions with reproducible tests.
- Denoise, Sharpen, Deblur, and compression repair have documented controls and output checks.
- AI Upscale is included only after evaluation and quality acceptance.
- PPI, print size, ICC, bit depth, and export-quality choices are reflected in the saved artifact.

### M4 — Retouch Studio — PLANNED

- Healing, Clone, Patch, skin and beauty retouch, digital makeup, and hair/clothing cleanup have undoable, reviewable results.
- Defaults are Brush 24 px, Strength 35%, and Hardness 25%.
- Texture and facial identity protection are ON by default and covered by tests.

### M5 — Chat Guidance & Reference Match — PLANNED

- The editor image and optional chat reference are clearly distinguished.
- Analysis returns actionable settings without silently changing pixels.
- Apply Suggested Settings requires user review and explicit action.
- Chat and editor state remain synchronized under delayed or missing notifications.

### M6 — Creative Lighting — PLANNED

- Golden Hour, Window Light, Backlight, and Sun Flare can be reviewed and undone.
- Directional controls and subject protection behave predictably across the supported image area.

### M7 — Crop & Composition — PLANNED

- Crop, rotate, straighten, and guides match the user’s selected geometry.
- Export dimensions exactly match the resulting native-resolution canvas and selected crop.

### M8 — Remote MCP — PLANNED

- Ordinary ChatGPT conversations can use the editor through a documented, authenticated remote flow.
- Privacy, authorization, session synchronization, and remote-compatible export pass security and end-to-end acceptance.
- Remote deployment remains a separate owner decision; this roadmap does not authorize deployment.