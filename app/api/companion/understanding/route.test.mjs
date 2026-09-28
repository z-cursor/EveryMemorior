import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";
import { NextRequest } from "next/server.js";

const root = mkdtempSync(join(tmpdir(), "pi-web-companion-understanding-route-"));
const originalDatabasePath = process.env.PI_WEB_DATABASE_PATH;
process.env.PI_WEB_DATABASE_PATH = join(root, "tenant.sqlite");
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const { GET, PATCH } = await jiti.import("./route.ts");
const { acceptTenantInvitation, setupTenantOwner, TENANT_SESSION_COOKIE } = await jiti.import("../../../../lib/tenant-auth.ts");
const { closeTenantStore, getTenantStore } = await jiti.import("../../../../lib/tenant-store.ts");
const auth = await setupTenantOwner({
  tenantName: "Memory", tenantSlug: "memory", displayName: "Owner",
  email: "owner@memory.test", password: "correct horse battery staple",
});
const cookie = `${TENANT_SESSION_COOKIE}=${auth.token}`;
const context = { tenantId: auth.session.tenant.id, membershipId: auth.session.membership.id };

function request(method, body, sessionCookie = cookie) {
  return new NextRequest("http://localhost/api/companion/understanding", {
    method, headers: { Cookie: sessionCookie, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}

after(() => {
  closeTenantStore();
  if (originalDatabasePath === undefined) delete process.env.PI_WEB_DATABASE_PATH;
  else process.env.PI_WEB_DATABASE_PATH = originalDatabasePath;
  rmSync(root, { recursive: true, force: true });
});

test("admin has their own companion memory consent and profile", async () => {
  const token = "admin-memory-invitation";
  getTenantStore().createInvitation(context, {
    email: "admin@memory.test", role: "admin",
    tokenHash: createHash("sha256").update(token).digest("hex"),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const admin = await acceptTenantInvitation({ token, displayName: "Admin", password: "correct horse battery staple" });
  const adminCookie = `${TENANT_SESSION_COOKIE}=${admin.token}`;
  const adminContext = { tenantId: admin.session.tenant.id, membershipId: admin.session.membership.id };
  const assignment = getTenantStore().ensureCompanionAssignment(adminContext, "admin-companion-session");
  assert.equal(assignment.membershipId, adminContext.membershipId);
  assert.equal(getTenantStore().getCompanionAssignment(context), null);
  const initial = await GET(request("GET", undefined, adminCookie));
  assert.equal((await initial.json()).consent.memoryEnabled, false);
  assert.equal((await PATCH(request("PATCH", { action: "set_consent", enabled: true }, adminCookie))).status, 200);
  assert.equal((await PATCH(request("PATCH", { action: "set_profile", field: "form_of_address", value: "小何" }, adminCookie))).status, 200);
  const own = await GET(request("GET", undefined, adminCookie));
  assert.equal((await own.json()).profile.find((item) => item.field === "form_of_address")?.value, "小何");
  const owner = await GET(request("GET"));
  assert.equal((await owner.json()).profile.some((item) => item.value === "小何"), false);
});

test("member can stay memory-off, opt in independently, and inspect the privacy boundary", async () => {
  const initial = await GET(request("GET"));
  const initialBody = await initial.json();
  assert.equal(initialBody.consent.memoryEnabled, false);
  assert.equal(initialBody.privacy.rawRetentionDays, 90);
  assert.match(initialBody.explanation, /AI/);
  const blockedProfile = await PATCH(request("PATCH", { action: "set_profile", field: "reply_length", value: "short" }));
  assert.equal(blockedProfile.status, 400);

  const enabled = await PATCH(request("PATCH", { action: "set_consent", enabled: true }));
  assert.equal(enabled.status, 200);
  assert.equal((await enabled.json()).consent.memoryEnabled, true);
});

test("member can confirm, correct, delete, and reset remembered information", async () => {
  const store = getTenantStore();
  const pending = store.saveCompanionMemory(context, {
    content: "我有高血压", sensitivity: "sensitive", sourceEntryId: "health-1",
  });
  const confirmed = await PATCH(request("PATCH", { action: "confirm_memory", memoryId: pending.id }));
  assert.equal((await confirmed.json()).memory.status, "confirmed");

  const corrected = await PATCH(request("PATCH", { action: "correct_memory", memoryId: pending.id, content: "血压已经恢复正常" }));
  const correctedBody = await corrected.json();
  assert.equal(correctedBody.memory.content, "血压已经恢复正常");
  assert.equal(correctedBody.memory.status, "pending_confirmation");
  assert.equal(store.listUsableCompanionMemories(context).some((memory) => memory.id === pending.id), false);
  const reconfirmed = await PATCH(request("PATCH", { action: "confirm_memory", memoryId: correctedBody.memory.id }));
  assert.equal((await reconfirmed.json()).memory.status, "confirmed");

  assert.equal((await PATCH(request("PATCH", { action: "delete_memory", memoryId: correctedBody.memory.id }))).status, 200);
  assert.equal((await PATCH(request("PATCH", { action: "reset_memories" }))).status, 200);
});

test("member controls only the restricted Companion Profile", async () => {
  const updated = await PATCH(request("PATCH", {
    action: "set_profile", field: "form_of_address", value: "王老师",
  }));
  assert.equal((await updated.json()).profile.value, "王老师");

  const prohibited = await PATCH(request("PATCH", {
    action: "set_profile", field: "diagnosis", value: "抑郁症",
  }));
  assert.equal(prohibited.status, 400);
  assert.match((await prohibited.json()).error, /Profile field/i);
});

test("profile dropdown values can be saved again without changing their meaning", async () => {
  for (const [field, value] of [["boundaries", "no_follow_up_questions"], ["topics", "饮食"]]) {
    const response = await PATCH(request("PATCH", { action: "set_profile", field, value }));
    const body = await response.json();
    assert.equal(response.status, 200, `${field}: ${JSON.stringify(body)}`);
    assert.equal(body.profile.value, value);
    const savedAgain = await PATCH(request("PATCH", { action: "set_profile", field, value: body.profile.value }));
    assert.equal(savedAgain.status, 200);
  }
});

test("member can inspect, correct, delete, and reset older fragment summaries", async () => {
  const store = getTenantStore();
  const fragment = store.addCompanionFragment(context, {
    sessionId: "session-1", startEntryId: "fragment-1", endEntryId: "fragment-2",
    summary: "较早聊过京剧。",
  });
  const loaded = await GET(request("GET"));
  assert.equal((await loaded.json()).fragments.some((item) => item.id === fragment.id), true);
  const corrected = await PATCH(request("PATCH", {
    action: "correct_fragment", fragmentId: fragment.id, summary: "较早聊过京剧和评书。",
  }));
  assert.match((await corrected.json()).fragment.summary, /阅读听书/);
  assert.equal((await PATCH(request("PATCH", { action: "delete_fragment", fragmentId: fragment.id }))).status, 200);
  store.addCompanionFragment(context, {
    sessionId: "session-1", startEntryId: "fragment-3", endEntryId: "fragment-4", summary: "较早聊过散步。",
  });
  assert.equal((await PATCH(request("PATCH", { action: "reset_fragments" }))).status, 200);
  assert.equal(store.listCompanionFragments(context).length, 0);
});

test("request tenant identifiers cannot escape the authenticated membership", async () => {
  const response = await PATCH(request("PATCH", {
    action: "set_profile", tenantId: "attacker-tenant", membershipId: "attacker-member",
    field: "reply_length", value: "short",
  }));
  assert.equal(response.status, 200);
  assert.equal(getTenantStore().listCompanionProfileFields(context).some((field) => field.field === "reply_length"), true);
});

test("memory accuracy feedback is measurable through the authenticated API", async () => {
  const memory = getTenantStore().saveCompanionMemory(context, {
    content: "喜欢听京剧", sensitivity: "ordinary", sourceEntryId: "metric-source",
  });
  const response = await PATCH(request("PATCH", { action: "memory_feedback", memoryId: memory.id, correct: false }));
  const body = await response.json();
  assert.equal(body.measurement.errors >= 1, true);
  assert.equal(body.measurement.errorRate > 0, true);
});

test("correcting changed memory records a personal-fact error", async () => {
  const store = getTenantStore();
  const memory = store.saveCompanionMemory(context, {
    content: "我每天喝红茶", sensitivity: "ordinary", sourceEntryId: "correction-metric-source",
  });
  const before = store.getCompanionMemoryErrorMeasurement(context);
  const response = await PATCH(request("PATCH", {
    action: "correct_memory", memoryId: memory.id, content: "我每天喝茉莉花茶",
  }));
  assert.equal(response.status, 200);
  const after = store.getCompanionMemoryErrorMeasurement(context);
  assert.equal(after.total, before.total + 1);
  assert.equal(after.errors, before.errors + 1);
});
