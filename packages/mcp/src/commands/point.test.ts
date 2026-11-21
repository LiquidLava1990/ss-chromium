import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { type Harness, startHarness } from "@/commands/testing/harness";

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(() => h?.close());

it("keeps a captured draggable inside a frame at its dropped position", async () => {
  const session = h.openSession(
    "ss-window-00000000-0000-4000-8000-000000000093",
  );
  await h.run(session, `goto ${h.fixtures.url("/misc")}`);
  const id = Number(/^\* (\d+)/m.exec(await h.run(session, "tab list"))?.[1]);
  const page = h.backend.pageOf(id);
  await page.evaluate(async () => {
    document.body.innerHTML =
      '<iframe style="position:absolute;left:100px;top:100px;width:400px;height:400px;border:0"></iframe>';
    const frame = document.querySelector("iframe")!;
    await new Promise<void>((resolve) => {
      frame.onload = () => resolve();
      frame.srcdoc =
        '<div id="piece" style="position:absolute;left:30px;top:30px;width:40px;height:40px;background:red;touch-action:none"></div>';
    });
    const piece = frame.contentDocument!.getElementById("piece")!;
    frame.contentWindow!.addEventListener("resize", () => {
      piece.style.left = "30px";
      piece.style.top = "30px";
      piece.dataset.dropped = "false";
    });
    let start: { x: number; y: number } | undefined;
    piece.addEventListener("pointerdown", (event) => {
      const e = event as PointerEvent;
      start = { x: e.clientX, y: e.clientY };
      piece.setPointerCapture(e.pointerId);
      piece.dataset.moves = "0";
    });
    piece.addEventListener("pointermove", (event) => {
      if (!start) return;
      const e = event as PointerEvent;
      piece.style.left = `${30 + e.clientX - start.x}px`;
      piece.style.top = `${30 + e.clientY - start.y}px`;
      piece.dataset.moves = String(Number(piece.dataset.moves) + 1);
    });
    piece.addEventListener("pointerup", () => {
      start = undefined;
      piece.dataset.dropped = "true";
    });
  });
  const viewport = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
  }));
  expect((await h.call(session, "screenshot")).isError).toBe(false);
  const result = await h.call(
    session,
    `point drag ${150 / viewport.width} ${150 / viewport.height} ${300 / viewport.width} ${300 / viewport.height}`,
  );
  expect(result.isError, result.text).toBe(false);
  const captured = await h.call(session, "screenshot iframe");
  expect(captured.isError, captured.text).toBe(false);
  await page.waitForTimeout(100);
  const state = await page.evaluate(() => {
    const piece = document
      .querySelector("iframe")!
      .contentDocument!.getElementById("piece")!;
    return {
      left: parseFloat(piece.style.left),
      top: parseFloat(piece.style.top),
      moves: Number(piece.dataset.moves),
      dropped: piece.dataset.dropped,
    };
  });
  expect(state.left).toBeCloseTo(180, 0);
  expect(state.top).toBeCloseTo(180, 0);
  expect(state.moves).toBeGreaterThan(1);
  expect(state.dropped).toBe("true");
});

