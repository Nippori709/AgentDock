import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { LocalWorkspaceBridgeConfig } from "./config.js";
import type { Workspace } from "./guard.js";
import { isSubpath, LocalWorkspaceBridgeError } from "./guard.js";
import { redactSensitiveText } from "./redact.js";

export interface WorktreeInfo {
  path: string;
  head?: string;
  branch?: string;
  bare?: boolean;
  detached?: boolean;
  prunable?: boolean;
}

function runGit(workspaceRoot: string, args: string[], maxBytes: number): string {
  const result = spawnSync("git", args, {
    cwd: workspaceRoot,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: maxBytes
  });
  if (result.error) throw new LocalWorkspaceBridgeError(`git failed: ${result.error.message}`);
  if (result.status !== 0) {
    throw new LocalWorkspaceBridgeError(redactSensitiveText(result.stderr?.trim() || result.stdout?.trim() || `git exited ${result.status}`));
  }
  return redactSensitiveText(result.stdout ?? "");
}

function assertAllowed(config: LocalWorkspaceBridgeConfig, absolute: string): string {
  const resolved = path.resolve(absolute);
  let current = fs.existsSync(resolved) ? resolved : path.dirname(resolved);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const canonical = fs.existsSync(current) ? fs.realpathSync(current) : path.resolve(current);
  if (!config.allowedRoots.some((root) => {
    try {
      const allowed = fs.realpathSync(root);
      return isSubpath(canonical, allowed) || sameExistingLocation(current, allowed);
    } catch { return false; }
  })) {
    throw new LocalWorkspaceBridgeError(`Worktree path is outside allowed roots: ${resolved}`);
  }
  return resolved;
}

function canonicalExistingPath(filePath: string): string {
  const resolved = path.resolve(filePath);
  return fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
}

function sameExistingLocation(left: string, right: string): boolean {
  try {
    // Compare filesystem identity instead of spelling. On Windows, 8.3 short
    // names may refer to the same directory as their long-path equivalents.
    const a = fs.statSync(left, { bigint: true });
    const b = fs.statSync(right, { bigint: true });
    if (a.ino > 0n && a.dev === b.dev && a.ino === b.ino) return true;
  } catch { /* Some paths may no longer exist; fall back to canonical spelling. */ }
  const a = canonicalExistingPath(left);
  const b = canonicalExistingPath(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function safeName(input: string): string {
  const name = input.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!name) throw new LocalWorkspaceBridgeError("Worktree name must contain letters, numbers, dot, underscore, or dash.");
  return name.slice(0, 80);
}

export function listWorktrees(config: LocalWorkspaceBridgeConfig, workspace: Workspace): WorktreeInfo[] {
  const output = runGit(workspace.root, ["worktree", "list", "--porcelain"], config.maxOutputBytes);
  const result: WorktreeInfo[] = [];
  let current: WorktreeInfo | undefined;
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line) {
      if (current) result.push(current);
      current = undefined;
      continue;
    }
    const [key, ...rest] = line.split(" ");
    const value = rest.join(" ");
    if (key === "worktree") current = { path: value };
    else if (!current) continue;
    else if (key === "HEAD") current.head = value;
    else if (key === "branch") current.branch = value.replace(/^refs\/heads\//, "");
    else if (key === "bare") current.bare = true;
    else if (key === "detached") current.detached = true;
    else if (key === "prunable") current.prunable = true;
  }
  if (current) result.push(current);
  return result;
}

export function createWorktree(
  config: LocalWorkspaceBridgeConfig,
  workspace: Workspace,
  options: { name: string; path?: string; branch?: string; startPoint?: string; detach?: boolean }
): WorktreeInfo {
  const name = safeName(options.name);
  const target = assertAllowed(
    config,
    options.path?.trim()
      ? (path.isAbsolute(options.path) ? options.path : path.resolve(workspace.root, options.path))
      : path.resolve(path.dirname(workspace.root), `${path.basename(workspace.root)}-worktrees`, name)
  );
  if (fs.existsSync(target)) throw new LocalWorkspaceBridgeError(`Worktree target already exists: ${target}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });

  const args = ["worktree", "add"];
  if (options.detach) args.push("--detach");
  else if (options.branch?.trim()) args.push("-b", options.branch.trim());
  args.push(target);
  if (options.startPoint?.trim()) args.push(options.startPoint.trim());
  runGit(workspace.root, args, config.maxOutputBytes);

  const real = fs.realpathSync(target);
  return listWorktrees(config, workspace).find((item) => sameExistingLocation(item.path, real))
    ?? { path: real, branch: options.branch };
}

export function removeWorktree(
  config: LocalWorkspaceBridgeConfig,
  workspace: Workspace,
  targetPath: string,
  force = false
): WorktreeInfo {
  const target = assertAllowed(config, path.isAbsolute(targetPath) ? targetPath : path.resolve(workspace.root, targetPath));
  const known = listWorktrees(config, workspace).find((item) => sameExistingLocation(item.path, target));
  if (!known) throw new LocalWorkspaceBridgeError(`Not a registered git worktree: ${target}`);
  if (sameExistingLocation(known.path, workspace.root)) {
    throw new LocalWorkspaceBridgeError("Refusing to remove the current primary workspace.");
  }
  runGit(workspace.root, ["worktree", "remove", ...(force ? ["--force"] : []), known.path], config.maxOutputBytes);
  return known;
}
