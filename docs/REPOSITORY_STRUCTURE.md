# Repository structure

This tree describes tracked public source on the V0.2.8 baseline plus the accepted PR1/PR2 source and current documentation and test files. It contains no image fixtures, session stores, credentials, local exports, or future placeholder engine directories.

~~~text
.
├── .github/
│   └── workflows/
│       └── ci.yml
├── .codex-plugin/
│   └── plugin.json
├── .gitignore
├── .mcp.json
├── AGENTS.md
├── LICENSE
├── NOTICE
├── package.json
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
│   ├── check.mjs
│   ├── offline-atomic-move.ps1
│   └── preview.mjs
├── server/
│   ├── edit-document.mjs
│   ├── editor-state.mjs
│   ├── index.mjs
│   └── offline-session-migration.mjs
├── tests/
│   ├── cross-process-state.mjs
│   ├── editor-state.mjs
│   ├── edit-document.mjs
│   ├── fixtures/
│   │   └── m1-g2-pr1.json
│   ├── mcp-contract.mjs
│   ├── offline-session-migration.mjs
│   ├── portrait-engine.mjs
│   ├── safety-contract.mjs
│   ├── ui-host.mjs
│   ├── version-consistency.mjs
│   └── windows-appdata-fallback.mjs
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
- scripts/check.mjs runs the syntax and regression checks shared by `npm run check` and CI; scripts/preview.mjs serves the editor for local preview.
- .github/workflows/ci.yml runs `npm run check` on pull requests using Windows and Node.js 24.
- docs/ records current architecture, planned milestones, quality safeguards, acceptance, testing, and version policy.
- legacy/affinity/ preserves archived material and is not the active editing engine.

Add implementation directories only when an accepted milestone needs actual source files.
