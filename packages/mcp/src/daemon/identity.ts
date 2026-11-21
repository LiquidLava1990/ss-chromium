import {
  createPrivateKey,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  sign,
} from "node:crypto";
import {
  linkSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";

import type { DaemonIdentity } from "@/contracts";
import { identityPath } from "@/daemon/paths";
import type { PairingKey } from "@/relay/extension-connection";

/**
 * The daemon's pairing key: `~/.browsermcp/identity.json` (0600), an ECDSA P-256 key pair made on first start and kept across restarts and updates, so the extension's **Allow** survives them
 */
export function loadIdentity(home: string): PairingKey {
  const file = identityPath(home);
  const identity = readIdentity(file) ?? createIdentity(file);
  return pairingKey(identity);
}

export function pairingKey(identity: DaemonIdentity): PairingKey {
  const privateKey: KeyObject = createPrivateKey(identity.privateKey);
  return {
    publicKey: identity.publicKey,
    sign: (payload) =>
      sign("sha256", Buffer.from(payload, "utf8"), {
        key: privateKey,
        dsaEncoding: "ieee-p1363",
      }).toString("base64"),
  };
}

function readIdentity(file: string): DaemonIdentity | null {
  let json: string;
  try {
    json = fileAccess(() => readFileSync(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    // A locked file is not a missing/corrupt identity. Never rotate its key.
    throw error;
  }
  try {
    const identity = JSON.parse(json) as DaemonIdentity;
    createPrivateKey(identity.privateKey);
    return typeof identity.publicKey === "string" ? identity : null;
  } catch {
    return null;
  }
}

/** A new ECDSA P-256 key pair */
export function generateIdentity(): DaemonIdentity {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  return {
    publicKey: publicKey
      .export({ type: "spki", format: "der" })
      .toString("base64"),
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

/**
 * Writes a new key to a temp file and links it into place, which fails if the file exists, so the file is never seen half-written and a daemon starting at the same moment never replaces the key another one already uses: the loser reads the winner's
 */
function createIdentity(file: string): DaemonIdentity {
  const identity = generateIdentity();
  const json = JSON.stringify(identity, null, 2);
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(temp, json, { mode: 0o600, flag: "wx" });
  try {
    try {
      linkSync(temp, file);
      return identity;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        // A file system without hard links: create it exclusively instead
        writeFileSync(file, json, { mode: 0o600, flag: "wx" });
        return identity;
      }
    }
    const existing = readIdentity(file);
    if (existing) {
      return existing;
    }
    // An unreadable file (edited by hand, or written by an older version): replace it, then use whatever is there in case another daemon replaced it too
    fileAccess(() => renameSync(temp, file));
    return readIdentity(file) ?? identity;
  } finally {
    rmSync(temp, { force: true });
  }
}

/** Windows scanners can briefly hold a closed file without delete sharing. */
function fileAccess<T>(operation: () => T): T {
  const deadline = Date.now() + 1000;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      return operation();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        process.platform !== "win32" ||
        !["EPERM", "EACCES", "EBUSY"].includes(code ?? "") ||
        Date.now() >= deadline
      )
        throw error;
      Atomics.wait(pause, 0, 0, 20);
    }
  }
}
