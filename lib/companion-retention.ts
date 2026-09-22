import { readFileSync } from "node:fs";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { COMPANION_RAW_RETENTION_DAYS } from "./companion-continuity";
import type { TenantContext, TenantStore } from "./tenant-store";
import { resolveSessionPath } from "./session-reader";
import { getRpcSession } from "./rpc-manager";

type JsonLine = Record<string, unknown> & { id?: string; type?: string; parentId?: string | null; timestamp?: string };

function readLines(path: string): JsonLine[] {
  return readFileSync(path, "utf8").split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as JsonLine);
}

function expiredMessageIds(path: string, now: string): Set<string> {
  const cutoff = new Date(new Date(now).getTime() - COMPANION_RAW_RETENTION_DAYS * 86_400_000).getTime();
  return new Set(readLines(path).flatMap((line) => {
    if (line.type !== "message" || typeof line.id !== "string" || typeof line.timestamp !== "string") return [];
    const timestamp = Date.parse(line.timestamp);
    return Number.isFinite(timestamp) && timestamp < cutoff ? [line.id] : [];
  }));
}

export function hasExpiredCompanionRawMessages(path: string, now = new Date().toISOString()): boolean {
  return expiredMessageIds(path, now).size > 0;
}

function rewriteWithout(path: string, initialIds: ReadonlySet<string>): string[] {
  const lines = readLines(path);
  const byId = new Map(lines.flatMap((line) => typeof line.id === "string" ? [[line.id, line] as const] : []));
  const removed = new Set(initialIds);
  for (const line of lines) {
    if (line.type === "compaction" && typeof line.firstKeptEntryId === "string" && removed.has(line.firstKeptEntryId) && line.id) {
      removed.add(line.id);
    }
  }
  const nearestKeptParent = (parentId: string | null): string | null => {
    let candidate = parentId;
    const visited = new Set<string>();
    while (candidate && removed.has(candidate) && !visited.has(candidate)) {
      visited.add(candidate);
      const parent = byId.get(candidate)?.parentId;
      candidate = typeof parent === "string" ? parent : null;
    }
    return candidate;
  };
  const kept = lines.filter((line) => !line.id || !removed.has(line.id)).map((line) => {
    if (typeof line.parentId !== "string" || !removed.has(line.parentId)) return line;
    return { ...line, parentId: nearestKeptParent(line.parentId) };
  });
  if (kept.length === 0 || kept[0].type !== "session") throw new Error("Companion session header would be removed");
  writePrivateFileAtomicSync(path, `${kept.map((line) => JSON.stringify(line)).join("\n")}\n`);
  return [...removed];
}

export function pruneCompanionRawMessages(
  store: TenantStore,
  context: TenantContext,
  sessionPath: string,
  now = new Date().toISOString(),
): { removedEntryIds: string[]; confirmedMemoryIds: string[] } {
  const expired = expiredMessageIds(sessionPath, now);
  if (expired.size === 0) return { removedEntryIds: [], confirmedMemoryIds: [] };
  const removedEntryIds = rewriteWithout(sessionPath, expired);
  const derived = store.removeCompanionSourceData(context, removedEntryIds, false, "retention");
  return { removedEntryIds, confirmedMemoryIds: derived.confirmedMemoryIds };
}

export function deleteCompanionSourceMessage(
  store: TenantStore,
  context: TenantContext,
  sessionPath: string,
  entryId: string,
  removeConfirmedMemories: boolean,
): { confirmedMemoryIds: string[] } {
  const lines = readLines(sessionPath);
  const source = lines.find((line) => line.id === entryId && line.type === "message");
  if (!source) throw new Error("Companion source message not found");
  const directAssistantReplies = lines.flatMap((line) => (
    line.type === "message"
    && line.parentId === entryId
    && (line.message as { role?: unknown } | undefined)?.role === "assistant"
    && typeof line.id === "string"
      ? [line.id]
      : []
  ));
  const removedEntryIds = rewriteWithout(sessionPath, new Set([entryId, ...directAssistantReplies]));
  return store.removeCompanionSourceData(context, removedEntryIds, removeConfirmedMemories);
}

declare global {
  var __piCompanionRetentionTimer: ReturnType<typeof setTimeout> | undefined;
}

export function scheduleCompanionRetentionSweep(store: TenantStore, delayMs = 0): void {
  if (globalThis.__piCompanionRetentionTimer) return;
  globalThis.__piCompanionRetentionTimer = setTimeout(async () => {
    globalThis.__piCompanionRetentionTimer = undefined;
    let targets: ReturnType<TenantStore["listCompanionRetentionTargets"]> = [];
    try { targets = store.listCompanionRetentionTargets(); } catch { /* The store may be closing during a restart. */ }
    let retrySoon = false;
    for (const target of targets) {
      try {
        const path = await resolveSessionPath(target.sessionId);
        if (!path || !hasExpiredCompanionRawMessages(path)) continue;
        const session = getRpcSession(target.sessionId);
        if (session?.isStreaming) {
          retrySoon = true;
          continue;
        }
        session?.destroy();
        pruneCompanionRawMessages(store, target, path);
      } catch {
        // One missing or malformed transcript must not stop retention for other tenants.
      }
    }
    scheduleCompanionRetentionSweep(store, retrySoon ? 60_000 : 60 * 60 * 1_000);
  }, Math.max(0, delayMs));
  globalThis.__piCompanionRetentionTimer.unref?.();
}
