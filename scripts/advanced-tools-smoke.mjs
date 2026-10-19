import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "../dist/config.js";
import { getExecManager } from "../dist/execOps.js";
import { makeUnifiedDiff } from "../dist/fsOps.js";
import { PathGuard, WorkspaceManager } from "../dist/guard.js";
import { getLspManager, queryLsp } from "../dist/lspOps.js";
import { globWorkspace, searchWorkspace } from "../dist/searchOps.js";
import { getTerminalManager } from "../dist/terminalOps.js";
import { listTasks, readTaskOutput, stopTask } from "../dist/taskOps.js";
import { applyToolResultRetention, enforceToolPermissionRules } from "../dist/toolRuntimeOps.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "codexpro-advanced-tools-"));
const config = loadConfig(["--root", root, "--bash", "full", "--tool-mode", "full"]);
config.allowedRoots = [root];
config.connectionTest = false;
config.writeMode = "workspace";
config.toolMode = "full";
config.bashMode = "full";
config.permissionPolicy = "denylist";
config.permissionAllowRules = [];
config.permissionDenyRules = [];
config.toolResultRetention = true;
config.maxToolResultBytes = 20 * 1024 * 1024;

const workspaces = new WorkspaceManager(config);
const workspace = workspaces.defaultWorkspace();
const guard = new PathGuard(config);
const exec = getExecManager(config);
const terminals = getTerminalManager(config);
const lsp = getLspManager(config);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function waitForExec(processId) {
  const deadline = Date.now() + 10_000;
  let cursor = 0;
  let result;
  do {
    result = await exec.poll(workspace, processId, { cursor, waitMs: 100 });
    cursor = result.next_cursor;
    if (!result.running) return result;
  } while (Date.now() < deadline);
  throw new Error("exec smoke timed out");
}

async function waitForDiagnostics(file) {
  const deadline = Date.now() + 6_000;
  let result;
  do {
    result = await queryLsp(config, guard, workspace, {
      operation: "diagnostics",
      path: file,
      maxResults: 20
    });
    if (result.diagnostics?.length) return result;
    await sleep(150);
  } while (Date.now() < deadline);
  return result;
}

