import { type Browser, browser } from "wxt/browser";
import { storage } from "wxt/utils/storage";

import type { AppInfo } from "@browsermcp/protocol";

import { appGroupsItem, type AppGroups } from "../storage";
import { groupTab, openAgentTab } from "./tab-groups";

type SavedWindow = { app: AppInfo; urls: string[] };
const savedWindows = storage.defineItem<SavedWindow[]>(
  "local:ssSessionWindows",
  { fallback: [] },
);
const restoredThisRun = storage.defineItem<boolean>(
  "session:ssWindowsRestored",
  { fallback: false },
);
let restoring = true;
let saveQueue: Promise<unknown> = Promise.resolve();
const windowSnapshots = new Map<number, Map<string, SavedWindow>>();
const closingWindows = new Map<number, Map<string, SavedWindow>>();
const pendingRestores = new Map<string, Promise<number | null>>();
const isolated = (id: string) => /^ss-window-[a-f0-9-]{36}$/.test(id);
const restorable = (url: string) =>
  /^(https?:\/\/|file:\/\/|about:blank$)/.test(url);

export async function forgetSSSession(appId: string) {
  for (const snapshots of [
    ...windowSnapshots.values(),
    ...closingWindows.values(),
  ])
    snapshots.delete(appId);
  const next = saveQueue.then(async () => {
    await savedWindows.setValue(
      (await savedWindows.getValue()).filter((entry) => entry.app.id !== appId),
    );
  });
  saveQueue = next.catch(() => {});
  await next;
}

// Chrome removes the tabs of a closing window one by one. Do not replace the
// last complete snapshot with those partial intermediate states.
export function noteSSWindowClosing(windowId: number) {
  const snapshot = windowSnapshots.get(windowId);
  if (snapshot?.size) closingWindows.set(windowId, new Map(snapshot));
}

// Session storage (and Chrome's tab/group IDs) does not survive a browser crash.
// Save ownership and read-navigation URLs, never form bodies or action commands.
export async function saveSSWindows(
  tabs: Browser.tabs.Tab[],
  groups: AppGroups,
) {
  if (restoring) return;
  windowSnapshots.clear();
  for (const tab of tabs) {
    const id = tab.id === undefined ? undefined : groups.tabApps[tab.id];
    const app = id && groups.apps[id];
    if (!id || !app || !isolated(id) || tab.windowId === undefined) continue;
    let snapshots = windowSnapshots.get(tab.windowId);
    if (!snapshots) windowSnapshots.set(tab.windowId, (snapshots = new Map()));
    let snapshot = snapshots.get(id);
    if (!snapshot)
      snapshots.set(id, (snapshot = { app: { id, name: app.name }, urls: [] }));
    const url = tab.url || tab.pendingUrl || "about:blank";
    if (restorable(url)) snapshot.urls.push(url);
    for (const [closingId, closingSnapshots] of closingWindows) {
      if (closingId !== tab.windowId) closingSnapshots.delete(id);
      if (!closingSnapshots.size) closingWindows.delete(closingId);
    }
  }
  const apps = Object.entries(groups.apps).filter(([id]) => isolated(id));
  if (!apps.length && !closingWindows.size) return;
  const windows = apps.flatMap(([id, app]) => {
    const urls = tabs
      .filter((tab) => groups.tabApps[tab.id!] === id)
      .map((tab) => tab.url || tab.pendingUrl || "about:blank")
      .filter(restorable);
    return urls.length ? [{ app: { id, name: app.name }, urls }] : [];
  });
  const next = saveQueue.then(async () => {
    const frozen = [...closingWindows.values()].flatMap((snapshots) => [
      ...snapshots.values(),
    ]);
    const closing = new Set(frozen.map((entry) => entry.app.id));
    const nextWindows = windows.filter((entry) => !closing.has(entry.app.id));
    const previous = await savedWindows.getValue();
    const merged = new Map(
      previous
        .filter((entry) => isolated(entry.app.id))
        .map((entry) => [entry.app.id, entry]),
    );
    const liveIds = new Set(
      tabs
        .map((tab) =>
          tab.id === undefined ? undefined : groups.tabApps[tab.id],
        )
        .filter(Boolean),
    );
    for (const id of liveIds) if (id && !closing.has(id)) merged.delete(id);
    for (const entry of [
      ...nextWindows,
      ...frozen.filter((entry) => entry.urls.length),
    ])
      merged.set(entry.app.id, entry);
    await savedWindows.setValue([...merged.values()]);
  });
  saveQueue = next.catch(() => {});
  await next;
}

export async function restoreSSWindows() {
  restoring = true;
  try {
    if (await restoredThisRun.getValue()) return;
    const saved = await savedWindows.getValue();
    if (saved.length) {
      // Give native session restoration a chance, then rebind fresh group/tab IDs.
      await new Promise((resolve) => setTimeout(resolve, 750));
      const liveGroups =
        (await browser.tabGroups?.query({}).catch((error: unknown) => {
          if (
            error instanceof Error &&
            /no current window/i.test(error.message)
          )
            return [];
          throw error;
        })) ?? [];
      for (const entry of saved) {
        if (!isolated(entry.app.id)) continue;
        const ids = new Set(
          liveGroups
            .filter((group) => group.title === entry.app.name)
            .map((group) => group.id),
        );
        const tabs = (
          await browser.tabs.query({ windowType: "normal" })
        ).filter((tab) => ids.has(tab.groupId));
        for (const tab of tabs)
          if (tab.id !== undefined) await groupTab(tab.id, entry.app);
      }
    }
    await restoredThisRun.setValue(true);
  } finally {
    restoring = false;
  }
}

// Reopen a saved window only when its own session asks to connect.
export async function restoreSSSession(appId: string): Promise<number | null> {
  if (!isolated(appId)) return null;
  const pending = pendingRestores.get(appId);
  if (pending) return pending;
  const restore = (async () => {
    await saveQueue;
    const groups = await appGroupsItem.getValue();
    const tabs = await browser.tabs.query({ windowType: "normal" });
    if (
      tabs.some(
        (tab) => tab.id !== undefined && groups.tabApps[tab.id] === appId,
      )
    )
      return null;
    const entry = (await savedWindows.getValue()).find(
      (item) => item.app.id === appId,
    );
    const savedUrls = entry?.urls.filter(restorable) ?? [];
    const urls = savedUrls.some((url) => url !== "about:blank")
      ? savedUrls.filter((url) => url !== "about:blank")
      : savedUrls;
    if (!entry || !urls.length) return null;
    const first = await openAgentTab(urls[0]!, appId);
    await groupTab(first, entry.app);
    const tab = await browser.tabs.get(first);
    for (const url of urls.slice(1)) {
      const next = await browser.tabs.create({
        url,
        windowId: tab.windowId,
        active: false,
      });
      if (next.id === undefined)
        throw new Error("Couldn't restore SS session tab");
      await groupTab(next.id, entry.app);
    }
    return first;
  })();
  pendingRestores.set(appId, restore);
  try {
    return await restore;
  } finally {
    pendingRestores.delete(appId);
  }
}
