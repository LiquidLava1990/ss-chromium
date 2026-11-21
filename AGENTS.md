# AGENTS.md

SS Chromium: an MCP server, daemon, browser extension and runtime that let AI apps drive a local Chromium, one window per conversation over one shared profile. Based on Browser MCP (internal package names keep its `@browsermcp/*` scope; they are not published). See `README.md` for how the parts fit together.

- `packages/protocol` (`@browsermcp/protocol`): the protocol between the extension and the daemon (frames, pairing, ports, close codes), and the extension IDs the daemon accepts.
- `packages/ss-chromium` (`ss-chromium`, published to npm): the CLI (`bin/`), the runtime that installs Chromium, provisions the extension and parents the shared browser (`lib/`), and its tests. `pnpm build` assembles the server and extension into it.
- `packages/mcp` (`@browsermcp/mcp`, private): the MCP server, bundled into `ss-chromium`: the thin process each AI app runs, the daemon and its command engine. Read its `AGENTS.md` before changing it.
- `packages/extension-core` (`@browsermcp/extension-core`): browser control for a Chromium extension's background (`addBrowserControl()`, `handleBrowserControlMessages()`), a content script (`@browsermcp/extension-core/content`: `handleFrameRemovalRequests()`, which the extension declares in its manifest for `<all_urls>` in all frames, so it can remove other extensions' frames that block attaching, idle until the background asks) and popup (`@browsermcp/extension-core/popup`: `useBrowserControl()`, `sendBrowserControlMessage()`). It's source, not built: extensions bundle it.
- `apps/extension` (`@browsermcp/extension`): the extension, "SS Browser Control": `extension-core` and a popup, in English. Its manifest's fixed `key` (`extension-key.ts`) gives every build the ID `SELF_BUILT_EXTENSION_ID`, which the daemon accepts.

## Conventions

- **On its own**: nothing here imports anything but these `@browsermcp/*` packages and npm packages, and a fresh clone must install, typecheck, test and build. Refer to other packages by name (`@browsermcp/mcp`), not by path.
- **Public**: this repository is public, so nothing private goes in it: no secrets, keys (only the extension's public `key`), personal paths, hostnames or internal links.
- **Out of scope**: CAPTCHA solving, bot-detection evasion and fingerprint spoofing.
- **Protocol changes** go into both sides at once: the daemon (`@browsermcp/mcp`'s `src/relay/`) and `extension-core`. The protocol is versioned (`RELAY_PROTOCOL_VERSION`): each side tells the user which one to update when it meets an incompatible one.
- **Extensions built on `extension-core`** pass what they add (analytics, review prompts) as hooks (`onEvent`, `onActivity`), so browser control itself sends nothing anywhere. Its popup messages go through its own `runtime.onMessage` listener, beside any the extension has.
- **The popup's text**: the smoke test finds the popup's elements by their English text ("Allow", "Code: …", "Connected…", "Stop", "Resume", "In use"), so keep those, or change the test with them.
- **Chromium only**: Firefox has no `debugger` API.
- **Tests**: Vitest next to the code. Never bind or connect to ports 9009–9012 or touch `~/.browsermcp`: use random ports, `--port` and a temporary `BROWSER_MCP_HOME`, and stop only the processes a test started.

## Commands

- `pnpm build`, `pnpm typecheck`, `pnpm test`: every package.
- `pnpm lint`, `pnpm format`: Oxlint and Oxfmt (`.oxlintrc.json`, `.oxfmtrc.json`). `.github/workflows/ci.yml` runs all of these.
- `pnpm --filter ss-chromium test` / `e2e`: the runtime's unit tests, and an end-to-end run that installs Chromium into a temp directory and drives a page over MCP.
- `pnpm smoke`: the end-to-end smoke test (`apps/extension/scripts/smoke-browser-control.ts`), which builds the extension in development mode and the server, and drives the extension through the server in headless Chromium. Run it after changing browser control, the protocol or the daemon. `--extension <dir>` runs it against another development build (production builds ignore the fake 0.1.x server's port).
