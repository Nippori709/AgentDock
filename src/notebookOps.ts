import fs from "node:fs";
import fsp from "node:fs/promises";
import type { LocalWorkspaceBridgeConfig } from "./config.js";
import type { Workspace } from "./guard.js";
import { LocalWorkspaceBridgeError, PathGuard } from "./guard.js";
import { makeUnifiedDiff, sha256 } from "./fsOps.js";
import { hasSecretValue, redactSensitiveText } from "./redact.js";

type NotebookCell = {
  id?: string;
  cell_type?: "code" | "markdown" | "raw" | string;
  source?: string | string[];
  outputs?: Array<Record<string, unknown>>;
  execution_count?: number | null;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
};

type Notebook = {
  cells?: NotebookCell[];
  nbformat?: number;
  nbformat_minor?: number;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
};

function sourceText(source: unknown): string {
  if (typeof source === "string") return source;
  if (Array.isArray(source)) return source.map(String).join("");
  return "";
}

function outputText(output: Record<string, unknown>): string {
  const type = String(output.output_type ?? "");
  if (type === "stream") return sourceText(output.text);
  if (type === "error") {
    const traceback = Array.isArray(output.traceback) ? output.traceback.map(String).join("\n") : "";
    const message = [output.ename, output.evalue].filter(Boolean).map(String).join(": ");
    return [message, traceback].filter(Boolean).join("\n");
  }
  const data = output.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const record = data as Record<string, unknown>;
    for (const key of ["text/plain", "text/markdown", "text/html"]) {
      if (record[key] !== undefined) return sourceText(record[key]);
    }
    const imageKeys = ["image/png", "image/jpeg", "image/svg+xml"].filter((key) => record[key] !== undefined);
    if (imageKeys.length) return `[rich output: ${imageKeys.join(", ")}]`;
  }
  return "";
}

async function loadNotebook(
  config: LocalWorkspaceBridgeConfig,
  guard: PathGuard,
  workspace: Workspace,
  filePath: string
): Promise<{ resolved: ReturnType<PathGuard["resolve"]>; raw: string; notebook: Notebook }> {
  const resolved = guard.resolve(workspace, filePath);
  await guard.assertTextFile(resolved.absPath, Math.max(config.maxReadBytes * 8, config.maxWriteBytes));
  const raw = await fsp.readFile(resolved.absPath, "utf8");
  let notebook: Notebook;
  try {
    notebook = JSON.parse(raw) as Notebook;
  } catch {
    throw new LocalWorkspaceBridgeError(`Invalid Jupyter notebook JSON: ${resolved.relPath}`);
  }
  if (!Array.isArray(notebook.cells)) throw new LocalWorkspaceBridgeError(`Notebook has no cells array: ${resolved.relPath}`);
  return { resolved, raw, notebook };
}

export async function readNotebook(
  config: LocalWorkspaceBridgeConfig,
  guard: PathGuard,
  workspace: Workspace,
  filePath: string
): Promise<{ path: string; text: string; cellCount: number; sha256: string; cells: Array<Record<string, unknown>> }> {
  const { resolved, raw, notebook } = await loadNotebook(config, guard, workspace, filePath);
  const cells = (notebook.cells ?? []).map((cell, index) => {
    const outputs = Array.isArray(cell.outputs)
      ? cell.outputs.map((output) => redactSensitiveText(outputText(output))).filter(Boolean)
      : [];
    return {
      index,
      id: cell.id ?? null,
      cell_type: cell.cell_type ?? "unknown",
      execution_count: cell.execution_count ?? null,
      source: redactSensitiveText(sourceText(cell.source)),
      outputs
    };
  });
  const text = cells.map((cell) => {
    const header = `Cell ${Number(cell.index) + 1}${cell.id ? ` [${cell.id}]` : ""} (${cell.cell_type})`;
    const body = String(cell.source ?? "");
    const outputs = Array.isArray(cell.outputs) && cell.outputs.length
      ? `\nOutputs:\n${cell.outputs.map((value) => String(value)).join("\n")}`
      : "";
    return `${header}\n${body}${outputs}`;
  }).join("\n\n");
  return { path: resolved.relPath, text: text || "(empty notebook)", cellCount: cells.length, sha256: sha256(raw), cells };
}

export async function editNotebook(
  config: LocalWorkspaceBridgeConfig,
  guard: PathGuard,
  workspace: Workspace,
  filePath: string,
  options: {
    newSource?: string;
    cellId?: string;
    cellIndex?: number;
    cellType?: "code" | "markdown";
    editMode?: "replace" | "insert" | "delete";
    expectedSha256?: string;
  }
): Promise<{ path: string; mode: string; cellIndex: number; cellId?: string; sha256: string; diff: ReturnType<typeof makeUnifiedDiff> }> {
  const { resolved, raw, notebook } = await loadNotebook(config, guard, workspace, filePath);
  if (options.expectedSha256 && sha256(raw) !== options.expectedSha256) {
    throw new LocalWorkspaceBridgeError("Notebook changed since read (expected_sha256 mismatch). Read it again before retrying.");
  }

  const cells = notebook.cells ?? [];
  const mode = options.editMode ?? "replace";
  let index = Number.isInteger(options.cellIndex) ? Number(options.cellIndex) : -1;
  if (options.cellId) index = cells.findIndex((cell) => cell.id === options.cellId);

  if (mode === "insert") {
    const insertAt = index < 0 ? cells.length : Math.max(0, Math.min(index, cells.length));
    const cell: NotebookCell = {
      cell_type: options.cellType ?? "code",
      metadata: {},
      source: options.newSource ?? ""
    };
    if (cell.cell_type === "code") {
      cell.execution_count = null;
      cell.outputs = [];
    }
    cells.splice(insertAt, 0, cell);
    index = insertAt;
  } else {
    if (index < 0 || index >= cells.length) {
      throw new LocalWorkspaceBridgeError("NotebookEdit requires a valid cell_id or zero-based cell_index for replace/delete.");
    }
    if (mode === "delete") {
      cells.splice(index, 1);
    } else {
      cells[index].source = options.newSource ?? "";
      if (options.cellType) cells[index].cell_type = options.cellType;
    }
  }

  notebook.cells = cells;
  const next = `${JSON.stringify(notebook, null, 1)}\n`;
  if (Buffer.byteLength(next, "utf8") > config.maxWriteBytes) {
    throw new LocalWorkspaceBridgeError(`Edited notebook exceeds max write size (${config.maxWriteBytes} bytes).`);
  }
  if (hasSecretValue(next)) throw new LocalWorkspaceBridgeError("Secret-looking notebook content is blocked from write.");

  const diff = makeUnifiedDiff(raw, next, resolved.relPath);
  guard.resolve(workspace, filePath, { forWrite: true });
  if (fs.readFileSync(resolved.absPath, "utf8") !== raw) {
    throw new LocalWorkspaceBridgeError("Notebook changed during edit. Read it again before retrying.");
  }
  fs.writeFileSync(resolved.absPath, next, "utf8");
  const edited = mode === "delete" ? undefined : cells[index];
  return {
    path: resolved.relPath,
    mode,
    cellIndex: index,
    cellId: edited?.id,
    sha256: sha256(next),
    diff
  };
}
