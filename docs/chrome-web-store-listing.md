# Chrome Web Store listing: SS Browser Control

Paste these into the developer dashboard. The manifest already carries the name, short name and
the 132-character description.

## Name (manifest, ≤75 characters)

SS Browser Control - Browser Automation for AI Agents (MCP)

## Summary / short description (manifest, ≤132 characters)

AI browser automation: Claude Code, Codex & any MCP client drive this browser locally. CAPTCHAs are handed to you. No cloud.

## Category

Developer Tools

## Detailed description

SS Browser Control connects this browser to AI agents running on your own computer. It is the
browser extension of SS Chromium, an open-source MCP (Model Context Protocol) server for browser
automation. With it, AI coding assistants and agents such as Claude Code, Claude Desktop, Codex,
Cursor and VS Code can open pages, read content, click, type, fill in forms, upload files,
follow popups and take screenshots in tabs of their own, using the sites you are already signed
in to.

How it works
• Install the SS Chromium server (one command, see the website link) and add it to your AI app.
• Open the extension popup and click Allow once, after checking that the 6-digit code matches the
one your AI app shows.
• Ask your agent to do something on the web. Each conversation works in its own tab group; you
can watch every step.

Features
• Browser automation for AI agents over the Model Context Protocol (MCP)
• Works with Claude Code, Codex, Cursor, VS Code and any MCP client
• Agents get their own tabs and never see the others; one Stop button cuts them all off
• Page snapshots, text extraction, clicks, typing, dropdowns, checkboxes, hover, scrolling,
file uploads, drag and drop, dialogs, screenshots, PDFs and downloads
• Follows popups and OAuth windows, and drives the browser's own account chooser
("Sign in with Google" via FedCM)
• CAPTCHA and bot-wall hand-off: detects reCAPTCHA, hCaptcha, Cloudflare/Turnstile and other
checks, pauses the agent and asks you to complete them, then lets the agent continue. It
never solves or bypasses them.
• Optional image description for agents through a local vision service (such as CrawlRX)
• Runs entirely on your computer: the extension talks only to the local server on 127.0.0.1

Privacy
• No account, no analytics, no data sent anywhere: page content goes only to the local server
and from there to the AI app you configured.
• The server proves its identity with a signature on every connection.
• No CAPTCHA solving, bot-detection evasion or fingerprint spoofing.

Open source (Apache-2.0): https://github.com/LiquidLava1990/ss-chromium

## Keywords to work into the listing and screenshots

browser automation, AI agent, MCP, Model Context Protocol, Claude, Claude Code, Codex, Cursor,
web automation, Chrome extension, Chromium, Playwright alternative, Puppeteer alternative,
AI browser control, form filling, file upload, screenshots, human in the loop, web testing

## Permission justifications

| Permission                            | Justification                                                                                                                                  |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| debugger                              | Sends the AI agent's page commands (clicks, typing, screenshots, page reads) to the tabs the agent owns, via the DevTools protocol.            |
| tabs                                  | Lists the agent's tabs with titles and URLs so it can choose one.                                                                              |
| tabGroups                             | Keeps each AI conversation's tabs in its own labeled group.                                                                                    |
| webNavigation                         | Detects tabs and popups a page opens so the agent can follow them.                                                                             |
| scripting, host permission <all_urls> | Removes other extensions' frames (such as a password manager's inline menu) that would block attaching the debugger. Nothing else is injected. |
| storage                               | Saves pairing and settings.                                                                                                                    |
| alarms                                | Keeps the connection to the local server alive.                                                                                                |

## Data usage disclosures

Collects no user data. Does not sell or transfer data. Not used for creditworthiness or lending.
Single purpose: let the user's local AI apps control this browser.
