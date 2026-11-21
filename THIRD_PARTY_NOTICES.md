# Third-party code and control comparison

SS Chromium is a modified Apache-2.0 version of BrowserMCP/mcp; see LICENSE
and NOTICE.md for the base revision and the modifications.

## Microsoft Playwright

Copyright (c) Microsoft Corporation. Licensed under the Apache License,
Version 2.0; a copy is included in LICENSE. The code is provided without
warranties or conditions of any kind, as described in that license.

Reviewed source revision: b4d016aadc5cbd2b898a284307975fe73e05483d.

- [files.ts](https://github.com/microsoft/playwright/blob/b4d016aadc5cbd2b898a284307975fe73e05483d/packages/playwright-core/src/tools/backend/files.ts):
  adapted the `browser_drop` payload and `locator.drop` operation into the SS
  `drop` command. Changes: session-mediated file reads, MIME-object validation,
  bounded execution, hidden-tab checks, and omission of payload contents from
  command echoes. The default transfers session file buffers and produces synthetic
  events. SS also adds an explicit `--native` Chromium CDP drag-event path, using
  only local paths already resolved by the session file reader. Native single-file,
  multiple-file and MIME drops are verified with trusted input events. There is
  no automatic fallback or replay after delivery.
- [context.ts](https://github.com/microsoft/playwright/blob/b4d016aadc5cbd2b898a284307975fe73e05483d/packages/playwright-core/src/tools/backend/context.ts):
  applied its tab-selection behavior (bring the actual page forward) to SS
  tab selection/creation and recovered windows. SS retains its own ownership
  checks and extension transport. Added an SS-specific `tab popup` command
  using opener events and Playwright's opener relation, with URL narrowing,
  bounded waiting, ambiguity errors, and no cross-conversation adoption.

## Other reviewed implementations

[hangwin/mcp-chrome](https://github.com/hangwin/mcp-chrome) uses MIT licensing.
Reviewed its dialog, upload, window-listing and CDP session-manager code.
No code from that repository is incorporated in this change: SS already has
those controls and an ownership-aware debugger manager. Its active-window
defaults would not preserve SS conversation isolation.

| Control area                                                | SS result of comparison                                                |
| ----------------------------------------------------------- | ---------------------------------------------------------------------- |
| Popup/tab switching                                         | Fixed actual focus; added opener-based popup selection                 |
| External document/data drop                                 | Added files, multiple files and MIME text                              |
| Native file inputs and chooser buttons                      | Existing upload command retained                                       |
| Alerts, confirmations and prompts                           | Existing dialog command; real-browser verification added               |
| Native federated account picker                             | Added official Chromium FedCm inspect/select/Continue/dismiss controls |
| Frames, hover, drag, scroll, dropdowns and keyboard         | Existing controls retained                                             |
| Screenshots, PDF, downloads, console and network inspection | Existing controls retained                                             |

Popup tests use local OAuth-style redirect/message/close fixtures. They do not
prove Google authentication or universal popup behavior. OS-owned dialogs,
site outages and provider login requirements remain outside this web-control
verification.

Native federated chooser control uses the official Chromium protocol:
https://chromedevtools.github.io/devtools-protocol/tot/FedCm/ .
It connects only to this SS host's loopback debugger and the current session's
exact claimed target, since the extension debugger API does not expose FedCm.
No Chromium source code is copied. Real local-provider tests cover existing
account selection, exact callback count, agent restart, foreign-session denial,
stale IDs, dismissal, and provider confirmation Continue followed by sign-in.
These are real Chromium dialogs with a fixture identity provider, not a test
of a live Google account or the browser's generic OS dialogs.
