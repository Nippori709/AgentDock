import type { CallToolResult, ImageContent } from "@modelcontextprotocol/server";
import { LocalWorkspaceBridgeError } from "./guard.js";

export type NativeImageMimeType = "image/jpeg" | "image/png" | "image/webp";

export function nativeImageResult(options: {
  data: Buffer;
  mimeType: NativeImageMimeType;
  summary: string;
  metadata: Record<string, unknown>;
  maxBytes: number;
}): CallToolResult {
  if (options.data.byteLength > options.maxBytes) {
    throw new LocalWorkspaceBridgeError(`Image output is too large (${options.data.byteLength} bytes). Limit: ${options.maxBytes} bytes.`);
  }
  const image: ImageContent = {
    type: "image",
    data: options.data.toString("base64"),
    mimeType: options.mimeType
  };
  return {
    content: [image, { type: "text", text: options.summary }],
    structuredContent: options.metadata
  };
}
