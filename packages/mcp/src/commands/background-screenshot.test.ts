import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { type Harness, startHarness } from "@/commands/testing/harness";

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(() => h?.close());

it("captures fresh pixels from its own tab without bringing it in front of another session", async () => {
  const a = h.openSession("ss-window-00000000-0000-4000-8000-000000000081");
  const b = h.openSession("ss-window-00000000-0000-4000-8000-000000000082");
  await h.run(a, `goto ${h.fixtures.url("/misc")}`);
  const aId = Number(/^\* (\d+)/m.exec(await h.run(a, "tab list"))?.[1]);
  await h.run(b, `goto ${h.fixtures.url("/second")}`);
  const bId = Number(/^\* (\d+)/m.exec(await h.run(b, "tab list"))?.[1]);
  const page = h.backend.pageOf(aId),
    foreground = h.backend.pageOf(bId);
  // The extension now selects within the window and never requests desktop
  // focus. Disable the harness's bringToFront implementation to exercise that.
  const activate = vi
    .spyOn(h.backend, "activateTab")
    .mockResolvedValue(undefined);
  try {
    for (const color of ["rgb(255, 0, 0)", "rgb(0, 0, 255)"]) {
      await page.evaluate(async (background) => {
        document.body.innerHTML = "";
        document.documentElement.style.background = background;
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
      }, color);
      await foreground.bringToFront();
      const { result, text, isError } = await h.call(a, "screenshot");
      expect(isError, text).toBe(false);
      const shot = result.content.find((item) => item.type === "image");
      if (!shot || shot.type !== "image") throw new Error("Screenshot missing");
      const pixel = await foreground.evaluate(async (data) => {
        const image = await createImageBitmap(await (await fetch(data)).blob());
        const canvas = new OffscreenCanvas(image.width, image.height);
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        return Array.from(context.getImageData(100, 100, 1, 1).data);
      }, `data:${shot.mimeType};base64,${shot.data}`);
      const expected = color.includes("255, 0, 0") ? [255, 0, 0] : [0, 0, 255];
      for (let channel = 0; channel < 3; channel++)
        expect(Math.abs(pixel[channel]! - expected[channel]!)).toBeLessThan(10);
    }
  } finally {
    activate.mockRestore();
  }
});

it("keeps ten concurrent sessions' inputs, failures and screenshots separate", async () => {
  const activate = vi
    .spyOn(h.backend, "activateTab")
    .mockResolvedValue(undefined);
  const create = vi
    .spyOn(h.backend, "createTab")
    .mockImplementation((args) => h.backend.createWindowTab(args));
  try {
    const entries = [];
    for (let index = 0; index < 10; index++) {
      const session = h.openSession(
        `ss-window-00000000-0000-4000-8000-${String(101 + index).padStart(12, "0")}`,
      );
      expect(
        (await h.call(session, `goto ${h.fixtures.url("/covered")}`)).isError,
      ).toBe(false);
      const id = Number(
        /^\* (\d+)/m.exec(await h.run(session, "tab list"))?.[1],
      );
      const page = h.backend.pageOf(id);
      const color = [25 + index * 20, 220 - index * 15, 50 + index * 17];
      await page.evaluate((rgb) => {
        document.body.innerHTML =
          "<label>Session value<input></label><button>Save</button>";
        document.documentElement.style.background = `rgb(${rgb.join(",")})`;
        document.body.querySelector("button")!.onclick = () => {
          document.body.dataset.saved = document.querySelector("input")!.value;
          document.body.dataset.saves = String(
            Number(document.body.dataset.saves || 0) + 1,
          );
        };
      }, color);
      entries.push({ session, id, page, color, value: `session-${index}` });
    }
    expect(new Set(entries.map((e) => e.id)).size).toBe(10);
    expect(
      new Set(
        await Promise.all(
          entries.map(async (e) => (await h.backend.findTab(e.id))?.windowId),
        ),
      ).size,
    ).toBe(10);
    const results = await Promise.all(
      entries.map((entry) =>
        h.call(
          entry.session,
          `fill getByLabel('Session value') "${entry.value}"\nclick getByRole('button', {name:'Save',exact:true})\nscreenshot`,
        ),
      ),
    );
    for (const [index, result] of results.entries()) {
      expect(result.isError, result.text).toBe(false);
      const entry = entries[index]!;
      expect(
        await entry.page.evaluate(() => ({
          value: document.querySelector("input")!.value,
          saved: document.body.dataset.saved,
          saves: document.body.dataset.saves,
        })),
      ).toEqual({ value: entry.value, saved: entry.value, saves: "1" });
      const shot = result.result.content.find((item) => item.type === "image");
      if (!shot || shot.type !== "image")
        throw new Error("Session screenshot missing");
      const pixel = await entry.page.evaluate(async (data) => {
        const image = await createImageBitmap(await (await fetch(data)).blob());
        const canvas = new OffscreenCanvas(image.width, image.height),
          context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        return Array.from(context.getImageData(100, 100, 1, 1).data);
      }, `data:${shot.mimeType};base64,${shot.data}`);
      for (let channel = 0; channel < 3; channel++)
        expect(Math.abs(pixel[channel]! - entry.color[channel]!)).toBeLessThan(
          10,
        );
    }
    const denied = await h.call(
      entries[0]!.session,
      `tab select ${entries[1]!.id}`,
    );
    expect(denied.isError).toBe(true);
    expect(denied.text).toContain("belongs to another session");
    const continued = await Promise.all(
      entries.map((entry) =>
        h.run(entry.session, "get value getByLabel('Session value')"),
      ),
    );
    for (const [index, result] of continued.entries())
      expect(result).toContain(entries[index]!.value);
  } finally {
    activate.mockRestore();
    create.mockRestore();
  }
});
