import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  type CallToolResult,
  ListRootsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  inject,
  it,
  vi,
} from "vitest";

import { INSTRUCTIONS } from "@/commands/instructions";
import { readDaemonInfo } from "@/daemon/info";
import { daemonInfoPath } from "@/daemon/paths";
import { createFileAccess } from "@/thin/files";
import { createThinServer } from "@/thin/server";
import { sessionIdForKey } from "@/thin/session-identity";

let home: string;
let root: string;
let port: number;
let close: () => Promise<void>;

beforeEach(async () => {
  home = mkdtempSync(path.join(tmpdir(), "browsermcp-home-"));
  root = realpathSync(mkdtempSync(path.join(tmpdir(), "browsermcp-root-")));
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as net.AddressInfo).port;
  await new Promise((resolve) => server.close(resolve));
});

afterEach(async () => {
  await close?.();
  vi.unstubAllEnvs();
  const info = readDaemonInfo(daemonInfoPath(home, port));
  if (info) {
    try {
      process.kill(info.pid);
    } catch {
      // Already gone
    }
  }
  // Daemons that lost the race to start may still be writing their log
  rmSync(home, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
  rmSync(root, { recursive: true, force: true });
});

/** The thin process's MCP server, with an MCP client that has roots (or not) */
async function connect({
  roots,
  beforeBrowserCall,
  clientName = "claude-code",
}: {
  roots?: string[];
  beforeBrowserCall?: () => Promise<unknown>;
  clientName?: string;
} = {}) {
  const { server, daemon } = createThinServer({
    capabilities: [],
    port,
    home,
    version: "2.0.0",
    daemonCommand: [process.execPath, inject("stubDaemon")],
    log: () => {},
    beforeBrowserCall,
  });
  const client = new Client(
    { name: clientName, version: "1.0.0" },
    { capabilities: roots ? { roots: {} } : {} },
  );
  if (roots) {
    client.setRequestHandler(ListRootsRequestSchema, async () => ({
      roots: roots.map((root) => ({ uri: pathToFileURL(root).href })),
    }));
  }
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  close = async () => {
    daemon.close();
    await client.close();
  };
  const run = async (commands: string) => {
    const result = (await client.callTool({
      name: "browser",
      arguments: { commands },
    })) as CallToolResult;
    return {
      text: (result.content[0] as { text: string }).text,
      isError: !!result.isError,
    };
  };
  return { client, run };
}

describe("the thin process's MCP server", () => {
  it("runs installation recovery before dispatch and stops on recovery failure", async () => {
    const recover = vi
      .fn()
      .mockRejectedValueOnce(new Error("browser host restart failed"))
      .mockResolvedValue(undefined);
    const { run } = await connect({ beforeBrowserCall: recover });
    expect(await run("app")).toEqual({
      text: "browser host restart failed",
      isError: true,
    });
    expect((await run("app")).text).toBe("claude-code Claude Code");
    expect(recover).toHaveBeenCalledTimes(2);
  });
  it("requires a conversation key before SS browser actions and refuses later changes", async () => {
    vi.stubEnv(
      "SS_CHROMIUM_SESSION_ID",
      "00000000-0000-0000-0000-000000000001",
    );
    vi.stubEnv("SS_CHROMIUM_CONVERSATION_KEY", "");
    const { client } = await connect({ clientName: "Codex" });
    const tool = (await client.listTools()).tools.find(
      (t) => t.name === "browser",
    )!;
    expect(tool.inputSchema.required).toContain("session_key");
    const missing = await client.callTool({
      name: "browser",
      arguments: { commands: "app" },
    });
    expect(missing.isError).toBe(true);
    const key = "codex:test-conversation";
    const result = await client.callTool({
      name: "browser",
      arguments: { commands: "app", session_key: key },
    });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result.content)).toContain(
      `ss-window-${sessionIdForKey(key)}`,
    );
    const changed = await client.callTool({
      name: "browser",
      arguments: { commands: "app", session_key: "codex:other-conversation" },
    });
    expect(changed.isError).toBe(true);
    expect(JSON.stringify(changed.content)).toContain("different conversation");
  });

  it("keeps the same SS owner identity when a client reconnects after restart", async () => {
    vi.stubEnv(
      "SS_CHROMIUM_SESSION_ID",
      "00000000-0000-0000-0000-000000000001",
    );
    vi.stubEnv("SS_CHROMIUM_CONVERSATION_KEY", "");
    const key = "codex:resume-conversation";
    const first = await connect({ clientName: "Codex" });
    const before = await first.client.callTool({
      name: "browser",
      arguments: { commands: "app", session_key: key },
    });
    await close();
    const second = await connect({ clientName: "Codex" });
    const after = await second.client.callTool({
      name: "browser",
      arguments: { commands: "app", session_key: key },
    });
    expect(before.isError).not.toBe(true);
    expect(after.isError).not.toBe(true);
    expect(after.content).toEqual(before.content);
  });

  it("automatically binds an environment-provided conversation key", async () => {
    const key = "codex:environment-conversation";
    vi.stubEnv(
      "SS_CHROMIUM_SESSION_ID",
      "00000000-0000-0000-0000-000000000001",
    );
    vi.stubEnv("SS_CHROMIUM_CONVERSATION_KEY", key);
    const { client, run } = await connect({ clientName: "Codex" });
    expect(
      (await client.listTools()).tools[0]!.inputSchema.required,
    ).not.toContain("session_key");
    expect((await run("app")).text).toContain(
      `ss-window-${sessionIdForKey(key)}`,
    );
  });
  it("lets the explicit first-call chat ID replace a stale inherited environment ID", async () => {
    vi.stubEnv(
      "SS_CHROMIUM_SESSION_ID",
      "00000000-0000-0000-0000-000000000001",
    );
    vi.stubEnv("SS_CHROMIUM_CONVERSATION_KEY", "codex:inherited-parent-chat");
    const { client } = await connect({ clientName: "Codex" });
    await client.listTools();
    const key = "codex:actual-current-chat";
    const result = await client.callTool({
      name: "browser",
      arguments: { commands: "app", session_key: key },
    });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result.content)).toContain(
      `ss-window-${sessionIdForKey(key)}`,
    );
    const changed = await client.callTool({
      name: "browser",
      arguments: {
        commands: "app",
        session_key: "codex:inherited-parent-chat",
      },
    });
    expect(changed.isError).toBe(true);
  });

  it("rejects inherited and explicitly supplied Codex keys from Claude", async () => {
    vi.stubEnv(
      "SS_CHROMIUM_SESSION_ID",
      "00000000-0000-0000-0000-000000000001",
    );
    vi.stubEnv("SS_CHROMIUM_CONVERSATION_KEY", "codex:parent");
    const { client, run } = await connect();
    expect((await client.listTools()).tools[0]!.inputSchema.required).toContain(
      "session_key",
    );
    expect((await run("app")).isError).toBe(true);
    const call = (session_key: string) =>
      client.callTool({
        name: "browser",
        arguments: { commands: "app", session_key },
      });
    expect((await call("codex:parent")).isError).toBe(true);
    const reply = await call("claude:actual-chat");
    expect(reply.isError).not.toBe(true);
    expect(JSON.stringify(reply.content)).toContain(
      `ss-window-${sessionIdForKey("claude:actual-chat")}`,
    );
  });

  it("serves the daemon's tools, named after the MCP client, with the instructions", async () => {
    const { client, run } = await connect();
    expect(client.getInstructions()).toBe(INSTRUCTIONS);
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["browser"]);
    expect(await run("app")).toEqual({
      text: "claude-code Claude Code",
      isError: false,
    });
  });

  it("resolves relative file paths against the client's first MCP root, and reads and writes absolute ones elsewhere", async () => {
    writeFileSync(path.join(root, "upload.txt"), "data");
    writeFileSync(path.join(home, "elsewhere.txt"), "away");
    const { run } = await connect({ roots: [root] });
    expect(await run("read upload.txt")).toEqual({
      text: "upload.txt text/plain data",
      isError: false,
    });
    expect(await run(`write shots/page.jpg x`)).toEqual({
      text: path.join(root, "shots/page.jpg"),
      isError: false,
    });
    expect(await run(`read ${path.join(home, "elsewhere.txt")}`)).toEqual({
      text: "elsewhere.txt text/plain away",
      isError: false,
    });
    expect(await run(`write ${path.join(home, "out/page.jpg")} x`)).toEqual({
      text: path.join(home, "out/page.jpg"),
      isError: false,
    });
  });

  it("resolves relative file paths against a root of / too", async () => {
    const systemRoot =
      process.platform === "win32" ? path.parse(process.cwd()).root : "/";
    const hosts =
      process.platform === "win32"
        ? path.join(
            process.env.SystemRoot ?? "C:/Windows",
            "System32/drivers/etc/hosts",
          )
        : "/etc/hosts";
    const { run } = await connect({ roots: [systemRoot] });
    expect(
      (
        await run(
          `read ${path.relative(systemRoot, hosts).replaceAll("\\", "/")}`,
        )
      ).text,
    ).toContain("hosts ");
  });
});

