import { EventEmitter } from "node:events";
import {
  type Browser,
  type BrowserContext,
  type Page,
  chromium,
} from "playwright-core";
import { expect, it, vi } from "vitest";

import { BrowserSlot } from "@/relay/browser-slot";

vi.mock("playwright-core", () => ({ chromium: { connectOverCDP: vi.fn() } }));

function fixture(target: string, identify = Promise.resolve()) {
  const page = new EventEmitter() as EventEmitter & Page;
  const context = new EventEmitter() as EventEmitter & BrowserContext;
  const browser = new EventEmitter() as EventEmitter & Browser;
  page.isClosed = () => false;
  page.context = () => context;
  context.pages = () => [page];
  context.newCDPSession = vi.fn(async () => {
    await identify;
    return {
      send: async () => ({ targetInfo: { targetId: target } }),
      detach: async () => {},
    };
  }) as unknown as BrowserContext["newCDPSession"];
  browser.contexts = () => [context];
  browser.close = vi.fn(async () => {});
  return { browser, page };
}

function slot() {
  return new BrowserSlot("b1", "Chromium", "fixture", "Chromium", {
    log: () => {},
    cdpUrl: () => "ws://fixture",
    onReleased: () => {},
    pageTimeoutMs: 1000,
  });
}

it("retains replacement pages when the old browser disconnects late", async () => {
  const old = fixture("old"),
    current = fixture("new");
  vi.mocked(chromium.connectOverCDP)
    .mockResolvedValueOnce(old.browser)
    .mockResolvedValueOnce(current.browser);
  const s = slot();
  await s.browser();
  await s.waitForPage("old");
  let finishClose!: () => void;
  old.browser.close = () =>
    new Promise((resolve) => {
      finishClose = resolve;
    });
  const closing = s.close();
  await s.browser();
  expect(await s.waitForPage("new")).toBe(current.page);
  old.browser.emit("disconnected");
  finishClose();
  await closing;
  expect(await s.waitForPage("new")).toBe(current.page);
  await s.close();
});

it("ignores late page identification from an old connection", async () => {
  let identify!: () => void;
  const old = fixture(
    "same",
    new Promise((resolve) => {
      identify = resolve;
    }),
  );
  const current = fixture("same");
  vi.mocked(chromium.connectOverCDP)
    .mockResolvedValueOnce(old.browser)
    .mockResolvedValueOnce(current.browser);
  const s = slot();
  await s.browser();
  await s.close();
  await s.browser();
  expect(await s.waitForPage("same")).toBe(current.page);
  identify();
  await new Promise((resolve) => setImmediate(resolve));
  expect(await s.waitForPage("same")).toBe(current.page);
  await s.close();
});
