// Finds the Chromium the shared profile runs in, or installs one (Playwright's Chromium build).
// Branded Google Chrome ignores --load-extension since version 137, so the runtime needs Chromium,
// Chrome for Testing or another browser that still honors it. SS_CHROMIUM_PATH picks one explicitly.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

/** @returns {string} playwright-core's CLI script */
function playwrightCli() {
  return path.join(
    path.dirname(require.resolve("playwright-core/package.json")),
    "cli.js",
  );
}

/**
 * The Chromium executable Playwright installs into `browsersDir`, whether or not it exists yet.
 * @param {string} browsersDir
 * @returns {Promise<string>}
 */
export async function bundledChromiumPath(browsersDir) {
  // A child process reads PLAYWRIGHT_BROWSERS_PATH when playwright-core loads; an import here could not.
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      `process.stdout.write(require(${JSON.stringify(require.resolve("playwright-core"))}).chromium.executablePath())`,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsersDir },
      windowsHide: true,
    },
  );
  if (result.status !== 0 || !result.stdout)
    throw new Error(
      `Could not locate Playwright's Chromium: ${result.stderr || "no output"}. Reinstall ss-chromium.`,
    );
  return result.stdout.trim();
}

/**
 * The browser to run: SS_CHROMIUM_PATH, else the Chromium `ss-chromium install` downloaded.
 * @param {{ browsers: string }} paths
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<{ executable: string, installed: boolean, source: "env" | "bundled" }>}
 */
export async function resolveBrowser(paths, env = process.env) {
  if (env.SS_CHROMIUM_PATH) {
    const executable = path.resolve(env.SS_CHROMIUM_PATH);
    return { executable, installed: existsSync(executable), source: "env" };
  }
  const executable = await bundledChromiumPath(paths.browsers);
  return { executable, installed: existsSync(executable), source: "bundled" };
}

/**
 * Downloads Playwright's Chromium into the state directory (about 150 MB, once).
 * @param {{ browsers: string }} paths
 * @param {{ quiet?: boolean }} [options]
 * @returns {Promise<string>} the executable
 */
export async function installBrowser(paths, options = {}) {
  const result = spawnSync(
    process.execPath,
    [playwrightCli(), "install", "chromium", "--no-shell"],
    {
      env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: paths.browsers },
      stdio: options.quiet ? "ignore" : "inherit",
      windowsHide: true,
    },
  );
  if (result.status !== 0)
    throw new Error(
      "Chromium download failed. Check your network connection and run `ss-chromium install` again, " +
        "or set SS_CHROMIUM_PATH to an existing Chromium executable.",
    );
  const executable = await bundledChromiumPath(paths.browsers);
  if (!existsSync(executable))
    throw new Error(
      `Chromium was installed but ${executable} is missing. Delete ${paths.browsers} and run \`ss-chromium install\` again.`,
    );
  return executable;
}
