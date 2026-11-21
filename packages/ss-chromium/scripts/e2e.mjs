// End-to-end check of the assembled package: installs Chromium into a temporary state
// directory, starts `ss-chromium mcp` like an AI app does, drives a local page through the
// `browser` tool (headless), then stops only the processes it started.
// Usage: node scripts/e2e.mjs [--keep]   (run `pnpm build` first)

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(here, "bin", "ss-chromium.mjs");
const home = mkdtempSync(path.join(tmpdir(), "ss-chromium-e2e-"));
const env = {
  ...process.env,
  SS_CHROMIUM_HOME: home,
  SS_CHROMIUM_HEADLESS: "1",
};
const PAGE = `<!doctype html><title>SS fixture</title><label>Name <input id="name"></label>
<button onclick="document.querySelector('#out').textContent='Hello, '+document.querySelector('#name').value">Greet</button>
<p id="out"></p>`;

/** @param {string} message */
function fail(message) {
  console.error(`E2E FAILED: ${message}`);
  process.exitCode = 1;
}

/** Text of a tool result. */
const text = (result) =>
  result.content.map((part) => part.text ?? "").join("\n");

async function main() {
  const site = createServer((_, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end(PAGE);
  });
  await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${site.address().port}/`;
  const client = new Client({ name: "e2e", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, "mcp"],
    env,
    stderr: "inherit",
  });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    if (!tools.tools.some((tool) => tool.name === "browser"))
      return fail("no browser tool listed");
    const session_key = "e2e:00000000-0000-4000-8000-000000000001";
    const result = await client.callTool(
      {
        name: "browser",
        arguments: {
          session_key,
          commands: `goto ${url}\nfill getByLabel('Name') World\nclick getByRole('button', { name: 'Greet' })\nget text '#out'`,
        },
      },
      undefined,
      { timeout: 300000 },
    );
    const output = text(result);
    if (result.isError || !output.includes("Hello, World"))
      return fail(`unexpected browser output:\n${output}`);
    console.log(
      "E2E PASSED: installed Chromium, provisioned the extension, drove a page over MCP.",
    );
  } finally {
    await client.close().catch(() => {});
    site.close();
    stopStarted();
  }
}

/** Stops the browser host, browser and daemon this run started (by the PIDs they recorded). */
function stopStarted() {
  const pids = [];
  const read = (file) =>
    existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const host = read(path.join(home, "daemon", "browser-host.json"));
  pids.push(host.browserPid, host.hostPid);
  const daemonDir = path.join(home, "daemon");
  for (const file of existsSync(daemonDir) ? readdirSync(daemonDir) : [])
    if (/^daemon(-\d+)?\.json$/.test(file))
      pids.push(read(path.join(daemonDir, file)).pid);
  for (const pid of pids.filter(Number.isInteger)) {
    try {
      process.kill(pid);
    } catch {
      // Already gone.
    }
  }
  if (!process.argv.includes("--keep")) {
    setTimeout(
      () =>
        rmSync(home, {
          recursive: true,
          force: true,
          maxRetries: 10,
          retryDelay: 500,
        }),
      2000,
    );
  } else console.log(`State kept in ${home}`);
}

await main();
