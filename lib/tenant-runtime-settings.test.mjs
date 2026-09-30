import assert from "node:assert/strict";
import test from "node:test";
import { tenantCompactionSettings } from "./tenant-runtime-settings.ts";

test("tenant long-form compaction starts before a large context accumulates", () => {
  assert.deepEqual(tenantCompactionSettings(262_144), {
    enabled: true,
    reserveTokens: 78_644,
    keepRecentTokens: 20_000,
  });
});

test("tenant compaction triggers at 70 percent of a medium context window", () => {
  const contextWindow = 100_000;
  const settings = tenantCompactionSettings(contextWindow);
  assert.equal(settings?.reserveTokens, 30_000);
  assert.equal(contextWindow - (settings?.reserveTokens ?? 0), 70_000);
});

test("tenant compaction settings are omitted when model context is unknown", () => {
  assert.equal(tenantCompactionSettings(undefined), undefined);
  assert.equal(tenantCompactionSettings(0), undefined);
});
