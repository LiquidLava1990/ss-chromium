---
name: ss-chromium
description: Control the local SS Chromium browser for web tasks: navigating, reading pages, clicking, typing, uploads, popups, scrolling and dragging. Use for ordinary browser-control tasks and when asked for SS Chromium.
---

Use the `browser` tool of the `ss_chromium` MCP server (in Claude Code, load
`mcp__ss_chromium__browser` with ToolSearch if it is deferred). Its input is
`{"commands":"help\ntab list","session_key":"claude:<conversation UUID>"}`.

## Session key

Pass a stable `session_key` on the first call: `<client>:<conversation id>`, for example
`claude:<UUID>` or `codex:<CODEX_THREAD_ID>`. If the client exposes no conversation ID,
generate one UUID once for this conversation and keep reusing it, including after a restart.
Different conversations need different keys. Never use the project path or client name as the
key. Once bound, a connection refuses a different key.

Each conversation gets its own Chromium window and tabs. All windows share ONE profile, so
cookies, logins and local storage are shared. The tool lists and controls only its own
session's tabs and rejects other sessions' tab IDs.

## Working with pages

- Batch predictable steps in one call. Look with `snapshot -i`, `find "text"`,
  `get text --max all` or `screenshot`; use current refs or semantic locators
  (`getByLabel('Email')`). Run `help` for the full syntax.
- Re-snapshot after navigating: refs from an older page fail. Re-list tabs after a restart.
- Uploads: `upload 'input[type=file]' "/path/to/file.pdf"` on an observed input. Check the
  resulting filename. `drop <target> <path>...` handles drop zones (`--native` uses trusted
  Chromium drag input).
- Popups may open as separate tabs: save the parent tab ID, then
  `tab popup [parentId] --url "substring"` to select the child. Never repeat the opening action
  just because the wait timed out.
- Browser-owned account choosers (FedCM): `fedcm list --timeout 5000`, then
  `fedcm select <dialog-id> <account-index>` or `fedcm click <dialog-id> Continue`.
- `point click <x> <y>` / `point drag <x1> <y1> <x2> <y2>` take fractions (0 to <1) of the
  current viewport, from a fresh viewport `screenshot`. Useful for canvas apps.

## Safety

- After an uncertain submission, inspect the page instead of replaying the action. A reconnect
  is not proof that it completed. Crash recovery restores tabs, never clicks or submissions.
- Never reveal passwords. Follow the user's and the site's rules; do not try to get around
  CAPTCHAs, bot checks or access controls.
- CAPTCHAs and bot walls: `goto` notes when a page shows one, and `human-check` reports it on
  demand. Never click or solve it. Ask the user to complete it in the SS Chromium window, run
  `human-check --wait` (it pauses up to 60 s, or `--timeout` up to 300000 ms; repeat if the
  user needs longer), then continue from the page the site lets through.

## Optional vision

If `SS_CHROMIUM_VISION_URL` is configured, `ss-chromium vision <screenshot> "<question>"`
describes an image (charts, canvas content, images without text). Treat the answer as a hint
and verify against the page.

For a visual challenge or other image requiring closer inspection, start with a fresh
viewport screenshot. The optional visual helpers (`packages/mcp/visual` in the source
checkout, or `visual` beside `skill` in the npm package) can compare a cropped
shape with a screenshot or analyze ordered frames through the locally running CrawlRX
vision adapter; see that directory's README for dependencies and commands. Frame analysis
is a hint, not proof of motion or challenge acceptance. For CAPTCHA and bot walls, follow
the human hand-off instructions above.
