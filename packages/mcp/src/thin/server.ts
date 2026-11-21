import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { fileURLToPath } from "node:url";

import { INSTRUCTIONS } from "@/commands/instructions";
import type { Capability } from "@/contracts";
import { browserMcpHome } from "@/daemon/paths";
import { DaemonClient } from "@/thin/daemon-client";
import { createFileAccess } from "@/thin/files";
import {
  sessionIdForKey,
  validateConversationKey,
} from "@/thin/session-identity";
import { debugLog, type Logger } from "@/utils/log";
import { errorMessage } from "@/utils/rpc";
import { VERSION } from "@/version";

export type ThinOptions = {
  capabilities: Capability[];
  port?: number;
  home?: string;
  version?: string;
  /** Starts the daemon. Default: this package's `dist/daemon.js` with the current Node */
  daemonCommand?: string[];
  log?: Logger;
  /** Installation hook, invoked on demand before dispatching browser commands. */
  beforeBrowserCall?: () => Promise<unknown>;
};

/**
 * Creates the thin process's MCP server: one per AI app, over stdio. It forwards `tools/list` and `tools/call` to the daemon (started on demand) and answers the daemon's file requests
 */
export function createThinServer(options: ThinOptions) {
  const log = options.log ?? debugLog;
  let scope = process.env.SS_CHROMIUM_SESSION_ID;
  const ss = !!scope && /^[a-f0-9-]{36}$/.test(scope);
  const provisionalScope = scope;
  let boundKey =
    ss && process.env.SS_CHROMIUM_CONVERSATION_KEY
      ? validateConversationKey(process.env.SS_CHROMIUM_CONVERSATION_KEY)
      : undefined;
  let initializedScope = false;
  let binding: Promise<void> | undefined;
  let hasCalled = false;
  const server = new Server(
    {
      name: ss ? "SS Chromium" : "Browser MCP",
      version: options.version ?? VERSION,
    },
    {
      capabilities: { tools: {} },
      instructions:
        INSTRUCTIONS +
        (ss
          ? "\nSS Chromium: pass a stable session_key for this conversation, <client>:<conversation id> (in Codex codex:<CODEX_THREAD_ID>; elsewhere generate one UUID once and reuse it). Reuse it when this conversation resumes; other conversations need different keys. Never derive it from the project path or client name."
          : ""),
    },
  );

  function clientNamespace(): "claude" | "codex" | undefined {
    const name = server.getClientVersion()?.name ?? "";
    if (/^claude\b/i.test(name)) return "claude";
    if (/^codex\b/i.test(name)) return "codex";
    return undefined;
  }

  function initializeScope(): void {
    if (initializedScope) return;
    initializedScope = true;
    const namespace = clientNamespace();
    if (boundKey && namespace && !boundKey.startsWith(`${namespace}:`)) {
      boundKey = undefined;
    }
    scope = boundKey ? sessionIdForKey(boundKey) : provisionalScope;
  }

  /** The AI app's MCP roots, or the working directory when it has none, which relative file paths resolve against */
  const roots = async (): Promise<string[]> => {
    if (server.getClientCapabilities()?.roots) {
      try {
        const { roots } = await server.listRoots(undefined, { timeout: 5000 });
        const paths = roots
          .filter((root) => root.uri.startsWith("file://"))
          .map((root) => fileURLToPath(root.uri));
        if (paths.length > 0) {
          return paths;
        }
      } catch (error) {
        log("Couldn't list the MCP roots:", errorMessage(error));
      }
    }
    return [process.cwd()];
  };

  const daemon = new DaemonClient({
    home: options.home ?? browserMcpHome(),
    port: options.port,
    version: options.version ?? VERSION,
    daemonCommand: options.daemonCommand ?? [
      process.execPath,
      fileURLToPath(new URL("./daemon.js", import.meta.url)),
    ],
    client: () => {
      const client = server.getClientVersion();
      if (ss) {
        return {
          name: `ss-window-${scope}`,
          title: boundKey
            ? boundKey.replace(":", "-")
            : `${client?.title ?? client?.name ?? "SS Chromium"} — ${scope}`,
          version: client?.version,
        };
      }
      return {
        name: client?.name ?? "MCP client",
        title: client?.title,
        version: client?.version,
      };
    },
    capabilities: options.capabilities,
    files: createFileAccess(roots),
    log,
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    initializeScope();
    const result = await daemon.call("tools/list", {});
    if (!ss) return result;
    return {
      ...result,
      tools: result.tools.map((tool) =>
        tool.name !== "browser"
          ? tool
          : {
              ...tool,
              inputSchema: {
                ...tool.inputSchema,
                properties: {
                  ...tool.inputSchema.properties,
                  session_key: {
                    type: "string",
                    description:
                      "Stable conversation key, <client>:<conversation id>, e.g. claude:<UUID> or codex:<CODEX_THREAD_ID>. Reuse after restart; different chats use different keys. Bind on the first call; later changes are refused.",
                  },
                },
                required: [
                  ...(tool.inputSchema.required ?? []),
                  ...(!boundKey ? ["session_key"] : []),
                ],
              },
            },
      ),
    };
  });

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request): Promise<CallToolResult> => {
      try {
        if (ss && request.params.name === "browser") {
          initializeScope();
          const requested = request.params.arguments?.session_key;
          if (requested !== undefined) {
            const key = validateConversationKey(requested);
            const namespace = clientNamespace();
            if (namespace && !key.startsWith(`${namespace}:`)) {
              throw new Error(
                `This MCP client requires a ${namespace}: conversation key.`,
              );
            }
            if (boundKey && key !== boundKey && hasCalled)
              throw new Error(
                "This connection is bound to a different conversation; its session_key cannot change",
              );
            if (key !== boundKey) {
              boundKey = key;
              binding = (async () => {
                // tools/list may already have opened the temporary daemon scope.
                // Finish that handshake before replacing it, without page actions.
                await daemon.connect().catch(() => {});
                daemon.close();
                scope = sessionIdForKey(key);
              })();
            }
          }
          if (!boundKey)
            throw new Error(
              "A stable session_key is required before browser control: pass <client>:<conversation id> (in Codex, codex:<CODEX_THREAD_ID>; otherwise generate one UUID for this conversation and reuse it). Do not use the client name or project path",
            );
          hasCalled = true;
          await binding;
        }
        if (request.params.name === "browser")
          await options.beforeBrowserCall?.();
        return await daemon.call("tools/call", {
          name: request.params.name,
          arguments: request.params.arguments,
        });
      } catch (error) {
        const message = errorMessage(error);
        return {
          content: [
            {
              type: "text",
              text:
                message === "Connection closed"
                  ? "The browser daemon stopped while handling this call. Reconnection starts automatically. Inspect the page state before repeating an input or submission; its outcome may be uncertain"
                  : message,
            },
          ],
          isError: true,
        };
      }
    },
  );

  return { server, daemon };
}

/** The `bin` entry: serves MCP over stdio until the AI app closes stdin */
export async function runThin(options: ThinOptions) {
  const { server, daemon } = createThinServer(options);
  process.stdin.on("close", () => {
    daemon.close();
    void server.close().finally(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
  await server.connect(new StdioServerTransport());
}
