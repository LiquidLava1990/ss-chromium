import { afterAll, beforeAll, expect, it, vi } from "vitest";

import { type Harness, startHarness } from "@/commands/testing/harness";

let h: Harness;
beforeAll(async () => {
  h = await startHarness();
});
afterAll(() => h?.close());

it.each([0.8, 1, 1.25])(
  "drags between observed iframe controls at page zoom %s",
  async (zoom) => {
    const session = h.openSession(`scaled-drag-${zoom}`);
    await h.run(session, `goto ${h.fixtures.url("/misc")}`);
    const id = Number(/^\* (\d+)/m.exec(await h.run(session, "tab list"))?.[1]);
    const page = h.backend.pageOf(id);
    await page.evaluate((zoom) => {
      document.body.style.zoom = String(zoom);
      document.body.innerHTML =
        '<iframe style="width:500px;height:340px;border:0"></iframe>';
      document.querySelector("iframe")!.srcdoc =
        `<body style="user-select:none"><button style="position:absolute;left:100px;top:220px;width:100px;height:60px" onpointerdown="window.dragging=true">Drag source</button><button style="position:absolute;left:330px;top:220px;width:100px;height:60px" onpointerup="if(window.dragging)document.body.dataset.dropped=String(event.isTrusted)">Drag target</button>`;
    }, zoom);
    const source = page
      .frameLocator("iframe")
      .getByRole("button", { name: "Drag source" });
    await source.waitFor();
    const snapshot = await h.run(session, "snapshot -i");
    const ref = (name: string) =>
      snapshot
        .split("\n")
        .find((line) => line.includes(`button "${name}"`))
        ?.match(/\[ref=([^\]]+)\]/)?.[1];
    const from = ref("Drag source"),
      to = ref("Drag target");
    expect(from).toBeDefined();
    expect(to).toBeDefined();
    const dragged = await h.call(session, `drag ${from} ${to}`);
    expect(dragged.isError, dragged.text).toBe(false);
    expect(
      await source.evaluate((el) => el.ownerDocument.body.dataset.dropped),
    ).toBe("true");
    await page
      .frameLocator("iframe")
      .getByRole("button", { name: "Drag target" })
      .evaluate((el) => ((el as HTMLButtonElement).disabled = true));
    const blocked = await h.call(session, `drag ${from} ${to}`);
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toContain("disabled");
  },
);

it("releases the mouse when a drag fails after pressing", async () => {
  const session = h.openSession("drag-release-failure");
  await h.run(session, `goto ${h.fixtures.url("/misc")}`);
  const id = Number(/^\* (\d+)/m.exec(await h.run(session, "tab list"))?.[1]);
  const page = h.backend.pageOf(id);
  await page.evaluate(() => {
    document.body.innerHTML =
      '<button id="from">From</button><button id="to">To</button>';
    document.addEventListener(
      "pointerup",
      (event) => (document.body.dataset.released = String(event.buttons)),
    );
  });
  const original = page.mouse.move.bind(page.mouse);
  const move = vi
    .spyOn(page.mouse, "move")
    .mockImplementation(async (x, y, options) => {
      if (options?.steps) throw new Error("injected interrupted drag");
      return original(x, y, options);
    });
  try {
    const result = await h.call(session, "drag #from #to");
    expect(result.isError).toBe(true);
    expect(result.text).toContain("injected interrupted drag");
    expect(await page.evaluate(() => document.body.dataset.released)).toBe("0");
  } finally {
    move.mockRestore();
  }
});