it("dispatches trusted click and drag events at viewport positions in the owned tab", async () => {
  const a = h.openSession("ss-window-00000000-0000-4000-8000-000000000091");
  const b = h.openSession("ss-window-00000000-0000-4000-8000-000000000092");
  await h.run(a, `goto ${h.fixtures.url("/misc")}`);
  const id = Number(/^\* (\d+)/m.exec(await h.run(a, "tab list"))?.[1]);
  const page = h.backend.pageOf(id);
  await page.evaluate(() => {
    document.body.innerHTML = '<div style="position:fixed;inset:0"></div>';
    document.body.dataset.events = "[]";
    for (const kind of ["pointerdown", "pointerup"]) {
      document.addEventListener(kind, (event) => {
        const e = event as PointerEvent;
        const events = JSON.parse(document.body.dataset.events || "[]");
        events.push({
          kind,
          x: e.clientX / innerWidth,
          y: e.clientY / innerHeight,
          width: innerWidth,
          height: innerHeight,
          trusted: e.isTrusted,
        });
        document.body.dataset.events = JSON.stringify(events);
      });
    }
  });
  await h.run(b, `goto ${h.fixtures.url("/second")}`);
  const result = await h.call(
    a,
    "screenshot\npoint click 0.25 0.25\npoint drag 0.2 0.2 0.8 0.7",
  );
  expect(result.isError, result.text).toBe(false);
  const events = await page.evaluate(() =>
    JSON.parse(document.body.dataset.events || "[]"),
  );
  expect(events.map((e: { kind: string }) => e.kind)).toEqual([
    "pointerdown",
    "pointerup",
    "pointerdown",
    "pointerup",
  ]);
  for (const event of events) expect(event.trusted).toBe(true);
  for (const [index, x, y] of [
    [0, 0.25, 0.25],
    [1, 0.25, 0.25],
    [2, 0.2, 0.2],
    [3, 0.8, 0.7],
  ]) {
    expect(events[index].x).toBeCloseTo(x, 2);
    expect(events[index].y, JSON.stringify(events)).toBeCloseTo(y, 2);
  }
  const foreign = Number(/^\* (\d+)/m.exec(await h.run(b, "tab list"))?.[1]);
  expect((await h.call(a, `tab select ${foreign}`)).isError).toBe(true);
  for (const command of [
    "point click 1 0.5",
    "point click NaN 0.5",
    "point drag 0.1 0.2 0.3",
    "point nope 0.2 0.3",
  ]) {
    expect((await h.call(a, command)).isError, command).toBe(true);
  }
  expect(
    await page.evaluate(
      () => JSON.parse(document.body.dataset.events || "[]").length,
    ),
  ).toBe(4);
});

it.each(["resize", "display-scale", "page-scale", "scroll", "reload"])(
  "rejects stale coordinates after %s, then uses the freshly measured viewport",
  async (change) => {
    const session = h.openSession(`geometry-${change}`, ["cdp"]);
    await h.run(session, `goto ${h.fixtures.url("/covered")}`);
    const id = Number(/^\* (\d+)/m.exec(await h.run(session, "tab list"))?.[1]);
    const page = h.backend.pageOf(id);
    await page.evaluate(() => {
      document.body.style.height = "3000px";
      document.body.dataset.clicks = "0";
      document.addEventListener("pointerdown", () => {
        document.body.dataset.clicks = String(
          Number(document.body.dataset.clicks) + 1,
        );
      });
    });
    expect((await h.call(session, "screenshot")).isError).toBe(false);
    if (change === "resize")
      await page.setViewportSize({ width: 930, height: 710 });
    if (change === "display-scale")
      await h.run(
        session,
        `cdp Emulation.setDeviceMetricsOverride '{"width":980,"height":740,"deviceScaleFactor":1.5,"mobile":false}'`,
      );
    if (change === "page-scale")
      await h.run(
        session,
        `cdp Emulation.setPageScaleFactor '{"pageScaleFactor":1.5}'`,
      );
    if (change === "scroll") await page.evaluate(() => scrollTo(0, 150));
    if (change === "reload") await page.reload();
    const stale = await h.call(session, "point click 0.25 0.25");
    expect(stale.isError, stale.text).toBe(true);
    expect(stale.text).toContain("changed since the screenshot");
    if (change !== "reload")
      expect(await page.evaluate(() => document.body.dataset.clicks)).toBe("0");
    await page.evaluate(() => {
      document.body.dataset.received = "";
      document.addEventListener("pointerdown", (e) => {
        document.body.dataset.received = JSON.stringify([e.clientX, e.clientY]);
      });
    });
    const viewport = await page.evaluate(() => ({
      x: visualViewport?.offsetLeft ?? 0,
      y: visualViewport?.offsetTop ?? 0,
      w: visualViewport?.width ?? innerWidth,
      h: visualViewport?.height ?? innerHeight,
    }));
    await page.evaluate((v) => {
      const marker = document.createElement("div");
      marker.style.cssText = `position:fixed;left:${v.x + v.w * 0.25 - 30}px;top:${v.y + v.h * 0.25 - 30}px;width:60px;height:60px;background:rgb(255,0,0);z-index:2147483647`;
      document.body.append(marker);
    }, viewport);
    const fresh = await h.call(session, "screenshot\npoint click 0.25 0.25");
    expect(fresh.isError, fresh.text).toBe(false);
    const shot = fresh.result.content.find((item) => item.type === "image");
    if (!shot || shot.type !== "image") throw Error("Screenshot missing");
    const pixel = await page.evaluate(async (data) => {
      const image = await createImageBitmap(await (await fetch(data)).blob());
      const canvas = new OffscreenCanvas(image.width, image.height),
        context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      return Array.from(
        context.getImageData(
          Math.floor(image.width * 0.25),
          Math.floor(image.height * 0.25),
          1,
          1,
        ).data,
      );
    }, `data:${shot.mimeType};base64,${shot.data}`);
    expect(pixel[0]).toBeGreaterThan(240);
    expect(pixel[1]).toBeLessThan(15);
    expect(pixel[2]).toBeLessThan(15);
    const received = await page.evaluate(() =>
      JSON.parse(document.body.dataset.received || "null"),
    );
    expect(received[0]).toBeCloseTo(viewport.x + viewport.w * 0.25, 0);
    expect(received[1]).toBeCloseTo(viewport.y + viewport.h * 0.25, 0);
  },
);

