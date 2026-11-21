import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { classifyHumanCheck, humanCheckNote } from "@/commands/human-check";
import { type Harness, startHarness } from "@/commands/testing/harness";

const none = { title: "Shop", frameUrls: [], markers: [] };

describe("classifyHumanCheck", () => {
  it("recognizes provider frames", () => {
    expect(
      classifyHumanCheck({
        ...none,
        frameUrls: ["https://www.google.com/recaptcha/api2/anchor?k=x"],
      }),
    ).toBe("reCAPTCHA");
    expect(
      classifyHumanCheck({
        ...none,
        frameUrls: ["https://newassets.hcaptcha.com/captcha/v1/x"],
      }),
    ).toBe("hCaptcha");
    expect(
      classifyHumanCheck({
        ...none,
        frameUrls: [
          "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/x",
        ],
      }),
    ).toBe("Cloudflare Turnstile");
  });
  it("recognizes widget markers and challenge titles", () => {
    expect(classifyHumanCheck({ ...none, markers: ["hCaptcha"] })).toBe(
      "hCaptcha",
    );
    expect(classifyHumanCheck({ ...none, title: "Just a moment..." })).toBe(
      "Cloudflare challenge",
    );
    expect(
      classifyHumanCheck({ ...none, title: "Please verify you are human" }),
    ).toBe("verification page");
  });
  it("leaves ordinary pages alone", () => {
    expect(classifyHumanCheck(none)).toBeNull();
    expect(
      classifyHumanCheck({
        title: "Robots in fiction",
        frameUrls: [
          "https://www.youtube.com/embed/x",
          "https://example.com/recaptcha-article",
        ],
        markers: [],
      }),
    ).toBeNull();
  });
  it("tells the agent to hand the check to the user", () => {
    expect(humanCheckNote("hCaptcha")).toMatch(
      /Don't try to solve it.*ask the user.*human-check --wait/,
    );
  });
});

describe("human-check in a real browser", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(() => h?.close());

  it("detects a check, waits while the user completes it, then continues", async () => {
    const session = h.openSession(
      "ss-window-00000000-0000-4000-8000-000000000201",
    );
    await h.run(session, `goto ${h.fixtures.url("/misc")}`);
    expect(await h.run(session, "human-check")).toContain(
      "no human check detected",
    );
    const id = Number(/^\* (\d+)/m.exec(await h.run(session, "tab list"))?.[1]);
    const page = h.backend.pageOf(id);
    await page.evaluate(() => {
      const widget = document.createElement("div");
      widget.className = "h-captcha";
      document.body.append(widget);
      // The "user" completes the check after a moment
      setTimeout(() => widget.remove(), 1500);
    });
    expect(await h.run(session, "human-check")).toContain(
      "human check: hCaptcha",
    );
    const waited = await h.call(session, "human-check --wait --timeout 10000");
    expect(waited.isError).toBe(false);
    expect(waited.text).toContain("human check cleared");
  });

  it("notes a human check right after navigating to one", async () => {
    const session = h.openSession(
      "ss-window-00000000-0000-4000-8000-000000000203",
    );
    const result = await h.call(
      session,
      `goto ${h.fixtures.url("/human-check")}`,
    );
    expect(result.text).toContain(
      "human-verification check (Cloudflare Turnstile)",
    );
    expect(result.text).toContain("ask the user");
  });

  it("reports a check the user has not completed in time", async () => {
    const session = h.openSession(
      "ss-window-00000000-0000-4000-8000-000000000202",
    );
    await h.run(session, `goto ${h.fixtures.url("/misc")}`);
    const id = Number(/^\* (\d+)/m.exec(await h.run(session, "tab list"))?.[1]);
    await h.backend.pageOf(id).evaluate(() => {
      document.title = "Just a moment...";
    });
    const waited = await h.call(session, "human-check --wait --timeout 1000");
    expect(waited.isError).toBe(true);
    expect(waited.text).toContain("has not completed it yet");
  });
});
