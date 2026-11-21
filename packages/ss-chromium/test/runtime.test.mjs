import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { browserArguments } from "../lib/browser-host.mjs";
import {
  commandLineArgument,
  matchingBrowser,
  parsePosixProcesses,
} from "../lib/browser-process.mjs";
import { stateHome, statePaths } from "../lib/paths.mjs";
import { configSnippet, installSkill } from "../lib/register.mjs";
import {
  extensionIdForKey,
  prepareBridge,
  provisionExtension,
} from "../lib/session.mjs";
import { describeImage, visionEndpoint } from "../lib/vision.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..", "..");
const temps = [];
function temp() {
  const dir = mkdtempSync(path.join(tmpdir(), "ss-chromium-test-"));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temps.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("state paths", () => {
  it("honors SS_CHROMIUM_HOME", () => {
    assert.equal(
      stateHome({ SS_CHROMIUM_HOME: "/x/y" }, "linux"),
      path.resolve("/x/y"),
    );
  });
  it("uses each platform's usual data directory", () => {
    assert.match(stateHome({ LOCALAPPDATA: "C:\\L" }, "win32"), /ss-chromium$/);
    assert.match(
      stateHome({}, "darwin"),
      /Application Support[\\/]ss-chromium$/,
    );
    assert.equal(
      stateHome({ XDG_DATA_HOME: "/data" }, "linux"),
      path.join("/data", "ss-chromium"),
    );
  });
});

describe("browser process matching", () => {
  const config = {
    executable: "/opt/chromium/chrome",
    profile: "/state/profile",
  };
  const browser = (pid, extra = "") => ({
    ProcessId: pid,
    ExecutablePath: config.executable,
    CommandLine: `${config.executable} --user-data-dir=/state/profile --remote-debugging-port=9333${extra}`,
  });

  it("reads quoted and plain arguments", () => {
    assert.equal(
      commandLineArgument('x --user-data-dir="/a b" --y=1', "user-data-dir"),
      "/a b",
    );
    assert.equal(commandLineArgument("x --y=1", "y"), "1");
    assert.equal(commandLineArgument("x", "y"), undefined);
  });
  it("adopts the browser process and ignores its renderers", () => {
    const found = matchingBrowser(
      [browser(1), browser(2, " --type=renderer")],
      config,
    );
    assert.deepEqual(found, { browserPid: 1, debugPort: 9333 });
  });
  it("ignores other profiles and executables", () => {
    const other = {
      ...browser(3),
      CommandLine: browser(3).CommandLine.replace("/state/profile", "/other"),
    };
    const foreign = { ...browser(4), ExecutablePath: "/usr/bin/other" };
    assert.equal(matchingBrowser([other, foreign], config), null);
  });
  it("refuses ambiguous or undebuggable owners of the profile", () => {
    assert.throws(
      () => matchingBrowser([browser(1), browser(2)], config),
      /Several browsers/,
    );
    const noPort = {
      ...browser(5),
      CommandLine: `${config.executable} --user-data-dir=/state/profile`,
    };
    assert.throws(() => matchingBrowser([noPort], config), /did not start/);
  });
  it("parses ps output, including executables with spaces", () => {
    const executable =
      "/Apps/Chrome for Testing.app/Contents/MacOS/Chrome for Testing";
    const processes = parsePosixProcesses(
      ` 12 ${executable} --user-data-dir=/p\n 13 /bin/zsh\n`,
      executable,
    );
    assert.equal(processes[0].ExecutablePath, executable);
    assert.equal(processes[1].ExecutablePath, null);
  });
});

describe("browser launch", () => {
  const config = { profile: "/p", paths: { extension: "/e" } };
  it("loads the provisioned extension and keeps debugging on loopback", () => {
    const args = browserArguments(config, 9444, false, {});
    assert.ok(args.includes("--load-extension=/e"));
    assert.ok(args.includes("--remote-debugging-address=127.0.0.1"));
    assert.ok(args.includes("--remote-debugging-port=9444"));
    assert.ok(!args.some((arg) => arg.startsWith("--headless")));
  });
  it("runs headless only when asked and restores after a crash", () => {
    const args = browserArguments(config, 1, true, {
      SS_CHROMIUM_HEADLESS: "1",
    });
    assert.ok(args.includes("--headless=new"));
    assert.ok(args.includes("--restore-last-session"));
  });
});

describe("installation identity", () => {
  it("derives the extension ID the server accepts from the manifest key", () => {
    const keySource = readFileSync(
      path.join(repo, "apps", "extension", "extension-key.ts"),
      "utf8",
    );
    const key = keySource.match(/"([A-Za-z0-9+/=]{100,})"/)[1];
    const protocol = readFileSync(
      path.join(repo, "packages", "protocol", "src", "index.ts"),
      "utf8",
    );
    const accepted = protocol.match(
      /SELF_BUILT_EXTENSION_ID = "([a-p]{32})"/,
    )[1];
    assert.equal(extensionIdForKey(key), accepted);
  });
  it("chooses a relay port once and keeps it", async () => {
    const env = { SS_CHROMIUM_HOME: temp() };
    const first = await prepareBridge(env);
    const second = await prepareBridge(env);
    assert.equal(first.port, second.port);
    assert.ok(first.port >= 1024);
  });
  it("refuses a corrupt relay port with a fix", async () => {
    const home = temp();
    const paths = statePaths(home);
    mkdirSync(paths.daemon, { recursive: true });
    writeFileSync(paths.bridge, JSON.stringify({ port: 80 }));
    await assert.rejects(
      prepareBridge({ SS_CHROMIUM_HOME: home }),
      /Delete that file/,
    );
  });
  it("provisions the extension with only public configuration", () => {
    const home = temp();
    const bundled = temp();
    writeFileSync(
      path.join(bundled, "manifest.json"),
      JSON.stringify({ background: { service_worker: "background.js" } }),
    );
    writeFileSync(
      path.join(bundled, "background.js"),
      "console.log('worker');\n",
    );
    const paths = statePaths(home);
    mkdirSync(paths.daemon, { recursive: true });
    provisionExtension({
      paths,
      bundledExtension: bundled,
      extensionId: "a".repeat(32),
      port: 9010,
      publicKey: "PUBLIC",
    });
    const worker = readFileSync(
      path.join(paths.extension, "background.js"),
      "utf8",
    );
    assert.match(
      worker,
      /^globalThis\.SS_CHROMIUM_SESSION=Object\.freeze\(\{"sessionId":"shared-profile","relayPort":9010,"publicKey":"PUBLIC"\}\);/,
    );
    assert.doesNotMatch(worker, /PRIVATE|privateKey/);
    assert.equal(
      readFileSync(paths.devExtensionIds, "utf8"),
      `${"a".repeat(32)}\n`,
    );
  });
});

describe("registration", () => {
  it("prints a standard MCP config block", () => {
    const parsed = JSON.parse(
      configSnippet(["node", "/x/ss-chromium.mjs", "mcp"]),
    );
    assert.deepEqual(parsed.mcpServers.ss_chromium, {
      command: "node",
      args: ["/x/ss-chromium.mjs", "mcp"],
    });
  });
  it("installs the skill once and never overwrites a different one", () => {
    const claude = temp();
    const source = path.join(temp(), "SKILL.md");
    writeFileSync(source, "skill v1");
    assert.equal(
      installSkill(path.join(claude, "missing"), source),
      "no Claude directory",
    );
    assert.equal(installSkill(claude, source), "installed");
    assert.equal(installSkill(claude, source), "up to date");
    writeFileSync(source, "skill v2");
    assert.equal(installSkill(claude, source), "kept existing");
    assert.equal(
      readFileSync(
        path.join(claude, "skills", "ss-chromium", "SKILL.md"),
        "utf8",
      ),
      "skill v1",
    );
  });
});

describe("optional vision", () => {
  it("is off unless configured, and only for http(s)", () => {
    assert.equal(visionEndpoint({}), null);
    assert.equal(
      visionEndpoint({ SS_CHROMIUM_VISION_URL: "http://127.0.0.1:1/analyze" })
        .port,
      "1",
    );
    assert.throws(
      () => visionEndpoint({ SS_CHROMIUM_VISION_URL: "file:///etc/passwd" }),
      /http/,
    );
  });
  it("explains how to turn it on", async () => {
    await assert.rejects(
      describeImage("x.png", "what?", {}),
      /SS_CHROMIUM_VISION_URL/,
    );
  });
  it("sends the image and prompt and returns the analysis", async () => {
    const image = path.join(temp(), "shot.png");
    writeFileSync(image, Buffer.from([1, 2, 3]));
    let received;
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        received = JSON.parse(body);
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ ok: true, analysis: "a bar chart" }));
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const url = `http://127.0.0.1:${server.address().port}/analyze`;
      assert.equal(
        await describeImage(image, "describe", { SS_CHROMIUM_VISION_URL: url }),
        "a bar chart",
      );
      assert.deepEqual(received, {
        image: "AQID",
        image_base64: "AQID",
        prompt: "describe",
      });
    } finally {
      server.close();
    }
  });
  it("speaks CrawlRX's /vision/analyze contract", async () => {
    const image = path.join(temp(), "shot.png");
    writeFileSync(image, Buffer.from([1, 2, 3]));
    const answers = [
      { success: true, text: "a login form", model: "m", elapsed_ms: 5 },
      { success: false, text: "", error: "No model server" },
    ];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        // CrawlRX rejects a request without image_base64 (HTTP 422).
        const ok = JSON.parse(body).image_base64 === "AQID";
        response.writeHead(ok ? 200 : 422, {
          "Content-Type": "application/json",
        });
        response.end(JSON.stringify(ok ? answers.shift() : {}));
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const env = {
        SS_CHROMIUM_VISION_URL: `http://127.0.0.1:${server.address().port}/vision/analyze`,
      };
      assert.equal(await describeImage(image, "describe", env), "a login form");
      await assert.rejects(
        describeImage(image, "describe", env),
        /No model server/,
      );
    } finally {
      server.close();
    }
  });
});

describe("cli", () => {
  const cli = path.join(here, "..", "bin", "ss-chromium.mjs");
  const run = (...args) =>
    spawnSync(process.execPath, [cli, ...args], {
      encoding: "utf8",
      env: { ...process.env, SS_CHROMIUM_HOME: temp() },
    });
  it("prints its version and config block", () => {
    assert.match(run("--version").stdout, /^\d+\.\d+\.\d+/);
    assert.ok(JSON.parse(run("config").stdout).mcpServers.ss_chromium);
  });
  it("rejects unknown commands with usage", () => {
    const result = run("nope");
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Unknown command: nope/);
  });
});

describe("daemon coupling", () => {
  it("keeps the browser host's status where the daemon reads it (FedCM)", () => {
    const paths = statePaths("/state");
    assert.equal(path.dirname(paths.hostInfo), paths.daemon);
    assert.equal(path.basename(paths.hostInfo), "browser-host.json");
  });
});
