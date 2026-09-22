import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach } from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { TenantStore } = await jiti.import("./tenant-store.ts");
const {
  buildCompanionLayeredContext,
  applyExplicitCompanionPreference,
  queueCompanionContinuityWork,
  queueCompanionSummaryWork,
  runNextCompanionContinuityJob,
  scheduleCompanionContinuityWorker,
} = await jiti.import("./companion-continuity.ts");
const roots = [];

function setup() {
  const root = mkdtempSync(join(tmpdir(), "pi-web-companion-continuity-"));
  roots.push(root);
  const store = new TenantStore(join(root, "tenant.sqlite"));
  const tenant = store.createTenantWithOwner({
    tenant: { name: "Memory", slug: `memory-${roots.length}` },
    owner: { email: `owner-${roots.length}@memory.test`, displayName: "Owner" },
  });
  return { store, context: { tenantId: tenant.tenant.id, membershipId: tenant.membership.id } };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("background processing does not create persistent understanding while memory is off", () => {
  const { store, context } = setup();
  queueCompanionContinuityWork(store, context, { sourceEntryId: "off-1", text: "我每天早上喝茉莉花茶", sessionId: "session-1" });
  const result = runNextCompanionContinuityJob(store, context, "test-worker");
  assert.deepEqual(result?.events, []);
  assert.equal(store.listCompanionMemories(context).length, 0);
  store.close();
});

test("eligible ordinary and sensitive facts become a receipt and a confirmation request after opt-in", () => {
  const { store, context } = setup();
  store.setCompanionMemoryConsent(context, true);
  queueCompanionContinuityWork(store, context, { sourceEntryId: "tea-1", text: "我每天早上喝茉莉花茶", sessionId: "session-1" });
  queueCompanionContinuityWork(store, context, { sourceEntryId: "health-1", text: "我有高血压，一直在吃药", sessionId: "session-1" });
  queueCompanionContinuityWork(store, context, { sourceEntryId: "mood-1", text: "我今天心情很难过", sessionId: "session-1" });
  queueCompanionContinuityWork(store, context, { sourceEntryId: "diagnosis-1", text: "我一直有抑郁症", sessionId: "session-1" });

  const ordinary = runNextCompanionContinuityJob(store, context, "test-worker");
  const sensitive = runNextCompanionContinuityJob(store, context, "test-worker");
  const transient = runNextCompanionContinuityJob(store, context, "test-worker");
  const diagnosis = runNextCompanionContinuityJob(store, context, "test-worker");
  assert.equal(ordinary?.events[0]?.type, "memory_receipt");
  assert.equal(sensitive?.events[0]?.type, "memory_confirmation");
  assert.deepEqual(transient?.events, []);
  assert.equal(diagnosis?.events[0]?.type, "memory_confirmation");
  assert.equal(store.listUsableCompanionMemories(context).length, 1);
  store.close();
});

test("every sensitive category is confirmation-only even without the original keywords", () => {
  const { store, context } = setup();
  store.setCompanionMemoryConsent(context, true);
  for (const [index, text] of [
    "我一直有艾滋病", "我每天吃降压片", "我每月都要还房贷", "我每周给父亲扫墓", "我总是和女儿闹矛盾",
  ].entries()) {
    queueCompanionContinuityWork(store, context, { sourceEntryId: `sensitive-${index}`, text, sessionId: "session-1" });
    assert.equal(runNextCompanionContinuityJob(store, context, "test-worker")?.events[0]?.type, "memory_confirmation");
  }
  store.close();
});

test("unknown stable content is not auto-saved when it is outside the low-sensitivity allowlist", () => {
  const { store, context } = setup();
  store.setCompanionMemoryConsent(context, true);
  queueCompanionContinuityWork(store, context, {
    sourceEntryId: "unknown-medication", text: "我喜欢吃奥氮平", sessionId: "session-1",
  });
  assert.deepEqual(runNextCompanionContinuityJob(store, context, "test-worker")?.events, []);
  assert.deepEqual(store.listCompanionMemories(context), []);
  store.close();
});

test("automatic ordinary memory stores only normalized allowlisted topics", () => {
  const { store, context } = setup();
  store.setCompanionMemoryConsent(context, true);
  queueCompanionContinuityWork(store, context, {
    sourceEntryId: "mixed-topic", text: "我喜欢喝茶，婆婆总针对我", sessionId: "session-1",
  });
  runNextCompanionContinuityJob(store, context, "test-worker");
  assert.equal(store.listCompanionMemories(context)[0]?.content, "喜欢：茶");
  store.close();
});

test("ordinary clothing language is not mistaken for medication", () => {
  const { store, context } = setup();
  store.setCompanionMemoryConsent(context, true);
  queueCompanionContinuityWork(store, context, {
    sourceEntryId: "clothing", text: "我喜欢喝茶，也喜欢服装设计", sessionId: "session-1",
  });
  const events = runNextCompanionContinuityJob(store, context, "test-worker")?.events ?? [];
  assert.equal(events[0]?.type, "memory_receipt");
  assert.equal(store.listCompanionMemories(context)[0]?.sensitivity, "ordinary");
  store.close();
});

test("general sensitive-topic questions are not saved as personal memories", () => {
  const { store, context } = setup();
  store.setCompanionMemoryConsent(context, true);
  for (const [index, text] of ["癌症有哪些症状？", "我想了解癌症", "我朋友得了癌症", "我服气了", "我服侍父母"].entries()) {
    queueCompanionContinuityWork(store, context, {
      sourceEntryId: `general-question-${index}`, text, sessionId: "session-1",
    });
    assert.deepEqual(runNextCompanionContinuityJob(store, context, "test-worker")?.events, [], text);
  }
  assert.deepEqual(store.listCompanionMemories(context), []);
  store.close();
});

test("compact first-person medication facts still require confirmation", () => {
  const { store, context } = setup();
  store.setCompanionMemoryConsent(context, true);
  queueCompanionContinuityWork(store, context, {
    sourceEntryId: "compact-medication", text: "我服奥氮平", sessionId: "session-1",
  });
  assert.equal(runNextCompanionContinuityJob(store, context, "test-worker")?.events[0]?.type, "memory_confirmation");
  store.close();
});

test("ordinary memory keeps each clause's preference polarity", () => {
  const { store, context } = setup();
  store.setCompanionMemoryConsent(context, true);
  queueCompanionContinuityWork(store, context, {
    sourceEntryId: "mixed-polarity", text: "我不喜欢咖啡，但喜欢红茶", sessionId: "session-1",
  });
  runNextCompanionContinuityJob(store, context, "test-worker");
  assert.equal(store.listCompanionMemories(context)[0]?.content, "不喜欢：咖啡；喜欢：红茶");
  store.close();
});

test("explicit conversational preferences are applied before post-reply inference", () => {
  const { store, context } = setup();
  store.setCompanionMemoryConsent(context, true);
  const profile = applyExplicitCompanionPreference(store, context, { sourceEntryId: "address-1", text: "请叫我周老师", sessionId: "session-1" });
  assert.equal(profile?.field, "form_of_address");
  assert.equal(profile?.value, "周老师");
  store.close();
});

test("temporary instructions, emotions, and intended actions do not become persistent understanding", () => {
  const { store, context } = setup();
  store.setCompanionMemoryConsent(context, true);
  assert.equal(applyExplicitCompanionPreference(store, context, { text: "请今天说短一点" }), null);
  assert.equal(applyExplicitCompanionPreference(store, context, { text: "今天请叫我小王" }), null);
  assert.equal(applyExplicitCompanionPreference(store, context, { text: "请叫我抑郁症" }), null);
  assert.equal(applyExplicitCompanionPreference(store, context, { text: "从现在开始请说短一点" })?.value, "short");
  store.deleteCompanionProfileField(context, "reply_length");
  for (const [index, text] of ["我最近一直很难过", "我一直想去旅行", "我计划明年每天去旅游"].entries()) {
    queueCompanionContinuityWork(store, context, { sourceEntryId: `transient-${index}`, text, sessionId: "session-1" });
    assert.deepEqual(runNextCompanionContinuityJob(store, context, "test-worker")?.events, []);
  }
  for (const sourceEntryId of ["temporary-profile-1", "temporary-profile-2"]) {
    queueCompanionContinuityWork(store, context, { sourceEntryId, text: "今天我喜欢简短回复", sessionId: "session-1" });
    assert.deepEqual(runNextCompanionContinuityJob(store, context, "test-worker")?.events, []);
  }
  assert.deepEqual(store.listCompanionProfileFields(context), []);
  for (const sourceEntryId of ["durable-profile-1", "durable-profile-2"]) {
    queueCompanionContinuityWork(store, context, { sourceEntryId, text: "我喜欢简短回复，因为长回复让我焦虑", sessionId: "session-1" });
    runNextCompanionContinuityJob(store, context, "test-worker");
  }
  assert.equal(store.listCompanionProfileFields(context).some((profile) => profile.field === "reply_length"), true);
  assert.deepEqual(store.listCompanionMemories(context), []);
  store.close();
});

test("memory-off excludes every persistent memory, profile, and summary layer", () => {
  const { store, context } = setup();
  store.setCompanionMemoryConsent(context, true);
  store.setCompanionProfileField(context, { field: "form_of_address", value: "赵老师", source: "explicit", confidence: 1 });
  store.addCompanionFragment(context, { sessionId: "session-1", startEntryId: "old-1", endEntryId: "old-2", summary: "旧摘要" });
  store.setCompanionMemoryConsent(context, false);
  const layered = buildCompanionLayeredContext(store, context, { currentText: "您好", recent: [], now: "2026-09-21T00:00:00.000Z" });
  assert.deepEqual(layered, []);
  store.close();
});

test("inferred profile changes need two consistent pieces of member evidence", () => {
  const { store, context } = setup();
  store.setCompanionMemoryConsent(context, true);
  queueCompanionContinuityWork(store, context, { sourceEntryId: "short-1", text: "我喜欢简短的回复", sessionId: "session-1" });
  queueCompanionContinuityWork(store, context, { sourceEntryId: "short-2", text: "短一点读起来更轻松", sessionId: "session-1" });
  assert.equal(runNextCompanionContinuityJob(store, context, "test-worker")?.events.some((event) => event.type === "profile_updated"), false);
  assert.equal(runNextCompanionContinuityJob(store, context, "test-worker")?.events.some((event) => event.type === "profile_updated"), true);
  assert.equal(store.listCompanionProfileFields(context)[0]?.value, "short");
  store.close();
});

test("layered context uses only relevant confirmed memory, active profile, summaries, and eligible recent turns", () => {
  const { store, context } = setup();
  store.setCompanionMemoryConsent(context, true);
  store.saveCompanionMemory(context, { content: "每天早上喝茉莉花茶", sensitivity: "ordinary", sourceEntryId: "tea" });
  store.saveCompanionMemory(context, { content: "住在北京市朝阳区", sensitivity: "sensitive", sourceEntryId: "address" });
  store.saveCompanionMemory(context, { content: "喜欢听评书", sensitivity: "ordinary", sourceEntryId: "story" });
  store.setCompanionProfileField(context, { field: "form_of_address", value: "李老师", source: "explicit", confidence: 1 });
  store.addCompanionFragment(context, {
    sessionId: "session-1", startEntryId: "old-1", endEntryId: "old-9", summary: "上周聊过泡茶时用的旧茶壶。",
  });

  const layered = buildCompanionLayeredContext(store, context, {
    currentText: "今天还想聊聊茉莉花茶",
    recent: [
      { role: "user", text: "最近的一句", status: "complete", entryId: "recent-1", timestamp: "2026-09-20T00:00:00.000Z" },
      { role: "assistant", text: "未完成内容", status: "incomplete", entryId: "recent-2", timestamp: "2026-09-20T00:00:01.000Z" },
      { role: "user", text: "过期原文", status: "complete", entryId: "expired", timestamp: "2026-01-01T00:00:00.000Z" },
    ],
    now: "2026-09-21T00:00:00.000Z",
  });
  const text = layered.map((item) => item.text).join("\n");
  assert.match(text, /茉莉花茶/);
  assert.match(text, /李老师/);
  assert.match(text, /旧茶壶/);
  assert.match(text, /最近的一句/);
  assert.doesNotMatch(text, /北京市朝阳区|喜欢听评书|未完成内容|过期原文/);
  store.close();
});

test("generic phrasing overlap does not recall an unrelated memory", () => {
  const { store, context } = setup();
  store.setCompanionMemoryConsent(context, true);
  store.saveCompanionMemory(context, { content: "我喜欢听评书", sensitivity: "ordinary", sourceEntryId: "story" });
  const layered = buildCompanionLayeredContext(store, context, { currentText: "我喜欢散步", recent: [] });
  assert.equal(layered.some((item) => item.source === "memory"), false);
  store.close();
});

test("a short exact topic recalls its confirmed memory", () => {
  const { store, context } = setup();
  store.setCompanionMemoryConsent(context, true);
  store.saveCompanionMemory(context, { content: "我喜欢京剧", sensitivity: "ordinary", sourceEntryId: "opera" });
  const layered = buildCompanionLayeredContext(store, context, { currentText: "京剧好听吗", recent: [] });
  assert.equal(layered.some((item) => item.source === "memory" && item.text.includes("京剧")), true);
  store.close();
});

test("a short exact sensitive term recalls only its confirmed memory", () => {
  const { store, context } = setup();
  store.setCompanionMemoryConsent(context, true);
  const memory = store.saveCompanionMemory(context, { content: "我有癌症", sensitivity: "sensitive", sourceEntryId: "health" });
  store.confirmCompanionMemory(context, memory.id);
  const layered = buildCompanionLayeredContext(store, context, { currentText: "癌症复查", recent: [] });
  assert.equal(layered.some((item) => item.source === "memory" && item.text.includes("癌症")), true);
  store.close();
});

test("confirmed sensitive memories use specific classified entities for relevance", () => {
  const scenarios = [
    ["我有胃炎", "胃炎复查"],
    ["我有帕金森病", "帕金森复查"],
    ["我住在北京市朝阳区", "北京市朝阳区附近的公园"],
    ["我每天服阿司匹林", "阿司匹林有什么副作用"],
    ["丈夫经常和我吵架", "丈夫和我吵架后怎么办"],
    ["我的工资是五千元", "工资什么时候发"],
  ];
  for (const [content, currentText] of scenarios) {
    const { store, context } = setup();
    store.setCompanionMemoryConsent(context, true);
    const memory = store.saveCompanionMemory(context, { content, sensitivity: "sensitive", sourceEntryId: content });
    store.confirmCompanionMemory(context, memory.id);
    const layered = buildCompanionLayeredContext(store, context, { currentText, recent: [] });
    assert.equal(layered.some((item) => item.source === "memory" && item.text.includes(content)), true, content);
    store.close();
  }
});

test("a generic sensitive-category word does not recall an unrelated confirmed memory", () => {
  const { store, context } = setup();
  store.setCompanionMemoryConsent(context, true);
  const memory = store.saveCompanionMemory(context, { content: "银行卡被冻结", sensitivity: "sensitive", sourceEntryId: "bank-card" });
  store.confirmCompanionMemory(context, memory.id);
  const layered = buildCompanionLayeredContext(store, context, { currentText: "银行几点关门", recent: [] });
  assert.equal(layered.some((item) => item.source === "memory"), false);
  const pain = store.saveCompanionMemory(context, { content: "我的膝盖疼痛", sensitivity: "sensitive", sourceEntryId: "knee" });
  store.confirmCompanionMemory(context, pain.id);
  const unrelatedPain = buildCompanionLayeredContext(store, context, { currentText: "肩膀疼痛怎么办", recent: [] });
  assert.equal(unrelatedPain.some((item) => item.source === "memory" && item.text.includes("膝盖")), false);
  store.close();
});

test("fragment summaries run through the same leased background queue", () => {
  const { store, context } = setup();
  store.setCompanionMemoryConsent(context, true);
  queueCompanionSummaryWork(store, context, {
    sessionId: "session-1", sourceEntryIds: ["old-1", "old-2"], summary: "较早聊过京剧。",
  });
  assert.equal(store.listCompanionFragments(context).length, 0);
  runNextCompanionContinuityJob(store, context, "summary-worker");
  assert.equal(store.listCompanionFragments(context)[0]?.summary, "较早聊过与戏曲音乐相关的日常兴趣。");
  store.close();
});

test("scheduled continuity work completes independently of a later request", async () => {
  const { store, context } = setup();
  store.setCompanionMemoryConsent(context, true);
  queueCompanionSummaryWork(store, context, {
    sessionId: "session-1", sourceEntryIds: ["old-3", "old-4"], summary: "较早聊过散步。",
  });
  scheduleCompanionContinuityWorker(store, context, "scheduled-worker");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(store.listCompanionFragments(context)[0]?.summary, "较早聊过与散步运动相关的日常兴趣。");
  store.close();
});

test("scheduled receipts retain the originating client message identity", async () => {
  const { store, context } = setup();
  store.setCompanionMemoryConsent(context, true);
  queueCompanionContinuityWork(store, context, {
    sourceEntryId: "tea-client", text: "我每天喝茉莉花茶", sessionId: "session-1", clientMessageId: "client-tea",
  });
  const observed = [];
  scheduleCompanionContinuityWorker(store, context, "receipt-worker", (event, clientMessageId) => {
    observed.push([event.type, clientMessageId]);
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(observed, [["memory_receipt", "client-tea"]]);
  store.close();
});

test("startup-style workers defer event-producing memory jobs", async () => {
  const { store, context } = setup();
  store.setCompanionMemoryConsent(context, true);
  queueCompanionContinuityWork(store, context, {
    sourceEntryId: "deferred-memory", text: "我每天喝茶", sessionId: "session-1", clientMessageId: "client-deferred",
  });
  queueCompanionSummaryWork(store, context, {
    sessionId: "session-1", sourceEntryIds: ["summary-1", "summary-2"], summary: "较早聊过京剧。",
  });
  scheduleCompanionContinuityWorker(store, context, "startup-worker", undefined, 0, ["fragment_summary"]);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(store.listCompanionFragments(context).length, 1);
  assert.equal(store.listCompanionMemories(context).length, 0);
  assert.equal(runNextCompanionContinuityJob(store, context, "attached-worker")?.clientMessageId, "client-deferred");
  store.close();
});
