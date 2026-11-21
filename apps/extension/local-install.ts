/**
 * A pre-trusted daemon key and relay port for builds that are not provisioned at launch.
 * Public builds leave both unset: the SS Chromium runtime injects its own installation's
 * public key when it loads the extension (`SS_CHROMIUM_SESSION`), and every other install
 * (Chrome Web Store, "Load unpacked") pairs with the server through the one-time **Allow** prompt.
 */
export const LOCAL_DAEMON_PUBLIC_KEY: string | undefined = undefined;
export const LOCAL_RELAY_PORT: number | undefined = undefined;
