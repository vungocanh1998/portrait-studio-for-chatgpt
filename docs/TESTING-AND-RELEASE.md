# Testing and release

## Current baseline and release status

V0.2.8 is the current accepted PRIVATE plugin baseline. Gate 0 was accepted on 2026-10-25 using a synthetic image in ChatGPT Desktop: revisions 34–36 were confirmed, a 4:5 crop rendered at 240 × 300, the saved PNG was validated, and the source remained unchanged.

This repository update aligns the MCP server and editor host version fields with the existing 0.2.8 manifests, adds a version-consistency check, makes the safety test work when the ignored synthetic fixture is absent, and reorganizes source documentation. It does not create a plugin release. Source metadata changes alter the runtime source build hash, so this commit does not claim byte-level identity with the existing PRIVATE release.

## Source syntax and regression checks

The project uses Node.js built-ins and has no test-runner dependency. From the repository root on Node.js 24, run the same check used by CI:

~~~powershell
npm run check
~~~

This checks syntax for the server, scripts, UI engine and test files, then runs the editor-state, EditDocument, offline migration/rollback, isolated shared renderer/epoch, inactive PR5 PNG integrity/transaction, MCP contract, portrait engine, safety contract, cross-process state, Windows app-data fallback and version-consistency suites. It stops at the first failure. The UI-host script is syntax-checked here but its interactive browser smoke remains separate. CI retains the full `npm run check` run on Windows and runs both `node tests/offline-session-migration.mjs` and `node tests/session-bound-export.mjs` on Ubuntu. Linux still executes POSIX crash-recovery/hostile-alias checks, while PR5 tests verify native-size PNG bytes/pixels, provenance, stale renderer/revision failure and cross-process lock coordination on both operating systems.

The safety contract validates the known 300 × 300 synthetic fixture and its approved hash when that ignored file is present locally. It also passes when the fixture is absent, so clean public checkouts do not need to contain an image.

The check runner simulates a hostile parent data-directory override and verifies that each child receives its own generated temporary `PORTRAIT_STUDIO_DATA_DIR`; the sentinel stays unchanged. The cross-process state suite repeats that check for its MCP children, confirms they share one synthetic store, and checks an external sentinel directory. The EditDocument suite reads a synthetic V1 store created under an OS temp directory and checks a frozen V2 model, strict read-only adaptation, revision/history contracts and unchanged input bytes. It never calls EditorSessions or its writer. The offline migration suite uses only generated temp stores and forces every child to synthetic home/app-data roots while passing a hostile PORTRAIT_STUDIO_DATA_DIR with an unchanged sentinel. It checks strict V1/V2 schemas, path and lock refusal, quiescence loss, competing writers, byte-exact backups, digest failures, crash/recovery points, rollback archives and the V2-edit-loss notice. It never reads a default or real app-data path. A text fixture pins legacy RGBA8 pixels, native crop pixels and synthetic source RGBA8 hash/immutability. PR4 adds **inactive** neutral-pixel parity, active Float64 White Balance/masked layer tests, bounded 5×5 source eyedropper rejection, EditDocument undo/redo reuse and cross-process renderer-epoch invalidation with synthetic paths. The fixture's future-contract flags remain `implemented: false` because no new controls are active in the PRIVATE runtime. End-to-end browser clone/preview/native-size PNG pixel parity and real session/export atomic coupling still require separate integration tests.

