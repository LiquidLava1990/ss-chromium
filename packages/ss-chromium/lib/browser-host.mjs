// The detached parent of the shared Chromium process. Event-driven (it reacts to the browser
// exiting), never a scheduled monitor. Started by `ensureBrowser()`; one per state directory.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

import { findRunningBrowser, verifyBrowser } from "./browser-process.mjs";
import { freePort, prepareShared, provisionExtension } from "./session.mjs";

const RESTART_DELAY_MS = 100;

/**
 * Chromium's command line for the shared profile.
 * @param {Awaited<ReturnType<typeof prepareShared>>} config
 * @param {number} debugPort
 * @param {boolean} restore reopen the last session's tabs after a crash
 * @param {NodeJS.ProcessEnv} env
 * @returns {string[]}
 */
export function browserArguments(
  config,
  debugPort,
  restore,
  env = process.env,
) {
  const args = [
    `--user-data-dir=${config.profile}`,
    `--load-extension=${config.paths.extension}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-search-engine-choice-screen",
    "--window-size=1280,1000",
    "--remote-debugging-address=127.0.0.1",
    `--remote-debugging-port=${debugPort}`,
    "--no-startup-window",
  ];
  if (env.SS_CHROMIUM_HEADLESS === "1") args.push("--headless=new");
  if (restore) args.push("--restore-last-session");
  return args;
}

/**
 * Takes the host lock, or exits quietly when a live host already holds it.
 * @param {string} lock
 */
function acquireLock(lock) {
  if (existsSync(lock)) {
    try {
      process.kill(JSON.parse(readFileSync(lock, "utf8")).pid, 0);
      process.exit(0);
    } catch {
      unlinkSync(lock);
    }
  }
  try {
    writeFileSync(lock, JSON.stringify({ pid: process.pid }), {
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "EEXIST")
      process.exit(0);
    throw error;
  }
}

async function main() {
  const config = await prepareShared();
  const { paths } = config;
  acquireLock(paths.hostLock);
  const token = randomBytes(32).toString("hex");
  /** @type {Record<string, unknown>} */
  let metadata = {};
  /** @type {Promise<void> | undefined} */
  let recovering;

  const writeInfo = () =>
    writeFileSync(
      paths.hostInfo,
      JSON.stringify({ ...metadata, hostToken: token }, null, 2),
      { mode: 0o600 },
    );

  /** @param {unknown} error */
  const fail = (error) => {
    writeFileSync(
      paths.hostError,
      `${new Date().toISOString()} ${error instanceof Error ? error.stack : String(error)}\n`,
    );
    server.close();
    process.exit(1);
  };

  /** @param {boolean} restore */
  const start = async (restore = false) => {
    const existing = await findRunningBrowser(config);
    if (existing) {
      Object.assign(metadata, existing, { adopted: true });
      writeInfo();
      return;
    }
    metadata.adopted = false;
    const browser = spawn(
      config.executable,
      browserArguments(
        config,
        /** @type {number} */ (metadata.debugPort),
        restore,
      ),
      { stdio: "ignore", windowsHide: false },
    );
    await new Promise((resolve, reject) => {
      browser.once("spawn", resolve);
      browser.once("error", reject);
    });
    metadata.browserPid = browser.pid;
    writeInfo();
    browser.once("exit", (code, signal) => {
      // A normal close stays closed: the next browser request starts a new host.
      if (code === 0 && !signal) {
        server.close();
        process.exit(0);
      }
      setTimeout(() => void start(true).catch(fail), RESTART_DELAY_MS);
    });
  };

  const server = createServer(async (request, response) => {
    if (
      request.headers.authorization !== `Bearer ${token}` ||
      request.url !== "/status"
    ) {
      response.writeHead(403);
      response.end();
      return;
    }
    try {
      if (metadata.adopted) {
        await verifyBrowser(/** @type {number} */ (metadata.debugPort)).catch(
          async () => {
            recovering ??= start().finally(() => {
              recovering = undefined;
            });
            await recovering;
          },
        );
      }
    } catch {
      response.writeHead(503);
      response.end("SS browser recovery failed");
      return;
    }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(metadata));
  });

  try {
    // A live browser on this profile already loaded its extension: never rewrite it under it.
    if (!(await findRunningBrowser(config))) provisionExtension(config);
    await new Promise((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve(undefined)),
    );
    const { publicKey: _publicKey, ...safe } = config;
    metadata = {
      ...safe,
      hostPid: process.pid,
      hostPort: /** @type {import("node:net").AddressInfo} */ (server.address())
        .port,
      debugPort: await freePort(),
    };
    await start();
  } catch (error) {
    fail(error);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await main();
