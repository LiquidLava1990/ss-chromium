import { beforeEach, expect, it } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";

import { appGroupsItem } from "../storage";
import { installFakeChrome } from "./fake-chrome.test-helper";
import { groupTab, openAgentTab } from "./tab-groups";
let chrome: ReturnType<typeof installFakeChrome>;
const a = { id: "ss-window-00000000-0000-4000-8000-000000000081", name: "A" };
const b = { id: "ss-window-00000000-0000-4000-8000-000000000082", name: "B" };
beforeEach(() => {
  fakeBrowser.reset();
  chrome = installFakeChrome();
});
it("hands the marked desktop starter to one session and keeps subsequent sessions separate", async () => {
  const starter = chrome.addTab({ url: "chrome://newtab/" });
  await fakeBrowser.storage.session.set({
    ssManualStarterTabIds: [starter.id],
  });
  const id = await openAgentTab("https://example.com/a", a.id);
  expect(id).toBe(starter.id);
  expect(chrome.tabs.size).toBe(1);
  await groupTab(id, a);
  const second = await openAgentTab("https://example.com/b", b.id);
  expect(chrome.tabs.get(second)!.windowId).not.toBe(starter.windowId);
  expect((await appGroupsItem.getValue()).tabApps[id]).toBe(a.id);
});
it("preserves ordinary blank tabs and marked windows that contain another tab", async () => {
  const ordinary = chrome.addTab({ url: "about:blank" });
  const marked = chrome.addTab({ url: "chrome://newtab/", windowId: 99 });
  await fakeBrowser.storage.session.set({ ssManualStarterTabIds: [marked.id] });
  chrome.addTab({ url: "https://example.com/preserved", windowId: 99 });
  const id = await openAgentTab("https://example.com/a", a.id);
  expect(id).not.toBe(ordinary.id);
  expect(id).not.toBe(marked.id);
  expect(chrome.tabs.get(ordinary.id)!.url).toBe("about:blank");
});
