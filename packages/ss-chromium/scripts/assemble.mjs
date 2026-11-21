// Copies the built MCP server and extension into this package, which is what npm ships.
// Run after `pnpm build` of @browsermcp/mcp and @browsermcp/extension (pnpm orders it).
import { cpSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.resolve(here, "..", "..");
const parts = [
  {
    from: path.join(repo, "packages", "mcp", "dist"),
    to: path.join(here, "server"),
  },
  {
    from: path.join(repo, "apps", "extension", ".output", "chrome-mv3"),
    to: path.join(here, "extension"),
  },
  { from: path.join(repo, "LICENSE"), to: path.join(here, "LICENSE") },
  { from: path.join(repo, "NOTICE.md"), to: path.join(here, "NOTICE.md") },
  { from: path.join(repo, "README.md"), to: path.join(here, "README.md") },
  {
    from: path.join(repo, "skills", "ss-chromium", "SKILL.md"),
    to: path.join(here, "skill", "SKILL.md"),
  },
  {
    from: path.join(repo, "packages", "mcp", "visual"),
    to: path.join(here, "visual"),
  },
];
for (const { from, to } of parts) {
  if (!existsSync(from)) {
    console.error(
      `Missing ${from}. Run \`pnpm build\` from the repository root first.`,
    );
    process.exit(1);
  }
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, {
    recursive: true,
    filter: (source) => !source.split(path.sep).includes("__pycache__"),
  });
}
console.log("Assembled server/, extension/, skill/, visual/ and license files.");
