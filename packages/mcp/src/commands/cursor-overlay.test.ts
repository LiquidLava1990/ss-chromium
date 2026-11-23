import { expect, it } from "vitest";

import { startHarness } from "@/commands/testing/harness";

it("replaces an old cursor without rendering CSS text and leaves page clicks working", async () => {
  const h = await startHarness();
  try {
    const session = h.openSession();
    await h.run(session, `goto ${h.fixtures.url("/misc")}`);
    const id = Number(/^\* (\d+)/m.exec(await h.run(session, "tab list"))?.[1]);
    const page = h.backend.pageOf(id);
    const url = h.fixtures.url("/strict-cursor");
    await page.route(url, (route) =>
      route.fulfill({
        contentType: "text/html",
        headers: {
          "Content-Security-Policy":
            "style-src 'none'; require-trusted-types-for 'script'",
        },
        body: "<!doctype html><title>Cursor fixture</title><button>Target</button>",
      }),
    );
    await page.addInitScript(() => {
      const attachShadow = Element.prototype.attachShadow;
      Element.prototype.attachShadow = function (init) {
        const root = attachShadow.call(this, init);
        if (this.id === "__browsermcp_cursor")
          Reflect.set(window, "testCursorRoot", root);
        return root;
      };
    });
    await page.goto(url);
    await page.evaluate(() => {
      const previous = document.createElement("browsermcp-cursor");
      previous.id = "__browsermcp_cursor";
      previous
        .attachShadow({ mode: "closed" })
        .append(".arrow { position:absolute; }");
      document.documentElement.append(previous);
      const target = document.querySelector("button")!;
      target.addEventListener("click", () => {
        target.textContent = "Clicked";
      });
    });

    const click = await h.call(session, "click button");
    expect(click.isError, click.text).toBe(false);
    await expect
      .poll(() => page.locator("button").textContent())
      .toBe("Clicked");
    expect(
      await page.evaluate(() => {
        const host = document.getElementById("__browsermcp_cursor")!;
        const root = Reflect.get(window, "testCursorRoot") as ShadowRoot;
        return {
          count: document.querySelectorAll("#__browsermcp_cursor").length,
          text: root.textContent,
          arrow: root.querySelector("path")?.getAttribute("fill"),
          labelBackground: getComputedStyle(root.querySelector("div")!)
            .backgroundColor,
          pointerEvents: getComputedStyle(host).pointerEvents,
        };
      }),
    ).toEqual({
      count: 1,
      text: "SS Chromium",
      arrow: "#2563eb",
      labelBackground: "rgb(37, 99, 235)",
      pointerEvents: "none",
    });
  } finally {
    await h.close();
  }
});
