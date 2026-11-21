import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { loadIdentity } from "@/daemon/identity";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    readFileSync: vi.fn(fs.readFileSync),
    renameSync: vi.fn(fs.renameSync),
  };
});

let home: string;
beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "ss-identity-lock-"));
});
afterEach(() => {
  vi.mocked(readFileSync).mockRestore();
  vi.mocked(renameSync).mockRestore();
  rmSync(home, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
});
const locked = () =>
  Object.assign(new Error("temporary Windows file lock"), { code: "EPERM" });

it.skipIf(process.platform !== "win32")(
  "keeps the same identity after a transient read lock",
  () => {
    const first = loadIdentity(home);
    vi.mocked(readFileSync).mockImplementationOnce(() => {
      throw locked();
    });
    expect(loadIdentity(home).publicKey).toBe(first.publicKey);
    expect(readdirSync(home)).toEqual(["identity.json"]);
  },
);

it.skipIf(process.platform !== "win32")(
  "retries a transient rename lock while replacing corrupt identity data",
  () => {
    writeFileSync(path.join(home, "identity.json"), "{");
    vi.mocked(renameSync).mockImplementationOnce(() => {
      throw locked();
    });
    const identity = loadIdentity(home);
    expect(loadIdentity(home).publicKey).toBe(identity.publicKey);
    expect(readdirSync(home)).toEqual(["identity.json"]);
  },
);

it("does not replace a valid identity when access remains denied", async () => {
  const first = loadIdentity(home);
  vi.mocked(readFileSync).mockImplementation(() => {
    throw locked();
  });
  expect(() => loadIdentity(home)).toThrow("temporary Windows file lock");
  vi.mocked(readFileSync).mockRestore();
  expect(loadIdentity(home).publicKey).toBe(first.publicKey);
  expect(readdirSync(home)).toEqual(["identity.json"]);
});
