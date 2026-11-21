// The shared browser profile and the per-conversation MCP server in front of it.
// Every agent conversation gets its own window; all windows share one profile (logins, cookies).
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { installBrowser, resolveBrowser } from "./browser-install.mjs";
import { PACKAGE_ROOT, stateHome, statePaths } from "./paths.mjs";

/** The relay ports a store-installed extension probes (`RELAY_PORTS` in the protocol). */
const RELAY_PORTS = [9010, 9011, 9012];
const HOST_START_TIMEOUT_MS = 20000;
const EXTENSION_START_TIMEOUT_MS = 15000;
const EXTENSION_CONNECT_SETTLE_MS = 1000;

/**
 * Whether `port` can be bound on loopback right now.
 * @param {number} port 0 picks any free port
 * @returns {Promise<number | null>} the bound port, or null when taken
 */
async function tryPort(port) {
  const socket = createServer();
  try {
    await new Promise((resolve, reject) => {
      socket.once("error", reject);
      socket.listen(port, "127.0.0.1", resolve);
    });
  } catch {
    return null;
  }
  const bound = /** @type {import("node:net").AddressInfo} */ (socket.address())
    .port;
  await new Promise((resolve) => socket.close(() => resolve(undefined)));
  return bound;
}

/** @returns {Promise<number>} any free loopback port */
export async function freePort() {
  const port = await tryPort(0);
  if (port === null) throw new Error("No free loopback port is available");
  return port;
}

/**
 * Writes `data` to `file` only if it does not exist yet (another process may race us).
 * @param {string} file
 * @param {string} data
 */
function writeOnce(file, data) {
  try {
    writeFileSync(file, data, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== "EEXIST")
      throw error;
  }
}

/**
 * The daemon's home and its relay port, chosen once and kept: the extension the browser
 * loaded was provisioned with it. A store-installed extension finds the default ports itself.
 * @param {NodeJS.ProcessEnv} env
 */
export async function prepareBridge(env = process.env) {
  const paths = statePaths(stateHome(env));
  mkdirSync(paths.daemon, { recursive: true, mode: 0o700 });
  if (!existsSync(paths.bridge)) {
    let port = null;
    for (const candidate of RELAY_PORTS) {
      port = await tryPort(candidate);
      if (port !== null) break;
    }
    writeOnce(
      paths.bridge,
      JSON.stringify({ port: port ?? (await freePort()) }),
    );
  }
  const { port } = JSON.parse(readFileSync(paths.bridge, "utf8"));
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error(
      `Invalid relay port in ${paths.bridge}. Delete that file and restart your AI app.`,
    );
  return { paths, port };
}

/**
 * The daemon's ECDSA key pair (same file and format the daemon reads), created once.
 * @param {string} file
 * @returns {{ publicKey: string, privateKey: string }}
 */
function loadOrCreateIdentity(file) {
  if (!existsSync(file)) {
    const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    writeOnce(
      file,
      JSON.stringify({
        publicKey: keys.publicKey
          .export({ type: "spki", format: "der" })
          .toString("base64"),
        privateKey: keys.privateKey
          .export({ type: "pkcs8", format: "pem" })
          .toString(),
      }),
    );
  }
  return JSON.parse(readFileSync(file, "utf8"));
}

/**
 * Chromium's extension ID for a manifest `key`.
 * @param {string} key base64 SPKI public key
 */
export function extensionIdForKey(key) {
  return createHash("sha256")
    .update(Buffer.from(key, "base64"))
    .digest("hex")
    .slice(0, 32)
    .replace(/[0-9a-f]/g, (digit) =>
      String.fromCharCode(97 + Number.parseInt(digit, 16)),
    );
}

/**
 * Everything the browser host needs: paths, port, executable, daemon key, extension ID.
 * @param {NodeJS.ProcessEnv} env
 */
export async function prepareShared(env = process.env) {
  const { paths, port } = await prepareBridge(env);
  const bundledExtension = path.join(PACKAGE_ROOT, "extension");
  const manifestFile = path.join(bundledExtension, "manifest.json");
  if (!existsSync(manifestFile))
    throw new Error(
      `The bundled extension is missing (${manifestFile}). Reinstall ss-chromium.`,
    );
  const browser = await resolveBrowser(paths, env);
  if (!browser.installed)
    throw new Error(
      browser.source === "env"
        ? `SS_CHROMIUM_PATH points to ${browser.executable}, which does not exist.`
        : "SS Chromium has no browser yet. Run `npx -y ss-chromium install` (or set SS_CHROMIUM_PATH to a Chromium executable).",
    );
  const identity = loadOrCreateIdentity(paths.identity);
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  return {
    paths,
    port,
    profile: paths.profile,
    executable: browser.executable,
    bundledExtension,
    extensionId: extensionIdForKey(manifest.key),
    publicKey: identity.publicKey,
  };
}

/**
 * Copies the bundled extension into the state directory and prepends this installation's
 * public configuration (relay port, daemon public key) to its service worker, so the
 * extension trusts exactly this daemon without an Allow prompt. No secret is written.
 * @param {Awaited<ReturnType<typeof prepareShared>>} config
 */
