import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const root = mkdtempSync(join(tmpdir(), "pi-web-companion-store-"));
const originalDatabasePath = process.env.PI_WEB_DATABASE_PATH;
process.env.PI_WEB_DATABASE_PATH = join(root, "tenant.sqlite");
const jiti = createJiti(import.meta.url, { moduleCache: false });
const { TenantStore, TENANT_SCHEMA_VERSION } = await jiti.import("./tenant-store.ts");

const store = new TenantStore(process.env.PI_WEB_DATABASE_PATH);
const first = store.createTenantWithOwner({
  tenant: { name: "First", slug: "first" },
  owner: { email: "owner@first.test", displayName: "First Owner" },
});
const second = store.createTenantWithOwner({
  tenant: { name: "Second", slug: "second" },
  owner: { email: "owner@second.test", displayName: "Second Owner" },
});
after(() => {
  store.close();
  if (originalDatabasePath === undefined) delete process.env.PI_WEB_DATABASE_PATH;
  else process.env.PI_WEB_DATABASE_PATH = originalDatabasePath;
  rmSync(root, { recursive: true, force: true });
});

test("creates one immutable published config and one fixed assignment per membership", () => {
  assert.equal(store.schemaVersion(), TENANT_SCHEMA_VERSION);
  const context = { tenantId: first.tenant.id, membershipId: first.membership.id };
  const config = store.ensureCompanionConfig(context);
  const assignment = store.ensureCompanionAssignment(context, "companion-session-1");
  assert.equal(assignment.configVersionId, config.id);
  assert.equal(store.ensureCompanionAssignment(context, "a-different-session").sessionId, "companion-session-1");
  assert.equal(store.listCompanionConfigVersions(context).length, 1);
});

test("keeps companion configs, assignments, and turns tenant-scoped", () => {
  const firstContext = { tenantId: first.tenant.id, membershipId: first.membership.id };
  const secondContext = { tenantId: second.tenant.id, membershipId: second.membership.id };
  const firstConfig = store.ensureCompanionConfig(firstContext);
  const secondConfig = store.ensureCompanionConfig(secondContext);
  assert.notEqual(firstConfig.id, secondConfig.id);
  assert.equal(store.getCompanionConfigVersion(second.tenant.id, firstConfig.id), null);
  assert.equal(store.getCompanionAssignment(secondContext), null);
  const turn = store.beginCompanionTurn(firstContext, {
    sessionId: "companion-session-1", clientMessageId: "message-1", configVersionId: firstConfig.id,
    classification: "ordinary", buffered: false,
  });
  assert.equal(store.findCompanionTurn(secondContext, "message-1"), null);
  assert.equal(store.completeCompanionTurn(firstContext, turn.id, { status: "completed", replyText: "完成" }).replyText, "完成");
});

test("publishes a draft without mutating the existing published version", () => {
  const context = { tenantId: first.tenant.id, membershipId: first.membership.id };
  const original = store.ensureCompanionConfig(context);
  const draft = store.createCompanionConfigDraft(context, {
    behaviorDocument: "更温和地回应。", modelProvider: "qwen", modelId: "FY-Qwen3.8-27B-NVFP4",
    thinkingLevel: "off", temperature: 0.1, maxOutputTokens: 500,
  });
  assert.equal(draft.status, "draft");
  assert.equal(store.getCompanionConfigVersion(first.tenant.id, original.id)?.status, "published");
  assert.equal(store.publishCompanionConfig(context, draft.id).status, "published");
});
