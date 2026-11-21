import { beforeEach, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";

import { appGroupsItem } from "../storage";
import { installFakeChrome } from "./fake-chrome.test-helper";
import {
  noteSSWindowClosing,
  restoreSSSession,
  restoreSSWindows,
  saveSSWindows,
} from "./ss-windows";

const a = {
  id: "ss-window-00000000-0000-4000-8000-000000000001",
  name: "Window A",
};
const b = {
  id: "ss-window-00000000-0000-4000-8000-000000000002",
  name: "Window B",
};
let chrome: ReturnType<typeof installFakeChrome>;
const saveFakeTabs = (
  tabs: ReturnType<typeof chrome.addTab>[],
  groups: Parameters<typeof saveSSWindows>[1],
) =>
  saveSSWindows(tabs as unknown as Parameters<typeof saveSSWindows>[0], groups);
beforeEach(() => {
  fakeBrowser.reset();
  chrome = installFakeChrome();
});

it("restores multiple tabs into separate owned windows after browser state clears", async () => {
  await fakeBrowser.storage.local.set({
    ssSessionWindows: [
      { app: a, urls: ["https://example.com/a", "https://example.com/a2"] },
      { app: b, urls: ["https://example.com/b", "https://example.com/b2"] },
    ],
  });
  await restoreSSWindows();
  expect(chrome.tabs.size).toBe(0);
  await restoreSSSession(a.id);
  expect(chrome.tabs.size).toBe(2);
  await restoreSSSession(b.id);
  const groups = await appGroupsItem.getValue();
  const first = [...chrome.tabs.values()].filter(
    (t) => groups.tabApps[t.id] === a.id,
  );
  const second = [...chrome.tabs.values()].filter(
    (t) => groups.tabApps[t.id] === b.id,
  );
  expect(first.map((t) => t.url)).toEqual([
    "https://example.com/a",
    "https://example.com/a2",
  ]);
  expect(second.map((t) => t.url)).toEqual([
    "https://example.com/b",
    "https://example.com/b2",
  ]);
  expect(first[0]!.windowId).not.toBe(second[0]!.windowId);
  expect(first[0]!.windowId).toBe(first[1]!.windowId);
});

it("does not duplicate windows when only the service worker restarts", async () => {
  await fakeBrowser.storage.local.set({
    ssSessionWindows: [{ app: a, urls: ["https://example.com/a"] }],
  });
  await restoreSSWindows();
  await restoreSSSession(a.id);
  const count = chrome.tabs.size;
  await restoreSSWindows();
  expect(chrome.tabs.size).toBe(count);
});

it("restores sessions when Chromium starts without a current window", async () => {
  await fakeBrowser.storage.local.set({
    ssSessionWindows: [{ app: a, urls: ["https://example.com/a"] }],
  });
  vi.spyOn(fakeBrowser.tabGroups, "query").mockRejectedValueOnce(
    new Error("No current window"),
  );
  await restoreSSWindows();
  expect(chrome.tabs.size).toBe(0);
  await restoreSSSession(a.id);
  expect([...chrome.tabs.values()].map((tab) => tab.url)).toEqual([
    "https://example.com/a",
  ]);
  expect(Object.values((await appGroupsItem.getValue()).tabApps)).toContain(
    a.id,
  );
});

it("rebinds a natively restored group instead of opening duplicate tabs", async () => {
  const tab = chrome.addTab({ id: 5, url: "https://example.com/a" });
  const id = await fakeBrowser.tabs.group({ tabIds: [tab.id] });
  await fakeBrowser.tabGroups.update(id, { title: a.name });
  await fakeBrowser.storage.local.set({
    ssSessionWindows: [{ app: a, urls: ["https://example.com/a"] }],
  });
  await restoreSSWindows();
  expect(chrome.tabs.size).toBe(1);
  expect((await appGroupsItem.getValue()).tabApps[tab.id]).toBe(a.id);
});

it("does not reopen scripts, browser pages or unrelated application snapshots", async () => {
  await fakeBrowser.storage.local.set({
    ssSessionWindows: [
      {
        app: a,
        urls: [
          "https://example.com/a",
          "javascript:alert(1)",
          "chrome://settings",
        ],
      },
      {
        app: { id: "other-app", name: "Other" },
        urls: ["https://example.com/private"],
      },
    ],
  });
  await restoreSSWindows();
  await restoreSSSession(a.id);
  expect([...chrome.tabs.values()].map((t) => t.url)).toEqual([
    "https://example.com/a",
  ]);
});

it("preserves a closing window while another conversation continues updating", async () => {
  await restoreSSWindows();
  const a1 = chrome.addTab({
    id: 101,
    windowId: 501,
    url: "https://example.com/a1",
  });
  const a2 = chrome.addTab({
    id: 102,
    windowId: 501,
    url: "https://example.com/a2",
  });
  const b1 = chrome.addTab({
    id: 103,
    windowId: 502,
    url: "https://example.com/b1",
  });
  const groups = {
    apps: {
      [a.id]: { name: a.name, color: "blue" as const, groupIds: [] },
      [b.id]: { name: b.name, color: "red" as const, groupIds: [] },
    },
    tabApps: { [a1.id]: a.id, [a2.id]: a.id, [b1.id]: b.id },
  };
  await saveFakeTabs([a1, a2, b1], groups);
  noteSSWindowClosing(501);
  await saveFakeTabs([a2, b1], groups);
  await saveFakeTabs([b1], groups);
  const saved = await fakeBrowser.storage.local.get("ssSessionWindows");
  expect(saved.ssSessionWindows).toEqual(
    expect.arrayContaining([
      { app: a, urls: ["https://example.com/a1", "https://example.com/a2"] },
      { app: b, urls: ["https://example.com/b1"] },
    ]),
  );
});

it("updates a snapshot when a single tab is closed normally", async () => {
  await restoreSSWindows();
  const first = chrome.addTab({
    id: 201,
    windowId: 601,
    url: "https://example.com/first",
  });
  const second = chrome.addTab({
    id: 202,
    windowId: 601,
    url: "https://example.com/second",
  });
  const groups = {
    apps: { [a.id]: { name: a.name, color: "blue" as const, groupIds: [] } },
    tabApps: { [first.id]: a.id, [second.id]: a.id },
  };
  await saveFakeTabs([first, second], groups);
  await saveFakeTabs([second], groups);
  const saved = await fakeBrowser.storage.local.get("ssSessionWindows");
  expect(saved.ssSessionWindows).toEqual([
    { app: a, urls: ["https://example.com/second"] },
  ]);
});

it("preserves the last complete snapshot when the window closes before the save finishes", async () => {
  await restoreSSWindows();
  const first = chrome.addTab({
    id: 301,
    windowId: 701,
    url: "https://example.com/one",
  });
  const second = chrome.addTab({
    id: 302,
    windowId: 701,
    url: "https://example.com/two",
  });
  const groups = {
    apps: { [a.id]: { name: a.name, color: "blue" as const, groupIds: [] } },
    tabApps: { [first.id]: a.id, [second.id]: a.id },
  };
  const pending = saveFakeTabs([first, second], groups);
  noteSSWindowClosing(701);
  await pending;
  await saveFakeTabs([], groups);
  const saved = await fakeBrowser.storage.local.get("ssSessionWindows");
  expect(saved.ssSessionWindows).toEqual([
    { app: a, urls: ["https://example.com/one", "https://example.com/two"] },
  ]);
});
