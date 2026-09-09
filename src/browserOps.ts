import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";
import type { Workspace } from "./guard.js";
import { LocalWorkspaceBridgeError, PathGuard } from "./guard.js";

export const DEFAULT_BROWSER_SCREENSHOT_WIDTH = 1440;
export const DEFAULT_BROWSER_SCREENSHOT_HEIGHT = 900;
export const DEFAULT_BROWSER_SCREENSHOT_WAIT_MS = 1000;
export const MAX_BROWSER_SCREENSHOT_DIMENSION = 5000;
export const MAX_BROWSER_SCREENSHOT_WAIT_MS = 10_000;
const BROWSER_TIMEOUT_MS = 30_000;

type BrowserPreference = "auto" | "edge" | "chrome" | "chromium";

export interface BrowserScreenshotResult {
  path: string;
  url: string;
  width: number;
  height: number;
  waitMs: number;
  browser: string;
  browserExecutable: string;
  bytes: number;
}

function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
}

export function isLocalBrowserUrl(input: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const host = normalizeHostname(parsed.hostname);
  if (host === "localhost" || host === "::1" || host === "0.0.0.0") return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(host)) {
    return host.split(".").every((part) => Number(part) >= 0 && Number(part) <= 255);
  }
  return false;
}

export function assertLocalBrowserUrl(input: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new LocalWorkspaceBridgeError(`Invalid browser URL: ${input}`);
  }
  if (!isLocalBrowserUrl(input)) {
    throw new LocalWorkspaceBridgeError(
      "browser_screenshot only accepts local development URLs on localhost, 127.0.0.0/8, ::1, or 0.0.0.0 using http/https."
    );
  }
  return parsed;
}

