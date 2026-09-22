import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("member and administrator quality controls stay in their existing product surfaces", async () => {
  const [understanding, settings] = await Promise.all([
    readFile(new URL("./CompanionUnderstandingPanel.tsx", import.meta.url), "utf8"),
    readFile(new URL("./CompanionGovernanceSettings.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(understanding, /有限人工质量复核/);
  assert.match(understanding, /与长期记忆分开的选择/);
  assert.match(settings, /有限人工质量复核/);
  assert.match(settings, /显式迁移与回滚/);
  assert.match(settings, /内部试用门槛/);
  assert.match(settings, /预览并迁移/);
  assert.match(settings, /愿意继续/);
  assert.match(settings, /缺失/);
});
