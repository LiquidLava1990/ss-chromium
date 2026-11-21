import { createHash } from "node:crypto";
import { expect, it } from "vitest";

import { SELF_BUILT_EXTENSION_ID } from "@browsermcp/protocol";

import { EXTENSION_KEY } from "./extension-key";
import { LOCAL_DAEMON_PUBLIC_KEY, LOCAL_RELAY_PORT } from "./local-install";

/** The extension ID Chrome derives from a manifest's `key`: the first 128 bits of its SHA-256 hash, with each hex digit (0-f) written as a letter (a-p) */
function getExtensionId(key: string): string {
  const hash = createHash("sha256")
    .update(Buffer.from(key, "base64"))
    .digest("hex")
    .slice(0, 32);
  return [...hash]
    .map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)))
    .join("");
}

it("gives every build the ID the server accepts", () => {
  expect(getExtensionId(EXTENSION_KEY)).toBe(SELF_BUILT_EXTENSION_ID);
});

it("ships no pre-trusted daemon key, so unprovisioned installs must pair", () => {
  expect(LOCAL_DAEMON_PUBLIC_KEY).toBeUndefined();
  expect(LOCAL_RELAY_PORT).toBeUndefined();
});
