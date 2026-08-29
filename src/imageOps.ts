import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { Workspace } from "./guard.js";
import { LocalWorkspaceBridgeError, PathGuard } from "./guard.js";
import { nativeImageResult, type NativeImageMimeType } from "./mediaUtils.js";

export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
export const MAX_IMAGE_OUTPUT_BYTES = 3 * 1024 * 1024;
export const DEFAULT_IMAGE_PREVIEW_DIMENSION = 1600;
export const SAFE_IMAGE_MAX_DIMENSION = 1600;
export const EXPERIMENTAL_IMAGE_MAX_DIMENSION = 4096;
export const DEFAULT_TILE_OVERLAP = 0.08;
const AUTO_PREVIEW_THRESHOLD_BYTES = 384_000;
const IMAGE_WORKER = fileURLToPath(new URL("../scripts/image-worker.py", import.meta.url));
const execFileAsync = promisify(execFile);

const MIME_BY_EXTENSION: Readonly<Record<string, NativeImageMimeType>> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp"
};

export interface ReadImageResult {
  path: string;
  mimeType: NativeImageMimeType;
  bytes: number;
  result: CallToolResult;
}

export interface ImageInfo {
  path: string;
  mimeType: NativeImageMimeType;
  bytes: number;
  width: number;
  height: number;
  longestDimension: number;
  recommendedPreviewDimension: number;
  recommendedTileRows: number;
  recommendedTileColumns: number;
  recommendedTileOverlap: number;
}

export interface ImageCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface LoadedImageSource {
  relPath: string;
  absPath: string;
  mimeType: NativeImageMimeType;
  bytes: number;
  original: Buffer;
}

function detectedImageMime(buffer: Buffer): NativeImageMimeType | undefined {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return undefined;
}

function formatMiB(bytes: number): string {
  return `${Math.round((bytes / (1024 * 1024)) * 100) / 100} MiB`;
}

async function loadImageSource(guard: PathGuard, workspace: Workspace, filePath: string): Promise<LoadedImageSource> {
  const resolved = guard.resolve(workspace, filePath);
  const extension = path.extname(resolved.relPath).toLowerCase();
  const extensionMime = MIME_BY_EXTENSION[extension];
  if (!extensionMime) throw new LocalWorkspaceBridgeError(`Unsupported image extension ${extension || "(none)"}. Supported extensions: .jpg, .jpeg, .png, .webp.`);

  const stat = await fsp.stat(resolved.absPath);
  if (!stat.isFile()) throw new LocalWorkspaceBridgeError(`Not a file: ${resolved.relPath}`);
  if (stat.size > MAX_IMAGE_BYTES) {
    throw new LocalWorkspaceBridgeError(`Image is too large (${stat.size} bytes). Limit: ${MAX_IMAGE_BYTES} bytes (${formatMiB(MAX_IMAGE_BYTES)}).`);
  }

  const original = await fsp.readFile(resolved.absPath);
  const detectedMime = detectedImageMime(original);
  if (!detectedMime) throw new LocalWorkspaceBridgeError("File content is not a supported JPEG, PNG, or WebP image (magic bytes do not match).");
  if (detectedMime !== extensionMime) throw new LocalWorkspaceBridgeError(`Image extension ${extension} declares ${extensionMime}, but magic bytes identify ${detectedMime}.`);

  return {
    relPath: resolved.relPath,
    absPath: resolved.absPath,
    mimeType: detectedMime,
    bytes: original.byteLength,
    original
  };
}