it("requires this tab's viewport capture and refuses element or full-page coordinates", async () => {
  const session = h.openSession();
  await h.run(session, `goto ${h.fixtures.url("/covered")}`);
  for (const capture of ["", "screenshot #target", "screenshot --full"]) {
    if (capture) expect((await h.call(session, capture)).isError).toBe(false);
    const result = await h.call(session, "point click 0.25 0.25");
    expect(result.isError, result.text).toBe(true);
    expect(result.text).toContain("fresh viewport screenshot");
  }
});

it("avoids beyond-viewport capture for visible elements and retains it for full pages", async () => {
  const captureModes: boolean[] = [];
  const newSession = h.backend.cdpSession.bind(h.backend);
  const attachment = vi
    .spyOn(h.backend, "cdpSession")
    .mockImplementation(async (id) => {
      const cdp = await newSession(id);
      const send = cdp.send.bind(cdp);
      vi.spyOn(cdp, "send").mockImplementation(((
        method: string,
        params: { captureBeyondViewport?: boolean },
      ) => {
        if (method === "Page.captureScreenshot")
          captureModes.push(params.captureBeyondViewport === true);
        return send(method as never, params as never);
      }) as typeof cdp.send);
      return cdp;
    });
  try {
    const session = h.openSession("capture-without-resize");
    await h.run(session, `goto ${h.fixtures.url("/misc")}`);
    const id = Number(/^\* (\d+)/m.exec(await h.run(session, "tab list"))?.[1]);
    await h.backend.pageOf(id).evaluate(() => {
      document.body.innerHTML =
        '<div id="piece" style="width:200px;height:100px;background:red"></div>';
      document.body.style.height = "2000px";
    });
    for (const command of [
      "screenshot #piece",
      "screenshot",
      "screenshot --full",
    ]) {
      const result = await h.call(session, command);
      expect(result.isError, result.text).toBe(false);
    }
    expect(captureModes).toEqual([false, false, true]);
    const stale = await h.call(session, "point click 0.2 0.2");
    expect(stale.isError).toBe(true);
    expect(stale.text).toContain("fresh viewport screenshot");
  } finally {
    attachment.mockRestore();
  }
});
