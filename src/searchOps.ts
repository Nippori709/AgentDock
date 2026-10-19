import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import type { LocalWorkspaceBridgeConfig } from "./config.js";
import type { Workspace } from "./guard.js";
import { LocalWorkspaceBridgeError, PathGuard } from "./guard.js";
import { listFiles, textScanByteLimit } from "./fsOps.js";
import { redactSensitiveText } from "./redact.js";
import { searchWorkspaceStructured, type AnalysisSearchIntent, type StructuredSearchResult } from "./analysis/index.js";

const require = createRequire(import.meta.url);
const rgPath = (require("@vscode/ripgrep") as { rgPath: string }).rgPath;

export interface SearchOptions {
  query: string;
  regex: boolean;
  root?: string;
  glob?: string;
  includeHidden: boolean;
  maxResults: number;
  multiline?: boolean;
  intent?: AnalysisSearchIntent;
  symbol?: string;
  includeTests?: boolean;
}

export interface SearchResult {
  text: string;
  matches: Array<{ path: string; line: number; text: string }>;
  truncated: boolean;
  used: "ripgrep" | "node";
  analysis?: StructuredSearchResult;
}

export interface GlobResult {
  text: string;
  paths: string[];
  truncated: boolean;
  used: "ripgrep";
}

function truncateLine(line: string, max = 400): string {
  if (line.length <= max) return line;
  return `${line.slice(0, max)}…`;
}

async function runRipgrep(config: LocalWorkspaceBridgeConfig, guard: PathGuard, workspace: Workspace, options: SearchOptions): Promise<SearchResult> {
  const target = guard.resolve(workspace, options.root ?? ".");
  const args = ["--json", "--line-number", "--with-filename", "--no-heading", "--color=never", "--max-columns", "500", "--max-count", "50", "--max-filesize", String(textScanByteLimit(config))];
  if (!options.regex) args.push("--fixed-strings");
  if (options.multiline) args.push("--multiline", "--multiline-dotall");
  if (options.includeHidden) args.push("--hidden");
  for (const glob of config.blockedGlobs) args.push("-g", `!${glob}`);
  if (options.glob) args.push("-g", options.glob);
  // Pass the query via -e so patterns beginning with "-" (e.g. "->", "--flag")
  // are treated as the search term instead of ripgrep options.
  args.push("-e", options.query, "--", target.absPath);

  return new Promise((resolve, reject) => {
    const child = spawn(rgPath, args, { cwd: workspace.root, env: { ...process.env, NO_COLOR: "1" }, shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
      if (stdout.length > config.maxOutputBytes) child.kill("SIGTERM");
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code && code > 1) {
        reject(new LocalWorkspaceBridgeError(stderr.trim() || `ripgrep failed with exit code ${code}`));
        return;
      }
      const matches: Array<{ path: string; line: number; text: string }> = [];
      const lines = stdout.split("\n").filter(Boolean);
      let visibleMatches = 0;
      for (const line of lines) {
        const value = JSON.parse(line);
        if (value.type !== "match") continue;
        const absPath = path.resolve(value.data?.path?.text ?? "");
        const rel = path.relative(workspace.root, absPath).split(path.sep).join("/");
        if (rel.startsWith("..")) continue;
        if (guard.isBlockedRelativePath(rel)) continue;
        visibleMatches += 1;
        if (matches.length >= options.maxResults) continue;
        const lineText = String(value.data?.lines?.text ?? "").replace(/\r?\n$/, "");
        matches.push({ path: rel || ".", line: Number(value.data?.line_number ?? 0), text: redactSensitiveText(truncateLine(lineText)) });
      }
      const text = matches.map((m) => `${m.path}:${m.line}: ${m.text}`).join("\n") || "No matches.";
      resolve({ text, matches, truncated: visibleMatches > matches.length || stdout.length > config.maxOutputBytes, used: "ripgrep" });
    });
  });
}

async function runNodeSearch(config: LocalWorkspaceBridgeConfig, guard: PathGuard, workspace: Workspace, options: SearchOptions): Promise<SearchResult> {
  const files = await listFiles(guard, workspace, {
    root: options.root,
    glob: options.glob,
    includeHidden: options.includeHidden,
    maxFiles: 20_000
  });
  const matches: Array<{ path: string; line: number; text: string }> = [];
  let visibleMatches = 0;
  const scanBytes = textScanByteLimit(config);
  const matcher = options.regex ? new RegExp(options.query) : undefined;
  for (const rel of files) {
    if (visibleMatches > options.maxResults) break;
    const resolved = guard.resolve(workspace, rel);
    try {
      const stat = await fsp.stat(resolved.absPath);
      if (stat.size > scanBytes) continue;
      const buffer = await fsp.readFile(resolved.absPath);
      if (buffer.includes(0)) continue;
      const lines = buffer.toString("utf8").split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const hit = matcher ? matcher.test(line) : line.includes(options.query);
        if (hit) {
          visibleMatches += 1;
          if (matches.length < options.maxResults) {
            matches.push({ path: rel, line: i + 1, text: redactSensitiveText(truncateLine(line)) });
          }
          if (visibleMatches > options.maxResults) break;
        }
      }
    } catch {
      // Skip unreadable files.
    }
  }
  const text = matches.map((m) => `${m.path}:${m.line}: ${m.text}`).join("\n") || "No matches.";
  return { text, matches, truncated: visibleMatches > matches.length, used: "node" };
}

