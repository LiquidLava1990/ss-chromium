# Security

SS Chromium lets AI apps drive a browser that may be signed in to your accounts, so reports
about it are taken seriously.

## Reporting a vulnerability

Report it privately through
[GitHub private vulnerability reporting](https://github.com/LiquidLava1990/ss-chromium/security/advisories/new),
not in a public issue. Include what you found, how to reproduce it (versions of `ss-chromium`
and the extension, your browser and operating system) and what an attacker could do with it.

## What counts

- **Who can drive the browser**: anything that lets a web page, another local user or another
  program control the browser without either the installation's provisioned daemon key or the
  **Allow** pairing, or that gets past the daemon listening only on `127.0.0.1`.
- **Conversation isolation**: one MCP conversation reaching another conversation's tabs.
- **The extension's own rules**: reaching incognito windows (unless allowed), browser or
  extension pages, or tabs while **Stop** is pressed.
- **The server and daemon**: reading or writing files or running programs beyond what a browser
  tool call allows, or leaking page content to anyone but the AI app that asked for it.
- **The runtime**: the provisioned extension or state directory exposing a private key, or the
  browser's debugging port listening beyond loopback.

## Supported versions

The latest release of the `ss-chromium` package and of the extension.
