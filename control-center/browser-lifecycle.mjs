import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const TRANSIENT_CACHE_DIRS = [
  'GPUCache',
  'GrShaderCache',
  'ShaderCache',
  'DawnCache',
  'Default/GPUCache'
];

function psSingleQuoted(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function buildDedicatedBrowserCleanupScript(profileDir) {
  const quotedProfile = psSingleQuoted(profileDir);
  return [
    `$profile = ${quotedProfile}`,
    "$targets = Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'msedge.exe' -or $_.Name -eq 'chrome.exe') -and $_.CommandLine -and $_.CommandLine.Contains($profile) }",
    '$targets | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }'
  ].join('; ');
}

export function stopDedicatedBrowserProcesses(profileDir, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return { attempted: false, ok: true };

  const run = options.execFileSyncImpl ?? execFileSync;
  try {
    run('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      buildDedicatedBrowserCleanupScript(profileDir)
    ], {
      windowsHide: true,
      stdio: 'ignore'
    });
    return { attempted: true, ok: true };
  } catch {
    // Opening the Control Center should still be attempted if cleanup fails.
    return { attempted: true, ok: false };
  }
}

export function clearDedicatedBrowserTransientCaches(profileDir, options = {}) {
  const fsImpl = options.fsImpl ?? fs;
  for (const relative of TRANSIENT_CACHE_DIRS) {
    try {
      fsImpl.rmSync(`${profileDir}/${relative}`, { recursive: true, force: true });
    } catch {
      // Cache cleanup is best-effort and must never block opening the UI.
    }
  }
}

export function prepareDedicatedBrowserProfile(profileDir, options = {}) {
  const result = stopDedicatedBrowserProcesses(profileDir, options);
  clearDedicatedBrowserTransientCaches(profileDir, options);
  return result;
}

export const browserLifecycleInternals = {
  TRANSIENT_CACHE_DIRS,
  psSingleQuoted
};
