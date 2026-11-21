// Where SS Chromium keeps its state, and where the bundled pieces live in the package.
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The installed package's root: holds `server/` (MCP server + daemon) and `extension/`. */
export const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/**
 * The per-user state directory: `SS_CHROMIUM_HOME`, else the platform's usual place.
 * @param {NodeJS.ProcessEnv} env
 * @param {NodeJS.Platform} platform
 * @returns {string}
 */
export function stateHome(env = process.env, platform = process.platform) {
  if (env.SS_CHROMIUM_HOME) return path.resolve(env.SS_CHROMIUM_HOME);
  if (platform === "win32")
    return path.join(
      env.LOCALAPPDATA || path.join(homedir(), "AppData", "Local"),
      "ss-chromium",
    );
  if (platform === "darwin")
    return path.join(
      homedir(),
      "Library",
      "Application Support",
      "ss-chromium",
    );
  return path.join(
    env.XDG_DATA_HOME || path.join(homedir(), ".local", "share"),
    "ss-chromium",
  );
}

/**
 * Every path SS Chromium uses under its state directory.
 * @param {string} home
 */
export function statePaths(home) {
  return {
    home,
    /** The daemon's home (`BROWSER_MCP_HOME`): bridge port, daemon key, daemon.json, log */
    daemon: path.join(home, "daemon"),
    bridge: path.join(home, "daemon", "bridge.json"),
    identity: path.join(home, "daemon", "identity.json"),
    devExtensionIds: path.join(home, "daemon", "dev-extension-ids"),
    /** The provisioned copy of the extension that the browser loads */
    extension: path.join(home, "extension"),
    /** The shared browser profile: cookies and logins of every agent window */
    profile: path.join(home, "profile"),
    /** Browsers installed by `ss-chromium install` (PLAYWRIGHT_BROWSERS_PATH) */
    browsers: path.join(home, "browsers"),
    // In the daemon home: the daemon reads it for native account-chooser (FedCM) control
    hostInfo: path.join(home, "daemon", "browser-host.json"),
    hostLock: path.join(home, "daemon", "browser-host.lock"),
    hostError: path.join(home, "daemon", "browser-host-error.txt"),
  };
}
