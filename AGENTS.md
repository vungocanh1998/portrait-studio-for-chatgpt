# Contributor instructions

## Baseline and scope

- The accepted baseline is V0.2.8. Preserve its working local editing behavior and privacy boundary.
- This repository is public source for an existing PRIVATE plugin. Repository changes do not authorize a new plugin release, a privacy-scope change, Remote MCP deployment, paid hosting, or public product deployment.
- Keep current behavior separate from future plans. Mark every M1–M8 feature as planned until it is implemented and accepted.
- Do not change the live editing architecture during documentation reorganization. Do not create empty directories for future engines.
- Do not edit HLT_DNTT or use HLT AI Bridge.

## Image and session safety

- Do not add user portraits, credentials, session stores, source files, or local exports to GitHub.
- Keep source and reference image bytes in the browser during normal editing. Preserve explicit user action for reference sharing and export.
- Preserve non-overwriting export, PNG integrity checks, source-hash checks, revision checks, and confirmed-preview requirements.
- The ignored synthetic test image may be used locally; never replace it with a user image or add it to the repository.

## Change and verification workflow

- Inspect the current default branch, open PRs, and relevant callers before editing. Preserve newer commits and local work.
- Keep changes focused and use a short-lived branch and reviewable PR. Never force-push.
- Run the syntax checks and regression suites in docs/TESTING-AND-RELEASE.md. The UI-host script is a live browser harness and requires a free loopback port.
- Keep plugin version declarations aligned across manifests, SBOM, MCP serverInfo, and UI appInfo. Run tests/version-consistency.mjs after changing version metadata.
- Do not claim byte-level identity with an existing PRIVATE release after changing source metadata; the source build hash includes these files.
- Report source-test evidence separately from ChatGPT Desktop or release evidence.