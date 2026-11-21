// Builds the Chrome Web Store upload: a production zip whose manifest has no `key`
// (the store refuses one). Usage: node scripts/zip-store.mjs
import { spawnSync } from "node:child_process";

const result = spawnSync("wxt", ["zip"], {
  env: { ...process.env, SS_STORE_BUILD: "1" },
  shell: process.platform === "win32",
  stdio: "inherit",
});
if (result.status !== 0) {
  console.error(
    "Store zip failed: see the wxt output above, fix it, and run again.",
  );
  process.exit(result.status ?? 1);
}
