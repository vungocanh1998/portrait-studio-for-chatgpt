# Legacy Affinity Portrait Studio (archived)

> Archived reference material retained from the original project. Current product: Portrait Studio for ChatGPT; see the repository root README.

**MVP 0.1.0 · Windows 11 · Affinity JavaScript Scripting SDK 3.3.1 beta**

An independent set of on-demand Affinity scripts and a restrained portrait-editing workflow. This is **not** a persistent Affinity panel or a Canva/Affinity product.

**Runtime status:** Source syntax and static safety checks pass. The scripts have not yet been executed in Affinity: `Enable Affinity Scripting` is off in the available test installation. See [Testing and release](TESTING-AND-RELEASE.md) for the smoke test and acceptance gates.

## What works in this MVP

| Feature | What the script does | What stays manual |
|---|---|---|
| Color Studio | Source implements an editable Vibrance adjustment with a dialog value clamped to the SDK-documented `-1…+1` range. | The adjustment creation, parameter mapping, layer placement, and one-step Undo still require an Affinity runtime smoke test. Choosing a reference look and importing a `.cube` LUT remain manual UI steps. |
| Retouch Studio | Source implements an `APS Retouch Workflow` group with Cleanup, Dodge & Burn, and Texture Detail subgroups using a compound command. | Group creation and one-step Undo still require an Affinity runtime smoke test. Add Pixel Layers inside the groups and use Affinity’s Clone/Healing tools manually. No paint strokes, skin smoothing, or face/body geometry edits are automated. |
| Crop Studio | Provides the safe workflow below. | Use Affinity’s Crop Tool. The SDK API overview does not document image cropping through scripts. |
| Quality Guard | Reads the open document’s filename, format token, likely bit depth (only when recognizable), color profile name, DPI, canvas bounds, and dirty state. It changes nothing. | Unknown format/bit-depth values are reported as unknown; the script does not convert or save. |

Every mutating script refuses to run unless the open document has a saved `.afphoto` path. Neither mutating script saves, exports, resizes, compresses, or overwrites a file. Work from a separately saved `.afphoto`; keep the camera original (including CR3) untouched.

## Install and run

1. In Affinity, enable JavaScript scripting in Settings if it is not already enabled.
2. Open **Scripting Studio** and the **Scripts Library**. Create a category such as `Affinity Portrait Studio`.
3. For each file in `scripts/`, create a script in the Script Editor, paste the complete file contents, and save it into that category. The exact control labels can change while the beta UI evolves; the official [Scripting Studio and library release notes](https://www.affinity.studio/help/sep-26-release-notes/) describe the current feature.
4. Review each imported/pasted script in the editor before running it. Imported scripts are untrusted by default. These scripts need no file-system, network, or Canva AI permission; leave those permissions disabled. See [Trusting scripts](https://www.affinity.studio/help/trusting-scripts/).
5. Open a working copy saved as `.afphoto`, run **APS Color Studio** or **APS Retouch Studio**, and check the new layer/group. Use `Ctrl+Z` once to confirm the whole operation is one history step.
6. Run **APS Quality Guard** before and after editing to record the reported format, profile, DPI, bounds, and dirty state.

Official starting point: [Running scripts](https://www.affinity.studio/help/running-scripts/) and [Scripting in Affinity](https://www.affinity.studio/help/scripting-in-affinity/).

## Recommended portrait workflow

1. Develop/import the CR3 in Affinity and save a new `.afphoto` file. Do not use Save As to the CR3 path.
2. Prefer a 16-bit/channel working document when your source and workflow support it. Quality Guard will report an unknown bit depth rather than guess from an unfamiliar SDK value.
3. Run Quality Guard and note the original’s displayed format, profile, DPI, canvas bounds and dirty state. Keep the CR3 in a separate, unchanged location.
4. Run Color Studio. Start with a low Vibrance value, compare the adjustment layer on/off, and fine-tune the layer’s parameters in Affinity. For a LUT, add Affinity’s LUT Adjustment manually, load your own licensed LUT, and adjust its strength in the Layers panel.
5. Run Retouch Studio. Add Pixel Layers within each named group. Use Clone/Healing only on specific distractions. Keep pores and natural texture; skip skin smoothing and all face/body geometry edits.
6. Use the Crop Tool manually. Keep the original canvas available for adjustment and avoid resampling/downscaling.
7. Compare before/after at fit-to-screen and 100%. Check face geometry, natural texture, color, focus, and crop. Hide/show adjustment groups and undo if anything looks wrong.
8. Save the result as a new `.afphoto`. Do not export over or save to the CR3 path. For a simple source-integrity check, record the CR3 SHA-256 before the session and compare it afterward with Windows `Get-FileHash -Algorithm SHA256`.

## Files

- `scripts/color-studio.js` — adjustable Vibrance layer.
- `scripts/retouch-studio.js` — undoable manual-retouch group scaffold.
- `scripts/quality-guard.js` — read-only document check.
- `../../tests/safety-contract.mjs` — dependency-free static safety assertions.
- `research.md` — current SDK capability, license review, and evidence.
- `../../SBOM.cdx.json` — CycloneDX 1.5 inventory; no third-party package is bundled.
- `LICENSE`, `NOTICE` — project license and product/trademark notice.

## Static checks

With Node.js installed, run from this folder:

```powershell
node --check .\scripts\color-studio.js
node --check .\scripts\retouch-studio.js
node --check .\scripts\quality-guard.js
node .\tests\safety-contract.mjs
```

These checks do not launch Affinity or validate the SDK at runtime. See [research.md](research.md) for the API boundary and [TESTING-AND-RELEASE.md](TESTING-AND-RELEASE.md) for current results and release gates.

## License

Original project source is MIT-licensed. Affinity is a trademark of Canva; this independent project is not affiliated with or endorsed by Canva/Affinity. See [NOTICE](NOTICE).