PR5 synthetic tests exercise the inactive `server/session-bound-export.mjs` against newly created `sessions.json`, output PNGs and provenance sidecars under system-generated temporary directories. The tests pin byte-for-byte PNG and decoded pixel SHA-256, bind native export pixels to the confirmed preview metadata, source/revision/renderer/build/pipeline, second-process remount, exclusive renderer registration lock, non-overwrite saves and V1 schema compatibility, while checking that a hostile parent data directory's sentinel is not touched. `server/index.mjs` and `ui/studio.html` remain unmodified; the MCP regression retains its legacy **detached** `save_edited_png` success case. The new PNG/provenance transaction is inactive and does not certify a Desktop release or provide crash-atomic multi-file commit/recovery or a cryptographic attestation. The M1 activation post-worker hardening verifies the pinned output directory and both just-written inode identities again **in the parent immediately before** `recordExport`, with synthetic regression injecting an actual POSIX directory rename/symlink swap at the worker-return/record gap. The regression requires refusal with unchanged V1 session bytes and an untouched replacement-directory sentinel. On Windows, where the held handle ordinarily blocks directory rename, a synthetic commit-boundary abort verifies owned-file cleanup. A separate worker-only synthetic test leaves a PNG/provenance pair deliberately **unrecorded** and confirms the V1 store has no saved export; this documents a possible crash orphan, **not** automatic recovery.

**Activation remains blocked:** an uncooperative POSIX process could still rename the directory after the new parent check but before or after the V1 `recordExport` persistence; a pathname is not a durable directory capability. The code does not claim to eliminate arbitrary adversarial races, atomic multi-file commits, crash orphan recovery or post-process pathname stability. Resolving those properties requires an explicitly reviewed publication/recovery protocol and platform-level integration tests before any live session-bound export.

## Local browser harness

tests/ui-host.mjs starts a local MCP process and an interactive loopback page. It is not a one-shot test: keep the server running while the browser is open, then stop it with Ctrl+C. Select a free port if the default port 4174 is already in use:

~~~powershell
$env:PORTRAIT_STUDIO_TEST_PORT = '54123'
node tests/ui-host.mjs
~~~

Open http://127.0.0.1:54123 and exercise the synthetic PNG flow: open a session, load the image, change color through chat without a widget notification, use Sync from Chat, crop to 4:5, apply the synthetic clone stroke, save, and verify the saved file. The harness displays the saved PNG’s dimensions, byte count, byte hash, pixel hash, and whether the source stayed unchanged. It simulates the local MCP app bridge; it is not the production ChatGPT Desktop host.

## Verification performed for this source update

On 2026-10-26 under Node.js 24.18.0 on Windows:

- Node syntax checks passed for server, UI engine, preview script, and all test scripts.
- Editor-state, MCP contract, portrait engine, safety contract, cross-process state, and version-consistency checks passed.
- The safety contract passed both without the ignored image fixture and with the local approved synthetic fixture.
- The browser harness passed in headless Chrome with a generated 50 × 50 synthetic PNG. A no-notification chat edit synchronized at revision 3; crop output was 40 × 50; the clone stroke changed the target pixel; the saved 319-byte PNG passed byte and pixel hash checks; no browser page errors were reported.

These checks do not repeat Gate 0 or certify a newly loaded Desktop plugin release. No production Desktop release or Remote MCP deployment was performed.

## Earlier V0.2.5 local-host evidence

A prior isolated local-host run used generated 50 × 50 JPEG and PNG images to check color changes, crop, undo/redo, save integrity, and source preservation. That harness simulated the MCP app bridge and did not establish production ChatGPT Desktop behavior.

## Scope and privacy limits

- Keep the plugin PRIVATE. Public source documentation and repository changes do not change plugin privacy or publish a release.
- Do not commit user portraits, credentials, session stores, source images, or local exports. The automated UI harness generates synthetic pixels in memory.
- The offline migration and rollback module is not imported by the live server and has not been run against real or private session data. It requires a caller-provided offline quiescence lease; no provider is wired in this repository.
- The current Canvas pipeline is 8-bit and does not guarantee ICC/wide-gamut fidelity or EXIF retention. RAW/CR3 and 16-bit editing are out of scope.
- The existing plugin is local stdio for supported ChatGPT Desktop local threads. Ordinary ChatGPT conversations require a separately verified Remote MCP deployment; none is included here.