export async function searchWorkspace(config: LocalWorkspaceBridgeConfig, guard: PathGuard, workspace: Workspace, rawOptions: Partial<SearchOptions>): Promise<SearchResult> {
  const query = rawOptions.symbol?.toString() || rawOptions.query?.toString() || "";
  if (!query) throw new LocalWorkspaceBridgeError("query is required.");
  const options: SearchOptions = {
    query,
    regex: Boolean(rawOptions.regex),
    root: rawOptions.root,
    glob: rawOptions.glob,
    includeHidden: Boolean(rawOptions.includeHidden),
    maxResults: Math.max(1, Math.min(rawOptions.maxResults ?? config.maxSearchResults, config.maxSearchResults)),
    multiline: Boolean(rawOptions.multiline),
    intent: rawOptions.intent,
    symbol: rawOptions.symbol,
    includeTests: rawOptions.includeTests
  };
  let lexical: SearchResult;
  try {
    lexical = await runRipgrep(config, guard, workspace, options);
  } catch (error) {
    if (options.regex) throw error;
    lexical = await runNodeSearch(config, guard, workspace, options);
  }
  const structuredRequested = rawOptions.intent !== undefined || rawOptions.symbol !== undefined || rawOptions.includeTests !== undefined;
  if (!structuredRequested) return lexical;
  if (!config.analysisEnabled) {
    lexical.analysis = {
      schemaVersion: 1,
      query,
      intent: rawOptions.intent && rawOptions.intent !== "auto" ? rawOptions.intent : "text",
      groups: { definitions: [], references: [], tests: [], configuration: [], documentation: [], other: [] },
      matches: [],
      coverage: { inventoryFiles: 0, analyzedFiles: 0, scannedBytes: 0, symbolCount: 0, relationshipCount: 0, truncated: true, warnings: ["Repository analysis is disabled by configuration."] },
      warnings: ["Repository analysis is disabled by configuration."],
      cache: { hit: false, key: "disabled" }
    };
    return lexical;
  }
  try {
    lexical.analysis = await searchWorkspaceStructured(config, guard, workspace, {
      query,
      intent: rawOptions.intent ?? "auto",
      includeTests: Boolean(rawOptions.includeTests),
      regex: Boolean(rawOptions.regex),
      root: options.root,
      maxResults: options.maxResults
    });
  } catch (error) {
    lexical.analysis = {
      schemaVersion: 1,
      query,
      intent: rawOptions.intent && rawOptions.intent !== "auto" ? rawOptions.intent : "text",
      groups: { definitions: [], references: [], tests: [], configuration: [], documentation: [], other: [] },
      matches: [],
      coverage: { inventoryFiles: 0, analyzedFiles: 0, scannedBytes: 0, symbolCount: 0, relationshipCount: 0, truncated: true, warnings: [] },
      warnings: [`Repository analysis unavailable: ${redactSensitiveText(error instanceof Error ? error.message : String(error))}`],
      cache: { hit: false, key: "unavailable" }
    };
  }
  return lexical;
}

export async function globWorkspace(
  config: LocalWorkspaceBridgeConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: { pattern: string; root?: string; includeHidden?: boolean; maxResults?: number }
): Promise<GlobResult> {
  const pattern = options.pattern?.trim();
  if (!pattern) throw new LocalWorkspaceBridgeError("pattern is required.");
  const maxResults = Math.max(1, Math.min(options.maxResults ?? config.maxSearchResults, config.maxSearchResults));
  const target = guard.resolve(workspace, options.root ?? ".");
  const stat = await fsp.stat(target.absPath);
  if (!stat.isDirectory()) throw new LocalWorkspaceBridgeError(`Glob root is not a directory: ${target.relPath}`);
  const args = ["--files", "--color=never"];
  if (options.includeHidden) args.push("--hidden");
  for (const blocked of config.blockedGlobs) args.push("-g", `!${blocked}`);
  args.push("-g", pattern, "--", target.absPath);

  return await new Promise((resolve, reject) => {
    const child = spawn(rgPath, args, { cwd: workspace.root, env: { ...process.env, NO_COLOR: "1" }, shell: false });
    let stdout = "";
    let stderr = "";
    let capped = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (capped) return;
      stdout += chunk;
      if (stdout.length > config.maxOutputBytes) {
        stdout = stdout.slice(0, config.maxOutputBytes);
        capped = true;
        child.kill("SIGTERM");
      }
    });
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-16_000); });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code && code > 1 && !capped) {
        reject(new LocalWorkspaceBridgeError(stderr.trim() || `ripgrep glob failed with exit code ${code}`));
        return;
      }
      const visible: string[] = [];
      let count = 0;
      for (const line of stdout.split(/\r?\n/)) {
        if (!line) continue;
        const absPath = path.isAbsolute(line) ? path.resolve(line) : path.resolve(workspace.root, line);
        const rel = path.relative(workspace.root, absPath).split(path.sep).join("/");
        if (rel.startsWith("..") || guard.isBlockedRelativePath(rel)) continue;
        count += 1;
        if (visible.length < maxResults) visible.push(rel);
      }
      visible.sort((a, b) => {
        try {
          return fs.statSync(path.join(workspace.root, b)).mtimeMs - fs.statSync(path.join(workspace.root, a)).mtimeMs;
        } catch {
          return a.localeCompare(b);
        }
      });
      resolve({
        text: visible.join("\n") || "No matches.",
        paths: visible,
        truncated: capped || count > visible.length,
        used: "ripgrep"
      });
    });
  });
}
