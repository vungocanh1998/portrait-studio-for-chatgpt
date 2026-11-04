# Export publication and recovery safety contract (M1-AR)

## Scope and current state

This is an **inactive PUBLIC CODE/TEST** safety specification, not authorization
to import into `server/index.mjs`, update the PRIVATE V0.2.8 plugin, inspect
real user files, or migrate any user session. The current V1 writer records
one latest export path per session; the output worker writes an independent PNG
and `.provenance.json` file. The three updates are **not one atomic commit**.

PR #11 added a parent-side output-directory canonical/inode check before
`recordExport()`. A same-user POSIX process can still rename/replace the
absolute path after that check and during/after V1 persistence; no purely
pathname-based recheck can guarantee future path stability.

## Recovery inventory (M1-AR-PR2)

`inspectExportRecovery({storePath, outputDirectory})` is deliberately
**read-only**, requires both paths explicitly, rejects default lookup,
noncanonical paths, symlink aliases, nonregular entries, active V1 store lock,
excessive directory sizes and malformed V1 state. It does not load
`EditorSessions` or call `recordExport()`, write, rename or unlink. All
synthetic test stores and outputs are generated beneath OS temporary roots.

It strictly reads the V1 store through `readV1Store()`, checks that its bytes
remain unchanged during the inventory, and verifies each recognized
`*-portrait-studio*.png` / `.png.provenance.json` pair using exact PNG
byte length and SHA-256, decoded RGBA8 pixel SHA-256, allowed provenance
fields, session identity, revision, source digest and V1 export metadata.
Files unrelated to the exporter are **ignored and never modified**.

| Inventory status | Meaning | Action allowed |
| --- | --- | --- |
| `recorded_verified` | Both files match provenance and the current V1 export record | Read-only report |
| `unreferenced_verified` | Both files verify, but no current V1 export record matches | Read-only report; may be an earlier legitimate export |
| `incomplete_pair` | PNG or sidecar missing | Read-only report; do not guess a missing partner |
| `invalid_pair` | Pair exists but fails strict integrity/metadata inspection | Read-only report; do not trust or repair the pair |
| `recorded_missing_pair` | V1 refers to an export whose pair has no recognized files | Read-only report; do not rewrite V1 |

`safeToAutoRecover` and `safeToAutoDelete` are always `false`.
The inventory is an **observation**, never authoritative proof that a file
is an orphan: V1 retains only the latest export record. An unreferenced pair
might be a previous valid user export. No automatic unlink, relinking, session
promotion, destination overwrite or destructive cleanup is allowed.

This inventory cannot establish an atomic filesystem snapshot under a
hostile same-user process. It checks directory and store identities
before/after reading and refuses observed alias, lock and byte changes,
but still does not close concurrent pathname races. It does not certify
third-party storage, media metadata, ICC/EXIF fidelity or a live Desktop flow.

## Publication/recovery protocol required before activation

A subsequent separately gated PR must define and test a bounded
**transaction identity/journal** and idempotent explicit recovery operation,
not infer commit status from orphan files alone. Proposed phases:

1. **Prepare:** validate the current session/revision/renderer/pixels under
   the documented session-first, renderer-second lock ordering; allocate a
   unique transaction ID and a trusted, platform-verified publication root.
2. **Stage:** exclusively create immutable PNG, sidecar and a bounded intent
   receipt using that ID, verify full readback, `fsync` individual files and
   the containing directory where supported. Nothing should be announced
   saved to the user at this point.
3. **Record:** only after validating stable publication identity, persist V1
   export metadata with a durable transaction receipt *outside* V1; preserve
   strict V1 schema and existing detached save contract.
4. **Reconcile:** on a separately authorized offline/quiescent recovery pass,
   verify both file hashes, source/revision/renderer provenance and journal
   against a strict V1 snapshot. Distinguish recorded, pending, superseded,
   corrupt and ambiguous entries; refuse uncertain ownership/path cases.
5. **Finalize:** only a proven, user-authorized, idempotent operation may
   reconcile a journal or quarantine owned staged artifacts. Do not
   automatically delete user files or older valid exports; retain audit logs
   and deterministic retry/rollback behavior.

The future tests must inject interruption at every stage (partial PNG,
complete PNG without sidecar, complete pair without intent, intent without V1
record, V1 record without final receipt, corruption/retry, concurrent export,
recorded path swap and restart). They must cover Windows and POSIX, preserve
V1 readability, and verify source image immutability and hostile sentinel
protection. Platform security/parent-directory permissions require separate
review. No claim of atomic multi-file filesystem publication is made.

## Activation gates remaining

- A stable-path publication design or restricted trusted-directory contract
  resisting unauthorized POSIX rename **after** the final check.
- Recovery journal and idempotent recovery under proven quiescence.
- Platform-specific Windows/Linux crash/injection/rename behavior with
  exact-head independent CI and Work ACCEPT.
- Real ChatGPT Desktop/browser clone→preview→export acceptance, native
  dimension/pixel integrity and source/CR3 immutability checks.
- Explicit Owner approval for each Squash Merge and a **different**, later
  explicit Owner approval for PRIVATE release or activation.

Keep `HLT_DNTT` separate. Do not publish personal images or credentials.
