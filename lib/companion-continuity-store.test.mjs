import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const root = mkdtempSync(join(tmpdir(), "pi-web-companion-continuity-store-"));
const jiti = createJiti(import.meta.url, { moduleCache: false });
const { TenantStore } = await jiti.import("./tenant-store.ts");
const store = new TenantStore(join(root, "tenant.sqlite"));
const first = store.createTenantWithOwner({
  tenant: { name: "First", slug: "first" },
  owner: { email: "owner@first.test", displayName: "First Owner" },
});
const second = store.createTenantWithOwner({
  tenant: { name: "Second", slug: "second" },
  owner: { email: "owner@second.test", displayName: "Second Owner" },
});
const firstContext = { tenantId: first.tenant.id, membershipId: first.membership.id };
const secondContext = { tenantId: second.tenant.id, membershipId: second.membership.id };

after(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

test("long-term memory stays off until the member independently opts in", () => {
  assert.equal(store.getCompanionConsent(firstContext).memoryEnabled, false);
  assert.throws(() => store.saveCompanionMemory(firstContext, {
    content: "喜欢喝茉莉花茶", sensitivity: "ordinary", sourceEntryId: "entry-off",
  }), /consent/i);

  const consent = store.setCompanionMemoryConsent(firstContext, true);
  assert.equal(consent.memoryEnabled, true);
  assert.ok(consent.optedInAt);
  assert.equal(store.getCompanionConsent(secondContext).memoryEnabled, false);
});

test("ordinary memories produce reversible receipts while sensitive memories wait for confirmation", () => {
  const ordinary = store.saveCompanionMemory(firstContext, {
    content: "喜欢喝茉莉花茶", sensitivity: "ordinary", sourceEntryId: "entry-tea",
  });
  assert.equal(ordinary.status, "confirmed");
  assert.equal(ordinary.receipt.reversible, true);

  const sensitive = store.saveCompanionMemory(firstContext, {
    content: "最近在治疗高血压", sensitivity: "sensitive", sourceEntryId: "entry-health",
  });
  assert.equal(sensitive.status, "pending_confirmation");
  assert.equal(store.listUsableCompanionMemories(firstContext).some((memory) => memory.id === sensitive.id), false);
  assert.equal(store.confirmCompanionMemory(firstContext, sensitive.id).status, "confirmed");
});

test("correction disables the old memory immediately and reset remains tenant-scoped", () => {
  const original = store.saveCompanionMemory(firstContext, {
    content: "每天六点散步", sensitivity: "ordinary", sourceEntryId: "entry-walk-old",
  });
  const corrected = store.correctCompanionMemory(firstContext, original.id, "每天七点散步");
  assert.equal(store.listUsableCompanionMemories(firstContext).some((memory) => memory.id === original.id), false);
  assert.equal(corrected.content, "每天·七点·日常习惯：散步运动");
  assert.equal(corrected.status, "confirmed");
  const meal = store.saveCompanionMemory(firstContext, {
    content: "我每天吃早饭", sensitivity: "ordinary", sourceEntryId: "entry-breakfast",
  });
  const healthCorrection = store.correctCompanionMemory(firstContext, meal.id, "我每天吃降压片");
  assert.equal(healthCorrection.sensitivity, "sensitive");
  assert.equal(healthCorrection.status, "pending_confirmation");
  const unknownCorrectionSource = store.saveCompanionMemory(firstContext, {
    content: "日常偏好：茶", sensitivity: "ordinary", sourceEntryId: "entry-unknown-medication",
  });
  const unknownCorrection = store.correctCompanionMemory(firstContext, unknownCorrectionSource.id, "我每天吃奥氮平");
  assert.equal(unknownCorrection.sensitivity, "sensitive");
  assert.equal(unknownCorrection.status, "pending_confirmation");
  const mixedCorrectionSource = store.saveCompanionMemory(firstContext, {
    content: "日常偏好：茶", sensitivity: "ordinary", sourceEntryId: "entry-mixed-medication",
  });
  const mixedCorrection = store.correctCompanionMemory(firstContext, mixedCorrectionSource.id, "我每天喝茶时服奥氮平");
  assert.equal(mixedCorrection.content, "我每天喝茶时服奥氮平");
  assert.equal(mixedCorrection.sensitivity, "sensitive");
  assert.equal(mixedCorrection.status, "pending_confirmation");
  const correctedFromSensitive = store.correctCompanionMemory(firstContext, healthCorrection.id, "我每天喜欢喝绿茶");
  assert.equal(correctedFromSensitive.content, "每天·喜欢：绿茶");
  assert.equal(correctedFromSensitive.sensitivity, "ordinary");
  assert.equal(correctedFromSensitive.status, "confirmed");

  store.setCompanionMemoryConsent(secondContext, true);
  store.saveCompanionMemory(secondContext, {
    content: "喜欢听评书", sensitivity: "ordinary", sourceEntryId: "entry-story",
  });
  store.resetCompanionMemories(firstContext);
  assert.equal(store.listUsableCompanionMemories(firstContext).length, 0);
  assert.equal(store.listUsableCompanionMemories(secondContext).length, 1);
});

test("the Companion Profile accepts only interaction preferences and requires repeated original evidence for inference", () => {
  const explicit = store.setCompanionProfileField(firstContext, {
    field: "form_of_address", value: "李老师", source: "explicit", confidence: 1,
  });
  assert.equal(explicit.value, "李老师");
  assert.throws(() => store.setCompanionProfileField(firstContext, {
    field: "diagnosis", value: "抑郁症", source: "explicit", confidence: 1,
  }), /profile field/i);
  assert.throws(() => store.setCompanionProfileField(firstContext, {
    field: "topics", value: "我的抑郁症", source: "explicit", confidence: 1,
  }), /prohibited/i);
  for (const value of ["糖尿病", "高血压", "双相情感障碍", "MBTI 内向", "讨好型", "中产", "女儿不孝", "婆婆讨厌我", "我的住址"]) {
    assert.throws(() => store.setCompanionProfileField(firstContext, {
      field: "topics", value, source: "explicit", confidence: 1,
    }), /prohibited/i);
  }
  const normalizedTopic = store.setCompanionProfileField(firstContext, {
    field: "topics", value: "我喜欢喝茶，婆婆总针对我", source: "explicit", confidence: 1,
  });
  assert.equal(normalizedTopic.value, "茶");

  assert.equal(store.recordCompanionProfileEvidence(firstContext, {
    field: "reply_length", value: "short", sourceEntryId: "entry-short-1", sourceText: "请说短一点",
  }), null);
  const inferred = store.recordCompanionProfileEvidence(firstContext, {
    field: "reply_length", value: "short", sourceEntryId: "entry-short-2", sourceText: "还是简短一点好",
  });
  assert.equal(inferred?.source, "inferred");
  assert.equal(inferred?.evidenceCount, 2);
  store.deleteCompanionProfileField(firstContext, "reply_length");
  assert.equal(store.recordCompanionProfileEvidence(firstContext, {
    field: "reply_length", value: "short", sourceEntryId: "entry-short-3", sourceText: "我仍然喜欢短回复",
  }), null);
});

test("background jobs are tenant-scoped and expose lease and retry state", () => {
  const job = store.enqueueCompanionBackgroundJob(firstContext, {
    type: "memory_profile", payload: { sourceEntryId: "entry-job", text: "我喜欢喝茶" },
  });
  const leased = store.leaseCompanionBackgroundJob(firstContext, "worker-1", 30_000);
  assert.equal(leased?.id, job.id);
  assert.equal(leased?.status, "leased");
  assert.equal(store.leaseCompanionBackgroundJob(secondContext, "worker-2", 30_000), null);

  const retry = store.failCompanionBackgroundJob(firstContext, job.id, "temporary", 0);
  assert.equal(retry.status, "pending");
  assert.equal(retry.attempts, 1);
  assert.equal(store.leaseCompanionBackgroundJob(firstContext, "worker-1", 30_000)?.id, job.id);
});

test("source cleanup invalidates queued summary work that references deleted entries", () => {
  store.enqueueCompanionBackgroundJob(firstContext, {
    type: "fragment_summary", payload: { sessionId: "session-1", sourceEntryIds: ["deleted-entry", "kept-entry"], summary: "摘要" },
  });
  store.removeCompanionSourceData(firstContext, ["deleted-entry"]);
  assert.equal(store.leaseCompanionBackgroundJob(firstContext, "worker-summary", 30_000), null);
});