export function provisionExtension(config) {
  const { paths, bundledExtension, extensionId, port, publicKey } = config;
  rmSync(paths.extension, { recursive: true, force: true });
  cpSync(bundledExtension, paths.extension, { recursive: true });
  writeFileSync(paths.devExtensionIds, `${extensionId}\n`);
  const manifest = JSON.parse(
    readFileSync(path.join(paths.extension, "manifest.json"), "utf8"),
  );
  const worker = path.resolve(
    paths.extension,
    manifest.background.service_worker,
  );
  if (!worker.startsWith(paths.extension + path.sep))
    throw new Error("The extension's service worker escapes its directory");
  const session = { sessionId: "shared-profile", relayPort: port, publicKey };
  writeFileSync(
    worker,
    `globalThis.SS_CHROMIUM_SESSION=Object.freeze(${JSON.stringify(session)});\n` +
      readFileSync(worker, "utf8"),
  );
  mkdirSync(paths.profile, { recursive: true, mode: 0o700 });
}

/**
 * Asks the running browser host for its status.
 * @param {Awaited<ReturnType<typeof prepareShared>>} config
 */
async function hostStatus(config) {
  const saved = JSON.parse(readFileSync(config.paths.hostInfo, "utf8"));
  const response = await fetch(`http://127.0.0.1:${saved.hostPort}/status`, {
    headers: { Authorization: `Bearer ${saved.hostToken}` },
    signal: AbortSignal.timeout(1000),
  });
  if (!response.ok)
    throw new Error("The SS browser host refused its status request");
  return response.json();
}

/**
 * Starts the browser host (detached; it parents Chromium) unless one already answers.
 * @param {NodeJS.ProcessEnv} env
 */
export async function ensureBrowser(env = process.env) {
  const config = await prepareShared(env);
  try {
    return { ...(await hostStatus(config)), started: false };
  } catch {
    // No host yet, or a stale one: start a new one below.
  }
  const child = spawn(
    process.execPath,
    [path.join(PACKAGE_ROOT, "lib", "browser-host.mjs")],
    { env, detached: true, stdio: "ignore", windowsHide: true },
  );
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
  const deadline = Date.now() + HOST_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      return { ...(await hostStatus(config)), started: true };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(
    `The SS browser did not start. See ${config.paths.hostError} for the reason.`,
  );
}

/**
 * After a cold start, waits until the extension's service worker runs in the new browser, so
 * the first call does not reach the daemon before the extension has connected to it.
 * On timeout it returns anyway: the daemon then reports the missing extension itself.
 * @param {number} debugPort
 * @param {string} extensionId
 */
async function waitForExtension(debugPort, extensionId) {
  const prefix = `chrome-extension://${extensionId}/`;
  const deadline = Date.now() + EXTENSION_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`, {
      signal: AbortSignal.timeout(1000),
    })
      .then((response) => (response.ok ? response.json() : []))
      .catch(() => []);
    const running = targets.some(
      (target) =>
        target.type === "service_worker" && target.url.startsWith(prefix),
    );
    if (running) {
      // The worker connects at once (no initial backoff) and reports its state right after.
      await new Promise((resolve) =>
        setTimeout(resolve, EXTENSION_CONNECT_SETTLE_MS),
      );
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/**
 * Downloads Chromium on first use when nothing was installed and SS_CHROMIUM_PATH is unset,
 * so a bare `npx ss-chromium` setup works. Output is discarded: stdout carries MCP.
 * @param {NodeJS.ProcessEnv} env
 */
async function installMissingBrowser(env) {
  const paths = statePaths(stateHome(env));
  const browser = await resolveBrowser(paths, env);
  if (!browser.installed && browser.source === "bundled")
    await installBrowser(paths, { quiet: true });
}

/**
 * The MCP stdio server an AI app runs. Browser launch errors are reported per call,
 * so the connection survives and the next call retries.
 * @param {NodeJS.ProcessEnv} env
 */
export async function runSessionServer(env = process.env) {
  const { paths, port } = await prepareBridge(env);
  const serverDir = path.join(PACKAGE_ROOT, "server");
  const { conversationKeyFromEnv } = await import(
    pathToFileURL(path.join(serverDir, "session-identity.js")).href
  );
  const key = conversationKeyFromEnv(env);
  env.BROWSER_MCP_HOME = paths.daemon;
  // The thin server binds the conversation key only after checking the MCP client.
  env.SS_CHROMIUM_SESSION_ID = randomUUID();
  if (key) env.SS_CHROMIUM_CONVERSATION_KEY = key;
  const { runThin } = await import(
    pathToFileURL(path.join(serverDir, "session-server.js")).href
  );
  await runThin({
    capabilities: [],
    port,
    // Request-driven: a closed browser reopens on the next browser call, never on a timer.
    beforeBrowserCall: async () => {
      await installMissingBrowser(env);
      const browser = await ensureBrowser(env);
      if (browser.started)
        await waitForExtension(browser.debugPort, browser.extensionId);
      return browser;
    },
  });
}
