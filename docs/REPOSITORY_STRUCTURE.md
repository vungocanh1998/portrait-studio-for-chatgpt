# Repository structure

This tree describes tracked public source on the V0.2.8 baseline plus the documentation and test files in this update. It contains no image fixtures, session stores, credentials, local exports, or future placeholder engine directories.

~~~text
.
├── .codex-plugin/
│   └── plugin.json
├── .gitignore
├── .mcp.json
├── AGENTS.md
├── LICENSE
├── NOTICE
├── README.md
├── SBOM.cdx.json
├── docs/
│   ├── ACCEPTANCE.md
│   ├── IMAGE_PIPELINE.md
│   ├── MASTER_ROADMAP.md
│   ├── QUALITY_GUARD.md
│   ├── REPOSITORY_STRUCTURE.md
│   ├── TESTING-AND-RELEASE.md
│   ├── VERSION_POLICY.md
│   └── architecture.md
├── legacy/
│   └── affinity/
│       ├── README.md
│       ├── TESTING-AND-RELEASE.md
│       ├── research.md
│       └── scripts/
│           ├── color-studio.js
│           ├── quality-guard.js
│           └── retouch-studio.js
├── mcp.json
├── plugin.json
├── scripts/
│   └── preview.mjs
├── server/
│   ├── editor-state.mjs
│   └── index.mjs
├── tests/
│   ├── cross-process-state.mjs
│   ├── editor-state.mjs
│   ├── mcp-contract.mjs
│   ├── portrait-engine.mjs
│   ├── safety-contract.mjs
│   ├── ui-host.mjs
│   └── version-consistency.mjs
└── ui/
    ├── engine.js
    └── studio.html
~~~

## Roles

- plugin.json and .codex-plugin/plugin.json describe the plugin and its host metadata.
- .mcp.json configures the local stdio server. mcp.json is retained as existing repository metadata.
- server/ contains the local MCP process and persistent editor-session logic.
- ui/ contains the MCP App editor and deterministic image engine.
- tests/ contains dependency-free source checks and the local synthetic browser harness.
- scripts/preview.mjs serves the editor for local preview.
- docs/ records current architecture, planned milestones, quality safeguards, acceptance, testing, and version policy.
- legacy/affinity/ preserves archived material and is not the active editing engine.

Add implementation directories only when an accepted milestone needs actual source files.