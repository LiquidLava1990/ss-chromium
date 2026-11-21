/**
 * The `browser` tool's commands. Each has a one-line `usage` for the tool's description and a `help` text for `help <command>`.
 * File-drop portions adapted from Microsoft Playwright (Copyright (c)
 * Microsoft Corporation), licensed under Apache-2.0. See THIRD_PARTY_NOTICES.md.
 */
import { randomUUID } from "node:crypto";
import type { CDPSession, Page } from "playwright-core";

import {
  click,
  drag,
  ACTION_TIMEOUT_MS,
  FIND_TIMEOUT_MS,
  hover,
  moveCursor,
  preparePointer,
  resolveOne,
  setCursorHidden,
  waitForLoad,
  withSettle,
} from "@/commands/actions";
import { sendCdp, subscribe } from "@/commands/cdp";
import { HIDDEN_TAB_MESSAGE, hiddenTabs } from "@/commands/hidden-tabs";
import {
  cap,
  capTail,
  compactJson,
  readCap,
  sleep,
  StepError,
} from "@/commands/output";
import type { FlagSpec, ParsedArgs, Token } from "@/commands/parser";
import { download, DOWNLOAD_MAX_BYTES, pdf } from "@/commands/save";
import {
  find,
  findByRef,
  interactiveOnly,
  render,
  shortRef,
  takeSnapshot,
} from "@/commands/snapshot";
import type { TabState } from "@/commands/tab-state";
import { parseTarget, type Target, toLocator } from "@/commands/targets";
import {
  forgetViewport,
  rememberViewport,
  requireCapturedViewport,
  sameGeometry,
  visualGeometry,
} from "@/commands/visual-geometry";
import type { Capability, SessionIO } from "@/contracts";
import type { NativeFedcm } from "@/relay/native-fedcm";

/** What a command can do, provided by the engine for one step */
export interface StepContext {
  args: ParsedArgs;
  io: SessionIO;
  capabilities: Capability[];
  /** Output of read commands, printed under the step's line */
  print(text: string): void;
  /** A short note on the step's line (`✓ click e3 — <note>`) */
  note(text: string): void;
  image(data: Buffer, mimeType: string): void;
  /** The current tab's page, claimed. Fails with guidance when there's no tab */
  page(): Promise<Page>;
  tab(): Promise<TabState>;
  /** The current tab's ID, or null */
  currentTabId(): number | null;
  /** Selects the SS tab within its own window before capture; no desktop focus. */
  prepareScreenshot?(): Promise<void>;
  /** For `goto`: the current tab's page, or a new tab of the agent's own */
  pageForGoto(): Promise<Page>;
  /** The engine's own CDP session on the current tab (screenshots) */
  internalCdp(): Promise<CDPSession>;
  fedcm(): Promise<NativeFedcm>;
  /** The agent's `cdp` session on the current tab */
  agentCdp(): Promise<NonNullable<TabState["cdp"]>>;
  tabs: {
    list(): Promise<string>;
    /** Opens a tab of the agent's own, in `browser` (an ID or label) or where the session's new tabs open */
    create(url?: string, browser?: string): Promise<number>;
    /** The label of the tab's browser while several browsers are connected, else undefined */
    browserOf(tabId: number): string | undefined;
    select(tabId: number): Promise<void>;
    popup(openerTabId: number, url?: string): Promise<number>;
    close(tabId?: number): Promise<void>;
  };
  /** The connected browsers (Chrome profiles) */
  browsers: {
    /** Whether several are connected */
    several(): boolean;
    list(): string;
    /** Opens the session's new tabs in this browser (an ID or label); returns its label */
    use(name: string): string;
  };
}

export type CommandDef = {
  name: string;
  /** One line in the tool's description */
  usage: string;
  /** False when another command's usage line covers this one */
  listed?: boolean;
  /** Listed by `help` only while several browsers are connected */
  severalBrowsers?: boolean;
  /** Details for `help <command>` */
  help: string;
  flags?: FlagSpec;
  /** Navigates by design, so the engine doesn't note the URL change */
  navigates?: boolean;
  /** Only reads the page, so the engine runs it again when the tab re-attached (a new Page) while it ran */
  reads?: boolean;
  /** Doesn't need a page (tab commands, help, wait <ms>) */
  noPage?: boolean;
  /** Runs while a dialog is open, which blocks the page (tab commands, help, `wait <ms>`, `dialog`) */
  whileDialog?: boolean | ((args: ParsedArgs) => boolean);
  /** The most positional arguments it takes (default none) */
  maxArgs?: number;
  /** How long the step may run before the engine abandons it, when that's longer than the default or `--timeout` plus headroom */
  timeoutMs?(args: ParsedArgs): number | undefined;
  capability?: Capability;
  /** The step's line without typed text. Also called with leniently parsed args when the line is invalid, so it must not assume they're valid */
  echo?(args: ParsedArgs): string;
  run(ctx: StepContext): Promise<void>;
};

export const TIMEOUT_MAX_MS = 60_000;

function positional(args: ParsedArgs, index: number, what: string): string {
  const token = args.positional[index];
  if (!token) throw new StepError(`Missing ${what}`);
  return token.text;
}

function target(args: ParsedArgs, index = 0, what = "<target>"): Target {
  return parseTarget(positional(args, index, what));
}

function timeoutFlag(args: ParsedArgs, fallback = 10_000): number {
  const value = args.flags.timeout;
  if (value === undefined || value === true) return fallback;
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms < 0)
    throw new StepError("--timeout takes milliseconds");
  return Math.min(ms, TIMEOUT_MAX_MS);
}

async function settled(
  ctx: StepContext,
  page: Page,
  action: () => Promise<unknown>,
) {
  const { loadTimedOut } = await withSettle(page, action);
  if (loadTimedOut) ctx.note("the page is still loading");
}

function normalizeUrl(url: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  if (/^(localhost|127\.|\[::1\])/.test(url)) return `http://${url}`;
  return `https://${url}`;
}

