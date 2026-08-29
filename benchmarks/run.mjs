import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { initGit, isToolError, resultBytes, round, withClient } from './harness.mjs';

const quick = process.argv.includes('--quick');
const fileCount = quick ? 200 : 2000;
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'local-workspace-bridge-benchmark-'));

try {
  await fs.writeFile(path.join(root, 'README.md'), '# Benchmark fixture\n', 'utf8');
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', private: true, scripts: { test: 'node -e "process.exit(0)"' } }, null, 2), 'utf8');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  for (let i = 0; i < fileCount; i += 1) {
    await fs.writeFile(path.join(root, 'src', `module-${String(i).padStart(5, '0')}.ts`), `export const value${i} = ${i};\n`, 'utf8');
  }
  await fs.writeFile(path.join(root, 'src', 'target.ts'), 'export const benchmarkTarget = 42;\n', 'utf8');
  await initGit(root);

  const modes = {};
  for (const mode of ['minimal', 'standard', 'full']) {
    modes[mode] = await withClient(root, { LOCALWORKSPACEBRIDGE_TOOL_MODE: mode }, async (client) => {
      const tools = await client.listTools();
      const names = tools.tools.map((tool) => tool.name);
      const workspaceId = await client.openWorkspace();
      const started = performance.now();
      const read = await client.tool('read', { workspace_id: workspaceId, path: 'src/target.ts' });
      if (isToolError(read) || !JSON.stringify(read).includes('benchmarkTarget')) throw new Error(`${mode} read workflow failed`);
      const edit = await client.tool('edit', { workspace_id: workspaceId, path: 'src/target.ts', old_text: '42', new_text: '43', expected_replacements: 1 });
      if (isToolError(edit)) throw new Error(`${mode} edit workflow failed`);
      const changes = await client.tool('show_changes', { workspace_id: workspaceId, path: 'src/target.ts', since: 'workspace', mark_reviewed: false });
      if (isToolError(changes) || !JSON.stringify(changes).includes('target.ts')) throw new Error(`${mode} review workflow failed`);
      const secretRead = await client.tool('read', { workspace_id: workspaceId, path: '.env' });
      if (!isToolError(secretRead)) throw new Error(`${mode} allowed blocked .env read`);
      await fs.writeFile(path.join(root, 'src', 'target.ts'), 'export const benchmarkTarget = 42;\n', 'utf8');
      return {
        tools: names.length,
        tool_schema_bytes: resultBytes(tools),
        common_workflows_passed: 4,
        common_workflows_total: 4,
        elapsed_ms: round(performance.now() - started)
      };
    });
  }

  const scale = await withClient(root, { LOCALWORKSPACEBRIDGE_TOOL_MODE: 'standard' }, async (client) => {
    const workspaceId = await client.openWorkspace();
    const started = performance.now();
    const inspect = await client.tool('inspect_workspace', { workspace_id: workspaceId, mode: 'inventory', max_files: Math.max(fileCount + 20, 300) });
    const inventoryMs = round(performance.now() - started);
    const searchStart = performance.now();
    const search = await client.tool('search', { workspace_id: workspaceId, query: 'benchmarkTarget', path: 'src', max_results: 10 });
    const searchMs = round(performance.now() - searchStart);
    if (isToolError(inspect) || isToolError(search) || !JSON.stringify(search).includes('target.ts')) throw new Error('scale workflow failed');
    return { files: fileCount + 3, inventory_ms: inventoryMs, search_ms: searchMs };
  });

  const report = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    fixture: { generated_source_files: fileCount + 1 },
    modes,
    scale
  };
  console.log(JSON.stringify(report, null, 2));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
