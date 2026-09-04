import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { Workspace } from "./guard.js";
import { LocalWorkspaceBridgeError, PathGuard } from "./guard.js";
import { nativeImageResult } from "./mediaUtils.js";

export const MAX_DOCUMENT_BYTES = 100 * 1024 * 1024;
export const MAX_DOCUMENT_TEXT_BYTES = 60_000;
export const MAX_PDF_PAGE_OUTPUT_BYTES = 3 * 1024 * 1024;
export const DEFAULT_PDF_PAGE_DIMENSION = 1800;
export const MAX_PDF_PAGE_DIMENSION = 2400;

const DOCUMENT_WORKER = fileURLToPath(new URL("../scripts/document-worker.py", import.meta.url));
const execFileAsync = promisify(execFile);

interface DocumentSource {
  relPath: string;
  absPath: string;
  bytes: number;
}

export interface PdfTextResult {
  path: string;
  bytes: number;
  pageCount: number;
  startPage: number;
  endPage: number;
  requestedEndPage: number;
  nextPage?: number;
  bytesReturned: number;
  truncated: boolean;
  text: string;
}

export interface DocxTextResult {
  path: string;
  bytes: number;
  totalLines: number;
  startLine: number;
  endLine: number;
  requestedEndLine: number;
  nextLine?: number;
  bytesReturned: number;
  truncated: boolean;
  text: string;
}

function defaultPython(): string {
  return process.platform === "win32" ? "python" : "python3";
}

function formatMiB(bytes: number): string {
  return `${Math.round((bytes / (1024 * 1024)) * 100) / 100} MiB`;
}