it.each([0.8, 1, 1.25])(
  "clicks a cross-origin iframe control once at page zoom %s",
  async (zoom) => {
    const session = h.openSession(`scaled-control-${zoom}`);
    await h.run(session, `goto ${h.fixtures.url("/misc")}`);
    const id = Number(/^\* (\d+)/m.exec(await h.run(session, "tab list"))?.[1]);
    const page = h.backend.pageOf(id);
    await page.route("http://frame.test/control", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<button style="position:absolute;left:210px;top:230px;width:100px;height:35px" onclick="parent.postMessage({trusted:event.isTrusted,shift:event.shiftKey},'*')">Scaled control</button>`,
      }),
    );
    await page.evaluate((zoom) => {
      window.onmessage = null;
      document.body.style.zoom = String(zoom);
      document.body.innerHTML =
        '<iframe style="position:absolute;left:50px;top:100px;width:350px;height:300px;border:3px solid black" src="http://frame.test/control"></iframe>';
      document.body.dataset.hits = "[]";
      window.addEventListener("message", (e) => {
        if (typeof e.data?.trusted !== "boolean") return;
        const hits = JSON.parse(document.body.dataset.hits!);
        hits.push(e.data);
        document.body.dataset.hits = JSON.stringify(hits);
      });
    }, zoom);
    await page.frameLocator("iframe").getByRole("button").waitFor();
    const button = page.frameLocator("iframe").getByRole("button");
    await button.evaluate((el) =>
      el.addEventListener("click", (event) => {
        const e = event as MouseEvent;
        el.setAttribute(
          "data-hit",
          JSON.stringify({
            count: Number(el.getAttribute("data-count") || 0) + 1,
            trusted: e.isTrusted,
            shift: e.shiftKey,
          }),
        );
        el.setAttribute(
          "data-count",
          String(Number(el.getAttribute("data-count") || 0) + 1),
        );
      }),
    );
    const snapshot = await h.run(session, "snapshot -i");
    const ref = snapshot
      .split("\n")
      .find((line) => line.includes('button "Scaled control"'))
      ?.match(/\[ref=([^\]]+)\]/)?.[1];
    expect(ref).toBeDefined();
    const clicked = await h.call(session, `click ${ref} --modifiers Shift`);
    expect(clicked.isError, clicked.text).toBe(false);
    await expect
      .poll(() => button.getAttribute("data-hit"))
      .toBe(JSON.stringify({ count: 1, trusted: true, shift: true }));
    const frame = page.frames().find((f) => f.url().includes("frame.test"))!;
    await frame.evaluate(() =>
      document.addEventListener(
        "keydown",
        (e) => (document.body.dataset.shift = String(e.shiftKey)),
        { once: true },
      ),
    );
    await page.keyboard.press("a");
    expect(await frame.evaluate(() => document.body.dataset.shift)).toBe(
      "false",
    );
    await page.evaluate(() => {
      const cover = document.createElement("div");
      cover.id = "cover";
      cover.style.cssText =
        "position:fixed;inset:0;background:white;z-index:100";
      document.body.append(cover);
    });
    const covered = await h.call(session, `click ${ref}`);
    expect(covered.isError, covered.text).toBe(true);
    expect(covered.text).toContain("covered");
    expect(await button.getAttribute("data-count")).toBe("1");
  },
);

it("maps a control through nested frames and an outer CSS transform", async () => {
  const session = h.openSession("nested-scaled-control");
  await h.run(session, `goto ${h.fixtures.url("/misc")}`);
  const id = Number(/^\* (\d+)/m.exec(await h.run(session, "tab list"))?.[1]);
  const page = h.backend.pageOf(id);
  await page.evaluate(() => {
    window.onmessage = null;
    document.body.innerHTML =
      '<iframe style="position:absolute;left:40px;top:40px;width:500px;height:500px;border:4px solid black;transform:scale(.8);transform-origin:0 0"></iframe>';
    const outer = document.querySelector("iframe")!;
    outer.srcdoc =
      '<iframe style="position:absolute;left:20px;top:30px;width:350px;height:300px;border:5px solid black"></iframe>';
    outer.onload = () => {
      outer.contentDocument!.querySelector("iframe")!.srcdoc =
        '<button style="position:absolute;left:210px;top:230px;width:100px;height:35px" onclick="parent.parent.postMessage(event.isTrusted,\'*\')">Nested control</button>';
    };
    document.body.dataset.hits = "[]";
    window.addEventListener("message", (e) => {
      if (typeof e.data === "boolean")
        document.body.dataset.hits = JSON.stringify([e.data]);
    });
  });
  await page
    .frameLocator("iframe")
    .frameLocator("iframe")
    .getByRole("button")
    .waitFor();
  const snapshot = await h.run(session, "snapshot -i");
  const ref = snapshot
    .split("\n")
    .find((line) => line.includes('button "Nested control"'))
    ?.match(/\[ref=([^\]]+)\]/)?.[1];
  expect(ref).toBeDefined();
  const clicked = await h.call(session, `click ${ref}`);
  expect(clicked.isError, clicked.text).toBe(false);
  await expect
    .poll(() => page.evaluate(() => JSON.parse(document.body.dataset.hits!)))
    .toEqual([true]);
});
