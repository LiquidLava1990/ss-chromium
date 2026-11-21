/** Native Chromium account chooser control; page input cannot reach this UI.
 * Uses the official FedCm CDP API, through this installation's owned host only.
 * https://chromedevtools.github.io/devtools-protocol/tot/FedCm/
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import WebSocket from "ws";

import { browserMcpHome } from "@/daemon/paths";

export type FedcmDialog = {
  dialogId: string;
  dialogType: string;
  title: string;
  subtitle?: string;
  accounts: {
    email: string;
    name: string;
    loginState: string;
    idpConfigUrl: string;
  }[];
};

export class NativeFedcm {
  dialog: FedcmDialog | null = null;
  private nextId = 0;
  private pending = new Map<
    number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  get closed() {
    return this.socket.readyState !== WebSocket.OPEN;
  }

  private constructor(private socket: WebSocket) {
    socket.on("message", (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (message.method === "FedCm.dialogShown") this.dialog = message.params;
      if (
        message.method === "FedCm.dialogClosed" &&
        message.params.dialogId === this.dialog?.dialogId
      )
        this.dialog = null;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    const fail = () => {
      this.dialog = null;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(
          new Error(
            "Native account chooser connection closed; inspect before repeating an action",
          ),
        );
      }
      this.pending.clear();
    };
    socket.on("close", fail);
    socket.on("error", fail);
  }

  static async connect(targetId: string): Promise<NativeFedcm> {
    if (!/^[a-fA-F0-9-]{16,64}$/.test(targetId))
      throw new Error("Invalid owned Chromium target");
    const host = JSON.parse(
      await readFile(path.join(browserMcpHome(), "browser-host.json"), "utf8"),
    );
    const validPort = (port: unknown) =>
      Number.isInteger(port) && Number(port) > 0 && Number(port) < 65536;
    if (
      !validPort(host.hostPort) ||
      !validPort(host.debugPort) ||
      !host.hostToken
    )
      throw new Error(
        "This SS browser host predates native account chooser support; reopen SS Chromium to load the updated host",
      );
    const status = await fetch(`http://127.0.0.1:${host.hostPort}/status`, {
      headers: { authorization: `Bearer ${host.hostToken}` },
      signal: AbortSignal.timeout(3000),
    });
    if (!status.ok) throw new Error("The owned SS browser host is unavailable");
    const live = (await status.json()) as {
      debugPort?: number;
      browserPid?: number;
    };
    if (
      live.debugPort !== host.debugPort ||
      live.browserPid !== host.browserPid
    )
      throw new Error("SS browser restarted; inspect its current tabs");
    const socket = new WebSocket(
      `ws://127.0.0.1:${host.debugPort}/devtools/page/${targetId}`,
      { handshakeTimeout: 5000 },
    );
    const controller = new NativeFedcm(socket);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("open", resolve);
        socket.once("error", reject);
      });
      await controller.send("FedCm.enable", {});
      return controller;
    } catch (error) {
      socket.terminate();
      throw error;
    }
  }

  async send(method: string, params: Record<string, unknown>) {
    if (this.closed)
      throw new Error(
        "Native account chooser disconnected; inspect again before acting",
      );
    const id = ++this.nextId;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `${method} timed out; inspect sign-in state before repeating it`,
          ),
        );
      }, 5000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }), (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  close() {
    this.socket.close();
  }
}
