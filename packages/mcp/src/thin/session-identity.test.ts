import { describe, expect, it } from "vitest";

import {
  conversationKeyFromEnv,
  sessionIdForKey,
  validateConversationKey,
} from "./session-identity";

describe("durable SS conversation identity", () => {
  it("keeps the versioned mapping stable across application updates", () => {
    expect(sessionIdForKey("codex:00000000-0000-0000-0000-000000000001")).toBe(
      "b128f6da-e0ad-5750-ae88-da5ee37cc16f",
    );
    expect(
      sessionIdForKey("codex:00000000-0000-0000-0000-000000000002"),
    ).not.toBe(sessionIdForKey("codex:00000000-0000-0000-0000-000000000001"));
  });
  it("uses the explicit conversation key ahead of an inherited terminal thread", () => {
    expect(
      conversationKeyFromEnv({
        SS_CHROMIUM_CONVERSATION_KEY: "claude:own-chat",
        CODEX_THREAD_ID: "00000000-0000-0000-0000-000000000001",
      }),
    ).toBe("claude:own-chat");
  });
  it("uses a valid Codex thread and leaves unidentified clients unbound", () => {
    expect(
      conversationKeyFromEnv({
        CODEX_THREAD_ID: "00000000-0000-0000-0000-00000000000A",
      }),
    ).toBe("codex:00000000-0000-0000-0000-00000000000a");
    expect(
      conversationKeyFromEnv({ CODEX_THREAD_ID: "project-folder" }),
    ).toBeUndefined();
    expect(conversationKeyFromEnv({})).toBeUndefined();
  });
  it("rejects missing, unnamespaced and malformed keys", () => {
    for (const key of [
      undefined,
      0,
      "codex",
      "codex:",
      "codex:a b",
      "codex:" + "a".repeat(201),
    ])
      expect(() => validateConversationKey(key)).toThrow(/conversation ID/);
  });
});
