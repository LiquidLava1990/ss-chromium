#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
// ss-chromium: MCP server (default), installer and diagnostics. Every command is non-interactive.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { installBrowser, resolveBrowser } from "../lib/browser-install.mjs";
import { PACKAGE_ROOT, stateHome, statePaths } from "../lib/paths.mjs";
import {
  configSnippet,
  installSkill,
  registerClients,
  unregisterClients,
} from "../lib/register.mjs";
import {
  ensureBrowser,
  prepareBridge,
  runSessionServer,
} from "../lib/session.mjs";
import { describeImage, visionEndpoint } from "../lib/vision.mjs";

const VERSION = JSON.parse(
  readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"),
).version;

const HELP = `ss-chromium ${VERSION}: let AI agents drive a local Chromium through MCP

Usage:
  ss-chromium [mcp]           Run the MCP server over stdio (what AI apps start)
  ss-chromium install         Download Chromium, register with Claude Code / Codex, add the skill
      --no-browser            Skip the Chromium download (use SS_CHROMIUM_PATH instead)
      --no-register           Don't register with AI app CLIs
      --no-skill              Don't install the Claude skill
  ss-chromium launch          Open the shared browser for manual browsing or signing in
  ss-chromium doctor          Show paths, browser, relay port and vision settings
  ss-chromium config          Print the MCP config block for other AI apps
  ss-chromium uninstall       Unregister from AI app CLIs (state is kept; delete it by hand)
  ss-chromium vision <image> <prompt>
                              Describe an image via SS_CHROMIUM_VISION_URL (optional)

Environment:
  SS_CHROMIUM_HOME            State directory (default: ${stateHome()})
  SS_CHROMIUM_PATH            Use this Chromium executable instead of the downloaded one
  SS_CHROMIUM_VISION_URL      Vision service for \`vision\` (off when unset)
  SS_CHROMIUM_HEADLESS=1      Run the shared browser headless (CI)
`;

/** @param {string[]} flags */
async function install(flags) {
  const paths = statePaths(stateHome());
  if (!flags.includes("--no-browser")) {
    const browser = await resolveBrowser(paths);
    if (browser.installed) console.log(`Browser: ${browser.executable}`);
    else console.log(`Browser: installed ${await installBrowser(paths)}`);
  }
  if (!flags.includes("--no-register")) {
    for (const result of registerClients())
      console.log(
        `${result.client}: ${result.status}${result.detail ? ` (${result.detail})` : ""}`,
      );
  }
  if (!flags.includes("--no-skill"))
    console.log(`Claude skill: ${installSkill()}`);
  console.log(
    `\nOther AI apps: add this MCP server config, then restart the app:\n${configSnippet()}`,
  );
  console.log("\nDone. Restart your AI app and ask it to open a web page.");
}

async function doctor() {
  const { paths, port } = await prepareBridge();
  const browser = await resolveBrowser(paths);
  const vision = visionEndpoint();
  console.log(
    JSON.stringify(
      {
        version: VERSION,
        node: process.version,
        state: paths.home,
        relayPort: port,
        browser: browser.executable,
        browserInstalled: browser.installed,
        extensionBundled: existsSync(
          path.join(PACKAGE_ROOT, "extension", "manifest.json"),
        ),
        profile: paths.profile,
        vision: vision ? vision.href : "off",
      },
      null,
      2,
    ),
  );
  if (!browser.installed) process.exitCode = 1;
}

/** @param {string[]} args */
async function vision(args) {
  const [image, ...prompt] = args;
  if (!image || prompt.length === 0)
    throw new Error('Usage: ss-chromium vision <image> "<what to describe>"');
  console.log(await describeImage(image, prompt.join(" ")));
}

/** @type {Record<string, (args: string[]) => Promise<void> | void>} */
const COMMANDS = {
  mcp: () => runSessionServer(),
  install,
  launch: async () => {
    const browser = await ensureBrowser();
    const client = new Client({
      name: "ss-chromium-desktop",
      version: VERSION,
    });
    try {
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [process.argv[1], "mcp"],
          env: process.env,
        }),
      );
      // Listing tools starts the relay without creating a conversation window.
      const { tools } = await client.listTools({}, { timeout: 25000 });
      if (!tools.some((tool) => tool.name === "browser")) {
        throw new Error(
          "The SS Chromium relay did not advertise browser control",
        );
      }
    } finally {
      await client.close();
    }
    console.log(`SS Chromium is running. Profile: ${browser.profile}`);
  },
  doctor,
  config: () => console.log(configSnippet()),
  uninstall: () => {
    for (const result of unregisterClients())
      console.log(`${result.client}: ${result.status}`);
    console.log(
      `State kept in ${stateHome()}. Delete it to remove the profile and browser.`,
    );
  },
  vision,
  help: () => console.log(HELP),
  "--help": () => console.log(HELP),
  "-h": () => console.log(HELP),
  "--version": () => console.log(VERSION),
  "-v": () => console.log(VERSION),
};

const [command = "mcp", ...rest] = process.argv.slice(2);
const handler = COMMANDS[command];
if (!handler) {
  console.error(`Unknown command: ${command}\n\n${HELP}`);
  process.exit(2);
}
try {
  await handler(rest);
} catch (error) {
  console.error(
    `ss-chromium ${command}: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
