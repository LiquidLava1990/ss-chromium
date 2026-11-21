import { beforeEach, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";

import { appGroupsItem } from "../storage";
import { installFakeChrome } from "./fake-chrome.test-helper";

const old = "ss-window-00000000-0000-4000-8000-000000000091";
const current = "ss-window-00000000-0000-4000-8000-000000000092";
const now = 1_800_000_000_000;
const day = 86_400_000;
let chrome: ReturnType<typeof installFakeChrome>;
let maintain: typeof import("./stale-sessions").maintainSSSessions;

beforeEach(async () => {
  vi.resetModules();
  fakeBrowser.reset();
  chrome = installFakeChrome();
  maintain = (await import("./stale-sessions")).maintainSSSessions;
  vi.spyOn(fakeBrowser.tabs, "remove").mockImplementation(async (ids) => {
    for (const id of Array.isArray(ids) ? ids : [ids]) chrome.tabs.delete(id);
  });
  await appGroupsItem.setValue({
    apps: {
      [old]: { name: "Old", color: "blue", groupIds: [] },
      [current]: { name: "Current", color: "red", groupIds: [] },
    },
    tabApps: { 1: old, 2: current },
  });
  Object.assign(chrome.addTab({ id: 1, url: "about:blank" }), {
    lastAccessed: now - 2 * day,
  });
  Object.assign(chrome.addTab({ id: 2 }), { lastAccessed: now - 2 * day });
});

it("closes stale owned tabs and deletes their saved restoration snapshot", async () => {
  await fakeBrowser.storage.local.set({
    ssSessionWindows: [
      { app: { id: old, name: "Old" }, urls: ["https://example.com/old"] },
      {
        app: { id: current, name: "Current" },
        urls: ["https://example.com/current"],
      },
    ],
  });
  expect(await maintain(current, new Set(), now)).toEqual([1]);
  expect(chrome.tabs.has(2)).toBe(true);
  expect(
    (await fakeBrowser.storage.local.get("ssSessionWindows")).ssSessionWindows,
  ).toEqual([
    {
      app: { id: current, name: "Current" },
      urls: ["https://example.com/current"],
    },
  ]);
});

it.each(["pinned", "audible", "attached", "recent", "unknown age"])(
  "preserves %s tabs",
  async (kind) => {
    const tab = chrome.tabs.get(1)!;
    if (kind === "pinned") tab.pinned = true;
    if (kind === "audible") Object.assign(tab, { audible: true });
    if (kind === "recent") Object.assign(tab, { lastAccessed: now - 1000 });
    if (kind === "unknown age")
      delete (tab as unknown as { lastAccessed?: number }).lastAccessed;
    expect(
      await maintain(current, new Set(kind === "attached" ? [1] : []), now),
    ).toEqual([]);
  },
);

it("keeps tabs for a recently used session even when its tabs were not selected", async () => {
  await fakeBrowser.storage.local.set({
    ssSessionActivity: { [old]: now - 1000 },
  });
  expect(await maintain(current, new Set(), now)).toEqual([]);
});

it("never closes unowned tabs", async () => {
  await appGroupsItem.setValue({ apps: {}, tabApps: {} });
  expect(await maintain(current, new Set(), now)).toEqual([]);
  expect(chrome.tabs.size).toBe(2);
});

it("rechecks user activity immediately before closing", async () => {
  const get = fakeBrowser.tabs.get;
  vi.spyOn(fakeBrowser.tabs, "get").mockImplementation(async (id) => ({
    ...(await get(id)),
    lastAccessed: now,
  }));
  expect(await maintain(current, new Set(), now)).toEqual([]);
});

it("preserves a stale session and its saved URLs when any tab is on a website", async () => {
  const draftUrl = "https://example.com/draft";
  await appGroupsItem.setValue({
    apps: {
      [old]: { name: "Old", color: "blue", groupIds: [] },
    },
    tabApps: { 1: old, 3: old },
  });
  Object.assign(chrome.addTab({ id: 3, url: draftUrl }), {
    lastAccessed: now - 2 * day,
  });
  const saved = [
    { app: { id: old, name: "Old" }, urls: ["about:blank", draftUrl] },
  ];
  await fakeBrowser.storage.local.set({ ssSessionWindows: saved });

  expect(await maintain(current, new Set(), now)).toEqual([]);
  expect(fakeBrowser.tabs.remove).not.toHaveBeenCalled();
  expect(
    (await fakeBrowser.storage.local.get("ssSessionWindows")).ssSessionWindows,
  ).toEqual(saved);
});

it("preserves an empty-looking tab when a website navigation is pending", async () => {
  const get = fakeBrowser.tabs.get;
  vi.spyOn(fakeBrowser.tabs, "get").mockImplementation(async (id) => ({
    ...(await get(id)),
    pendingUrl: "https://example.com/draft",
  }));
  expect(await maintain(current, new Set(), now)).toEqual([]);
  expect(fakeBrowser.tabs.remove).not.toHaveBeenCalled();
});
