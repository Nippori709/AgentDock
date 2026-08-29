import fs from "node:fs";
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { minimatch } from "minimatch";
import type { LocalWorkspaceBridgeConfig } from "./config.js";
import { expandHome } from "./config.js";

export interface Workspace {
  id: string;
  root: string;
  openedAt: string;
  lastUsedAt: string;
}

export class LocalWorkspaceBridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalWorkspaceBridgeError";
  }
}

export function isSubpath(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function normalizeRelPath(relPath: string): string {
  const normalized = relPath.split(path.sep).join("/");
  if (normalized === "") return ".";
  return normalized;
}

export function displayPath(absPath: string, root: string): string {
  const rel = path.relative(root, absPath) || ".";
  return normalizeRelPath(rel);
}

function workspaceIdForRoot(realRoot: string): string {
  return `ws_${createHash("sha256").update(realRoot).digest("hex").slice(0, 24)}`;
}

function maybeRealpath(existingPath: string): string | undefined {
  try {
    return fs.realpathSync(existingPath);
  } catch {
    return undefined;
  }
}

function closestExistingParent(absPath: string): string {
  let current = path.resolve(absPath);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

export class WorkspaceManager {
  private readonly workspaces = new Map<string, Workspace>();
  private activeWorkspaceId?: string;
  private selectedDefaultWorkspaceId?: string;

  constructor(private readonly config: LocalWorkspaceBridgeConfig) {}

  defaultWorkspace(): Workspace {
    const selected = this.selectedDefaultWorkspaceId ? this.workspaces.get(this.selectedDefaultWorkspaceId) : undefined;
    const workspace = selected ?? [...this.workspaces.values()].find((item) => item.root === this.config.defaultRoot) ?? this.openWorkspace(this.config.defaultRoot);
    return this.touch(workspace);
  }

  openWorkspace(rootInput?: string): Workspace {
    const requested = rootInput?.trim() ? expandHome(rootInput.trim()) : this.config.defaultRoot;
    const resolved = path.resolve(requested);
    if (!fs.existsSync(resolved)) {
      throw new LocalWorkspaceBridgeError(`Workspace root does not exist: ${resolved}`);
    }
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      throw new LocalWorkspaceBridgeError(`Workspace root is not a directory: ${resolved}`);
    }
    const realRoot = fs.realpathSync(resolved);
    const allowed = this.config.allowedRoots.some((allowedRoot) => isSubpath(realRoot, allowedRoot));
    if (!allowed) {
      throw new LocalWorkspaceBridgeError(
        `Workspace root is outside allowed roots: ${realRoot}\nAllowed roots:\n${this.config.allowedRoots.map((r) => `- ${r}`).join("\n")}`
      );
    }

    const existing = [...this.workspaces.values()].find((workspace) => workspace.root === realRoot);
    if (existing) return this.touch(existing);

    const id = workspaceIdForRoot(realRoot);
    const now = new Date().toISOString();
    const workspace = { id, root: realRoot, openedAt: now, lastUsedAt: now };
    this.workspaces.set(id, workspace);
    return this.touch(workspace);
  }

  getWorkspace(id?: string): Workspace {
    if (!id) {
      const active = this.activeWorkspaceId ? this.workspaces.get(this.activeWorkspaceId) : undefined;
      return active ? this.touch(active) : this.defaultWorkspace();
    }
    const workspace = this.workspaces.get(id);
    if (!workspace) {
      throw new LocalWorkspaceBridgeError(`Unknown workspace_id: ${id}. Call open_workspace first.`);
    }
    return this.touch(workspace);
  }

  listWorkspaces(): Workspace[] {
    return [...this.workspaces.values()];
  }

  activeWorkspaceIdValue(): string | undefined {
    return this.activeWorkspaceId;
  }

  defaultWorkspaceIdValue(): string | undefined {
    const selected = this.selectedDefaultWorkspaceId ? this.workspaces.get(this.selectedDefaultWorkspaceId) : undefined;
    const configured = [...this.workspaces.values()].find((item) => item.root === this.config.defaultRoot);
    return (selected ?? configured)?.id;
  }

  setDefaultWorkspace(id: string): Workspace {
    const workspace = this.workspaces.get(id);
    if (!workspace) throw new LocalWorkspaceBridgeError(`Unknown workspace_id: ${id}. Call open_workspace first.`);
    this.selectedDefaultWorkspaceId = id;
    return this.touch(workspace);
  }

  closeWorkspace(id: string): Workspace {
    const workspace = this.workspaces.get(id);
    if (!workspace) throw new LocalWorkspaceBridgeError(`Unknown workspace_id: ${id}.`);
    this.workspaces.delete(id);
    if (this.activeWorkspaceId === id) this.activeWorkspaceId = undefined;
    if (this.selectedDefaultWorkspaceId === id) this.selectedDefaultWorkspaceId = undefined;
    return workspace;
  }

  private touch(workspace: Workspace): Workspace {
    workspace.lastUsedAt = new Date().toISOString();
    this.activeWorkspaceId = workspace.id;
    return workspace;
  }
}

export class PathGuard {
  constructor(private readonly config: LocalWorkspaceBridgeConfig) {}

  isBlockedRelativePath(relPath: string): boolean {
    const rel = normalizeRelPath(relPath).replace(/^\.\//, "");
    if (!rel || rel === ".") return false;
    return this.config.blockedGlobs.some((glob) =>
      minimatch(rel, glob, { dot: true, nocase: false, matchBase: false }) ||
      minimatch(path.basename(rel), glob, { dot: true, nocase: false, matchBase: true })
    );
  }

  assertNotBlocked(relPath: string): void {
    if (this.isBlockedRelativePath(relPath)) {
      throw new LocalWorkspaceBridgeError(`Path is blocked by safety rules: ${relPath}`);
    }
  }

  resolve(workspace: Workspace, inputPath = ".", options: { forWrite?: boolean } = {}): { absPath: string; relPath: string } {
    const expanded = expandHome(inputPath || ".");
    const candidate = path.isAbsolute(expanded) ? expanded : path.join(workspace.root, expanded);
    let absPath = path.resolve(candidate);
    const realTarget = maybeRealpath(absPath);
    let relPath = displayPath(absPath, workspace.root);

    if (!isSubpath(absPath, workspace.root)) {
      if (realTarget && isSubpath(realTarget, workspace.root)) {
        absPath = realTarget;
        relPath = displayPath(realTarget, workspace.root);
      } else if (options.forWrite) {
        const parent = closestExistingParent(path.dirname(absPath));
        const realParent = maybeRealpath(parent);
        if (!realParent || !isSubpath(realParent, workspace.root)) {
          throw new LocalWorkspaceBridgeError(`Path escapes workspace root: ${inputPath}`);
        }
        absPath = path.resolve(realParent, path.relative(parent, absPath));
        relPath = displayPath(absPath, workspace.root);
      } else {
        throw new LocalWorkspaceBridgeError(`Path escapes workspace root: ${inputPath}`);
      }
    }

    this.assertNotBlocked(relPath);

    if (realTarget) {
      if (!isSubpath(realTarget, workspace.root)) {
        throw new LocalWorkspaceBridgeError(`Path resolves outside workspace root through a symlink: ${inputPath}`);
      }
      const realRel = displayPath(realTarget, workspace.root);
      this.assertNotBlocked(realRel);
    }

    if (options.forWrite) {
      try {
        if (fs.lstatSync(absPath).isSymbolicLink()) {
          throw new LocalWorkspaceBridgeError(`Refusing to write through a symlink: ${inputPath}`);
        }
      } catch (error) {
        if (error instanceof LocalWorkspaceBridgeError) throw error;
      }
      const parent = closestExistingParent(path.dirname(absPath));
      const realParent = maybeRealpath(parent);
      if (realParent && !isSubpath(realParent, workspace.root)) {
        throw new LocalWorkspaceBridgeError(`Write path resolves through a parent outside the workspace: ${inputPath}`);
      }
      if (realParent) {
        const realParentRel = displayPath(realParent, workspace.root);
        this.assertNotBlocked(realParentRel);
      }
    }

    return { absPath, relPath };
  }

  async assertTextFile(absPath: string, maxBytes: number): Promise<void> {
    const stat = await fsp.stat(absPath);
    if (!stat.isFile()) {
      throw new LocalWorkspaceBridgeError(`Not a file: ${absPath}`);
    }
    if (stat.size > maxBytes) {
      throw new LocalWorkspaceBridgeError(`File is too large (${stat.size} bytes). Limit: ${maxBytes} bytes.`);
    }
    if (stat.size === 0) return;
    const handle = await fsp.open(absPath, "r");
    try {
      const sample = Buffer.alloc(Math.min(64 * 1024, stat.size));
      let offset = 0;
      while (offset < stat.size) {
        const { bytesRead } = await handle.read(sample, 0, sample.length, offset);
        if (bytesRead === 0) break;
        if (sample.subarray(0, bytesRead).includes(0)) {
          throw new LocalWorkspaceBridgeError("Refusing to read binary file.");
        }
        offset += bytesRead;
      }
    } finally {
      await handle.close();
    }
  }
}

export function userHome(): string {
  return os.homedir();
}