/** Turns `*.example.com/**` into a regex; without `*`, matches a substring */
function urlMatcher(pattern: string): (url: string) => boolean {
  if (!pattern.includes("*")) return (url) => url.includes(pattern);
  const source = pattern
    .split("**")
    .map((part) =>
      part
        .split("*")
        .map((piece) => piece.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join("[^/]*"),
    )
    .join(".*");
  const regex = new RegExp(`^${source}$`);
  return (url) => regex.test(url);
}

async function pointerCommand(
  ctx: StepContext,
  index = 0,
): Promise<{
  page: Page;
  source: string;
  point: Awaited<ReturnType<typeof preparePointer>>;
}> {
  const page = await ctx.page();
  const t = target(ctx.args, index);
  const locator = await resolveOne(page, t);
  return {
    page,
    source: t.source,
    point: await preparePointer(locator, t.source),
  };
}

const MODIFIERS = ["Alt", "Control", "ControlOrMeta", "Meta", "Shift"] as const;

const SCROLL_DIRECTIONS = ["down", "up", "top", "bottom"] as const;

async function setChecked(ctx: StepContext, checked: boolean) {
  const page = await ctx.page();
  const t = target(ctx.args);
  const locator = await resolveOne(page, t);
  let current: boolean;
  try {
    current = await locator.isChecked({ timeout: ACTION_TIMEOUT_MS });
  } catch {
    throw new StepError(`${t.source} isn't a checkbox, radio or switch`);
  }
  if (current === checked) {
    ctx.note(`already ${checked ? "checked" : "unchecked"}`);
    return;
  }
  const point = await preparePointer(locator, t.source);
  await settled(ctx, page, () => click(page, point));
  if ((await locator.isChecked().catch(() => !checked)) !== checked) {
    throw new StepError(
      `Clicking ${t.source} didn't ${checked ? "check" : "uncheck"} it`,
    );
  }
}

async function fillLike(ctx: StepContext, page: Page, submit: boolean) {
  if (!submit) return;
  await hiddenTabs.ensureVisible(page);
  await settled(ctx, page, () => page.keyboard.press("Enter"));
}

const STATIC_TYPES = new Set([
  "image",
  "stylesheet",
  "font",
  "media",
  "script",
  "manifest",
  "texttrack",
]);

/** Runs `src` (a function or an expression) in the page, with the element as the function's argument */
async function evaluate(page: Page, src: string, element?: Target) {
  const call = (arg: string) =>
    `(async () => { const __fn = (${src}\n); return typeof __fn === "function" ? await __fn(${arg}) : __fn; })()`;
  if (!element) return page.evaluate(call(""));
  const locator = await resolveOne(page, element);
  // Hand the element over through a global, since a string of code can't take Playwright arguments (and page CSP may forbid eval)
  const key = `__browsermcp_el_${randomUUID()}`;
  const handle = await locator.elementHandle({ timeout: ACTION_TIMEOUT_MS });
  if (!handle) throw new StepError("Target is no longer attached");
  try {
    const frame = await handle.ownerFrame();
    if (!frame) throw new StepError("Target frame is no longer attached");
    try {
      await handle.evaluate((el, key) => {
        (window as unknown as Record<string, Element>)[key] = el;
      }, key);
      return await frame.evaluate(
        call(
          `(() => { const el = window[${JSON.stringify(key)}]; delete window[${JSON.stringify(key)}]; return el; })()`,
        ),
      );
    } finally {
      await frame
        .evaluate((key) => {
          delete (window as unknown as Record<string, Element>)[key];
        }, key)
        .catch(() => {});
    }
  } finally {
    await handle.dispose();
  }
}

/** Reads a JPEG's size from its SOF marker */
function jpegSize(data: Buffer): { width: number; height: number } | null {
  let i = 2;
  while (i + 9 < data.length) {
    if (data[i] !== 0xff) return null;
    const marker = data[i + 1];
    const length = data.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xc3) {
      return {
        height: data.readUInt16BE(i + 5),
        width: data.readUInt16BE(i + 7),
      };
    }
    i += 2 + length;
  }
  return null;
}

/** Longest side of a screenshot: larger images are downscaled by the API anyway */
const SCREENSHOT_MAX_SIDE = 1568;

async function screenshot(ctx: StepContext) {
  const page = await ctx.page();
  forgetViewport(page);
  await ctx.prepareScreenshot?.();
  const t = ctx.args.positional[0]
    ? parseTarget(ctx.args.positional[0].text)
    : undefined;
  await hiddenTabs.ensureVisible(page);
  const tab = await ctx.tab();
  const emulationOwner =
    tab.cdp &&
    [...tab.cdp.used].some(
      (method) =>
        method === "Emulation.setDeviceMetricsOverride" ||
        method === "Emulation.setPageScaleFactor",
    );
  const cdp = emulationOwner ? tab.cdp!.session : await ctx.internalCdp();
  let geometry = await visualGeometry(page);
  for (let attempt = 0; attempt < 10; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const next = await visualGeometry(page);
    if (sameGeometry(geometry, next)) break;
    geometry = next;
    if (attempt === 9)
      throw new StepError(
        "Viewport is changing; wait before taking a screenshot",
      );
  }
  const metrics = { ...geometry, x: geometry.pageX, y: geometry.pageY };
  let clip = {
    x: metrics.x,
    y: metrics.y,
    width: metrics.width,
    height: metrics.height,
  };
  if (t) {
    const locator = await resolveOne(page, t);
    await locator.evaluate((el) => {
      const box = el.getBoundingClientRect();
      if (box.bottom < 0 || box.top > innerHeight) {
        el.scrollIntoView({ block: "center", behavior: "instant" });
      }
    });
    const box = await locator.boundingBox();
    if (!box) throw new StepError(`${t.source} isn't visible`);
    const scroll = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
    clip = {
      x: box.x + scroll.x,
      y: box.y + scroll.y,
      width: box.width,
      height: box.height,
    };
    geometry = await visualGeometry(page);
  } else if (ctx.args.flags.full) {
    clip = {
      x: 0,
      y: 0,
      width: metrics.scrollWidth,
      height: Math.min(metrics.scrollHeight, 16_384),
    };
  }
  const longest = Math.max(clip.width, clip.height);
  const scale = Math.min(1, SCREENSHOT_MAX_SIDE / longest);
  await setCursorHidden(page, true);
  let data: Buffer;
  try {
    const capture = cdp.send("Page.captureScreenshot", {
      format: "jpeg",
      quality: 80,
      clip: { ...clip, scale: scale * geometry.scale },
      fromSurface: true,
      // Beyond-viewport capture can resize the page even for a visible element,
      // causing resize-sensitive canvases to discard their interaction state.
      captureBeyondViewport:
        !!ctx.args.flags.full ||
        clip.x < geometry.pageX ||
        clip.y < geometry.pageY ||
        clip.x + clip.width > geometry.pageX + geometry.width ||
        clip.y + clip.height > geometry.pageY + geometry.height,
    });
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new StepError("timeout")),
        hiddenTabs.screenshotTimeoutMs,
      );
    });
    try {
      data = Buffer.from(
        (await Promise.race([capture, timeout])).data,
        "base64",
      );
    } catch (error) {
      if (!(error instanceof StepError)) throw error;
      throw new StepError(
        (await hiddenTabs.isVisible(page))
          ? `The screenshot took over ${hiddenTabs.screenshotTimeoutMs / 1000} s`
          : HIDDEN_TAB_MESSAGE,
      );
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await setCursorHidden(page, false);
    // Surface capture resets Chromium's pinch scale. The clip was rendered at
    // that scale above; restore it before validating or dispatching input.
    if (
      geometry.scale !== 1 &&
      (await page.evaluate(() => visualViewport?.scale)) === 1
    ) {
      await cdp.send("Emulation.setPageScaleFactor", {
        pageScaleFactor: geometry.scale,
      });
    }
  }
  const afterCapture = await visualGeometry(page);
  // Full-page surface capture can expose the scrollbar gutter as visual width.
  // It never supplies a point-input anchor; still reject navigation or other changes.
  const fullPageScrollbarChange =
    !!ctx.args.flags.full &&
    geometry.width <= geometry.layoutWidth &&
    afterCapture.width === geometry.layoutWidth &&
    sameGeometry({ ...geometry, width: afterCapture.width }, afterCapture);
  if (!sameGeometry(geometry, afterCapture) && !fullPageScrollbarChange) {
    const changed = Object.keys(geometry).filter(
      (key) =>
        key !== "url" &&
        key !== "scrollWidth" &&
        key !== "scrollHeight" &&
        geometry[key as keyof typeof geometry] !==
          afterCapture[key as keyof typeof afterCapture],
    );
    throw new StepError(
      `Viewport changed during capture (${changed.join(", ")}); take a fresh screenshot`,
    );
  }
  if (!t && !ctx.args.flags.full) rememberViewport(page, geometry);
  const size = jpegSize(data);
  ctx.image(data, "image/jpeg");
  if (size) ctx.note(`${size.width}×${size.height} JPEG`);
  const path = ctx.args.flags.path;
  if (typeof path === "string") {
    const saved = await ctx.io.writeFile(path, data);
    ctx.note(`saved to ${saved}`);
  }
}

