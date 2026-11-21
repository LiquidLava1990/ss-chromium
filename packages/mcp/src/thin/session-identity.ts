import { createHash } from "node:crypto";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function validateConversationKey(key: unknown): string {
  if (
    typeof key !== "string" ||
    !/^[a-z][a-z0-9_-]{0,31}:[A-Za-z0-9._:-]{1,200}$/.test(key)
  ) {
    throw new Error(
      "session_key must be a namespaced conversation ID, such as codex:<CODEX_THREAD_ID>",
    );
  }
  return key;
}

export function conversationKeyFromEnv(
  env: NodeJS.ProcessEnv,
): string | undefined {
  if (env.SS_CHROMIUM_CONVERSATION_KEY)
    return validateConversationKey(env.SS_CHROMIUM_CONVERSATION_KEY);
  if (env.CODEX_THREAD_ID && uuid.test(env.CODEX_THREAD_ID))
    return `codex:${env.CODEX_THREAD_ID.toLowerCase()}`;
  return undefined;
}

/** Versioned namespace: updates must preserve this mapping and extension ownership. */
export function sessionIdForKey(key: string): string {
  const bytes = createHash("sha256")
    .update("ss-chromium/conversation/v1\0")
    .update(validateConversationKey(key))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