try {
  await fs.writeFile(path.join(root, "alpha.py"), [
    "def greet(name: str) -> str:",
    "    return f\"hello {name}\"",
    ""
  ].join("\n"), "utf8");
  await fs.writeFile(path.join(root, "beta.py"), [
    "from alpha import greet",
    "print(greet(\"world\"))",
    ""
  ].join("\n"), "utf8");
  await fs.writeFile(path.join(root, "broken.py"), [
    "value: int = \"not-an-int\"",
    ""
  ].join("\n"), "utf8");
  await fs.writeFile(path.join(root, "alpha.ts"), [
    "export const answer = 42;",
    "export function target() { return answer; }",
    ""
  ].join("\n"), "utf8");
  await fs.writeFile(path.join(root, "beta.ts"), [
    'import { answer, target } from "./alpha";',
    "export function caller() { return target() + answer; }",
    "console.log(caller());",
    ""
  ].join("\n"), "utf8");
  await fs.writeFile(path.join(root, "notes.txt"), "needle-one\nneedle-two\n", "utf8");
  await fs.writeFile(path.join(root, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true
    },
    include: ["*.ts"]
  }, null, 2), "utf8");

  const glob = await globWorkspace(config, guard, workspace, { pattern: "**/*.py", maxResults: 20 });
  assert.equal(glob.used, "ripgrep");
  assert(glob.paths.includes("alpha.py") && glob.paths.includes("beta.py"), JSON.stringify(glob));

  const grep = await searchWorkspace(config, guard, workspace, {
    query: "needle-two",
    regex: false,
    root: ".",
    includeHidden: false,
    maxResults: 20
  });
  assert.equal(grep.used, "ripgrep");
  assert.equal(grep.matches[0]?.path, "notes.txt");

  const pyDefinition = await queryLsp(config, guard, workspace, {
    operation: "goToDefinition",
    path: "beta.py",
    line: 2,
    character: 8,
    maxResults: 20
  });
  assert.equal(pyDefinition.provider, "pyright");
  assert(pyDefinition.locations?.some(item => item.path === "alpha.py"), JSON.stringify(pyDefinition));

  const pyHover = await queryLsp(config, guard, workspace, {
    operation: "hover",
    path: "beta.py",
    line: 2,
    character: 8,
    maxResults: 20
  });
  assert.equal(pyHover.server_reused, true, JSON.stringify(pyHover));

  const tsDefinition = await queryLsp(config, guard, workspace, {
    operation: "goToDefinition",
    path: "beta.ts",
    line: 2,
    character: 35,
    maxResults: 20
  });
  assert.equal(tsDefinition.provider, "typescript-language-server");
  assert(tsDefinition.locations?.length, JSON.stringify(tsDefinition));

  const tsSymbols = await queryLsp(config, guard, workspace, {
    operation: "documentSymbol",
    path: "alpha.ts",
    maxResults: 20
  });
  assert.equal(tsSymbols.server_reused, true, JSON.stringify(tsSymbols));
  assert(tsSymbols.symbols?.some(item => item.name === "answer" || item.name === "target"), JSON.stringify(tsSymbols));

  const workspaceSymbols = await queryLsp(config, guard, workspace, {
    operation: "workspaceSymbol",
    path: "alpha.ts",
    query: "target",
    maxResults: 20
  });
  assert(workspaceSymbols.symbols?.some(item => item.name.includes("target")), JSON.stringify(workspaceSymbols));

  const diagnostics = await waitForDiagnostics("broken.py");
  assert(diagnostics?.diagnostics?.some(item => /assign|int|str|string/i.test(item.message)), JSON.stringify(diagnostics));

  const oldText = [
    "top",
    "old-a",
    "keep-1",
    "keep-2",
    "keep-3",
    "keep-4",
    "keep-5",
    "keep-6",
    "keep-7",
    "old-b",
    "bottom",
    ""
  ].join("\n");
  const newText = oldText.replace("old-a", "new-a").replace("old-b", "new-b");
  const diff = makeUnifiedDiff(oldText, newText, "multi.txt");
  assert.equal(diff.additions, 2);
  assert.equal(diff.deletions, 2);
  assert.equal((diff.diff.match(/^@@/gm) ?? []).length, 2, diff.diff);

  const oversized = {
    content: [{ type: "text", text: "x".repeat(80_000) }],
    structuredContent: {
      workspace_id: workspace.id,
      root: workspace.root,
      matches: Array.from({ length: 180 }, (_, index) => ({
        path: `src/file-${index}.ts`,
        line: index + 1,
        preview: "y".repeat(200)
      }))
    }
  };
  const retained = applyToolResultRetention(config, "grep", oversized);
  assert.equal(retained.structuredContent.inline_result_truncated, true, JSON.stringify(retained.structuredContent));
  assert(retained.structuredContent.retained_result_path, JSON.stringify(retained.structuredContent));
  const retainedText = await fs.readFile(path.join(root, retained.structuredContent.retained_result_path), "utf8");
  assert.match(retainedText, /file-179\.ts/);

  config.permissionDenyRules = ["Bash(git push*)"];
  assert.throws(
    () => enforceToolPermissionRules(
      config,
      "bash",
      { command: "git push --force origin main" },
      { annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: true } }
    ),
    /denied by permission rule/
  );
  config.permissionDenyRules = [];
  config.permissionPolicy = "strict";
  config.permissionAllowRules = ["Bash(node *)"];
  assert.doesNotThrow(() => enforceToolPermissionRules(
    config,
    "bash",
    { command: "node emit.mjs" },
    { annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: true } }
  ));
  assert.throws(
    () => enforceToolPermissionRules(
      config,
      "bash",
      { command: "git status" },
      { annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: true } }
    ),
    /Strict permission policy blocked/
  );
  config.permissionPolicy = "denylist";
  config.permissionAllowRules = [];

  await fs.writeFile(path.join(root, "emit.mjs"), "console.log('spill-ok');\n", "utf8");
  const started = await exec.start(workspace, "node emit.mjs", { requestId: "spill-smoke", waitMs: 0 });
  const processTaskId = `process:${started.process_id}`;
  assert(listTasks(config, workspace).some(item => item.task_id === processTaskId));
  const completed = await waitForExec(started.process_id);
  assert.equal(completed.exit_code, 0, JSON.stringify(completed));
  assert(completed.spill_path, JSON.stringify(completed));
  const spill = await fs.readFile(path.join(root, completed.spill_path), "utf8");
  assert.match(spill, /\[stdout\] spill-ok/);
  const taskOutput = await readTaskOutput(config, workspace, processTaskId, { cursor: 0, maxChars: 12_000 });
  assert.equal(taskOutput.kind, "process");

  config.writeMode = "off";
  const noSpillStarted = await exec.start(workspace, "node emit.mjs", { requestId: "no-spill-smoke", waitMs: 0 });
  const noSpillCompleted = await waitForExec(noSpillStarted.process_id);
  assert.equal(noSpillCompleted.spill_path, null, JSON.stringify(noSpillCompleted));
  config.writeMode = "workspace";

  const opened = terminals.open(workspace, { cols: 100, rows: 30 });
  const terminalTaskId = `terminal:${opened.terminal_id}`;
  assert(listTasks(config, workspace).some(item => item.task_id === terminalTaskId));
  await sleep(300);
  const fakeSecret = ["abcdefghijklm", "nopqrstuvwx"].join("");
  const terminalCommand = process.platform === "win32"
    ? `Write-Output 'pty-ok'; Write-Output 'API_KEY=${fakeSecret}'\r`
    : `printf 'pty-ok\\nAPI_KEY=${fakeSecret}\\n'\n`;
  terminals.send(workspace, opened.terminal_id, terminalCommand);
  // PowerShell startup and PTY output delivery can exceed a fixed 500 ms delay.
  let terminalOutput;
  const terminalDeadline = Date.now() + 8_000;
  do {
    terminalOutput = await readTaskOutput(config, workspace, terminalTaskId, { cursor: 0, maxChars: 24_000 });
    if (/pty-ok/.test(terminalOutput.output) && /API_KEY= \[REDACTED_SECRET\]/.test(terminalOutput.output)) break;
    await sleep(150);
  } while (Date.now() < terminalDeadline);
  assert.match(terminalOutput.output, /pty-ok/, JSON.stringify(terminalOutput));
  assert.match(terminalOutput.output, /API_KEY= \[REDACTED_SECRET\]/, JSON.stringify(terminalOutput));
  assert(!terminalOutput.output.includes(fakeSecret), JSON.stringify(terminalOutput));
  const stoppedTerminal = await stopTask(config, workspace, terminalTaskId);
  assert.equal(stoppedTerminal.closed, true);

  console.log("PASS persistent LSP reuse/symbols/diagnostics, bundled ripgrep, multi-hunk diff, tool-result retention, permission rules, unified tasks, process spill, and PTY redaction");
} finally {
  await lsp.dispose();
  await terminals.dispose();
  await exec.dispose();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fs.rm(root, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      break;
    } catch (error) {
      if (attempt === 4) throw error;
      await sleep(250);
    }
  }
}
