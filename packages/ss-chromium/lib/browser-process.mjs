// Finds an already-running shared browser (same executable and profile) so a restarted host
// adopts it instead of launching a second Chromium on the same profile.
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

/**
 * The value of `--name=value` (or `--name="value with spaces"`) in a command line.
 * @param {string} command
 * @param {string} name
 * @returns {string | undefined}
 */
export function commandLineArgument(command, name) {
  return command
    .match(new RegExp(`(?:^|\\s)--${name}=(?:"([^"]+)"|(\\S+))`))
    ?.slice(1)
    .find(Boolean);
}

/** @param {string} file */
function normalized(file) {
  const resolved = path.resolve(file);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * @typedef {{ ProcessId: number, ExecutablePath?: string | null, CommandLine?: string | null }} BrowserProcess
 * @typedef {{ executable: string, profile: string }} BrowserIdentity
 */

/**
 * The browser process (not a renderer/helper) running `config.executable` on `config.profile`.
 * @param {BrowserProcess[]} processes
 * @param {BrowserIdentity} config
 * @returns {{ browserPid: number, debugPort: number } | null}
 */
export function matchingBrowser(processes, config) {
  const matches = processes.filter((candidate) => {
    const command = candidate.CommandLine || "";
    if (!candidate.ExecutablePath || /(?:^|\s)--type=/.test(command))
      return false;
    if (normalized(candidate.ExecutablePath) !== normalized(config.executable))
      return false;
    const profile = commandLineArgument(command, "user-data-dir");
    return !!profile && normalized(profile) === normalized(config.profile);
  });
  if (matches.length > 1)
    throw new Error(
      "Several browsers run the SS Chromium profile. Close them all, then retry.",
    );
  if (!matches.length) return null;
  const debugPort = Number(
    commandLineArgument(matches[0].CommandLine || "", "remote-debugging-port"),
  );
  if (!Number.isInteger(debugPort) || debugPort < 1 || debugPort > 65535)
    throw new Error(
      "A browser that SS Chromium did not start is using its profile. Close it, then retry.",
    );
  return { browserPid: matches[0].ProcessId, debugPort };
}

/**
 * Checks that the debugging endpoint answers on loopback at exactly `debugPort`.
 * @param {number} debugPort
 */
export async function verifyBrowser(debugPort) {
  const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`, {
    signal: AbortSignal.timeout(2000),
  });
  if (!response.ok) throw new Error("Chromium debugging endpoint unavailable");
  const data = await response.json();
  const endpoint = new URL(data.webSocketDebuggerUrl);
  if (
    !["127.0.0.1", "localhost"].includes(endpoint.hostname) ||
    Number(endpoint.port) !== debugPort
  )
    throw new Error("Unexpected Chromium debugging endpoint");
}

/**
 * @param {string} executable
 * @returns {Promise<BrowserProcess[]>}
 */
async function windowsProcesses(executable) {
  const name = path.win32.basename(executable).replace(/'/g, "");
  const { stdout } = await execute(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Get-CimInstance Win32_Process -Filter "Name='${name}'" | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress`,
    ],
    { windowsHide: true, timeout: 10000, maxBuffer: 4 * 1024 * 1024 },
  );
  if (!stdout.trim()) return [];
  const parsed = JSON.parse(stdout);
  return Array.isArray(parsed) ? parsed : [parsed];
}

/**
 * `ps` output as processes. The executable is the command line's prefix that matches
 * `executable` (its path may contain spaces, as macOS app bundles do).
 * @param {string} stdout
 * @param {string} executable
 * @returns {BrowserProcess[]}
 */
export function parsePosixProcesses(stdout, executable) {
  return stdout
    .split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(.*)$/))
    .filter((match) => match !== null)
    .map(([, pid, command]) => ({
      ProcessId: Number(pid),
      ExecutablePath:
        command === executable || command.startsWith(`${executable} `)
          ? executable
          : null,
      CommandLine: command,
    }));
}

/**
 * @param {BrowserIdentity} config
 * @returns {Promise<{ browserPid: number, debugPort: number } | null>}
 */
export async function findRunningBrowser(config) {
  const processes =
    process.platform === "win32"
      ? await windowsProcesses(config.executable)
      : parsePosixProcesses(
          (
            await execute("ps", ["-axww", "-o", "pid=,args="], {
              timeout: 10000,
              maxBuffer: 4 * 1024 * 1024,
            })
          ).stdout,
          config.executable,
        );
  const existing = matchingBrowser(processes, config);
  if (existing) await verifyBrowser(existing.debugPort);
  return existing;
}
