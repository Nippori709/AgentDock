import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import createIgnore, { type Ignore } from "ignore";
import type { LocalWorkspaceBridgeConfig } from "../config.js";
import { listFiles, textScanByteLimit } from "../fsOps.js";
import type { PathGuard, Workspace } from "../guard.js";
import { classifyFileRole, classifyLanguage, isEntrypoint, isGeneratedFile } from "./classify.js";
import type { InventoryFile, InventoryResult } from "./types.js";

async function analysisIgnoreMatchers(workspace: Workspace, configured: string[]): Promise<{ configured: Ignore; git: Ignore }> {
  const configuredMatcher = createIgnore().add(configured);
  const gitMatcher = createIgnore();
  try {
    const text = await fsp.readFile(path.join(workspace.root, ".gitignore"), "utf8");
    gitMatcher.add(text);
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
  }
  return { configured: configuredMatcher, git: gitMatcher };
}

function addManifestPath(paths: Set<string>, value: unknown): void {
  if (typeof value === "string") {
    const normalized = value.replaceAll("\\", "/").replace(/^\.\//, "").split(/[?#]/, 1)[0];
    if (/\.(?:[cm]?[jt]sx?|py)$/i.test(normalized)) {
      paths.add(normalized);
      const builtTypeScript = normalized.match(/^dist\/(.+)\.(?:mjs|cjs|js)$/i);
      if (builtTypeScript) {
        for (const extension of ["ts", "tsx", "mts", "cts"]) paths.add(`src/${builtTypeScript[1]}.${extension}`);
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) addManifestPath(paths, item);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) addManifestPath(paths, item);
  }
}

async function manifestEntrypoints(workspace: Workspace): Promise<Set<string>> {
  const entrypoints = new Set<string>();
  try {
    const pkg = JSON.parse(await fsp.readFile(path.join(workspace.root, "package.json"), "utf8")) as Record<string, unknown>;
    addManifestPath(entrypoints, pkg.bin);
    addManifestPath(entrypoints, pkg.main);
    addManifestPath(entrypoints, pkg.exports);
    const scripts = pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts as Record<string, unknown> : {};
    for (const name of ["start", "dev"]) {
      const command = scripts[name];
      if (typeof command !== "string") continue;
      for (const match of command.matchAll(/(?:^|\s)([^\s"']+\.(?:[cm]?[jt]sx?|py))(?:\s|$)/gi)) addManifestPath(entrypoints, match[1]);
    }
  } catch {
    // Missing or malformed manifests do not prevent bounded heuristic analysis.
  }
  try {
    const pyproject = await fsp.readFile(path.join(workspace.root, "pyproject.toml"), "utf8");
    let inScripts = false;
    for (const rawLine of pyproject.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (/^\[/.test(line)) inScripts = line === "[project.scripts]";
      else if (inScripts) {
        const match = line.match(/^[^#=]+?=\s*["']([A-Za-z_][\w.]*)(?::[\w.]+)?["']/);
        if (match) {
          const modulePath = match[1].replaceAll(".", "/");
          for (const candidate of [`${modulePath}.py`, `${modulePath}/__main__.py`]) entrypoints.add(candidate);
        }
      }
    }
  } catch {
    // pyproject.toml is optional.
  }
  return entrypoints;
}

export async function inventoryWorkspace(config: LocalWorkspaceBridgeConfig, guard: PathGuard, workspace: Workspace): Promise<InventoryResult> {
  const maxFiles = config.analysisLimits.maxInventoryFiles;
  const declaredPaths = await manifestEntrypoints(workspace);
  const ignoreMatchers = await analysisIgnoreMatchers(workspace, config.analysisIgnoreGlobs);
  const isDeclaredPath = (relPath: string, isDirectory: boolean): boolean =>
    declaredPaths.has(relPath) || (isDirectory && [...declaredPaths].some((entry) => entry.startsWith(`${relPath}/`)));
  const candidates = await listFiles(guard, workspace, {
    root: ".", includeHidden: true, maxFiles: maxFiles + 1,
    ignore: (relPath, isDirectory) => {
      if (isDeclaredPath(relPath, isDirectory)) return false;
      const pathname = isDirectory ? `${relPath}/` : relPath;
      return ignoreMatchers.configured.ignores(pathname) || ignoreMatchers.git.ignores(pathname);
    }
  });
  const truncated = candidates.length > maxFiles;
  const files: InventoryFile[] = [];

  for (const candidate of candidates.slice(0, maxFiles)) {
    try {
      const resolved = guard.resolve(workspace, candidate);
      const stat = await fsp.stat(resolved.absPath);
      if (!stat.isFile()) continue;
      await guard.assertTextFile(resolved.absPath, textScanByteLimit(config));
      const language = classifyLanguage(resolved.relPath);
      files.push({
        path: resolved.relPath,
        bytes: stat.size,
        modifiedMs: stat.mtimeMs,
        language,
        role: classifyFileRole(resolved.relPath, language),
        generated: isGeneratedFile(resolved.relPath),
        entrypoint: isEntrypoint(resolved.relPath)
      });
    } catch {
      // Blocked, escaping, unreadable, binary, and oversized files are absent by design.
    }
  }

  const available = new Set(files.map((file) => file.path));
  const declaredEntrypoints = new Set([...declaredPaths].filter((entry) => available.has(entry)));
  for (const file of files) {
    file.entrypoint = declaredEntrypoints.has(file.path) || (!declaredEntrypoints.size && isEntrypoint(file.path));
  }

  files.sort((a, b) => a.path.localeCompare(b.path));
  const fingerprint = createHash("sha256")
    .update(files.map((file) => `${file.path}:${file.bytes}:${file.modifiedMs}`).join("\n"))
    .digest("hex");
  const warnings = truncated ? [`Inventory truncated at ${maxFiles} files.`] : [];
  return {
    files,
    fingerprint,
    coverage: {
      inventoryFiles: files.length,
      analyzedFiles: 0,
      scannedBytes: 0,
      symbolCount: 0,
      relationshipCount: 0,
      truncated,
      warnings
    }
  };
}