async function snapshotCommand(ctx: StepContext) {
  const page = await ctx.page();
  const max = readCap(ctx.args.flags.max);
  const depthFlag = ctx.args.flags.depth;
  const depth = depthFlag === undefined ? Infinity : Number(depthFlag);
  if (depthFlag !== undefined && (!Number.isInteger(depth) || depth < 1)) {
    throw new StepError("--depth takes a number ≥ 1");
  }
  const scope = ctx.args.positional[0]
    ? parseTarget(ctx.args.positional[0].text)
    : undefined;
  let scopeRef: string | undefined;
  if (scope?.kind === "ref") scopeRef = scope.ref;
  else if (scope) {
    // A scoped snapshot first, for the scope's ref, then the full one that every ref resolves against
    const locator = await resolveOne(page, scope);
    scopeRef = (
      (await locator.ariaSnapshotJSON({ mode: "ai" })) as { ref?: string }[]
    )[0]?.ref;
  }
  let nodes = await takeSnapshot(page);
  if (scopeRef && scope?.kind !== "ref") scopeRef = shortRef(page, scopeRef);
  if (scopeRef) {
    const node = findByRef(nodes, scopeRef);
    if (!node) {
      throw new StepError(
        scope?.kind === "ref"
          ? `Ref ${scopeRef} isn't on the page anymore. Run \`snapshot -i\` or use a locator`
          : `${scope?.source} isn't in the accessibility tree (hidden or aria-hidden)`,
      );
    }
    nodes = [node];
  }
  if (ctx.args.flags.i) nodes = interactiveOnly(nodes);
  const text = render(nodes, depth);
  ctx.print(
    cap(text || (ctx.args.flags.i ? "(nothing interactive)" : "(empty)"), max),
  );
}

/** `wait <ms>` */
function isSleep(args: ParsedArgs) {
  const first = args.positional[0];
  return !!first && !first.quoted && /^\d+$/.test(first.text);
}

/** `goto` and `tab new <url>`: up to 30 s to commit, then 10 s to load */
/** Longest text `type` sends key by key: each key is a round trip to the browser (through the extension, for the user's Chrome), so longer text is inserted at once, which fields that react to keys still see as one input */
const TYPE_KEYS_MAX_CHARS = 200;
const NAVIGATION_STEP_MS = 45_000;
const BODY_TIMEOUT_MS = 10_000;

const URL_ARG = (args: ParsedArgs) => positional(args, 0, "<url>");

