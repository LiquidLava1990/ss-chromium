// Registers the MCP server with the AI apps whose CLIs are installed (Claude Code, Codex),
// and installs the optional Claude skill. Non-interactive and idempotent.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { PACKAGE_ROOT } from "./paths.mjs";

export const SERVER_NAME = "ss_chromium";

/** @returns {string[]} the command an AI app runs for this installation */
export function serverCommand() {
  return [
    process.execPath,
    path.join(PACKAGE_ROOT, "bin", "ss-chromium.mjs"),
    "mcp",
  ];
}

/** The JSON block most MCP clients (Claude Desktop, Cursor, ...) accept. */
export function configSnippet(command = serverCommand()) {
  const [executable, ...args] = command;
  return JSON.stringify(
    { mcpServers: { [SERVER_NAME]: { command: executable, args } } },
    null,
    2,
  );
}

/** @param {string} arg */
function shellQuote(arg) {
  return /^[\w./:=@-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`;
}

/**
 * Runs an AI app's CLI. Windows CLIs are `.cmd` shims, which only a shell can start.
 * @param {string} cli
 * @param {string[]} args
 */
function run(cli, args) {
  const windows = process.platform === "win32";
  const result = windows
    ? spawnSync([cli, ...args].map(shellQuote).join(" "), {
        shell: true,
        encoding: "utf8",
        windowsHide: true,
        timeout: 60000,
      })
    : spawnSync(cli, args, { encoding: "utf8", timeout: 60000 });
  return {
    ok: result.status === 0,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
  };
}

/** @param {string} cli */
function available(cli) {
  return run(cli, ["--version"]).ok;
}

/**
 * The AI apps this machine has, and how to (re-)register the server with each.
 * @param {string[]} command
 */
function clients(command) {
  return [
    {
      name: "Claude Code",
      cli: "claude",
      remove: ["mcp", "remove", "--scope", "user", SERVER_NAME],
      add: ["mcp", "add", "--scope", "user", SERVER_NAME, "--", ...command],
    },
    {
      name: "Codex",
      cli: "codex",
      remove: ["mcp", "remove", SERVER_NAME],
      add: ["mcp", "add", SERVER_NAME, "--", ...command],
    },
  ];
}

/**
 * Registers (or re-points) the server in every installed AI app CLI.
 * @param {string[]} [command]
 * @returns {{ client: string, status: "registered" | "not installed" | "failed", detail?: string }[]}
 */
export function registerClients(command = serverCommand()) {
  return clients(command).map((client) => {
    if (!available(client.cli))
      return { client: client.name, status: "not installed" };
    run(client.cli, client.remove);
    const added = run(client.cli, client.add);
    return added.ok
      ? { client: client.name, status: "registered" }
      : { client: client.name, status: "failed", detail: added.output };
  });
}

/** Removes the server from every installed AI app CLI. */
export function unregisterClients() {
  return clients(serverCommand()).map((client) => {
    if (!available(client.cli))
      return { client: client.name, status: "not installed" };
    const removed = run(client.cli, client.remove);
    return {
      client: client.name,
      status: removed.ok ? "removed" : "not registered",
    };
  });
}

/**
 * Copies the usage skill into `~/.claude/skills/ss-chromium` when Claude is set up and no
 * different skill of that name exists (an existing one is never overwritten).
 * @param {string} [claudeHome]
 * @param {string} [sourceFile] the skill to install (default: the bundled one)
 * @returns {"installed" | "up to date" | "kept existing" | "no Claude directory"}
 */
export function installSkill(
  claudeHome = path.join(homedir(), ".claude"),
  sourceFile = path.join(PACKAGE_ROOT, "skill", "SKILL.md"),
) {
  if (!existsSync(claudeHome)) return "no Claude directory";
  const source = readFileSync(sourceFile, "utf8");
  const targetDir = path.join(claudeHome, "skills", "ss-chromium");
  const target = path.join(targetDir, "SKILL.md");
  if (existsSync(target)) {
    return readFileSync(target, "utf8") === source
      ? "up to date"
      : "kept existing";
  }
  mkdirSync(targetDir, { recursive: true });
  writeFileSync(target, source);
  return "installed";
}