function windowsCandidates(preference: BrowserPreference): Array<{ name: string; executable: string }> {
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const localAppData = process.env.LOCALAPPDATA;
  const edge = [
    path.join(programFilesX86, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    ...(localAppData ? [path.join(localAppData, "Microsoft", "Edge", "Application", "msedge.exe")] : [])
  ].map((executable) => ({ name: "edge", executable }));
  const chrome = [
    path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
    ...(localAppData ? [path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe")] : [])
  ].map((executable) => ({ name: "chrome", executable }));
  if (preference === "edge") return edge;
  if (preference === "chrome") return chrome;
  if (preference === "chromium") return [];
  return [...edge, ...chrome];
}

function macCandidates(preference: BrowserPreference): Array<{ name: string; executable: string }> {
  const edge = [{ name: "edge", executable: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" }];
  const chrome = [{ name: "chrome", executable: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" }];
  const chromium = [{ name: "chromium", executable: "/Applications/Chromium.app/Contents/MacOS/Chromium" }];
  if (preference === "edge") return edge;
  if (preference === "chrome") return chrome;
  if (preference === "chromium") return chromium;
  return [...edge, ...chrome, ...chromium];
}

function commandCandidates(preference: BrowserPreference): Array<{ name: string; command: string }> {
  const edge = ["microsoft-edge", "microsoft-edge-stable", "msedge"].map((command) => ({ name: "edge", command }));
  const chrome = ["google-chrome", "google-chrome-stable", "chrome"].map((command) => ({ name: "chrome", command }));
  const chromium = ["chromium", "chromium-browser"].map((command) => ({ name: "chromium", command }));
  if (preference === "edge") return edge;
  if (preference === "chrome") return chrome;
  if (preference === "chromium") return chromium;
  return [...edge, ...chrome, ...chromium];
}

function findOnPath(command: string): string | undefined {
  const lookup = process.platform === "win32" ? "where.exe" : "which";
  const result = spawnSync(lookup, [command], { encoding: "utf8", windowsHide: true, timeout: 3000 });
  if (result.status !== 0 || !result.stdout) return undefined;
  const first = result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  return first && fs.existsSync(first) ? first : undefined;
}

export function findBrowserExecutable(preference: BrowserPreference = "auto"): { name: string; executable: string } {
  const directCandidates = process.platform === "win32"
    ? windowsCandidates(preference)
    : process.platform === "darwin"
      ? macCandidates(preference)
      : [];
  for (const candidate of directCandidates) {
    if (fs.existsSync(candidate.executable)) return candidate;
  }
  for (const candidate of commandCandidates(preference)) {
    const executable = findOnPath(candidate.command);
    if (executable) return { name: candidate.name, executable };
  }
  throw new LocalWorkspaceBridgeError(
    `No supported browser executable was found for browser=${preference}. Install Microsoft Edge, Google Chrome, or Chromium on this machine.`
  );
}

function defaultOutputPath(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `.ai-bridge/screenshots/browser-${stamp}.png`;
}

function boundedInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new LocalWorkspaceBridgeError(`Expected an integer between ${min} and ${max}, got ${value}.`);
  }
  return value;
}

export async function captureBrowserScreenshot(
  guard: PathGuard,
  workspace: Workspace,
  inputUrl: string,
  options: {
    outputPath?: string;
    width?: number;
    height?: number;
    waitMs?: number;
    browser?: BrowserPreference;
    overwrite?: boolean;
  } = {}
): Promise<BrowserScreenshotResult> {
  const parsed = assertLocalBrowserUrl(inputUrl);
  const width = boundedInt(options.width, DEFAULT_BROWSER_SCREENSHOT_WIDTH, 320, MAX_BROWSER_SCREENSHOT_DIMENSION);
  const height = boundedInt(options.height, DEFAULT_BROWSER_SCREENSHOT_HEIGHT, 240, MAX_BROWSER_SCREENSHOT_DIMENSION);
  const waitMs = boundedInt(options.waitMs, DEFAULT_BROWSER_SCREENSHOT_WAIT_MS, 0, MAX_BROWSER_SCREENSHOT_WAIT_MS);
  const output = guard.resolve(workspace, options.outputPath?.trim() || defaultOutputPath(), { forWrite: true });
  if (path.extname(output.absPath).toLowerCase() !== ".png") {
    throw new LocalWorkspaceBridgeError("browser_screenshot output_path must end in .png.");
  }
  if (fs.existsSync(output.absPath) && options.overwrite !== true) {
    throw new LocalWorkspaceBridgeError(`Screenshot output already exists: ${output.relPath}. Set overwrite=true or choose another output_path.`);
  }

  const selected = findBrowserExecutable(options.browser ?? "auto");
  await fsp.mkdir(path.dirname(output.absPath), { recursive: true });
  const browser = await chromium.launch({ executablePath: selected.executable, headless: true, timeout: BROWSER_TIMEOUT_MS });
  try {
    const context = await browser.newContext({ viewport: { width, height }, ignoreHTTPSErrors: true, serviceWorkers: "block", acceptDownloads: false });
    await context.route("**/*", route => isLocalBrowserUrl(route.request().url()) ? route.continue() : route.abort("blockedbyclient"));
    await context.routeWebSocket("**/*", socket => {
      if (isLocalBrowserUrl(socket.url().replace(/^ws:/, "http:").replace(/^wss:/, "https:"))) socket.connectToServer();
      else socket.close();
    });
    const page = await context.newPage();
    await page.goto(parsed.toString(), { waitUntil: "domcontentloaded", timeout: BROWSER_TIMEOUT_MS });
    if (waitMs) await new Promise(resolve => setTimeout(resolve, waitMs));
    guard.resolve(workspace, output.relPath, { forWrite: true });
    await page.screenshot({ path: output.absPath, timeout: BROWSER_TIMEOUT_MS, fullPage: false });

    let stat;
    try {
      stat = await fsp.stat(output.absPath);
    } catch {
      throw new LocalWorkspaceBridgeError("Browser exited without creating the screenshot file. Verify that the local dev server is running and the URL is reachable.");
    }
    if (!stat.isFile() || stat.size === 0) {
      throw new LocalWorkspaceBridgeError("Browser created an empty screenshot file.");
    }
    return {
      path: output.relPath,
      url: parsed.toString(),
      width,
      height,
      waitMs,
      browser: selected.name,
      browserExecutable: selected.executable,
      bytes: stat.size
    };
  } finally {
    await browser.close();
  }
}
