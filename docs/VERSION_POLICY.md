# Version policy

## Current source version

The current source version is 0.2.8. Root plugin.json is the canonical source value. Keep these declarations aligned:

- plugin.json version.
- .codex-plugin/plugin.json version.
- SBOM.cdx.json metadata component version.
- server/index.mjs MCP initialize serverInfo.version.
- ui/studio.html MCP App appInfo.version.

The server reads the root manifest for runtime diagnostics, while MCP initialize and UI initialize each expose their own protocol version field. Keep all five declarations equal.

Run tests/version-consistency.mjs after changing version metadata. It reads the canonical value from plugin.json and checks the other four declarations. Historical references to V0.2.5, V0.2.6, or V0.2.7 in release history and tests are valid when clearly labeled historical.

## Release rules

- Keep the existing PRIVATE plugin scope. A public source commit does not publish, update, or change the privacy setting of a plugin release.
- Do not silently create a release or claim that source matches a previously uploaded artifact byte-for-byte.
- server/index.mjs includes source files in its build hash. Changing version literals changes that hash even when behavior is unchanged.
- Any future plugin release or Remote MCP deployment requires a separate owner decision and its own verification.
- Version changes must be deliberate, consistent, tested, and documented in the release history.