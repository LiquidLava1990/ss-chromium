# NOTICE

SS Chromium
Copyright 2026 SS Chromium contributors

This product is a modified version of Browser MCP (https://github.com/BrowserMCP/mcp),
revision a51ddc4ee2210b102468a52b114e6f00e5bd206e, licensed under the Apache License,
Version 2.0. It is not an official Browser MCP release and is not endorsed by Browser MCP.

Changes from Browser MCP, summarized (see the git history for detail):

- New name, icon and extension identity (`SS Browser Control`, its own extension ID).
- A runtime (`packages/ss-chromium`) that installs Chromium, loads the extension into a
  dedicated shared profile, and provisions the extension with this installation's daemon
  public key so that it trusts exactly that local daemon. Installs from the Chrome Web Store
  or "Load unpacked" still pair through the one-time Allow prompt.
- Conversation-scoped windows: each MCP conversation key gets its own window and tabs; all
  windows share one profile. Ownership survives reconnects, restarts and browser crashes.
- Additional commands: `point` (viewport-relative input), `tab popup`, `drop` (file and MIME
  drops, optionally as native Chromium drag events) and `fedcm` (browser account choosers).
- Optional image description through an external vision service (`SS_CHROMIUM_VISION_URL`).

Third-party code adapted in these changes is listed in THIRD_PARTY_NOTICES.md.