async function readPrefix(filePath: string, bytes: number): Promise<Buffer> {
  const handle = await fsp.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function loadDocumentSource(
  guard: PathGuard,
  workspace: Workspace,
  filePath: string,
  expectedExtension: ".pdf" | ".docx"
): Promise<DocumentSource> {
  const resolved = guard.resolve(workspace, filePath);
  const extension = path.extname(resolved.relPath).toLowerCase();
  if (extension !== expectedExtension) {
    throw new LocalWorkspaceBridgeError(`Expected a ${expectedExtension} file, got ${extension || "(no extension)"}.`);
  }

  const stat = await fsp.stat(resolved.absPath);
  if (!stat.isFile()) throw new LocalWorkspaceBridgeError(`Not a file: ${resolved.relPath}`);
  if (stat.size > MAX_DOCUMENT_BYTES) {
    throw new LocalWorkspaceBridgeError(`Document is too large (${stat.size} bytes). Limit: ${MAX_DOCUMENT_BYTES} bytes (${formatMiB(MAX_DOCUMENT_BYTES)}).`);
  }

  const prefix = await readPrefix(resolved.absPath, 8);
  if (expectedExtension === ".pdf" && prefix.subarray(0, 5).toString("ascii") !== "%PDF-") {
    throw new LocalWorkspaceBridgeError("File extension is .pdf, but the file does not have a PDF signature.");
  }
  if (expectedExtension === ".docx" && !(prefix[0] === 0x50 && prefix[1] === 0x4b)) {
    throw new LocalWorkspaceBridgeError("File extension is .docx, but the file does not look like a ZIP/OOXML package.");
  }

  return { relPath: resolved.relPath, absPath: resolved.absPath, bytes: stat.size };
}

async function runDocumentWorker(python: string, args: string[], maxBuffer = 8 * 1024 * 1024): Promise<Buffer> {
  try {
    const output = await execFileAsync(python, [DOCUMENT_WORKER, ...args], {
      encoding: "buffer",
      windowsHide: true,
      timeout: 30_000,
      maxBuffer,
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" }
    });
    return output.stdout;
  } catch (error) {
    const value = error as NodeJS.ErrnoException & { stderr?: Buffer | string };
    let detail = "";
    try {
      const parsed = JSON.parse(Buffer.isBuffer(value.stderr) ? value.stderr.toString("utf8") : String(value.stderr ?? ""));
      detail = typeof parsed.error === "string" ? parsed.error : "";
    } catch {}
    if (value.code === "ENOENT") throw new LocalWorkspaceBridgeError(`Document Python executable was not found: ${python}.`);
    throw new LocalWorkspaceBridgeError(detail || "Document processing failed. Verify that the file is valid and PyMuPDF is installed for PDF support.");
  }
}

function parseWorkerJson<T>(output: Buffer, kind: string): T {
  try {
    return JSON.parse(output.toString("utf8")) as T;
  } catch {
    throw new LocalWorkspaceBridgeError(`Document worker returned invalid ${kind} metadata.`);
  }
}

export async function readPdfText(
  guard: PathGuard,
  workspace: Workspace,
  filePath: string,
  options: { startPage?: number; endPage?: number; maxBytes?: number; python?: string } = {}
): Promise<PdfTextResult> {
  const source = await loadDocumentSource(guard, workspace, filePath, ".pdf");
  const maxBytes = Math.max(1000, Math.min(options.maxBytes ?? MAX_DOCUMENT_TEXT_BYTES, MAX_DOCUMENT_TEXT_BYTES));
  const output = await runDocumentWorker(options.python ?? defaultPython(), [
    "pdf-text",
    source.absPath,
    String(options.startPage ?? 1),
    String(options.endPage ?? 0),
    String(maxBytes)
  ]);
  const parsed = parseWorkerJson<{
    page_count: number;
    start_page: number;
    end_page: number;
    requested_end_page: number;
    next_page?: number | null;
    bytes_returned: number;
    truncated: boolean;
    text: string;
  }>(output, "PDF");

  return {
    path: source.relPath,
    bytes: source.bytes,
    pageCount: parsed.page_count,
    startPage: parsed.start_page,
    endPage: parsed.end_page,
    requestedEndPage: parsed.requested_end_page,
    ...(parsed.next_page ? { nextPage: parsed.next_page } : {}),
    bytesReturned: parsed.bytes_returned,
    truncated: parsed.truncated,
    text: parsed.text
  };
}

export async function readDocxText(
  guard: PathGuard,
  workspace: Workspace,
  filePath: string,
  options: { startLine?: number; endLine?: number; maxBytes?: number; python?: string } = {}
): Promise<DocxTextResult> {
  const source = await loadDocumentSource(guard, workspace, filePath, ".docx");
  const maxBytes = Math.max(1000, Math.min(options.maxBytes ?? MAX_DOCUMENT_TEXT_BYTES, MAX_DOCUMENT_TEXT_BYTES));
  const output = await runDocumentWorker(options.python ?? defaultPython(), [
    "docx-text",
    source.absPath,
    String(options.startLine ?? 1),
    String(options.endLine ?? 0),
    String(maxBytes)
  ]);
  const parsed = parseWorkerJson<{
    total_lines: number;
    start_line: number;
    end_line: number;
    requested_end_line: number;
    next_line?: number | null;
    bytes_returned: number;
    truncated: boolean;
    text?: string;
  }>(output, "DOCX");

  return {
    path: source.relPath,
    bytes: source.bytes,
    totalLines: parsed.total_lines,
    startLine: parsed.start_line,
    endLine: parsed.end_line,
    requestedEndLine: parsed.requested_end_line,
    ...(parsed.next_line ? { nextLine: parsed.next_line } : {}),
    bytesReturned: parsed.bytes_returned,
    truncated: parsed.truncated,
    text: parsed.text ?? ""
  };
}

function pdfRenderCandidates(requestedDimension: number): number[] {
  const ladder = [2400, 2200, 2000, 1800, 1600, 1400, 1200, 1000, 900, 768];
  return [...new Set([requestedDimension, ...ladder.filter((dimension) => dimension < requestedDimension)])];
}

export async function readPdfPage(
  guard: PathGuard,
  workspace: Workspace,
  filePath: string,
  page: number,
  options: { maxDimension?: number; python?: string } = {}
): Promise<CallToolResult> {
  const source = await loadDocumentSource(guard, workspace, filePath, ".pdf");
  const python = options.python ?? defaultPython();
  const requestedDimension = Math.max(128, Math.min(options.maxDimension ?? DEFAULT_PDF_PAGE_DIMENSION, MAX_PDF_PAGE_DIMENSION));
  let rendered: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let usedDimension = requestedDimension;
  for (const dimension of pdfRenderCandidates(requestedDimension)) {
    rendered = await runDocumentWorker(python, ["pdf-render", source.absPath, String(page), String(dimension)], 16 * 1024 * 1024);
    usedDimension = dimension;
    if (rendered.byteLength <= MAX_PDF_PAGE_OUTPUT_BYTES) break;
  }
  if (rendered.byteLength > MAX_PDF_PAGE_OUTPUT_BYTES) {
    throw new LocalWorkspaceBridgeError(`Rendered PDF page is still too large (${rendered.byteLength} bytes). Request a smaller max_dimension.`);
  }

  return nativeImageResult({
    data: rendered,
    mimeType: "image/jpeg",
    maxBytes: MAX_PDF_PAGE_OUTPUT_BYTES,
    summary: `Rendered PDF page ${page} from ${source.relPath} at up to ${usedDimension}px longest side.`,
    metadata: {
      path: source.relPath,
      page,
      bytes: rendered.byteLength,
      original_bytes: source.bytes,
      max_dimension: usedDimension,
      rendered: true
    }
  });
}