async function runImageWorker(python: string, args: string[], maxBuffer = 4 * 1024 * 1024): Promise<Buffer> {
  try {
    const output = await execFileAsync(python, [IMAGE_WORKER, ...args], {
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
    if (value.code === "ENOENT") throw new LocalWorkspaceBridgeError(`Image preview Python executable was not found: ${python}.`);
    throw new LocalWorkspaceBridgeError(detail || "Image processing failed. Verify that PyMuPDF is installed and the image is valid.");
  }
}

function defaultPython(): string {
  return process.platform === "win32" ? "python" : "python3";
}

async function inspectDimensions(python: string, file: string): Promise<{ width: number; height: number }> {
  const output = await runImageWorker(python, ["info", file], 64 * 1024);
  try {
    const parsed = JSON.parse(output.toString("utf8")) as { width?: unknown; height?: unknown };
    const width = Number(parsed.width);
    const height = Number(parsed.height);
    if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) throw new Error("invalid dimensions");
    return { width, height };
  } catch {
    throw new LocalWorkspaceBridgeError("Image worker returned invalid dimension metadata.");
  }
}

async function renderPreview(python: string, file: string, dimension: number): Promise<Buffer> {
  return runImageWorker(python, ["preview", file, String(dimension)]);
}

async function renderCrop(python: string, file: string, crop: ImageCrop, dimension: number): Promise<Buffer> {
  return runImageWorker(python, [
    "crop",
    file,
    String(crop.x),
    String(crop.y),
    String(crop.width),
    String(crop.height),
    String(dimension)
  ]);
}

function previewCandidates(requestedDimension: number): number[] {
  const ladder = [4096, 3600, 3200, 3000, 2800, 2400, 2200, 2000, 1800, 1600, 1400, 1200, 1000, 900, 768];
  return [...new Set([requestedDimension, ...ladder.filter((dimension) => dimension < requestedDimension)])];
}

function safeCropCandidates(requestedDimension: number): number[] {
  const ladder = [1600, 1500, 1400, 1300, 1200, 1000, 900, 768];
  return [...new Set([requestedDimension, ...ladder.filter((dimension) => dimension < requestedDimension)])];
}

function clampOverlap(overlap: number): number {
  if (!Number.isFinite(overlap)) return DEFAULT_TILE_OVERLAP;
  return Math.max(0, Math.min(overlap, 0.2));
}

export function recommendedTileGrid(width: number, height: number, maxDimension = SAFE_IMAGE_MAX_DIMENSION, _overlap = DEFAULT_TILE_OVERLAP): { rows: number; columns: number } {
  return {
    rows: Math.max(1, Math.ceil(height / maxDimension)),
    columns: Math.max(1, Math.ceil(width / maxDimension))
  };
}

export function tileCrop(width: number, height: number, row: number, column: number, rows: number, columns: number, overlap = DEFAULT_TILE_OVERLAP): ImageCrop {
  if (!Number.isInteger(row) || row < 1 || row > rows || !Number.isInteger(column) || column < 1 || column > columns) {
    throw new LocalWorkspaceBridgeError(`Tile row/column is out of range. Valid rows: 1-${rows}; columns: 1-${columns}.`);
  }
  const boundedOverlap = clampOverlap(overlap);
  const baseX0 = Math.floor(((column - 1) * width) / columns);
  const baseX1 = column === columns ? width : Math.floor((column * width) / columns);
  const baseY0 = Math.floor(((row - 1) * height) / rows);
  const baseY1 = row === rows ? height : Math.floor((row * height) / rows);
  const marginX = Math.round((baseX1 - baseX0) * boundedOverlap);
  const marginY = Math.round((baseY1 - baseY0) * boundedOverlap);
  const x0 = Math.max(0, baseX0 - marginX);
  const y0 = Math.max(0, baseY0 - marginY);
  const x1 = Math.min(width, baseX1 + marginX);
  const y1 = Math.min(height, baseY1 + marginY);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

export async function getImageInfo(
  guard: PathGuard,
  workspace: Workspace,
  filePath: string,
  options: { python?: string; tileOverlap?: number } = {}
): Promise<ImageInfo> {
  const source = await loadImageSource(guard, workspace, filePath);
  const dimensions = await inspectDimensions(options.python ?? defaultPython(), source.absPath);
  const overlap = clampOverlap(options.tileOverlap ?? DEFAULT_TILE_OVERLAP);
  const grid = recommendedTileGrid(dimensions.width, dimensions.height, SAFE_IMAGE_MAX_DIMENSION, overlap);
  return {
    path: source.relPath,
    mimeType: source.mimeType,
    bytes: source.bytes,
    width: dimensions.width,
    height: dimensions.height,
    longestDimension: Math.max(dimensions.width, dimensions.height),
    recommendedPreviewDimension: DEFAULT_IMAGE_PREVIEW_DIMENSION,
    recommendedTileRows: grid.rows,
    recommendedTileColumns: grid.columns,
    recommendedTileOverlap: overlap
  };
}

export async function readImageFile(
  guard: PathGuard,
  workspace: Workspace,
  filePath: string,
  options: { maxDimension?: number; returnOriginal?: boolean; python?: string } = {}
): Promise<ReadImageResult> {
  const source = await loadImageSource(guard, workspace, filePath);
  const python = options.python ?? defaultPython();
  const requestedDimension = options.maxDimension;

  let shouldPreview = requestedDimension !== undefined || (!options.returnOriginal && source.original.byteLength > AUTO_PREVIEW_THRESHOLD_BYTES);
  if (!shouldPreview && !options.returnOriginal) {
    // Small files can still contain very large pixel dimensions. Keep the default path safe for ChatGPT.
    const dimensions = await inspectDimensions(python, source.absPath);
    shouldPreview = Math.max(dimensions.width, dimensions.height) > SAFE_IMAGE_MAX_DIMENSION;
  }

  let output: Buffer<ArrayBufferLike> = source.original;
  let outputMime: NativeImageMimeType = source.mimeType;
  let previewDimension: number | undefined;
  if (shouldPreview) {
    previewDimension = requestedDimension ?? DEFAULT_IMAGE_PREVIEW_DIMENSION;
    for (const dimension of previewCandidates(previewDimension)) {
      output = await renderPreview(python, source.absPath, dimension);
      previewDimension = dimension;
      if (output.byteLength <= MAX_IMAGE_OUTPUT_BYTES) break;
    }
    outputMime = "image/jpeg";
  }

  if (output.byteLength > MAX_IMAGE_OUTPUT_BYTES) {
    throw new LocalWorkspaceBridgeError(`Image result is still too large (${output.byteLength} bytes). Request a smaller max_dimension or use read_image_crop/read_image_tile.`);
  }

  const preview = shouldPreview;
  const metadata = {
    path: source.relPath,
    mime_type: outputMime,
    bytes: output.byteLength,
    preview,
    ...(preview ? {
      max_dimension: previewDimension,
      safe_preview_dimension: SAFE_IMAGE_MAX_DIMENSION,
      experimental_high_resolution: (previewDimension ?? 0) > SAFE_IMAGE_MAX_DIMENSION,
      original_mime_type: source.mimeType,
      original_bytes: source.original.byteLength
    } : {})
  };
  const result = nativeImageResult({
    data: output,
    mimeType: outputMime,
    summary: `${preview ? "Loaded local image preview" : "Loaded local image"}: ${source.relPath}`,
    metadata,
    maxBytes: MAX_IMAGE_OUTPUT_BYTES
  });
  return { path: source.relPath, mimeType: outputMime, bytes: output.byteLength, result };
}

export async function readImageCrop(
  guard: PathGuard,
  workspace: Workspace,
  filePath: string,
  crop: ImageCrop,
  options: { maxDimension?: number; python?: string } = {}
): Promise<ReadImageResult> {
  const source = await loadImageSource(guard, workspace, filePath);
  const python = options.python ?? defaultPython();
  const dimensions = await inspectDimensions(python, source.absPath);
  if (crop.x < 0 || crop.y < 0 || crop.width <= 0 || crop.height <= 0) {
    throw new LocalWorkspaceBridgeError("Crop coordinates must use non-negative x/y and positive width/height.");
  }
  if (crop.x >= dimensions.width || crop.y >= dimensions.height) {
    throw new LocalWorkspaceBridgeError(`Crop starts outside the image bounds (${dimensions.width}x${dimensions.height}).`);
  }
  const boundedCrop: ImageCrop = {
    x: Math.round(crop.x),
    y: Math.round(crop.y),
    width: Math.min(Math.round(crop.width), dimensions.width - Math.round(crop.x)),
    height: Math.min(Math.round(crop.height), dimensions.height - Math.round(crop.y))
  };
  const requestedDimension = Math.min(options.maxDimension ?? SAFE_IMAGE_MAX_DIMENSION, SAFE_IMAGE_MAX_DIMENSION);
  let output: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let renderedDimension = requestedDimension;
  for (const dimension of safeCropCandidates(requestedDimension)) {
    output = await renderCrop(python, source.absPath, boundedCrop, dimension);
    renderedDimension = dimension;
    if (output.byteLength <= MAX_IMAGE_OUTPUT_BYTES) break;
  }
  if (output.byteLength > MAX_IMAGE_OUTPUT_BYTES) {
    throw new LocalWorkspaceBridgeError(`Image crop is still too large (${output.byteLength} bytes). Request a smaller crop or max_dimension.`);
  }
  const result = nativeImageResult({
    data: output,
    mimeType: "image/jpeg",
    summary: `Loaded local image crop: ${source.relPath}`,
    metadata: {
      path: source.relPath,
      mime_type: "image/jpeg",
      bytes: output.byteLength,
      preview: true,
      max_dimension: renderedDimension,
      original_mime_type: source.mimeType,
      original_bytes: source.bytes,
      original_width: dimensions.width,
      original_height: dimensions.height,
      crop: boundedCrop
    },
    maxBytes: MAX_IMAGE_OUTPUT_BYTES
  });
  return { path: source.relPath, mimeType: "image/jpeg", bytes: output.byteLength, result };
}

export async function readImageTile(
  guard: PathGuard,
  workspace: Workspace,
  filePath: string,
  row: number,
  column: number,
  options: { overlap?: number; maxDimension?: number; python?: string } = {}
): Promise<ReadImageResult> {
  const info = await getImageInfo(guard, workspace, filePath, { python: options.python, tileOverlap: options.overlap });
  const overlap = clampOverlap(options.overlap ?? DEFAULT_TILE_OVERLAP);
  const crop = tileCrop(info.width, info.height, row, column, info.recommendedTileRows, info.recommendedTileColumns, overlap);
  const image = await readImageCrop(guard, workspace, filePath, crop, {
    maxDimension: Math.min(options.maxDimension ?? SAFE_IMAGE_MAX_DIMENSION, SAFE_IMAGE_MAX_DIMENSION),
    python: options.python
  });
  const structured = image.result.structuredContent as Record<string, unknown> | undefined;
  if (structured) {
    image.result.structuredContent = {
      ...structured,
      tile: {
        row,
        column,
        rows: info.recommendedTileRows,
        columns: info.recommendedTileColumns,
        overlap
      }
    };
  }
  return image;
}
