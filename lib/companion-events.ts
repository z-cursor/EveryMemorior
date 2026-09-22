import type { CompanionTurnEvent } from "./companion-runtime";

type Listener = (event: CompanionTurnEvent) => void;

declare global {
  var __piCompanionEventListeners: Map<string, Set<Listener>> | undefined;
}
function listeners(): Map<string, Set<Listener>> {
  return globalThis.__piCompanionEventListeners ??= new Map();
}

export function publishCompanionEvent(key: string, event: CompanionTurnEvent): void {
  for (const listener of listeners().get(key) ?? []) {
    try { listener(event); } catch { /* A disconnected browser must not stop the turn. */ }
  }
}

export function subscribeCompanionEvents(key: string, listener: Listener): () => void {
  const set = listeners().get(key) ?? new Set<Listener>();
  set.add(listener);
  listeners().set(key, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners().delete(key);
  };
}

export function companionEventKey(tenantId: string, membershipId: string): string {
  return `${tenantId}:${membershipId}`;
}
