import type { WorkspaceAnalysis } from "./types.js";

interface CachedAnalysis {
  value: WorkspaceAnalysis;
  lastAccessMs: number;
}

const cache = new Map<string, CachedAnalysis>();

function pruneCache(maxEntries: number, ttlMs: number, now = Date.now()): void {
  for (const [key, entry] of cache.entries()) {
    if (now - entry.lastAccessMs > ttlMs) cache.delete(key);
  }
  while (cache.size > maxEntries) {
    const oldest = cache.keys().next().value as string | undefined;
    if (!oldest) break;
    cache.delete(oldest);
  }
}

export function getCachedWorkspaceAnalysis(key: string, options: { maxEntries: number; ttlMs: number }): WorkspaceAnalysis | undefined {
  const now = Date.now();
  pruneCache(options.maxEntries, options.ttlMs, now);
  const entry = cache.get(key);
  if (!entry) return undefined;
  cache.delete(key);
  cache.set(key, { value: entry.value, lastAccessMs: now });
  return entry.value;
}

export function setCachedWorkspaceAnalysis(key: string, value: WorkspaceAnalysis, options: { maxEntries: number; ttlMs: number }): void {
  cache.delete(key);
  cache.set(key, { value, lastAccessMs: Date.now() });
  pruneCache(options.maxEntries, options.ttlMs);
}

export function invalidateWorkspaceAnalysis(workspaceId: string): void {
  for (const key of cache.keys()) {
    if (key.startsWith(`${workspaceId}:`)) cache.delete(key);
  }
}
