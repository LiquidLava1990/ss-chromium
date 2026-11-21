import { defineConfig } from "tsup";

// `dist/index.js` is the thin process (the `bin`); `dist/daemon.js` the daemon it starts with `node`. Dependencies stay external; workspace packages are bundled
export default defineConfig({
  entry: {
    index: "src/index.ts",
    daemon: "src/daemon/main.ts",
    "session-identity": "src/thin/session-identity.ts",
    "session-server": "src/thin/server.ts",
  },
  format: ["esm"],
  target: "node20",
  clean: true,
});
