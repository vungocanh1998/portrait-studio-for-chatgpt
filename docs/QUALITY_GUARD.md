# Quality and safety guard

This guard records current V0.2.8 protections and required defaults for planned work. Planned controls are not currently available.

## Current V0.2.8 protections

- The original source file is never overwritten. Saving creates a separate PNG only after an explicit user action.
- Source and reference bytes stay in browser memory during normal editing. Reference sharing is an explicit action and uses a reduced, metadata-free preview.
- Edit calls target an exact session and revision. Stale updates are rejected.
- A save is unavailable until the current renderer confirms the current revision. Confirmation includes matching source and rendered-pixel identity.
- The MCP process validates the saved PNG, dimensions, byte count, and hashes before reporting success.
- Orphaned or unreadable session locks fail closed. The server does not remove a lock automatically.
- V0.2.8 color edits are global and deterministic. Automatic face edits, selective skin masks, and automatic healing are outside current scope.

## Required planned safeguards

- **M1:** make edits non-destructive; keep shared state, layers, masks, and history consistent across tools.
- **M2:** local highlight recovery defaults to strength 45%, feather 65%, and skin protection ON.
- **M3:** evaluate AI Upscale carefully before inclusion; expose quality, PPI, print-size, ICC, bit-depth, and export-quality settings clearly.
- **M4:** healing defaults to Brush 24 px, Strength 35%, and Hardness 25%. Texture and facial identity protection must be ON by default.
- **M5:** keep reference selection optional. Show suggested changes for user review and require an explicit Apply action.
- **M6:** protect the subject when applying directional light.
- **M7:** preserve exact native-resolution output unless the user explicitly selects a crop or transform that changes dimensions.
- **M8:** require authentication, privacy, session-sync, and export checks before remote use is accepted.

## Review rule

Acceptance must verify both the resulting image behavior and the source/privacy boundary. Use synthetic images for automated and integration tests. Do not commit user images, credentials, private session data, or local exports.