export const COMMANDS: CommandDef[] = [
  {
    name: "goto",
    usage: "goto <url>   # the first goto opens a background tab of your own",
    help: "Opens a URL in the current tab (the first time, in a new background tab of your own). Waits for the load event (up to 10 s).",
    navigates: true,
    noPage: true,
    maxArgs: 1,
    timeoutMs: () => NAVIGATION_STEP_MS,
    async run(ctx) {
      const url = normalizeUrl(URL_ARG(ctx.args));
      const page = await ctx.pageForGoto();
      await page.goto(url, { waitUntil: "commit", timeout: 30_000 });
      if (!(await waitForLoad(page))) ctx.note("the page is still loading");
      if (page.url() !== url && page.url() !== `${url}/`)
        ctx.note(`→ ${page.url()}`);
    },
  },
  ...(["back", "forward", "reload"] as const).map((name): CommandDef => ({
    name,
    usage: name === "back" ? "back | forward | reload" : name,
    listed: name === "back",
    help: `${name === "reload" ? "Reloads the page" : `Goes ${name} in the tab's history`}, waiting for the load event (up to 10 s).`,
    navigates: name === "reload",
    maxArgs: 0,
    async run(ctx) {
      const page = await ctx.page();
      const options = { waitUntil: "commit" as const, timeout: 10_000 };
      const response =
        name === "back"
          ? await page.goBack(options)
          : name === "forward"
            ? await page.goForward(options)
            : await page.reload(options);
      if (!response && name !== "reload" && page.url() === "about:blank") {
        throw new StepError(`There's no page to go ${name} to`);
      }
      if (!(await waitForLoad(page))) ctx.note("the page is still loading");
    },
  })),
  {
    name: "point",
    usage: "point click <x> <y> | point drag <x1> <y1> <x2> <y2>",
    help: "Click or drag at normalized viewport coordinates (0..1) from a fresh viewport screenshot. Do not use element or full-page screenshots. Inspect the page after input.",
    maxArgs: 5,
    async run(ctx) {
      const args = ctx.args.positional.map((part) => part.text);
      const mode = args[0];
      const count = mode === "click" ? 2 : mode === "drag" ? 4 : 0;
      if (!count || args.length !== count + 1) {
        throw new StepError(
          "Use point click <x> <y> or point drag <x1> <y1> <x2> <y2>",
        );
      }
      const coords = args.slice(1).map(Number);
      if (
        coords.some(
          (n, i) =>
            args[i + 1].trim() === "" || !Number.isFinite(n) || n < 0 || n >= 1,
        )
      ) {
        throw new StepError("Coordinates must be finite numbers in [0, 1)");
      }
      const page = await ctx.page();
      await hiddenTabs.ensureVisible(page);
      const dimensions = () => visualGeometry(page);
      let viewport = await dimensions();
      let stable = false;
      for (let attempt = 0; attempt < 10; attempt++) {
        await page.waitForTimeout(100);
        const next = await dimensions();
        if (sameGeometry(next, viewport)) {
          stable = true;
          break;
        }
        viewport = next;
      }
      if (!stable)
        throw new StepError(
          "Viewport is still resizing; take a fresh screenshot and try again",
        );
      viewport = await requireCapturedViewport(page);
      if (viewport.width <= 0 || viewport.height <= 0)
        throw new StepError("Viewport is unavailable");
      const [x1, y1, x2, y2] = coords;
      const sx = viewport.offsetX + x1! * viewport.width;
      const sy = viewport.offsetY + y1! * viewport.height;
      await moveCursor(page, sx, sy);
      await requireCapturedViewport(page);
      if (mode === "click") {
        await page.mouse.click(sx, sy);
      } else {
        const ex = viewport.offsetX + x2! * viewport.width;
        const ey = viewport.offsetY + y2! * viewport.height;
        await page.mouse.move(sx, sy);
        await page.mouse.down();
        try {
          for (let step = 1; step <= 12; step++) {
            await requireCapturedViewport(page);
            await page.mouse.move(
              sx + ((ex - sx) * step) / 12,
              sy + ((ey - sy) * step) / 12,
            );
          }
          await moveCursor(page, ex, ey);
        } finally {
          await page.mouse.up();
        }
      }
    },
  },
  {
    name: "click",
    usage:
      "click <target> [--double] [--button right|middle] [--modifiers Shift,Control]",
    help: "Clicks the element's center after scrolling it into view. Fails if it's hidden, disabled or covered (naming what covers it). Waits for a navigation it starts.",
    flags: { double: false, button: true, modifiers: true },
    maxArgs: 1,
    async run(ctx) {
      const { page, point } = await pointerCommand(ctx);
      const button = ctx.args.flags.button;
      if (
        button !== undefined &&
        !["left", "right", "middle"].includes(String(button))
      ) {
        throw new StepError("--button is left, right or middle");
      }
      const modifiers =
        typeof ctx.args.flags.modifiers === "string"
          ? ctx.args.flags.modifiers.split(",").map((key) => {
              const name = key.trim();
              if (!MODIFIERS.includes(name as (typeof MODIFIERS)[number])) {
                throw new StepError(
                  `--modifiers takes ${MODIFIERS.join(", ")}`,
                );
              }
              return name as (typeof MODIFIERS)[number];
            })
          : undefined;
      await settled(ctx, page, () =>
        click(page, point, {
          button: button as "left" | undefined,
          clickCount: ctx.args.flags.double ? 2 : 1,
          modifiers,
        }),
      );
    },
  },
  {
    name: "hover",
    usage: "hover <target>",
    help: "Moves the mouse over the element.",
    maxArgs: 1,
    async run(ctx) {
      const { page, point } = await pointerCommand(ctx);
      await hover(page, point);
    },
  },
  {
    name: "drag",
    usage: "drag <source> <target>",
    help: "Drags the source element onto the target with mouse input.",
    maxArgs: 2,
    async run(ctx) {
      const page = await ctx.page();
      const from = target(ctx.args, 0, "<source>");
      const to = target(ctx.args, 1, "<target>");
      const fromPoint = await preparePointer(
        await resolveOne(page, from),
        from.source,
      );
      const toPoint = await preparePointer(
        await resolveOne(page, to),
        to.source,
      );
      await drag(page, fromPoint, toPoint);
    },
  },
  {
    name: "drop",
    usage:
      'drop <target> [<path>...] [--data \'{"text/plain":"text"}\'] [--native]',
    help: "Drops files or MIME text onto an element. Default: Playwright's synthetic drop with session file buffers. --native: Chromium dragEnter/dragOver/drop input; file paths must be accessible on the browser machine (as in local SS Chromium). No automatic fallback or retry after a delivered event.",
    maxArgs: Infinity,
    flags: { data: true, native: false },
    echo: (args) => `drop ${args.positional[0]?.text ?? ""}`,
    async run(ctx) {
      const t = target(ctx.args);
      const paths = ctx.args.positional.slice(1).map((token) => token.text);
      let data: Record<string, string> | undefined;
      if (ctx.args.flags.data !== undefined) {
        try {
          const parsed: unknown = JSON.parse(String(ctx.args.flags.data));
          if (
            !parsed ||
            typeof parsed !== "object" ||
            Array.isArray(parsed) ||
            !Object.keys(parsed).length ||
            !Object.entries(parsed).every(
              ([mime, value]) =>
                mime.includes("/") && typeof value === "string",
            )
          )
            throw new Error();
          data = parsed as Record<string, string>;
        } catch {
          throw new StepError(
            "--data takes a nonempty JSON object mapping MIME types to strings",
          );
        }
      }
      if (!paths.length && !data)
        throw new StepError("Provide a local file path or --data");
      const files = await Promise.all(
        paths.map((path) => ctx.io.readFile(path)),
      );
      const page = await ctx.page();
      const locator = await resolveOne(page, t);
      await hiddenTabs.ensureVisible(page);
      if (ctx.args.flags.native) {
        const nativePaths = files.map((file) => {
          if (!file.absolutePath)
            throw new StepError(
              "Native file drop requires a resolved local path from the session file reader; use the default buffer drop",
            );
          return file.absolutePath;
        });
        const point = await preparePointer(locator, t.source);
        const cdp = await ctx.internalCdp();
        const payload = {
          items: Object.entries(data ?? {}).map(([mimeType, value]) => ({
            mimeType,
            data: value,
          })),
          files: nativePaths,
          dragOperationsMask: 1,
        };
        await settled(ctx, page, async () => {
          for (const type of ["dragEnter", "dragOver", "drop"] as const) {
            await cdp.send("Input.dispatchDragEvent", {
              type,
              x: point.x,
              y: point.y,
              data: payload,
            });
          }
        });
        return;
      }
      // Adapted from Microsoft Playwright's tools/backend/files.ts (Apache-2.0).
      // Keep session file I/O and ownership rather than passing arbitrary host paths.
      await settled(ctx, page, () =>
        locator.drop(
          { ...(files.length ? { files } : {}), ...(data ? { data } : {}) },
          { timeout: ACTION_TIMEOUT_MS },
        ),
      );
    },
  },
  {
    name: "scroll",
    usage:
      "scroll down|up [<px>] | scroll top|bottom | scroll <target>   # --in <target>: its scroll area",
    help: "Scrolls the page by <px> (most of a screen without it), to its top or bottom, or scrolls the target into view. When the page itself doesn't scroll (an app whose content scrolls in a pane), it scrolls the page's largest scroll area. --in scrolls the scroll area holding that element instead. down, up, top and bottom note where they ended, so for a list that loads more as you scroll, repeat `scroll bottom` with a `wait` until it stays at the bottom.",
    flags: { in: true },
    maxArgs: 2,
    async run(ctx) {
      const page = await ctx.page();
      const first = ctx.args.positional[0];
      if (!first)
        throw new StepError("Missing down, up, top, bottom or <target>");
      const direction = first.quoted
        ? undefined
        : SCROLL_DIRECTIONS.find((name) => name === first.text.toLowerCase());
      if (!direction) {
        if (ctx.args.positional[1] || ctx.args.flags.in !== undefined) {
          throw new StepError(
            "scroll <target> takes no <px> or --in. Use scroll down|up [<px>] --in <target>",
          );
        }
        const locator = await resolveOne(page, parseTarget(first.text));
        await hiddenTabs.ensureVisible(page);
        await locator.evaluate(
          (el) => el.scrollIntoView({ block: "center", behavior: "instant" }),
          undefined,
          { timeout: ACTION_TIMEOUT_MS },
        );
        return;
      }
      const pxToken = ctx.args.positional[1];
      const px = pxToken ? Number(pxToken.text) : null;
      if (pxToken && (direction === "top" || direction === "bottom")) {
        throw new StepError(`scroll ${direction} takes no <px>`);
      }
      if (px !== null && (!Number.isFinite(px) || px <= 0)) {
        throw new StepError("<px> is a number of pixels, more than 0");
      }
      const inFlag = ctx.args.flags.in;
      const area =
        typeof inFlag === "string"
          ? await resolveOne(page, parseTarget(inFlag))
          : page.locator(":root");
      await hiddenTabs.ensureVisible(page);
      const { top, max, inner } = await area.evaluate(
        (el, [direction, px, isPage]) => {
          const root = document.scrollingElement ?? document.documentElement;
          const scrolls = (node: Element) =>
            /auto|scroll|overlay/.test(getComputedStyle(node).overflowY) &&
            node.scrollHeight > node.clientHeight;
          // The element's nearest scroll area (itself included), else the page
          let box: Element = root;
          for (
            let node: Element | null = el;
            node && node !== root;
            node =
              node.parentElement ??
              ((node.getRootNode() as ShadowRoot).host || null)
          ) {
            if (scrolls(node)) {
              box = node;
              break;
            }
          }
          // An app whose page doesn't scroll but a pane does (html and body overflow: hidden, main overflow: auto): its largest visible scroll area
          if (isPage && root.scrollHeight <= root.clientHeight) {
            let largest = 0;
            for (const node of document.body?.querySelectorAll("*") ?? []) {
              if (!scrolls(node)) continue;
              const rect = node.getBoundingClientRect();
              const visible =
                Math.max(
                  0,
                  Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0),
                ) *
                Math.max(
                  0,
                  Math.min(rect.right, innerWidth) - Math.max(rect.left, 0),
                );
              if (visible > largest) {
                largest = visible;
                box = node;
              }
            }
          }
          const end = box.scrollHeight - box.clientHeight;
          const step =
            px ??
            Math.round((box === root ? innerHeight : box.clientHeight) * 0.8);
          box.scrollTo({
            top:
              direction === "top"
                ? 0
                : direction === "bottom"
                  ? end
                  : box.scrollTop + (direction === "up" ? -step : step),
            behavior: "instant",
          });
          return {
            top: Math.round(box.scrollTop),
            max: Math.round(box.scrollHeight - box.clientHeight),
            inner: box !== root,
          };
        },
        [direction, px, typeof inFlag !== "string"] as const,
        { timeout: ACTION_TIMEOUT_MS },
      );
      const what = inner ? "the scroll area" : "the page";
      if (max <= 0) ctx.note(`${what} doesn't scroll`);
      else if (top >= max - 1) ctx.note(`at the bottom of ${what}, ${max} px`);
      else if (top <= 0) ctx.note(`at the top of ${what}`);
      else ctx.note(`at ${top} of ${max} px`);
    },
  },
  {
    name: "fill",
    usage: 'fill <target> "<text>" [--submit]',
    help: "Replaces the field's value (input, textarea, contenteditable) at once, without key presses. For a field that reacts to typing (autocomplete, search as you type), click it and use type. --submit presses Enter after. The text isn't echoed back.",
    flags: { submit: false },
    maxArgs: 2,
    // With one argument, it may be the text with the target missing, so it isn't echoed
    echo: (args) =>
      `fill${args.positional.length >= 2 ? ` ${args.positional[0].text}` : ""}${args.flags.submit ? " --submit" : ""}`,
    async run(ctx) {
      if (ctx.args.positional.length < 2) {
        throw new StepError(
          'fill takes a target and the text: fill <target> "<text>"',
        );
      }
      const page = await ctx.page();
      const t = target(ctx.args);
      const text = positional(ctx.args, 1, '"<text>"');
      const locator = await resolveOne(page, t);
      const box = await locator.boundingBox().catch(() => null);
      if (box)
        await moveCursor(page, box.x + box.width / 2, box.y + box.height / 2);
      await locator.fill(text, { force: true, timeout: ACTION_TIMEOUT_MS });
      await fillLike(ctx, page, !!ctx.args.flags.submit);
    },
  },
  {
    name: "type",
    usage:
      'type "<text>" [--submit] [--slowly] [--paste]   # key by key, into the focused element',
    help: `Types into the focused element key by key, as a person would, so fields that react to keys (autocomplete, search as you type) respond. Text over ${TYPE_KEYS_MAX_CHARS} characters is inserted at once instead. --slowly waits between keys (for fields that drop fast keys), --paste inserts the text at once without key presses, --submit presses Enter after. The text isn't echoed back.`,
    flags: { submit: false, slowly: false, paste: false },
    maxArgs: 1,
    echo: (args) =>
      `type${args.flags.submit ? " --submit" : ""}${args.flags.slowly ? " --slowly" : ""}${args.flags.paste ? " --paste" : ""}`,
    async run(ctx) {
      const page = await ctx.page();
      const text = positional(ctx.args, 0, '"<text>"');
      const focused = await page.evaluate(() => {
        let el = document.activeElement;
        while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
        return !!el && el !== document.body;
      });
      if (!focused) {
        throw new StepError(
          'Nothing is focused. Click a field first, or use `fill <target> "<text>"`',
        );
      }
      await hiddenTabs.ensureVisible(page);
      if (ctx.args.flags.slowly && ctx.args.flags.paste) {
        throw new StepError("type takes --slowly or --paste, not both");
      }
      if (ctx.args.flags.slowly) await page.keyboard.type(text, { delay: 30 });
      else if (ctx.args.flags.paste || text.length > TYPE_KEYS_MAX_CHARS)
        await page.keyboard.insertText(text);
      else await page.keyboard.type(text);
      await fillLike(ctx, page, !!ctx.args.flags.submit);
    },
  },
  {
    name: "press",
    usage: "press <key>   # Enter, Escape, ArrowDown, Control+a",
    help: "Presses a key or combination on the focused element: Enter, Tab, Escape, ArrowDown, Control+a, Meta+Shift+K. Waits for a navigation it starts.",
    maxArgs: 1,
    async run(ctx) {
      const page = await ctx.page();
      const key = positional(ctx.args, 0, "<key>");
      await hiddenTabs.ensureVisible(page);
      await settled(ctx, page, () => page.keyboard.press(key));
    },
  },
  {
    name: "select",
    usage: 'select <target> "<value>"...   # by value or label',
    help: "Selects options of a <select> by value or label (several for a multiple select).",
    maxArgs: Infinity,
    async run(ctx) {
      const page = await ctx.page();
      const t = target(ctx.args);
      const values = ctx.args.positional.slice(1).map((token) => token.text);
      if (!values.length) throw new StepError('Missing "<value>"');
      const locator = await resolveOne(page, t);
      await settled(ctx, page, async () => {
        const selected = await locator.selectOption(values, {
          force: true,
          timeout: ACTION_TIMEOUT_MS,
        });
        if (!selected.length)
          throw new StepError(`No option of ${t.source} matches`);
      });
    },
  },
  {
    name: "check",
    usage: "check <target>",
    help: "Checks a checkbox, radio or switch (nothing if already checked).",
    maxArgs: 1,
    run: (ctx) => setChecked(ctx, true),
  },
  {
    name: "uncheck",
    usage: "uncheck <target>",
    help: "Unchecks a checkbox or switch (nothing if already unchecked).",
    maxArgs: 1,
    run: (ctx) => setChecked(ctx, false),
  },
  {
    name: "upload",
    usage: "upload <target> <path>...   # local files",
    help: "Sets files on a file input, or on the file chooser that clicking the target opens. Paths are on your machine: absolute, under ~, or relative to your MCP root (or working directory).",
    maxArgs: Infinity,
    echo: (args) =>
      `upload ${args.positional.map((token) => token.text).join(" ")}`,
    async run(ctx) {
      const page = await ctx.page();
      const t = target(ctx.args);
      const paths = ctx.args.positional.slice(1).map((token) => token.text);
      if (!paths.length) throw new StepError("Missing <path>");
      const files = [];
      for (const path of paths) {
        try {
          files.push(await ctx.io.readFile(path));
        } catch (error) {
          throw new StepError((error as Error).message);
        }
      }
      const locator = await resolveOne(page, t);
      const isFileInput = await locator.evaluate(
        (el) => el instanceof HTMLInputElement && el.type === "file",
        undefined,
        { timeout: ACTION_TIMEOUT_MS },
      );
      if (isFileInput) {
        await locator.setInputFiles(files, { timeout: ACTION_TIMEOUT_MS });
        return;
      }
      const chooser = page.waitForEvent("filechooser", {
        timeout: FIND_TIMEOUT_MS,
      });
      chooser.catch(() => {});
      await click(page, await preparePointer(locator, t.source));
      try {
        await (await chooser).setFiles(files);
      } catch {
        throw new StepError(
          `Clicking ${t.source} didn't open a file chooser. Target the <input type=file>`,
        );
      }
    },
  },
  {
    name: "wait",
    usage:
      'wait <ms> | wait --text "<text>" | wait --gone "<text>" | wait --url <glob> | wait <target>',
    help: "Waits a number of ms (up to 60000), or until text appears or disappears, the URL matches (a glob with * and **, or a substring), or the target is visible. Times out after 10 s; change it with --timeout <ms>.",
    flags: { text: true, gone: true, url: true, timeout: true },
    noPage: true,
    maxArgs: 1,
    whileDialog: (args) => isSleep(args),
    timeoutMs: (args) =>
      isSleep(args)
        ? Math.min(Number(args.positional[0].text), TIMEOUT_MAX_MS)
        : undefined,
    async run(ctx) {
      const { flags } = ctx.args;
      const first = ctx.args.positional[0];
      if (first && isSleep(ctx.args)) {
        await sleep(Math.min(Number(first.text), TIMEOUT_MAX_MS));
        return;
      }
      const page = await ctx.page();
      const timeout = timeoutFlag(ctx.args);
      let check: () => Promise<boolean>;
      let what: string;
      if (typeof flags.text === "string") {
        const locator = page.getByText(flags.text);
        check = () =>
          locator
            .filter({ visible: true })
            .count()
            .then((n) => n > 0);
        what = `the text ${JSON.stringify(flags.text)}`;
      } else if (typeof flags.gone === "string") {
        const locator = page.getByText(flags.gone);
        check = () =>
          locator
            .filter({ visible: true })
            .count()
            .then((n) => n === 0);
        what = `${JSON.stringify(flags.gone)} to go away`;
      } else if (typeof flags.url === "string") {
        const matches = urlMatcher(flags.url);
        check = async () => matches(page.url());
        what = `a URL matching ${flags.url}`;
      } else if (first) {
        const t = parseTarget(first.text);
        const locator = toLocator(page, t);
        check = () =>
          locator
            .filter({ visible: true })
            .count()
            .then((n) => n > 0);
        what = t.source;
      } else {
        throw new StepError(
          "wait takes <ms>, --text, --gone, --url or a <target>",
        );
      }
      const deadline = Date.now() + timeout;
      // A check can hang (e.g. while a dialog blocks the page), so each gets only the time that's left
      const checkInTime = () =>
        Promise.race([
          check().catch(() => false),
          sleep(Math.max(0, deadline - Date.now())).then(() => false),
        ]);
      while (!(await checkInTime())) {
        if (Date.now() >= deadline) {
          throw new StepError(
            `Timed out after ${timeout} ms waiting for ${what}`,
          );
        }
        await sleep(100);
      }
    },
  },
  {
    name: "fedcm",
    usage:
      "fedcm list [--timeout <ms>] | fedcm select <dialogId> <accountIndex> | fedcm click <dialogId> Continue|ErrorGotIt|ErrorMoreDetails | fedcm dismiss <dialogId>",
    help: "Controls Chromium's native federated sign-in chooser, including Google accounts when the site uses FedCM. list prints the current dialog and zero-based account indices; select chooses an observed account and continues sign-in. click Continue presses the provider-login confirmation button. Use observed dialog IDs; stale IDs fail without replay. Ordinary Google popup pages still use tab popup and normal click. Does not change account credentials or browser privacy settings.",
    maxArgs: 3,
    flags: { timeout: true },
    whileDialog: true,
    async run(ctx) {
      const action = positional(ctx.args, 0, "list, select, click or dismiss");
      if (!["list", "select", "click", "dismiss"].includes(action))
        throw new StepError("fedcm takes list, select, click or dismiss");
      const controller = await ctx.fedcm();
      if (action === "list") {
        const deadline = Date.now() + timeoutFlag(ctx.args, 500);
        while (
          !controller.dialog &&
          !controller.closed &&
          Date.now() < deadline
        )
          await sleep(50);
        if (controller.closed)
          throw new StepError(
            "Native account chooser disconnected; inspect again",
          );
        const dialog = controller.dialog;
        ctx.print(
          dialog
            ? JSON.stringify({
                ...dialog,
                accounts: dialog.accounts.map((account, index) => ({
                  index,
                  ...account,
                })),
              })
            : "No native account chooser is open. Inspect the page or its popup tabs.",
        );
        return;
      }
      const id = positional(ctx.args, 1, "observed dialog ID");
      const dialog = controller.dialog;
      if (!dialog || dialog.dialogId !== id)
        throw new StepError(
          "That native sign-in dialog is no longer open; run `fedcm list` before acting",
        );
      if (action === "select") {
        const text = positional(ctx.args, 2, "zero-based account index");
        const index = Number(text);
        if (
          !/^\d+$/.test(text) ||
          !Number.isSafeInteger(index) ||
          !dialog.accounts[index]
        )
          throw new StepError(
            "Choose an account index observed in `fedcm list`",
          );
        await controller.send("FedCm.selectAccount", {
          dialogId: id,
          accountIndex: index,
        });
      } else if (action === "click") {
        const button = positional(
          ctx.args,
          2,
          "Continue, ErrorGotIt or ErrorMoreDetails",
        );
        const dialogButton =
          button === "Continue" ? "ConfirmIdpLoginContinue" : button;
        if (
          ![
            "ConfirmIdpLoginContinue",
            "ErrorGotIt",
            "ErrorMoreDetails",
          ].includes(dialogButton)
        )
          throw new StepError("Unknown native sign-in button");
        await controller.send("FedCm.clickDialogButton", {
          dialogId: id,
          dialogButton,
        });
      } else await controller.send("FedCm.dismissDialog", { dialogId: id });
      // Never repeat a delivered sign-in operation, even if navigation is delayed.
    },
  },
  {
    name: "dialog",
    usage:
      'dialog accept ["<text>"] | dialog dismiss   # a dialog ends the batch it opens in',
    help: 'Answers the open alert, confirm, prompt or beforeunload dialog. A dialog ends the batch it opens in. accept "<text>" fills a prompt.',
    maxArgs: 2,
    whileDialog: true,
    echo: (args) => {
      const action = args.positional[0]?.text;
      return action === "accept" || action === "dismiss"
        ? `dialog ${action}`
        : "dialog";
    },
    async run(ctx) {
      const tab = await ctx.tab();
      const action = positional(ctx.args, 0, "accept or dismiss");
      if (action !== "accept" && action !== "dismiss") {
        throw new StepError("dialog takes accept or dismiss");
      }
      const dialog = tab.dialog;
      if (!dialog) throw new StepError("No dialog is open");
      tab.dialog = null;
      await settled(ctx, tab.page, () =>
        action === "accept"
          ? dialog.accept(ctx.args.positional[1]?.text)
          : dialog.dismiss(),
      );
      // The step the dialog interrupted goes on now: it finishes within this call, which holds the tab
      await tab.finishAbandoned();
    },
  },
  {
    name: "tab",
    usage:
      "tab list | tab new [<url>] | tab select <tabId> | tab popup [<openerTabId>] [--url <text>] | tab close [<tabId>]",
    help: "Lists tabs, opens/selects a tab, or closes a tab you opened. popup waits up to 5 seconds for one child of the current or specified opener and selects it. --url narrows popup candidates by URL substring; multiple matches require narrowing. SS sessions stay within their own tabs.",
    noPage: true,
    navigates: true,
    flags: { browser: true, url: true },
    maxArgs: 2,
    whileDialog: true,
    timeoutMs: () => NAVIGATION_STEP_MS,
    async run(ctx) {
      const sub = positional(ctx.args, 0, "list, new, select, popup or close");
      const browser = ctx.args.flags.browser;
      if (browser !== undefined && sub !== "new") {
        throw new StepError("--browser goes with `tab new`");
      }
      if (ctx.args.flags.url !== undefined && sub !== "popup")
        throw new StepError("--url goes with `tab popup`");
      const id = () => {
        const value = Number(positional(ctx.args, 1, "<tabId>"));
        if (!Number.isInteger(value))
          throw new StepError("<tabId> is a number from `tab list`");
        return value;
      };
      if (sub === "list") ctx.print(await ctx.tabs.list());
      else if (sub === "new") {
        const url = ctx.args.positional[1]?.text;
        const tabId = await ctx.tabs.create(
          url ? normalizeUrl(url) : undefined,
          typeof browser === "string" ? browser : undefined,
        );
        const label = ctx.tabs.browserOf(tabId);
        ctx.note(label ? `tab ${tabId} in ${label}` : `tab ${tabId}`);
      } else if (sub === "select") await ctx.tabs.select(id());
      else if (sub === "popup") {
        const opener = ctx.args.positional[1] ? id() : ctx.currentTabId();
        if (opener === null) throw new StepError("Select the opener tab first");
        const selected = await ctx.tabs.popup(
          opener,
          typeof ctx.args.flags.url === "string"
            ? ctx.args.flags.url
            : undefined,
        );
        ctx.note(`tab ${selected}; opener ${opener}`);
      } else if (sub === "close") {
        await ctx.tabs.close(ctx.args.positional[1] ? id() : undefined);
      } else throw new StepError("tab takes list, new, select, popup or close");
    },
  },
  {
    name: "browser",
    usage:
      'browser list | browser use "<name>"|<id>   # the connected browsers (Chrome profiles), and which one new tabs open in',
    help: 'Lists the connected browsers (Chrome profiles), * marking the one your new tabs open in, or chooses it. New tabs open in the browser of the tab you selected or opened last, else the one the user used last; `browser use` changes that until you select a tab elsewhere, and `tab new --browser "<name>"|<id>` opens one tab elsewhere. Quote names with spaces ("Chrome 2"). Tab IDs from `tab list` work across browsers.',
    severalBrowsers: true,
    noPage: true,
    whileDialog: true,
    maxArgs: 2,
    async run(ctx) {
      const sub = positional(ctx.args, 0, "list or use");
      if (sub === "list") ctx.print(ctx.browsers.list());
      else if (sub === "use") {
        const label = ctx.browsers.use(positional(ctx.args, 1, "<name|id>"));
        ctx.note(`new tabs open in ${label}`);
      } else throw new StepError("browser takes list or use");
    },
  },
  {
    name: "snapshot",
    reads: true,
    usage:
      "snapshot [<target>] [-i] [--depth N] [--max N|all]   # -i: interactive elements, headings, landmarks",
    help: "Prints the accessibility tree with refs (e12, f1e3 in iframes) to use as targets. -i keeps interactive elements, landmarks, headings and cells. A target or --depth narrows it; refs stay valid either way.",
    flags: { i: false, depth: true, max: true },
    maxArgs: 1,
    run: snapshotCommand,
  },
  {
    name: "find",
    reads: true,
    usage: 'find "<text>" [--max N|all]   # snapshot lines containing the text',
    help: "Prints the snapshot lines whose name, text or URL contain the text (ignoring case), each with its ancestors, so you can act on a ref without a full snapshot.",
    flags: { max: true },
    maxArgs: 1,
    async run(ctx) {
      const page = await ctx.page();
      const query = positional(ctx.args, 0, '"<text>"');
      const matches = find(await takeSnapshot(page), query);
      ctx.print(
        matches.length
          ? cap(
              matches.join("\n"),
              readCap(ctx.args.flags.max),
              "use more specific text",
            )
          : `No matches for ${JSON.stringify(query)}`,
      );
    },
  },
  {
    name: "get",
    reads: true,
    usage:
      "get text|value|count [<target>] [--max N|all] | get attr <name> <target> | get url | get title",
    help: "text: the target's visible text (the page's without a target). value: a field's value. count: how many elements match. attr: an attribute.",
    flags: { max: true },
    maxArgs: 3,
    async run(ctx) {
      const page = await ctx.page();
      const what = positional(
        ctx.args,
        0,
        "text, value, count, attr, url or title",
      );
      const max = readCap(ctx.args.flags.max);
      if (what === "url") return ctx.print(page.url());
      if (what === "title") return ctx.print(await page.title());
      if (what === "count") {
        return ctx.print(
          String(await toLocator(page, target(ctx.args, 1)).count()),
        );
      }
      if (what === "attr") {
        const name = positional(ctx.args, 1, "<name>");
        const locator = await resolveOne(page, target(ctx.args, 2));
        const value = await locator.getAttribute(name, {
          timeout: ACTION_TIMEOUT_MS,
        });
        return ctx.print(value ?? "(none)");
      }
      if (what === "value") {
        const locator = await resolveOne(page, target(ctx.args, 1));
        return ctx.print(
          cap(await locator.inputValue({ timeout: ACTION_TIMEOUT_MS }), max),
        );
      }
      if (what === "text") {
        const t = ctx.args.positional[1]
          ? parseTarget(ctx.args.positional[1].text)
          : undefined;
        const locator = t ? await resolveOne(page, t) : page.locator("body");
        const text = (await locator.innerText({ timeout: ACTION_TIMEOUT_MS }))
          .replace(/\n{3,}/g, "\n\n")
          .trim();
        return ctx.print(
          cap(text, max, 'use a narrower target or `find "<text>"`'),
        );
      }
      throw new StepError("get takes text, value, count, attr, url or title");
    },
  },
  {
    name: "screenshot",
    reads: true,
    usage:
      "screenshot [<target>] [--full] [--path <file>]   # JPEG, longest side ≤ 1568 px",
    help: "Adds a JPEG of the viewport (or the element, or the full page) to the result, longest side ≤ 1568 px. --path also saves it, overwriting an existing file (paths: absolute, under ~, or relative to your MCP root or working directory).",
    flags: { full: false, path: true },
    maxArgs: 1,
    run: screenshot,
  },
  {
    name: "pdf",
    usage: "pdf [<path>] [--landscape]   # saves the page as a PDF",
    help: "Prints the page to a PDF, as Chrome's Save as PDF does (print styles, backgrounds, the page size the page's CSS sets), and saves it to <path> (or --path), overwriting an existing file. Without <path>, it saves <page title>.pdf in your MCP root (or working directory), adding (1), (2)… rather than overwrite. Paths: absolute, under ~, or relative to your MCP root.",
    flags: { landscape: false, path: true },
    maxArgs: 1,
    timeoutMs: () => TIMEOUT_MAX_MS,
    run: pdf,
  },
  {
    name: "download",
    usage:
      "download <url>|<target> [--path <file>]   # fetches a file as the page would",
    help: `Fetches a file in the page, as its own scripts would (its cookies; another site's file needs CORS), and saves it. Takes a URL (absolute, or relative to the page: /, ./, ../, ?) or a link, image or media element (a ref or locator), whose href or src it fetches. Up to ${DOWNLOAD_MAX_BYTES / 1024 / 1024} MB. Saves to --path, overwriting an existing file, else under the server's file name, the link's download name or the URL's last segment in your MCP root (or working directory), adding (1), (2)… rather than overwrite. Doesn't click or open Chrome's downloads; for a file only a click produces, find its URL with \`requests\` or \`get attr href <target>\`.`,
    flags: { path: true },
    maxArgs: 1,
    timeoutMs: () => TIMEOUT_MAX_MS,
    run: download,
  },
  {
    name: "eval",
    usage:
      'eval "<function>" [<target>]   # runs in the page; e.g. eval "() => location.href"',
    help: 'Runs JavaScript in the page and prints the result as JSON: a function (async is fine; with a target it gets the element) or an expression. E.g. eval "() => document.title", eval "el => el.dataset" e5.',
    flags: { max: true },
    maxArgs: 2,
    async run(ctx) {
      const page = await ctx.page();
      const src = positional(ctx.args, 0, '"<function>"');
      const element = ctx.args.positional[1]
        ? parseTarget(ctx.args.positional[1].text)
        : undefined;
      const result = await evaluate(page, src, element);
      ctx.print(
        cap(compactJson(result), readCap(ctx.args.flags.max), "return less"),
      );
    },
  },
  {
    name: "console",
    usage: "console [--errors]   # with uncaught errors",
    help: "Prints the tab's console messages and uncaught errors with their stacks (the last 500 of each), newest last. --errors keeps console errors and uncaught errors only.",
    flags: { errors: false, max: true },
    async run(ctx) {
      const tab = await ctx.tab();
      const entries = [...tab.console, ...tab.uncaught]
        .filter(
          (entry) =>
            !ctx.args.flags.errors ||
            entry.type === "error" ||
            entry.type === "uncaught",
        )
        .sort((a, b) => a.seq - b.seq);
      ctx.print(
        entries.length
          ? capTail(
              entries
                .map(
                  (entry) =>
                    `[${entry.type}] ${entry.text}${entry.location ? ` (${entry.location})` : ""}`,
                )
                .join("\n"),
              readCap(ctx.args.flags.max),
            )
          : "(no messages)",
      );
    },
  },
  {
    name: "requests",
    usage: 'requests [--static] [--filter "<text>"]',
    help: "Lists the tab's requests (the last 500): #id, method, status, URL. Images, scripts, styles and fonts only with --static. --filter keeps URLs containing the text.",
    flags: { static: false, filter: true, max: true },
    async run(ctx) {
      const tab = await ctx.tab();
      const filter =
        typeof ctx.args.flags.filter === "string"
          ? ctx.args.flags.filter
          : undefined;
      const lines = tab.requests
        .filter(
          ({ request }) =>
            (ctx.args.flags.static ||
              !STATIC_TYPES.has(request.resourceType())) &&
            (!filter || request.url().includes(filter)),
        )
        .map(({ id, request, response, failure }) => {
          const status = response ? response.status() : (failure ?? "pending");
          return `#${id} ${request.method()} ${status} ${request.url()}`;
        });
      ctx.print(
        lines.length
          ? capTail(lines.join("\n"), readCap(ctx.args.flags.max))
          : "(no requests)",
      );
    },
  },
  {
    name: "request",
    usage: "request <id> [--body]",
    help: "Shows a request's headers, its post data, and the response's headers; --body adds the response body (capped).",
    flags: { body: false, max: true },
    maxArgs: 1,
    async run(ctx) {
      const tab = await ctx.tab();
      const id = Number(positional(ctx.args, 0, "<id>").replace(/^#/, ""));
      const entry = tab.requests.find((item) => item.id === id);
      if (!entry) throw new StepError(`No request #${id}. Run \`requests\``);
      const { request, response, failure } = entry;
      const headers = (h: Record<string, string>) =>
        Object.entries(h)
          .map(([name, value]) => `  ${name}: ${value}`)
          .join("\n");
      const lines = [
        `${request.method()} ${request.url()}`,
        "Request headers:",
        headers(await request.allHeaders()),
      ];
      const post = request.postData();
      if (post) lines.push("Post data:", post);
      if (failure) lines.push(`Failed: ${failure}`);
      if (response) {
        lines.push(
          `Status: ${response.status()} ${response.statusText()}`,
          "Response headers:",
          headers(await response.allHeaders()),
        );
        if (ctx.args.flags.body) {
          const type = (await response.headerValue("content-type")) ?? "";
          // A body that never arrives (a stream, a request still loading) mustn't hold the step
          const body = await Promise.race([
            response.body().catch(() => null),
            sleep(BODY_TIMEOUT_MS).then(() => null),
          ]);
          if (!body) lines.push("Body: (not available)");
          else if (/text|json|xml|javascript|html|csv|urlencoded/.test(type)) {
            lines.push("Body:", body.toString("utf8"));
          } else
            lines.push(`Body: (${type || "binary"}, ${body.length} bytes)`);
        }
      }
      ctx.print(
        cap(lines.join("\n"), readCap(ctx.args.flags.max), "omit --body"),
      );
    },
  },
  {
    name: "cdp",
    usage:
      "cdp <Domain.method> [<json>] | cdp on <Domain.event>... | cdp events [<Domain.event>] [--max N] | cdp wait <Domain.event> [--timeout ms]",
    help: "Raw Chrome DevTools Protocol on a session of your own on the tab (only with --caps cdp). `cdp on` buffers events (500), `cdp events` prints and clears them, `cdp wait` waits for the next one. When the tab is released, domains you enabled are disabled and overrides, interception and a paused debugger are cleared.",
    capability: "cdp",
    flags: { max: true, timeout: true },
    maxArgs: Infinity,
    async run(ctx) {
      const state = await ctx.agentCdp();
      const first = positional(ctx.args, 0, "<Domain.method>");
      const events = (tokens: Token[]) => {
        const names = tokens.map((token) => token.text);
        for (const name of names) {
          if (!/^[A-Z]\w*\.\w+$/.test(name))
            throw new StepError(
              `${name} isn't a CDP event like Network.requestWillBeSent`,
            );
        }
        return names;
      };
      const max = readCap(ctx.args.flags.max);
      const format = (event: { method: string; params: unknown }) =>
        `${event.method} ${compactJson(event.params)}`;
      if (first === "on") {
        const names = events(ctx.args.positional.slice(1));
        if (!names.length) throw new StepError("Missing <Domain.event>");
        for (const name of names) subscribe(state, name);
        return;
      }
      if (first === "events") {
        const [name] = events(ctx.args.positional.slice(1));
        const picked = state.events.filter(
          (event) => !name || event.method === name,
        );
        state.events = state.events.filter((event) => !picked.includes(event));
        ctx.print(
          picked.length
            ? capTail(picked.map(format).join("\n"), max)
            : "(no events)",
        );
        return;
      }
      if (first === "wait") {
        const [name] = events(ctx.args.positional.slice(1));
        if (!name) throw new StepError("Missing <Domain.event>");
        subscribe(state, name);
        const timeout = timeoutFlag(ctx.args);
        const event = await new Promise<{
          method: string;
          params: unknown;
        } | null>((resolve) => {
          const listener = (params: unknown) => {
            clearTimeout(timer);
            resolve({ method: name, params });
          };
          const timer = setTimeout(() => {
            state.session.off(name as "Debugger.paused", listener as never);
            resolve(null);
          }, timeout);
          state.session.once(name as "Debugger.paused", listener as never);
        });
        if (!event) throw new StepError(`No ${name} within ${timeout} ms`);
        ctx.print(cap(format(event), max));
        return;
      }
      if (!/^[A-Z]\w*\.\w+$/.test(first)) {
        throw new StepError(`${first} isn't a CDP method like Network.enable`);
      }
      let params: Record<string, unknown> | undefined;
      const json = ctx.args.positional[1]?.text;
      if (json) {
        try {
          params = JSON.parse(json) as Record<string, unknown>;
        } catch {
          throw new StepError(
            `The params aren't valid JSON: ${json.slice(0, 80)}`,
          );
        }
      }
      const result = await sendCdp(state, first, params);
      ctx.print(
        cap(compactJson(result), max, "use cdp events or narrower params"),
      );
    },
  },
];

COMMANDS.push({
  name: "help",
  usage: "help [<command>]",
  help: "Prints the commands, or one command's details.",
  noPage: true,
  whileDialog: true,
  maxArgs: 1,
  async run(ctx) {
    const name = ctx.args.positional[0]?.text;
    if (!name) {
      ctx.print(
        [
          ...availableCommands(ctx.capabilities)
            .filter(
              (command) =>
                command.listed !== false &&
                (!command.severalBrowsers || ctx.browsers.several()),
            )
            .map((command) => command.usage),
          "",
          TARGETS_HELP,
        ].join("\n"),
      );
      return;
    }
    const command = COMMANDS.find((item) => item.name === name);
    if (!command) throw new StepError(`No command ${name}. Run \`help\``);
    const flags = command.capability
      ? `\nNeeds --caps ${command.capability}.`
      : "";
    ctx.print(`${command.usage}\n${command.help}${flags}`);
  },
});

export const TARGETS_HELP =
  "Targets: a ref from snapshot (e12, f1e3 in an iframe), a Playwright locator (getByRole('button', { name: 'Submit' }), getByLabel, getByText, getByPlaceholder, getByTestId, .first(), .nth(i), .filter({ hasText }), locator('css')), or a CSS selector (quote it if it has spaces).";

/** The commands a session can run: those without a capability, and those whose capability it has */
export function availableCommands(
  capabilities: readonly string[],
): CommandDef[] {
  return COMMANDS.filter(
    (command) =>
      !command.capability || capabilities.includes(command.capability),
  );
}

export const COMMANDS_BY_NAME = new Map(
  COMMANDS.map((command) => [command.name, command]),
);
