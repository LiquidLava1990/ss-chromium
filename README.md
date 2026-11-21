# SS Chromium: browser automation for AI agents (MCP server + Chrome extension)

**SS Chromium lets AI coding agents such as Claude Code, Codex, Cursor and any MCP client control
a real Chromium browser on your computer.** It is an open-source MCP server, a Chrome/Chromium
extension and a one-line installer: agents navigate, read pages, click, type, fill forms, upload
files, follow popups and sign-in choosers, and take screenshots and PDFs, while you stay signed
in once in a shared local profile. When a site shows a CAPTCHA or bot wall, SS Chromium detects
it, pauses the agent and hands it to you, then continues once you have cleared it. Each AI
conversation gets its own browser window and tabs. Everything runs locally on loopback: no cloud
relay, no account, no telemetry. A local alternative to driving Playwright or Puppeteer by hand.

- **Works with**: Claude Code, Claude Desktop, Codex, Cursor, VS Code, any Model Context Protocol client
- **Platforms**: Windows, macOS, Linux
- **License**: Apache-2.0, based on [Browser MCP](https://github.com/BrowserMCP/mcp) (see [NOTICE.md](NOTICE.md))

## Features

- **Real browser control for AI agents**: a real, visible Chromium (or your own Chrome, Edge or
  Brave), not a headless scraper. Agents navigate, go back and forward, reload and work with
  pages you can watch.
- **One window per conversation, one shared signed-in profile**: sign in once and every agent
  reuses the cookies and logins, while each conversation sees only its own tabs. Windows and
  tabs survive reconnects, MCP restarts and browser crashes (submissions are never replayed).
- **Tabs, popups and dialogs**: open, list, select and close tabs; follow popups and OAuth
  windows (`tab popup`); answer alert, confirm and prompt dialogs.
- **Forms and input**: fill, type, press keys, select dropdowns, check boxes, click, hover,
  scroll, drag, and viewport-relative `point` input for canvas apps. Works across iframes and
  shadow DOM.
- **File uploads and drops**: set file inputs, and drop files or MIME data onto drop zones
  (optionally as native Chromium drag events).
- **Efficient page reading**: accessibility snapshots with element refs, text search, and
  `get text` / values / attributes, sized for an LLM context window.
- **Screenshots, PDFs and downloads**: viewport, element or full-page screenshots; save pages as
  PDF; capture downloads.
- **Debugging**: console errors, network requests and response bodies, `eval` in the page.
- **Sign-in helpers**: drives Chromium's native account chooser (FedCM, such as "Sign in with
  Google") with `fedcm list`, `fedcm select` and `fedcm click`.
- **CAPTCHA and bot-wall hand-off**: detects reCAPTCHA, hCaptcha, Cloudflare challenges and
  Turnstile, DataDome, Arkose Labs, GeeTest, PerimeterX and AWS WAF checks and tells the agent to
  stop and ask you; `human-check --wait` then pauses until you have completed the check in the
  window, and the agent continues. It never solves or bypasses them.
- **Optional vision**: describe screenshots (charts, canvas content, images) through a
  [CrawlRX](https://github.com/LiquidLava1990/crawlrx) vision endpoint or any compatible service.
- **MCP for every client**: Claude Code, Claude Desktop, Codex, Cursor, VS Code and any Model
  Context Protocol client; a bundled Claude skill teaches agents the workflow.
- **Local and private**: loopback only, signed daemon identity, no account, no telemetry.
- **Easy deployment**: one-line installers for Windows, macOS and Linux, `npx`, or the
  extension zip for "Load unpacked".

## Install in one line (Quick start)

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/LiquidLava1990/ss-chromium/main/install/install.ps1 | iex
```

**macOS / Linux:**

```sh
curl -fsSL https://raw.githubusercontent.com/LiquidLava1990/ss-chromium/main/install/install.sh | sh
```

The installer:

1. installs Node.js LTS if it is missing (winget on Windows, Homebrew on macOS),
2. installs the `ss-chromium` package globally,
3. downloads a private Chromium build (~150 MB, into SS Chromium's own folder — your
   regular browser is not touched),
4. registers the MCP server with **Claude Code** and **Codex** if their CLIs are installed,
   and adds the `ss-chromium` skill to Claude if `~/.claude` exists.

Restart your AI app and ask it to open a web page. That's it.

It never prompts, so it also works from scripts. Opt out of steps with environment variables:
`SS_CHROMIUM_NO_REGISTER=1`, `SS_CHROMIUM_NO_BROWSER=1`, `SS_CHROMIUM_NO_SKILL=1`.

### Already have Node.js? One line per AI app

```sh
# Claude Code
claude mcp add --scope user ss_chromium -- npx -y ss-chromium@latest

# Codex
codex mcp add ss_chromium -- npx -y ss-chromium@latest
```

Chromium downloads automatically on the first browser call (or run `npx -y ss-chromium install`
ahead of time).

### MCP server config for any other client (Claude Desktop, Cursor, VS Code, …)

```json
{
  "mcpServers": {
    "ss_chromium": {
      "command": "npx",
      "args": ["-y", "ss-chromium@latest"]
    }
  }
}
```

## Browser automation commands for AI agents

The server exposes one tool, `browser`, that takes a batch of commands:

```json
{
  "session_key": "claude:3f0c…",
  "commands": "goto https://example.com\nsnapshot -i"
}
```

- `session_key` names the conversation (`<client>:<conversation id>`). The same key reclaims the
  same window and tabs after a restart; different conversations must use different keys.
  The bundled skill tells agents how to pick one.
- Commands include `goto`, `snapshot`, `find`, `get text`, `click`, `fill`, `type`, `press`,
  `select`, `check`, `hover`, `upload`, `drop`, `scroll`, `drag`, `point`, `tab`, `dialog`,
  `fedcm`, `human-check`, `wait`,
  `screenshot`, `pdf`, `download`, `console`, `requests` and `eval`. Run `help` for the syntax.
- Open the shared browser yourself (for example, to sign in to a site once) with
  `ss-chromium launch`.

## Use the Chrome extension in your own browser, or the bundled Chromium

|                   | **SS Chromium runtime** (installer / npx)                               | **Extension in your own Chrome**                                            |
| ----------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Browser           | Private Chromium in SS Chromium's folder                                | Your Chrome, Edge or Brave                                                  |
| Extension install | Automatic (loaded at launch)                                            | Chrome Web Store, or _Load unpacked_ from the release zip                   |
| Pairing           | Automatic: the extension is provisioned with this computer's daemon key | Click **Allow** once in the extension popup after checking the 6-digit code |
| Profile           | Dedicated shared profile for agents                                     | Your own profile                                                            |

To use your own browser: download `ss-browser-control-<version>-chrome.zip` from
[Releases](https://github.com/LiquidLava1990/ss-chromium/releases), unzip it, open
`chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick the folder.
Then add the MCP server as above. (Branded Google Chrome 137+ no longer accepts extensions from
the command line, which is why the runtime uses its own Chromium.)

## Chrome extension permissions explained

The extension asks for:

| Permission                                            | Why                                                                                                                                                                                                |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `debugger`                                            | Sends the agent's page commands (clicks, typing, screenshots, DOM reads) to the tabs it owns, through Chrome's DevTools protocol. Chrome shows its "is debugging this browser" bar while attached. |
| `tabs`, `tabGroups`                                   | Lists the agent's tabs with their titles and URLs, and keeps each conversation's tabs in its own group/window.                                                                                     |
| `webNavigation`                                       | Notices tabs and popups that a page opens, so the agent can follow them.                                                                                                                           |
| `scripting`, `<all_urls>` host access, content script | Only to remove other extensions' frames (such as a password manager's inline menu) that would block attaching the debugger. The content script stays idle until asked.                             |
| `storage`                                             | Remembers pairing and settings.                                                                                                                                                                    |
| `alarms`                                              | Keeps the connection to the local server alive.                                                                                                                                                    |

The extension talks only to the SS Chromium daemon on `127.0.0.1`. It verifies the daemon's
signature on every connection, and agents can only reach the tabs of their own conversation.
Press **Stop** in the popup to cut off all agents.

## CAPTCHAs and bot walls: detect, hand to you, continue

When a page shows a human-verification check, SS Chromium notices it (right after `goto`, or on
demand with `human-check`) and tells the agent not to touch it but to ask you. You complete the
check in the visible SS Chromium window; `human-check --wait` pauses the agent (up to 5 minutes
per call) until the check is gone, and the agent carries on from the page the site lets through.
Because the profile is shared and persistent, a check you clear once often stays cleared for
later agents.

SS Chromium is for driving your own browser on your behalf. It contains **no automated CAPTCHA
solving, no bot-detection evasion and no fingerprint spoofing**.

## Optional vision (image description) for agents

Set `SS_CHROMIUM_VISION_URL` to an image-description service (for example a
[CrawlRX](https://github.com/LiquidLava1990/crawlrx) vision endpoint) to enable

```sh
ss-chromium vision screenshot.png "What does this chart show?"
```

The service receives `POST {"image": "<base64>", "prompt": "…"}` and answers
`{"ok": true, "analysis": "…"}`. Unset (the default), nothing is sent anywhere.

## Commands and settings

```text
ss-chromium [mcp]       MCP server over stdio (what AI apps run)
ss-chromium install     Download Chromium, register with Claude Code / Codex, add the skill
ss-chromium launch      Open the shared browser
ss-chromium doctor      Show paths, browser, relay port and settings
ss-chromium config      Print the MCP config block
ss-chromium uninstall   Unregister from Claude Code / Codex (state is kept)
ss-chromium vision      Optional image description
```

| Variable                       | Default                                                                                                 | Meaning                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `SS_CHROMIUM_HOME`             | `%LOCALAPPDATA%\ss-chromium`, `~/Library/Application Support/ss-chromium`, `~/.local/share/ss-chromium` | State: profile, browser, daemon key                                        |
| `SS_CHROMIUM_PATH`             | downloaded Chromium                                                                                     | Use another Chromium-based executable that still honors `--load-extension` |
| `SS_CHROMIUM_CONVERSATION_KEY` | —                                                                                                       | Bind the server to one conversation key up front                           |
| `SS_CHROMIUM_VISION_URL`       | off                                                                                                     | Vision service for `ss-chromium vision`                                    |
| `SS_CHROMIUM_HEADLESS`         | `0`                                                                                                     | `1` runs the shared browser headless (CI)                                  |

## Update

Re-run the installer, or `npm install -g ss-chromium@latest`. With `npx … ss-chromium@latest`
you always get the latest version when your AI app restarts. Your profile and pairing are kept.

## Uninstall

```sh
ss-chromium uninstall
npm uninstall -g ss-chromium
```

Then delete the state folder (`ss-chromium doctor` prints it) to remove the profile and browser.

## Build from source

Node.js 24+ and pnpm (`corepack enable`):

```sh
pnpm install
pnpm build          # server, extension, and the ss-chromium package
pnpm test           # unit and integration tests
pnpm --filter ss-chromium e2e   # installs Chromium in a temp folder and drives a page over MCP
pnpm --filter ss-chromium stress -- 1   # multi-session stress run (20 cases per round; see the script header)
pnpm zip:extension  # release zip for "Load unpacked"
pnpm zip:store      # Chrome Web Store upload (no manifest key)
```

Layout: `packages/mcp` (MCP server and daemon), `packages/extension-core` and `apps/extension`
(the extension), `packages/protocol` (shared protocol), `packages/ss-chromium` (the published
package: CLI, runtime and installers' target), `install/` (one-line installers),
`skills/ss-chromium` (agent skill).

## License

[Apache-2.0](LICENSE). Based on Browser MCP; third-party notices in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
