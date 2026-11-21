import { describe, expect, it, vi } from "vitest";

import { DaemonClient } from "@/thin/daemon-client";

const timeout = () => new Error("No answer to tools/list within 5 s");
const call = { name: "browser", arguments: { commands: "tab list" } };

describe("half-dead daemon recovery", () => {
  it("reconnects after a timed-out probe and dispatches the action once", async () => {
    const client = new DaemonClient({} as never);
    const dead = {
      open: true,
      pendingCount: 0,
      close: vi.fn(),
      request: vi.fn().mockRejectedValue(timeout()),
    };
    const fresh = {
      open: true,
      close: vi.fn(),
      request: vi
        .fn()
        .mockResolvedValueOnce({ tools: [] })
        .mockResolvedValueOnce({ content: [] }),
    };
    vi.spyOn(client, "connect")
      .mockResolvedValueOnce(dead as never)
      .mockResolvedValueOnce(fresh as never);
    await client.call("tools/call", call);
    expect(dead.close).toHaveBeenCalledOnce();
    expect(dead.request).toHaveBeenCalledOnce();
    expect(fresh.request.mock.calls.map(([method]) => method)).toEqual([
      "tools/list",
      "tools/call",
    ]);
  });

  it("does not close a peer that has another request in flight", async () => {
    const client = new DaemonClient({} as never);
    const peer = {
      open: true,
      pendingCount: 1,
      close: vi.fn(),
      request: vi.fn().mockRejectedValue(timeout()),
    };
    const connect = vi
      .spyOn(client, "connect")
      .mockResolvedValue(peer as never);
    await expect(client.call("tools/call", call)).rejects.toThrow(
      "No answer to tools/list",
    );
    expect(peer.close).not.toHaveBeenCalled();
    expect(connect).toHaveBeenCalledOnce();
  });

  it("does not dispatch an action when the replacement probe fails", async () => {
    const client = new DaemonClient({} as never);
    const dead = {
      open: true,
      pendingCount: 0,
      close: vi.fn(),
      request: vi.fn().mockRejectedValue(timeout()),
    };
    const fresh = {
      open: true,
      close: vi.fn(),
      request: vi.fn().mockRejectedValue(timeout()),
    };
    vi.spyOn(client, "connect")
      .mockResolvedValueOnce(dead as never)
      .mockResolvedValueOnce(fresh as never);
    await expect(client.call("tools/call", call)).rejects.toThrow(
      "No answer to tools/list",
    );
    expect(fresh.request).toHaveBeenCalledOnce();
    expect(fresh.request.mock.calls[0][0]).toBe("tools/list");
  });
});
