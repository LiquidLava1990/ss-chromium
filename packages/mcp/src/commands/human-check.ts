import type { Page } from "playwright-core";

/**
 * Recognizes pages that ask for human verification (CAPTCHAs, bot walls) so the agent can hand
 * them to the user and wait. It never interacts with the check: SS Chromium does not solve,
 * bypass or evade CAPTCHAs or bot detection.
 */

/** What the page shows that hints at a human check */
export type PageSignals = {
  title: string;
  /** `src` of every iframe in the main document */
  frameUrls: string[];
  /** Provider markers found in the main document (see `MARKER_SELECTORS`) */
  markers: string[];
};

const FRAME_PROVIDERS: { provider: string; pattern: RegExp }[] = [
  {
    provider: "reCAPTCHA",
    pattern: /\/\/(www\.)?(google\.com|recaptcha\.net)\/recaptcha\//i,
  },
  { provider: "hCaptcha", pattern: /\/\/([a-z0-9-]+\.)?hcaptcha\.com\//i },
  {
    provider: "Cloudflare Turnstile",
    pattern: /\/\/challenges\.cloudflare\.com\//i,
  },
  {
    provider: "Arkose Labs",
    pattern: /\/\/([a-z0-9-]+\.)?(arkoselabs|funcaptcha)\.com\//i,
  },
  {
    provider: "DataDome",
    pattern: /\/\/([a-z0-9-]+\.)?captcha-delivery\.com\//i,
  },
  { provider: "GeeTest", pattern: /\/\/([a-z0-9-]+\.)?geetest\.com\//i },
];

/** CSS selectors of provider widgets and challenge pages, with the provider they indicate */
export const MARKER_SELECTORS: Record<string, string> = {
  ".g-recaptcha, [data-sitekey].g-recaptcha": "reCAPTCHA",
  ".h-captcha": "hCaptcha",
  ".cf-turnstile": "Cloudflare Turnstile",
  "#challenge-form, #cf-challenge-running, #challenge-running":
    "Cloudflare challenge",
  "#px-captcha": "PerimeterX / HUMAN",
  "#captcha-container.amzn-captcha-modal, [id^='aws-waf-captcha']":
    "AWS WAF CAPTCHA",
};

const TITLE_PATTERNS: { provider: string; pattern: RegExp }[] = [
  {
    provider: "Cloudflare challenge",
    pattern: /^(just a moment\.\.\.|attention required! \| cloudflare)$/i,
  },
  {
    provider: "verification page",
    pattern:
      /\b(verify (that )?you('| a)re (a )?human|are you a robot|human verification|security check)\b/i,
  },
];

/** The kind of human check the signals show, or null when none is recognized */
export function classifyHumanCheck(signals: PageSignals): string | null {
  for (const url of signals.frameUrls) {
    const match = FRAME_PROVIDERS.find(({ pattern }) => pattern.test(url));
    if (match) return match.provider;
  }
  if (signals.markers.length > 0) return signals.markers[0]!;
  return (
    TITLE_PATTERNS.find(({ pattern }) => pattern.test(signals.title.trim()))
      ?.provider ?? null
  );
}

/** Reads the signals from the page's main document. A page that can't be read shows none */
export async function readPageSignals(page: Page): Promise<PageSignals> {
  return page
    .evaluate((selectors: Record<string, string>) => {
      const markers = Object.entries(selectors)
        .filter(([selector]) => document.querySelector(selector) !== null)
        .map(([, provider]) => provider);
      const frameUrls = [...document.querySelectorAll("iframe")].map(
        (frame) => frame.src,
      );
      return { title: document.title, frameUrls, markers };
    }, MARKER_SELECTORS)
    .catch(() => ({ title: "", frameUrls: [], markers: [] }));
}

/** The human check on the page, or null */
export async function detectHumanCheck(page: Page): Promise<string | null> {
  return classifyHumanCheck(await readPageSignals(page));
}

/** The note added after a navigation lands on a human check */
export function humanCheckNote(provider: string): string {
  return `this page shows a human-verification check (${provider}). Don't try to solve it: ask the user to complete it in the SS Chromium window, then run \`human-check --wait\` and continue`;
}
