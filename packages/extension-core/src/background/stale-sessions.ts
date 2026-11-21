import { browser } from "wxt/browser";
import { storage } from "wxt/utils/storage";

import { appGroupsItem } from "../storage";
import { forgetSSSession } from "./ss-windows";

export const SS_IDLE_TTL_MS = 24 * 60 * 60 * 1000;
const activity = storage.defineItem<Record<string, number>>(
  "local:ssSessionActivity",
  { fallback: {} },
);
let queue: Promise<unknown> = Promise.resolve();
let lastSweep = 0;
const emptyTabUrls = new Set([
  "about:blank",
  "chrome://newtab/",
  "chrome://new-tab-page/",
]);

function isEmptyTab(tab: { url?: string; pendingUrl?: string }): boolean {
  return (
    tab.url !== undefined &&
    emptyTabUrls.has(tab.url) &&
    (tab.pendingUrl === undefined || emptyTabUrls.has(tab.pendingUrl))
  );
}

/** Request-driven only: no timers, alarms, recurring jobs or browser focus changes. */
export function maintainSSSessions(
  appId: string | undefined,
  attached: ReadonlySet<number>,
  now = Date.now(),
) {
  const run = async () => {
    const times = await activity.getValue();
    if (appId) times[appId] = now;
    await activity.setValue(times);
    if (lastSweep && now - lastSweep < 60_000) return [];
    const groups = await appGroupsItem.getValue();
    const tabs = await browser.tabs.query({ windowType: "normal" });
    const removed: number[] = [];
    for (const id of Object.keys(groups.apps)) {
      if (!/^ss-window-[a-f0-9-]{36}$/.test(id) || id === appId) continue;
      const owned = tabs.filter(
        (t) => t.id !== undefined && groups.tabApps[t.id] === id,
      );
      if (!owned.length) continue;
      const accessed = owned
        .map((t) => t.lastAccessed)
        .filter(
          (t): t is number => typeof t === "number" && Number.isFinite(t),
        );
      const lastUsed = Math.max(
        times[id] ?? (accessed.length === owned.length ? 0 : now),
        ...accessed,
      );
      times[id] = lastUsed;
      // Website tabs can hold unsaved form state, even after a day of inactivity.
      if (
        now - lastUsed <= SS_IDLE_TTL_MS ||
        owned.some(
          (t) => !isEmptyTab(t) || t.pinned || t.audible || attached.has(t.id!),
        )
      )
        continue;
      // Recheck ownership and current tab state immediately before closing.
      const current = await appGroupsItem.getValue();
      const live = await Promise.all(
        owned.map((t) => browser.tabs.get(t.id!).catch(() => null)),
      );
      if (
        live.some(
          (t) =>
            !t ||
            !isEmptyTab(t) ||
            current.tabApps[t.id!] !== id ||
            t.pinned ||
            t.audible ||
            attached.has(t.id!) ||
            (typeof t.lastAccessed === "number" &&
              now - t.lastAccessed <= SS_IDLE_TTL_MS),
        )
      )
        continue;
      const ids = owned.map((t) => t.id!);
      await browser.tabs.remove(ids);
      await forgetSSSession(id);
      delete times[id];
      removed.push(...ids);
    }
    await activity.setValue(times);
    lastSweep = now;
    return removed;
  };
  const result = queue.then(run, run);
  queue = result.catch(() => {});
  return result;
}
