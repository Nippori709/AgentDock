import type { LocalWorkspaceBridgeConfig } from "./config.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

type ToolSecurityScheme =
  | { type: "noauth" }
  | { type: "oauth2"; scopes: string[] };

const patchedTransports = new WeakSet<object>();

function defaultSecuritySchemes(config: LocalWorkspaceBridgeConfig): ToolSecurityScheme[] {
  return config.publicUrl && config.authToken
    ? [{ type: "oauth2", scopes: ["mcp:tools"] }]
    : [{ type: "noauth" }];
}

function patchToolListPayload(config: LocalWorkspaceBridgeConfig, payload: any): any {
  const tools = payload?.result?.tools;
  if (!Array.isArray(tools)) return payload;
  const fallback = defaultSecuritySchemes(config);
  return {
    ...payload,
    result: {
      ...payload.result,
      tools: tools.map((tool: any) => ({
        ...tool,
        securitySchemes: Array.isArray(tool.securitySchemes)
          ? tool.securitySchemes
          : Array.isArray(tool?._meta?.securitySchemes)
            ? tool._meta.securitySchemes
            : fallback
      }))
    }
  };
}

/**
 * MCP SDK 1.x currently keeps securitySchemes only in tool _meta even when the
 * registration config supplies the standard top-level field. OpenAI hosts use
 * the standard field to decide whether a tool is callable with OAuth. Mirror
 * the field into the serialized tools/list response until the SDK preserves it.
 */
export function applyToolSecuritySchemeCompat<T extends Transport>(config: LocalWorkspaceBridgeConfig, transport: T): T {
  if (patchedTransports.has(transport as object)) return transport;
  patchedTransports.add(transport as object);
  const originalSend = transport.send.bind(transport);
  transport.send = async (message, options) => {
    const envelope = message as any;
    const patchedMessage = patchToolListPayload(config, envelope);
    if (patchedMessage === envelope) return originalSend(message, options);
    return originalSend(patchedMessage, options);
  };
  return transport;
}

/** Preserve OpenAI's top-level tool auth extension on modern, fetch-shaped MCP responses. */
export async function patchModernToolSecuritySchemes(config: LocalWorkspaceBridgeConfig, response: Response): Promise<Response> {
  if (!response.ok) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json") && !contentType.includes("text/event-stream")) return response;

  const original = await response.text();
  let patched = original;
  try {
    if (contentType.includes("text/event-stream")) {
      patched = original
        .split(/(\r?\n)/)
        .map((line) => {
          if (!line.startsWith("data: ")) return line;
          const payload = JSON.parse(line.slice(6));
          return `data: ${JSON.stringify(patchToolListPayload(config, payload))}`;
        })
        .join("");
    } else {
      patched = JSON.stringify(patchToolListPayload(config, JSON.parse(original)));
    }
  } catch {
    patched = original;
  }

  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(patched, { status: response.status, statusText: response.statusText, headers });
}
