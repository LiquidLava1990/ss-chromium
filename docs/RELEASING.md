# Releasing

SS Chromium ships three things from one tag:

| Asset                                               | Who uses it                                                          |
| --------------------------------------------------- | -------------------------------------------------------------------- |
| `ss-chromium.tgz` (npm package)                     | The one-line installers, and `npx ss-chromium` once published to npm |
| `ss-browser-control-<version>-chrome.zip`           | "Load unpacked" in your own Chrome / Edge / Brave                    |
| `ss-browser-control-<version>-chrome-web-store.zip` | The Chrome Web Store upload (manifest without `key`)                 |

No browser binary is distributed: the runtime downloads Playwright's Chromium build on the user's
machine, so there is nothing to code-sign or notarize.

## Cut a release

1. Bump `version` in `packages/ss-chromium/package.json` and `apps/extension/package.json`.
2. Commit, then tag and push: `git tag v1.0.1 && git push origin main v1.0.1`.
3. The `Release` workflow builds, tests, and creates a **draft** GitHub release with all assets.
   Review it and publish it. The installers download `releases/latest/download/ss-chromium.tgz`,
   so they only see published (non-draft) releases.
4. npm: add an `NPM_TOKEN` repository secret (an npm automation token) and the workflow publishes
   `ss-chromium` with provenance on the next tag. Or publish by hand:
   `npm publish release/ss-chromium.tgz --access public`.

## Chrome Web Store (first submission)

The extension ID `gkgbcabjiekpohmmlgcanojkdcpjccal` comes from the public `key` in
`apps/extension/extension-key.ts`. To give the store listing the same ID, the **first** upload
must carry the matching private key, which is kept outside this repository:

1. `pnpm zip:store`, then add the private key to the zip root as `key.pem`.
2. Upload it in the Chrome Web Store developer dashboard. Later uploads use the plain
   `pnpm zip:store` output (no `key.pem`).
3. If the store assigns a different ID anyway, put it in `CHROME_WEB_STORE_EXTENSION_ID`
   (`packages/protocol/src/index.ts`) and release a new server version.

Listing answers:

- **Single purpose**: lets the user's own local AI apps (MCP clients) control this browser
  through a server running on the same computer.
- **Permission justifications**: see the "Permissions explained" table in the README.
  `debugger` relays page commands to tabs the agent owns; `<all_urls>`/`scripting`/the content
  script only remove other extensions' frames that block attaching.
- **Remote code**: none. All code is in the package; the extension only connects to
  `127.0.0.1`.
- **Data usage**: no data is collected or transmitted off the device. Page content goes only
  to the local server, which hands it to the AI app the user configured.
- **Privacy policy URL**: the repository README's "Permissions explained" and "What it will not
  do" sections, or a dedicated page if the dashboard requires one.
- The listing must not claim CAPTCHA or bot-detection bypass; the product has none.

## Going public

1. `gh repo edit LiquidLava1990/ss-chromium --visibility public --accept-visibility-change-consequences`
2. Enable private vulnerability reporting (Settings → Code security) for `SECURITY.md`.
3. Publish the draft release, publish to npm, submit to the Chrome Web Store.
