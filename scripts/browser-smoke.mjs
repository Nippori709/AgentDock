import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { captureBrowserScreenshot, findBrowserExecutable, isLocalBrowserUrl } from "../dist/browserOps.js";
import { PathGuard } from "../dist/guard.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const workspace = {
  id: "browser-smoke",
  root: projectRoot,
  openedAt: new Date().toISOString(),
  lastUsedAt: new Date().toISOString()
};
const guard = new PathGuard({ blockedGlobs: [] });
const outputPath = ".ai-bridge/browser-smoke.png";

assert.equal(isLocalBrowserUrl("http://localhost:5173"), true);
assert.equal(isLocalBrowserUrl("http://127.0.0.1:3000"), true);
assert.equal(isLocalBrowserUrl("https://example.com"), false);

const selected = findBrowserExecutable("auto");
assert.ok(selected.executable);

const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  html, body { margin: 0; font-family: Arial, sans-serif; background: #f5f5f5; }
  main { min-height: 100vh; display: grid; place-items: center; }
  .card { padding: 48px; background: white; border-radius: 24px; box-shadow: 0 12px 40px rgba(0,0,0,.12); }
  h1 { margin: 0 0 12px; font-size: 48px; }
  p { margin: 0; font-size: 20px; }
</style>
</head>
<body><main><section class="card"><h1>LocalWorkspaceBridge Browser Smoke</h1><p>localhost screenshot works</p></section></main></body>
</html>`;

const server = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
});
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

try {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const result = await captureBrowserScreenshot(
    guard,
    workspace,
    `http://127.0.0.1:${address.port}/`,
    { outputPath, width: 960, height: 640, waitMs: 500, overwrite: true }
  );
  assert.equal(result.path.replaceAll("\\", "/"), outputPath);
  assert.ok(result.bytes > 1000);
  const png = await fs.readFile(path.join(projectRoot, outputPath));
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  console.log(JSON.stringify({ ok: true, browser: result.browser, bytes: result.bytes, viewport: `${result.width}x${result.height}` }));
} finally {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(path.join(projectRoot, outputPath), { force: true });
}
