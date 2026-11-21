// Optional image description through an external vision service, such as CrawlRX's vision
// endpoint. Off unless SS_CHROMIUM_VISION_URL is set. Not a CAPTCHA solver: use it to describe
// what a page shows (charts, canvas apps, images without text alternatives).
import { readFileSync } from "node:fs";

const VISION_TIMEOUT_MS = 65000;

/**
 * The configured endpoint, or null when vision is turned off.
 * @param {NodeJS.ProcessEnv} env
 * @returns {URL | null}
 */
export function visionEndpoint(env = process.env) {
  const value = env.SS_CHROMIUM_VISION_URL?.trim();
  if (!value) return null;
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("SS_CHROMIUM_VISION_URL must be an http(s) URL");
  return url;
}

/**
 * Sends a screenshot and a question to the vision service.
 * Request: POST JSON `{ image: <base64>, prompt }`. Response: JSON `{ ok: true, analysis: string }`.
 * @param {string} imageFile
 * @param {string} prompt
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<string>} the analysis
 */
export async function describeImage(imageFile, prompt, env = process.env) {
  const endpoint = visionEndpoint(env);
  if (!endpoint)
    throw new Error(
      "Vision is off. Set SS_CHROMIUM_VISION_URL to a vision service (for example a CrawlRX vision endpoint) to use it.",
    );
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      image: readFileSync(imageFile).toString("base64"),
      prompt,
    }),
    signal: AbortSignal.timeout(VISION_TIMEOUT_MS),
  });
  if (!response.ok)
    throw new Error(
      `The vision service at ${endpoint.origin} answered HTTP ${response.status}`,
    );
  const result = await response.json();
  if (result?.ok !== true || typeof result.analysis !== "string")
    throw new Error(
      "The vision service returned an unexpected response; it must answer { ok: true, analysis }",
    );
  return result.analysis;
}
