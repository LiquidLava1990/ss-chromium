import { defineBackground } from "wxt/utils/define-background";

import {
  addBrowserControl,
  handleBrowserControlMessages,
} from "@browsermcp/extension-core";

import { LOCAL_DAEMON_PUBLIC_KEY, LOCAL_RELAY_PORT } from "../../local-install";

/**
 * The service worker: browser control, the connection to the SS Chromium daemon and the `chrome.debugger` relay (`@browsermcp/extension-core`). Chrome stops it whenever it's idle, so its listeners are added synchronously here, and its state lives in `browser.storage`
 */
export default defineBackground(() => {
  // The session launcher prepends public configuration before this bundled worker.
  // It is not page state: each browser has its own extension directory and profile.
  const session = (
    globalThis as typeof globalThis & {
      SS_CHROMIUM_SESSION?: {
        relayPort: number;
        publicKey: string;
        sessionId: string;
      };
    }
  ).SS_CHROMIUM_SESSION;
  if (
    session &&
    (!Number.isInteger(session.relayPort) ||
      session.relayPort < 1024 ||
      session.relayPort > 65535 ||
      typeof session.publicKey !== "string" ||
      !session.publicKey ||
      typeof session.sessionId !== "string")
  ) {
    throw new Error("Invalid SS Chromium session configuration");
  }
  const alwaysEnabled = session?.sessionId === "shared-profile";
  Object.assign(globalThis, { SS_ALWAYS_ENABLED: alwaysEnabled });
  handleBrowserControlMessages(
    addBrowserControl({
      alwaysEnabled,
      reconnectDelaysMs: [0, 100, 250, 500, 1000, 2000],
      // Provisioned by the SS Chromium runtime: trust its own daemon key (signatures are still
      // verified). Anything else pairs through the one-time **Allow** prompt.
      trustedDaemonKeys: session
        ? [session.publicKey]
        : LOCAL_DAEMON_PUBLIC_KEY
          ? [LOCAL_DAEMON_PUBLIC_KEY]
          : [],
      relayPort: session?.relayPort ?? LOCAL_RELAY_PORT,
      // The smoke test's fake 0.1.x server
      legacyPortOverride: import.meta.env.MODE !== "production",
    }),
  );
});