describe("createFileAccess", () => {
  it("reads and writes absolute paths outside the roots, and through symlinks", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "browsermcp-outside-"));
    writeFileSync(path.join(outside, "secret"), "s");
    symlinkSync(outside, path.join(root, "link"));
    const files = createFileAccess(async () => [root]);
    await expect(
      files.readFile({ path: path.join(outside, "secret") }),
    ).resolves.toMatchObject({
      name: "secret",
      base64: Buffer.from("s").toString("base64"),
    });
    await expect(
      files.readFile({ path: "link/secret" }),
    ).resolves.toMatchObject({ name: "secret" });
    await expect(
      files.writeFile({ path: "link/new.txt", base64: "eA==" }),
    ).resolves.toEqual({ path: path.join(root, "link/new.txt") });
    expect(existsSync(path.join(outside, "new.txt"))).toBe(true);
    rmSync(outside, { recursive: true, force: true });
  });

  it("doesn't ask for the roots for absolute paths and ~", async () => {
    writeFileSync(path.join(root, "abs.txt"), "x");
    const files = createFileAccess(async () => {
      throw new Error("asked for the roots");
    }, home);
    await expect(
      files.readFile({ path: path.join(root, "abs.txt") }),
    ).resolves.toMatchObject({ name: "abs.txt" });
    await expect(
      files.writeFile({ path: "~/abs.txt", base64: "eA==" }),
    ).resolves.toEqual({ path: path.join(home, "abs.txt") });
  });

  it("expands ~ to the home directory", async () => {
    const files = createFileAccess(async () => [root], home);
    mkdirSync(path.join(home, "Downloads"));
    await expect(
      files.writeFile({ path: "~/Downloads/file.pdf", base64: "eA==" }),
    ).resolves.toEqual({ path: path.join(home, "Downloads/file.pdf") });
    await expect(
      files.readFile({ path: "~/Downloads/file.pdf" }),
    ).resolves.toMatchObject({
      name: "file.pdf",
      mimeType: "application/pdf",
    });
  });

  it("creates a file only if it isn't there when asked to, else overwrites", async () => {
    const files = createFileAccess(async () => [root], home);
    writeFileSync(path.join(root, "taken.txt"), "old");
    await expect(
      files.writeFile({ path: "taken.txt", base64: "eA==", exclusive: true }),
    ).rejects.toThrow(/EEXIST/);
    expect(readFileSync(path.join(root, "taken.txt"), "utf8")).toBe("old");
    await files.writeFile({ path: "taken.txt", base64: "eA==" });
    expect(readFileSync(path.join(root, "taken.txt"), "utf8")).toBe("x");
  });

  it("uses the working directory when the client has no roots", async () => {
    const files = createFileAccess(async () => [process.cwd()]);
    await expect(
      files.readFile({ path: "package.json" }),
    ).resolves.toMatchObject({
      name: "package.json",
      mimeType: "application/json",
    });
  });
});
