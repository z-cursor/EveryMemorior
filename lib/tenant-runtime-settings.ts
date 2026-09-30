import type { CompactionSettings } from "@earendil-works/pi-coding-agent";

/**
 * Keep long-running tenant workflows below 70% of the model context window.
 * The SDK default reserves only 16k tokens, which is too late for large
 * context models when tool output and preserved reasoning accumulate.
 */
export function tenantCompactionSettings(contextWindow: number | undefined): CompactionSettings | undefined {
  if (!Number.isFinite(contextWindow) || !contextWindow || contextWindow <= 0) return undefined;
  const targetContext = Math.max(16_384, Math.floor(contextWindow * 7 / 10));
  const reserveTokens = Math.max(16_384, contextWindow - targetContext);
  const keepRecentTokens = Math.max(8_192, Math.min(20_000, Math.floor(targetContext / 2)));
  return { enabled: true, reserveTokens, keepRecentTokens };
}
