#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createLocalWorkspaceBridgeServer } from "./server.js";
import { applyToolSecuritySchemeCompat } from "./transportCompat.js";

const LOCALWORKSPACEBRIDGE_VERSION = "0.1.0";

function printHelp(): void {
  console.log(`LocalWorkspaceBridge MCP stdio server

Usage:
  local-workspace-bridge-mcp --root /path/to/repo [--allow-root /path]
  local-workspace-bridge-mcp --version
  local-workspace-bridge-mcp --help

Most users should run: local-workspace-bridge start`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--version") || argv.includes("-v") || argv[0] === "version") {
    console.log(LOCALWORKSPACEBRIDGE_VERSION);
    return;
  }
  if (argv.includes("--help") || argv[0] === "help") {
    printHelp();
    return;
  }

  process.env.LOCALWORKSPACEBRIDGE_ALLOW_NO_HTTP_TOKEN ??= "1";
  const config = loadConfig();
  const server = createLocalWorkspaceBridgeServer(config);
  const transport = new StdioServerTransport();
  applyToolSecuritySchemeCompat(config, transport);
  await server.connect(transport);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
