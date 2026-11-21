import type { Page } from "playwright-core";

import { StepError } from "@/commands/output";

export async function visualGeometry(page: Page) {
  return page.evaluate(() => ({
    width: visualViewport?.width ?? innerWidth,
    height: visualViewport?.height ?? innerHeight,
    layoutWidth: innerWidth,
    layoutHeight: innerHeight,
    offsetX: visualViewport?.offsetLeft ?? 0,
    offsetY: visualViewport?.offsetTop ?? 0,
    pageX: visualViewport?.pageLeft ?? scrollX,
    pageY: visualViewport?.pageTop ?? scrollY,
    scale: visualViewport?.scale ?? 1,
    dpr: devicePixelRatio,
    url: location.href,
    document: performance.timeOrigin,
    scrollWidth: document.documentElement.scrollWidth,
    scrollHeight: document.documentElement.scrollHeight,
  }));
}

type Geometry = Awaited<ReturnType<typeof visualGeometry>>;
const captures = new WeakMap<Page, Geometry>();

export function sameGeometry(a: Geometry, b: Geometry) {
  return (Object.keys(a) as (keyof Geometry)[])
    .filter((key) => key !== "scrollWidth" && key !== "scrollHeight")
    .every((key) => a[key] === b[key]);
}

export function forgetViewport(page: Page) {
  captures.delete(page);
}
export function rememberViewport(page: Page, geometry: Geometry) {
  captures.set(page, geometry);
}

export async function requireCapturedViewport(page: Page) {
  const captured = captures.get(page);
  if (!captured)
    throw new StepError("Take a fresh viewport screenshot before point input");
  const current = await visualGeometry(page);
  if (!sameGeometry(captured, current)) {
    captures.delete(page);
    throw new StepError(
      "Window, zoom, scroll or page changed since the screenshot; take a fresh viewport screenshot before point input",
    );
  }
  return current;
}
