import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { LocalWorkspaceBridgeConfig } from "./config.js";
import type { Workspace } from "./guard.js";
import { PathGuard } from "./guard.js";
import { readTextFile, repoTree } from "./fsOps.js";
import { gitLog, gitStatus } from "./gitOps.js";
import { discoverSkillInventory } from "./capabilitiesOps.js";
import type { SkillInventoryItem } from "./capabilitiesOps.js";

export interface WorkspaceSummary {
  text: string;
  workspaceId: string;
  root: string;
  agentsLoaded: boolean;
  agentsPath?: string;
  skills: string[];
  skillInventory: SkillInventoryItem[];
  skillCounts: Record<string, number>;
  tree?: string;
  gitStatus: string;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

async function safeReaddir(dir: string): Promise<fs.Dirent[]> {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

export async function discoverSkills(workspace: Workspace, options: { includeGlobal?: boolean } = {}): Promise<string[]> {
  const candidateDirs = unique([
    path.join(workspace.root, ".codex", "skills"),
    path.join(workspace.root, "skills"),
    ...(options.includeGlobal
      ? [path.join(os.homedir(), ".codex", "skills"), path.join(os.homedir(), ".chatgpt", "skills")]
      : [])
  ]);
  const skills: string[] = [];
  for (const dir of candidateDirs) {
    const entries = await safeReaddir(dir);
    for (const entry of entries) {
      if (entry.isDirectory()) skills.push(entry.name);
      else if (entry.isFile() && entry.name.endsWith(".md")) skills.push(entry.name.replace(/\.md$/, ""));
    }
  }
  return unique(skills).sort((a, b) => a.localeCompare(b));
}

function skillCounts(skills: Array<{ source?: string }>): Record<string, number> {
  const counts: Record<string, number> = { total: skills.length, workspace: 0, user: 0, plugin: 0, other: 0 };
  for (const skill of skills) {
    const source = skill.source ?? "other";
    counts[source] = (counts[source] ?? 0) + 1;
  }
  return counts;
}

async function findAgentsFile(workspace: Workspace): Promise<string | undefined> {
  const [first] = await findAgentsFilesInDir(workspace, ".");
  return first;
}

function candidateAgentDirs(targetPath: string): string[] {
  const normalized = targetPath.split(path.sep).join("/").replace(/^\.\//, "");
  const parts = normalized && normalized !== "." ? normalized.split("/").filter(Boolean) : [];
  const dirs = [""];
  const directoryParts = parts.length > 0 && parts.at(-1)?.includes(".") ? parts.slice(0, -1) : parts;
  for (let i = 0; i < directoryParts.length; i += 1) {
    dirs.push(directoryParts.slice(0, i + 1).join("/"));
  }
  return [...new Set(dirs)];
}

async function findAgentsFilesInDir(workspace: Workspace, dir: string): Promise<string[]> {
  const names = ["AGENTS.override.md", "AGENTS.md", "agents.md", ".agents.md"];
  const absDir = path.join(workspace.root, dir);
  const entries = await safeReaddir(absDir);
  const files = entries.filter((entry) => entry.isFile());
  const out: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const entry =
      files.find((item) => item.name === name) ??
      files.find((item) => item.name.toLowerCase() === name.toLowerCase());
    if (!entry) continue;
    const rel = dir && dir !== "." ? `${dir}/${entry.name}` : entry.name;
    const real = fs.realpathSync(path.join(workspace.root, rel)).toLowerCase();
    if (seen.has(real)) continue;
    seen.add(real);
    out.push(rel);
  }
  return out;
}

async function readAgentsChain(
  config: LocalWorkspaceBridgeConfig,
  guard: PathGuard,
  workspace: Workspace,
  targetPath: string,
  maxBytes: number
): Promise<{ text: string; files: string[] }> {
  const chunks: string[] = [];
  const files: string[] = [];
  const seenRealPaths = new Set<string>();
  const candidates = (
    await Promise.all(candidateAgentDirs(targetPath).map((dir) => findAgentsFilesInDir(workspace, dir || ".")))
  ).flat();
  for (const rel of candidates) {
    try {
      const resolved = guard.resolve(workspace, rel);
      if (!fs.existsSync(resolved.absPath)) continue;
      const real = fs.realpathSync(resolved.absPath).toLowerCase();
      if (seenRealPaths.has(real)) continue;
      seenRealPaths.add(real);
      const agents = await readTextFile(config, guard, workspace, rel, { maxBytes });
      chunks.push(`--- ${rel} ---\n${agents.text}`);
      files.push(rel);
    } catch (error) {
      chunks.push(`--- ${rel} ---\n[unreadable: ${error instanceof Error ? error.message : String(error)}]`);
      files.push(rel);
    }
  }
  return {
    text: chunks.length ? chunks.join("\n\n") : "No AGENTS.md-style instruction files found for this target path.",
    files
  };
}

export async function workspaceSummary(
  config: LocalWorkspaceBridgeConfig,
  guard: PathGuard,
  workspace: Workspace,
  options: { includeTree?: boolean; maxDepth?: number; maxEntries?: number; includeSkills?: boolean; includeGlobalSkills?: boolean } = {}
): Promise<WorkspaceSummary> {
  const skillInventory = options.includeSkills
    ? await discoverSkillInventory(workspace, { includeGlobal: options.includeGlobalSkills !== false, maxSkills: 20 })
    : [];
  const skills = skillInventory.map((skill) => skill.name);
  const counts = skillCounts(skillInventory);
  const agentsPath = await findAgentsFile(workspace);
  let agentsText = "AGENTS.md: none loaded";
  if (agentsPath) {
    agentsText = `AGENTS.md: ${agentsPath} (read this file before editing or making project decisions).`;
  }

  let treeText: string | undefined;
  if (options.includeTree !== false) {
    const tree = await repoTree(config, guard, workspace, {
      path: ".",
      maxDepth: Math.max(1, Math.min(options.maxDepth ?? 3, 8)),
      includeHidden: false,
      maxEntries: Math.max(1, Math.min(options.maxEntries ?? 500, 3000))
    });
    treeText = tree.text;
  }

  const status = gitStatus(config, workspace);
  const log = gitLog(config, workspace, 5);
  const skillText = options.includeSkills
    ? `Skills: ${counts.total} total (${counts.workspace ?? 0} workspace, ${counts.user ?? 0} user, ${counts.plugin ?? 0} plugin, ${counts.other ?? 0} other).`
    : "Skills: skipped. Pass include_skills=true if skill discovery is needed.";
  const text = `# Workspace\n\nWorkspace: ${workspace.id}\nRoot: ${workspace.root}\nBash mode: ${config.bashMode}\nWrite mode: ${config.writeMode}\nTool mode: ${config.toolMode}\n\n${agentsText}\n${skillText}\n\n## Git status\n\n${status}\n\n## Recent commits\n\n${log}\n${treeText ? `\n## Files\n\n${treeText}` : ""}`;

  return {
    text,
    workspaceId: workspace.id,
    root: workspace.root,
    agentsLoaded: Boolean(agentsPath),
    agentsPath,
    skills,
    skillInventory,
    skillCounts: counts,
    tree: treeText,
    gitStatus: status
  };
}

