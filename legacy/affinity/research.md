# Affinity Portrait Studio — SDK and license review

**Verified against official documentation:** 2026-10-21  
**Documented SDK:** 3.3.1, beta  
**Target:** Affinity for Windows 11

## Capability boundary

| Area | Verified | MVP behavior |
|---|---|---|
| Script UI | Scripts run on demand. They can inspect the current document, show a dialog, and change document content. The official help explicitly says scripts cannot add persistent tools, alter core UI, run continuously, intercept input, or provide event-driven automation. | Deliver three runnable scripts and a workflow guide. “Studio” is a script/workflow name, not a dockable plugin panel. [Scripting in Affinity](https://www.affinity.studio/help/scripting-in-affinity/) |
| Undo | Official examples use `AddChildNodesCommandBuilder`, `CompoundCommandBuilder`, and `doc.executeCommand(...)`; a compound command becomes one history action. | Each document edit is issued as a single undoable command/compound command. [Scripting examples](https://www.affinity.studio/help/scripting-examples/) · [Crop Marks tutorial](https://www.affinity.studio/help/scripting-tutorial-crop-marks/) |
| Color | SDK 3.3.1 documents `VibranceAdjustmentParametersApi`, its `setVibrance` range `-1.0…+1.0`, `VibranceAdjustmentRasterNodeDefinitionApi`, and `AddChildNodesCommandBuilderApi.addVibranceAdjustmentRasterNode`. The API overview has no LUT/lookup-table API entry. | Color script adds an editable Vibrance adjustment layer and asks for its initial strength. It is a neutral-color starting preset, not a look matched to the user’s photos. LUT import remains a manual UI step. [SDK API overview](https://sdk.affinity.studio/33001/js/apis.html) · [Other adjustments](https://www.affinity.studio/help/adjustments-other-adjustments/) · [Importing add-ons](https://www.affinity.studio/help/addons-importing-addons/) |
| Retouch | The official tutorial shows creating named container layers and adding children with one compound command. Affinity documents retouch brushes as manual pixel-layer operations; no corresponding retouch-stroke automation API was verified. | Retouch script creates an editable workflow group with three named groups. The user adds Pixel Layers and paints manually. No smoothing, face reshaping, or body-proportion changes are automated. [Retouching](https://www.affinity.studio/help/retouching-retouch/) · [Crop Marks tutorial](https://www.affinity.studio/help/scripting-tutorial-crop-marks/) |
| Crop | The SDK API overview has no image-crop API. The Crop Marks tutorial generates print marks and is not a crop tool. | Crop remains a manual Crop Tool operation. Do not represent crop marks as image cropping. [Cropping and straightening](https://www.affinity.studio/help/size-transform-cropping/) · [SDK API overview](https://sdk.affinity.studio/33001/js/apis.html) |
| Quality Guard | `DocumentApi` exposes path, format, DPI and current spread; `ColourProfileApi` exposes the profile name; `SpreadNodeApi` exposes its document bounds. `RasterFormat` values include 8/16-bit and floating-point formats. The installed app’s exact enum serialization and dimensions were not observable here. | Read-only script reports file basename, format token, inferred bit depth when the token is recognizable, ICC profile, DPI, canvas bounds and dirty state. Unknown values remain “unknown”; it never converts, saves or exports. [Document API](https://sdk.affinity.studio/33001/js/apis/DocumentApi/index.html) · [Colour profile API](https://sdk.affinity.studio/33001/js/apis/ColourProfileApi/index.html) · [Spread node API](https://sdk.affinity.studio/33001/js/apis/SpreadNodeApi/index.html) |
| CR3 and source preservation | SDK includes save/export operations, so it does not itself guarantee RAW source preservation. | Editing scripts require a saved `.afphoto` document and do not call save/export. Convert or develop CR3 in Affinity, then save a separate `.afphoto` working copy manually. The script cannot prove the original CR3’s bytes stayed unchanged. |
| 16-bit/channel | API exposes document format and color-format information, but the exact runtime mapping was not verified against this Windows installation. | Quality Guard reports a recognized format token or labels the bit depth as unknown. It never changes bit depth. Start with a separate 16-bit/channel `.afphoto` copy when available. |

## Trust and permissions

Affinity marks imported scripts untrusted by default. Its trust guidance recommends inspecting the source and checking requested permissions before running it. These scripts do not require file-system, network, or Canva AI access. Keep those permissions disabled for this project. [Trusting scripts](https://www.affinity.studio/help/trusting-scripts/)

## Open-source review

- [Affinity Script Manager](https://github.com/JiriKrblich/Affinity-script-manager) and [Affinity Community Scripts](https://github.com/JiriKrblich/Affinity-Community-Scripts) were reviewed as workflow references. Neither repository root provided a license grant for the reviewed code, so no source or assets were copied.
- [affinity-mcp-setup](https://github.com/bolloplayer/affinity-mcp-setup) contains an explicit [MIT license](https://github.com/bolloplayer/affinity-mcp-setup/blob/main/LICENSE), but it is an MCP bridge and was excluded. No third-party code or runtime package is bundled.
- The project’s own source is licensed under MIT. Canva/Affinity trademarks and software are not included or licensed by this repository.

## Verification limit

Affinity for Windows was installed and its build (`Mid October '26 (4940)`) and scripting settings were inspected. **Enable Affinity Scripting** was off, so no script was loaded or run. The included test is a static safety-contract check plus JavaScript syntax checking; it cannot verify beta SDK wrapper exports, actual layer placement, preview, visual result, or one-step Undo. See [Archived workflow](README.md) for the Windows run-through.
