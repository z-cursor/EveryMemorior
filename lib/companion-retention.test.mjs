import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const root = mkdtempSync(join(tmpdir(), "pi-web-companion-retention-"));
const jiti = createJiti(import.meta.url, { moduleCache: false });
const { TenantStore } = await jiti.import("./tenant-store.ts");
const { pruneCompanionRawMessages, deleteCompanionSourceMessage } = await jiti.import("./companion-retention.ts");
const store = new TenantStore(join(root, "tenant.sqlite"));
const created = store.createTenantWithOwner({
  tenant: { name: "Retention", slug: "retention" },
  owner: { email: "owner@retention.test", displayName: "Owner" },
});
const context = { tenantId: created.tenant.id, membershipId: created.membership.id };
store.setCompanionMemoryConsent(context, true);

after(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

function line(value) { return `${JSON.stringify(value)}\n`; }

test("90-day cleanup atomically removes expired raw messages and dependent derived data", () => {
  const path = join(root, "session.jsonl");
  writeFileSync(path,
    line({ type: "session", version: 3, id: "session-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: root })
    + line({ type: "message", id: "old-user", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "user", content: "旧消息" } })
    + line({ type: "message", id: "old-assistant", parentId: "old-user", timestamp: "2026-01-01T00:01:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "旧回复" }] } })
    + line({ type: "message", id: "recent-user", parentId: "old-assistant", timestamp: "2026-09-20T00:00:00.000Z", message: { role: "user", content: "新消息" } })
    + line({ type: "message", id: "recent-assistant", parentId: "recent-user", timestamp: "2026-09-20T00:01:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "新回复" }] } }),
  );
  const confirmed = store.saveCompanionMemory(context, { content: "喜欢旧茶壶", sensitivity: "ordinary", sourceEntryId: "old-user" });
  const pending = store.saveCompanionMemory(context, { content: "住在旧地址", sensitivity: "sensitive", sourceEntryId: "old-user" });
  store.recordCompanionProfileEvidence(context, { field: "reply_length", value: "short", sourceEntryId: "old-user", sourceText: "旧证据" });
  store.recordCompanionProfileEvidence(context, { field: "reply_length", value: "short", sourceEntryId: "recent-user", sourceText: "新证据" });
  store.addCompanionFragment(context, { sessionId: "session-1", startEntryId: "old-user", endEntryId: "recent-user", summary: "包含旧消息的摘要" });

  const result = pruneCompanionRawMessages(store, context, path, "2026-09-21T00:00:00.000Z");
  const entries = readFileSync(path, "utf8").trim().split("\n").map((item) => JSON.parse(item));
  assert.deepEqual(result.removedEntryIds.sort(), ["old-assistant", "old-user"]);
  assert.deepEqual(result.confirmedMemoryIds, [confirmed.id]);
  assert.equal(entries.some((entry) => entry.id === "old-user" || entry.id === "old-assistant"), false);
  assert.equal(entries.find((entry) => entry.id === "recent-user").parentId, null);
  assert.equal(store.listCompanionMemories(context).some((memory) => memory.id === pending.id), false);
  assert.equal(store.listUsableCompanionMemories(context).some((memory) => memory.id === confirmed.id), true);
  assert.equal(store.listCompanionProfileFields(context).some((field) => field.field === "reply_length"), false);
  assert.equal(store.listCompanionFragments(context).length, 0);
});

test("source deletion can separately remove its associated confirmed memory", () => {
  const path = join(root, "single.jsonl");
  writeFileSync(path,
    line({ type: "session", version: 3, id: "session-2", timestamp: "2026-09-20T00:00:00.000Z", cwd: root })
    + line({ type: "message", id: "source", parentId: null, timestamp: "2026-09-20T00:00:00.000Z", message: { role: "user", content: "我喜欢桂花茶" } })
    + line({ type: "message", id: "answer", parentId: "source", timestamp: "2026-09-20T00:01:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "记住了" }] } }),
  );
  const memory = store.saveCompanionMemory(context, { content: "喜欢桂花茶", sensitivity: "ordinary", sourceEntryId: "source" });
  deleteCompanionSourceMessage(store, context, path, "source", true);
  assert.equal(store.listUsableCompanionMemories(context).some((item) => item.id === memory.id), false);
  assert.equal(readFileSync(path, "utf8").trim().split("\n").length, 1);
});

test("memory feedback produces an inspectable personal-fact error rate", () => {
  const memory = store.saveCompanionMemory(context, { content: "喜欢乌龙茶", sensitivity: "ordinary", sourceEntryId: "feedback-source" });
  store.recordCompanionMemoryFeedback(context, memory.id, true);
  store.recordCompanionMemoryFeedback(context, memory.id, false);
  assert.deepEqual(store.getCompanionMemoryErrorMeasurement(context), { total: 2, errors: 1, errorRate: 0.5 });
});
