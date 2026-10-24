# Architecture and supported platform

**Verified against official OpenAI documentation:** 2026-10-24

## ChatGPT app structure

ChatGPT Apps use an MCP server for tools and optional UI. The UI is returned as an MCP App resource and runs in a sandboxed iframe. The shared MCP Apps bridge uses JSON-RPC over postMessage; ChatGPT-specific APIs are used only for capabilities the shared bridge does not provide. This project registers one open_portrait_studio tool and one text/html;profile=mcp-app UI resource.

The plugin uses a local stdio MCP process. That keeps image processing in the browser and avoids a hosted image backend. OpenAI documents local MCP plugins as desktop-only and requires partner approval for public directory submission; this project is private and is not being submitted publicly. A private local plugin still needs verification in ChatGPT Desktop.

## File and pixel flow

1. The user selects JPEG/PNG files in the app UI. The browser decodes them into ImageBitmap objects in the UI process.
2. Color preview, crop, manual clone strokes, and PNG export use the browser Canvas API. The MCP process does not receive file bytes or paths and has no network handler.
3. Download creates a separate PNG in the browser. The source file is not edited or overwritten. The export contains the selected crop at native pixel dimensions.
4. Optional AI suggestions require a separate user click. The UI renders only the selected reference as a metadata-free PNG preview (maximum 1200 pixels on the long edge), uploads that copy through ChatGPT's file API, and asks ChatGPT to suggest a color preset and intensity. The original image is not sent for this suggestion.

Canvas export omits source EXIF metadata. Canvas processing uses an 8-bit display color pipeline; this does not preserve a 16-bit source path or guarantee wide-gamut/ICC fidelity. CR3 processing is out of scope and has not been tested. The app does not use text-to-image generation.

## Dependencies and licensing

The MCP process uses Node.js built-ins only. The UI uses browser-standard Canvas, File, and Blob APIs. There are no third-party runtime packages, external image-processing services, bundled fonts, or downloaded assets. The project remains MIT-licensed.

## Official sources

- [MCP server and UI quickstart](https://developers.openai.com/plugins/build/app-quickstart)
- [Add UI to an MCP server](https://developers.openai.com/plugins/build/chatgpt-ui)
- [ChatGPT plugin UI and file API reference](https://developers.openai.com/plugins/reference)
- [OpenAI MCP Extensions specification](https://github.com/openai/mcp-extensions/blob/main/docs/spec.md)
- [Desktop-only plugins](https://developers.openai.com/plugins/deploy/desktop-only)
- [Plugin package format](https://developers.openai.com/plugins/build/plugins)
