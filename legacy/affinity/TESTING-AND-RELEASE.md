# Testing and release

## Current validation — 2026-10-21

- Affinity build observed: `Mid October '26 (4940)`. The SDK documentation currently identifies version 3.3.1 as beta.
- The app's **Enable Affinity Scripting** setting is off. Scripts cannot be run until the owner enables it manually. No app security setting was changed.
- Static checks passed: JavaScript syntax checks for all three scripts and `node tests/safety-contract.mjs` (current repository safety checks cover the active ChatGPT app package).
- Source audit passed: the committed tree contains no portrait, RAW, or Affinity document assets; no secret-pattern matches were found; MIT license is present; CycloneDX SBOM lists no bundled third-party components.
- **Not runtime accepted:** SDK wrapper availability, layer creation/placement, visible parameter values, Quality Guard output, and single-step Undo have not been exercised.

## Windows 11 smoke test

Use a disposable blank `.afphoto` or a separate copy of a non-sensitive test document. Do not open or save over a CR3. Keep the Affinity file-system, network, Canva AI, and dynamic-code permissions disabled for these scripts.

1. In Affinity Settings → Scripting, enable Affinity Scripting manually. Review each source file before importing it into Script Editor and Scripts Library.
2. Run `APS Quality Guard`. Confirm it reports only the document basename, format, profile, DPI, bounds, and dirty state. Check the reported bit depth against Document Setup; unfamiliar tokens must remain “unknown”.
3. Run `APS Color Studio`, choose a low value, and inspect the Layers panel. Confirm a Vibrance adjustment is present, can be toggled/edited, and a single `Ctrl+Z` removes the complete operation. Redo once and confirm the document returns to the same state.
4. Run `APS Retouch Studio`. Confirm the named group and three subgroups appear, and a single `Ctrl+Z` removes the complete group operation. Redo once. No brush strokes should be created by the script.
5. Run Quality Guard again. Confirm the file path, format, bit depth, ICC/profile, DPI, and canvas bounds did not change because of the scripts. Confirm the document is dirty after edits and clean after undoing them all.
6. Test the edit scripts against an unsaved document and a non-`.afphoto` path. Confirm they stop before changing the document.
7. Crop manually with Affinity's Crop Tool. Confirm the result is reversible and no resampling/downscaling occurred. The SDK script does not crop.
8. Save the working result as a new `.afphoto`. Compare the original CR3's SHA-256 before/after; the source must remain unchanged.

Record the Affinity build, operating system, script result, layer names, undo/redo outcome, displayed format/bit-depth token, profile, and bounds. Do not attach portrait files or screenshots containing personal information to an issue or public repository.

## Release gates

### 0.1.0 — private MVP

Source, README, official SDK capability review, MIT license, CycloneDX SBOM, and static safety test are prepared. This is not runtime accepted and must not be described as a verified Affinity extension.

### 0.2.0 — runtime accepted

- Complete the smoke test above on the target Windows 11/Affinity build.
- Fix any wrapper, command-builder, parameter, or layer-order incompatibility found; rerun all static checks and the affected runtime checks.
- Update capability notes from observed evidence. Keep LUT loading and crop automation manual unless the SDK documents and runtime verifies them.
- Record that originals remain unchanged and that each scripted edit has the expected undo behavior.

### 1.0.0 — compatibility release

- Repeat the smoke test on the then-current Affinity release and one clean Windows 11 profile.
- Recheck source history, license/notice, SBOM, sensitive-data scan, and reproducible package contents.
- Publish only after runtime acceptance and a separate owner decision to make the repository public.
