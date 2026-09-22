import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const root = mkdtempSync(join(tmpdir(), "pi-web-companion-runtime-"));
const originalDatabasePath = process.env.PI_WEB_DATABASE_PATH;
process.env.PI_WEB_DATABASE_PATH = join(root, "tenant.sqlite");
const jiti = createJiti(import.meta.url, { moduleCache: false });
const { setupTenantOwner } = await jiti.import("./tenant-auth.ts");
const { CompanionRuntime, classifyCompanionInput, coalesceCompanionText } = await jiti.import("./companion-runtime.ts");
const { closeTenantStore } = await jiti.import("./tenant-store.ts");

const ownerAuth = await setupTenantOwner({
  tenantName: "First", tenantSlug: "first", displayName: "Owner",
  email: "owner@first.test", password: "correct horse battery staple",
});
after(() => {
  closeTenantStore();
  if (originalDatabasePath === undefined) delete process.env.PI_WEB_DATABASE_PATH;
  else process.env.PI_WEB_DATABASE_PATH = originalDatabasePath;
  rmSync(root, { recursive: true, force: true });
});

test("classifies urgent, sensitive, current-fact, and ordinary companion inputs", () => {
  assert.equal(classifyCompanionInput("我现在想自杀"), "urgent_danger");
  assert.equal(classifyCompanionInput("我的银行卡密码是 1234"), "sensitive");
  assert.equal(classifyCompanionInput("今天北京天气怎么样"), "current_fact");
  assert.equal(classifyCompanionInput("阳光很好，谢谢你"), "ordinary");
});

test("coalesces a short burst without creating blank lines or empty turns", () => {
  assert.equal(coalesceCompanionText(["第一句", "  ", "第二句"]), "第一句\n第二句");
});

test("streams ordinary turns and excludes incomplete or rejected context", async () => {
  const seen = [];
  const runtime = new CompanionRuntime({
    persistence: {
      getAssignment: () => ({ tenantId: ownerAuth.session.tenant.id, membershipId: ownerAuth.session.membership.id, sessionId: "session-1", configVersionId: "config-1" }),
      getConfig: () => ({
        id: "config-1", tenantId: ownerAuth.session.tenant.id, version: 1, status: "published",
        behaviorDocument: "回应具体感受，默认使用您。", modelProvider: "test", modelId: "test-model",
        thinkingLevel: "off", temperature: 0.2, maxOutputTokens: 300, createdAt: "2026-01-01T00:00:00.000Z", publishedAt: "2026-01-01T00:00:00.000Z",
      }),
      findTurn: () => null,
      beginTurn: (_context, input) => ({ ...input, id: "turn-1", status: "running" }),
      completeTurn: (_context, _turnId, input) => ({ id: "turn-1", tenantId: ownerAuth.session.tenant.id, membershipId: ownerAuth.session.membership.id, sessionId: "session-1", clientMessageId: "client-1", configVersionId: "config-1", classification: "ordinary", buffered: false, createdAt: "2026-01-01T00:00:00.000Z", replyText: input.replyText ?? null, failureType: input.failureType ?? null, firstVisibleAt: input.firstVisibleAt ?? null, completedAt: input.completedAt ?? null, status: input.status }),
    },
    context: () => [
      { role: "user", text: "保留的上一句", status: "complete" },
      { role: "assistant", text: "已审核的回复", status: "complete" },
      { role: "assistant", text: "未完成的候选", status: "incomplete" },
      { role: "assistant", text: "被拒绝的候选", status: "rejected" },
    ],
    generate: async (request, onDelta) => {
      seen.push(request);
      await onDelta("您好，");
      await onDelta("我记得这件小事。");
      return "您好，我记得这件小事。";
    },
  });
  const events = [];
  const result = await runtime.runCompanionTurn({
    auth: ownerAuth.session,
    sessionId: "session-1",
    clientMessageId: "client-1",
    text: "我想聊聊那件小事",
  }, (event) => events.push(event));

  assert.equal(result.status, "completed", JSON.stringify({ result, events }));
  assert.deepEqual(events.filter((event) => event.type === "text_delta").map((event) => event.text), ["您好，", "我记得这件小事。"]);
  assert.match(seen[0].systemPrompt, /回应具体感受/);
  assert.match(seen[0].context.map((item) => item.text).join("\n"), /保留的上一句/);
  assert.doesNotMatch(seen[0].context.map((item) => item.text).join("\n"), /未完成|被拒绝/);
});

test("buffers risky turns until review approves them", async () => {
  const events = [];
  const generated = [];
  const runtime = new CompanionRuntime({
    persistence: {
      getAssignment: () => ({ tenantId: "tenant-1", membershipId: "member-1", sessionId: "session-1", configVersionId: "config-1" }),
      getConfig: () => ({
        id: "config-1", tenantId: "tenant-1", version: 1, status: "published", behaviorDocument: "安全优先。", modelProvider: "test", modelId: "test-model", thinkingLevel: "off", temperature: 0, maxOutputTokens: 300, createdAt: "2026-01-01T00:00:00.000Z", publishedAt: "2026-01-01T00:00:00.000Z",
      }),
      findTurn: () => null,
      beginTurn: (_context, input) => ({ ...input, id: "turn-2", status: "running" }),
      completeTurn: (_context, _turnId, input) => ({ id: "turn-2", tenantId: "tenant-1", membershipId: "member-1", sessionId: "session-1", clientMessageId: "client-2", configVersionId: "config-1", classification: "professional", buffered: true, createdAt: "2026-01-01T00:00:00.000Z", replyText: input.replyText ?? null, failureType: input.failureType ?? null, firstVisibleAt: input.firstVisibleAt ?? null, completedAt: input.completedAt ?? null, status: input.status }),
    },
    context: () => [],
    generate: async (_request, onDelta) => {
      generated.push(true);
      await onDelta("危险候选不应提前出现");
      return "经过审核的安全回复";
    },
    review: async () => ({ approved: true }),
  });
  const result = await runtime.runCompanionTurn({ auth: { tenant: { id: "tenant-1" }, membership: { id: "member-1" } }, sessionId: "session-1", clientMessageId: "client-2", text: "我需要医疗建议" }, (event) => events.push(event));

  assert.equal(result.status, "completed", JSON.stringify({ result, events }));
  assert.equal(generated.length, 1);
  assert.equal(events.some((event) => event.type === "text_delta"), false);
  assert.equal(events.at(-1).type, "turn_completed");
});

test("returns the persisted result for an idempotent retry", async () => {
  let generationCount = 0;
  const persisted = { id: "turn-3", status: "completed", replyText: "已经完成" };
  const runtime = new CompanionRuntime({
    persistence: {
      getAssignment: () => ({ tenantId: "tenant-1", membershipId: "member-1", sessionId: "session-1", configVersionId: "config-1" }),
      getConfig: () => ({ id: "config-1", tenantId: "tenant-1", version: 1, status: "published", behaviorDocument: "", modelProvider: "test", modelId: "test-model", thinkingLevel: "off", temperature: 0, maxOutputTokens: 300, createdAt: "2026-01-01T00:00:00.000Z", publishedAt: "2026-01-01T00:00:00.000Z" }),
      findTurn: () => persisted,
      beginTurn: () => { throw new Error("must not begin a duplicate turn"); },
      completeTurn: (input) => input,
    },
    context: () => [],
    generate: async () => { generationCount += 1; return "不会生成"; },
  });
  const events = [];
  const result = await runtime.runCompanionTurn({ auth: { tenant: { id: "tenant-1" }, membership: { id: "member-1" } }, sessionId: "session-1", clientMessageId: "client-3", text: "重试" }, (event) => events.push(event));

  assert.equal(generationCount, 0);
  assert.equal(result.status, "completed");
  assert.equal(result.replyText, "已经完成");
  assert.equal(events[0].type, "turn_replayed");
});

test("does not leak a rejected buffered candidate and reports interrupted output as incomplete", async () => {
  const events = [];
  const runtime = new CompanionRuntime({
    persistence: {
      getAssignment: () => ({ tenantId: "tenant-1", membershipId: "member-1", sessionId: "session-1", configVersionId: "config-1" }),
      getConfig: () => ({ id: "config-1", tenantId: "tenant-1", version: 1, status: "published", behaviorDocument: "", modelProvider: "test", modelId: "test-model", thinkingLevel: "off", temperature: 0, maxOutputTokens: 300, createdAt: "2026-01-01T00:00:00.000Z", publishedAt: "2026-01-01T00:00:00.000Z" }),
      findTurn: () => null,
      beginTurn: (_context, input) => ({ ...input, id: "turn-4", status: "running" }),
      completeTurn: (_context, _turnId, input) => ({ id: "turn-4", tenantId: "tenant-1", membershipId: "member-1", sessionId: "session-1", clientMessageId: "client-4", configVersionId: "config-1", classification: "professional", buffered: true, createdAt: "2026-01-01T00:00:00.000Z", replyText: input.replyText ?? null, failureType: input.failureType ?? null, firstVisibleAt: null, completedAt: null, status: input.status }),
    },
    context: () => [],
    generate: async (_request, onDelta, signal) => {
      await onDelta("候选内容不应泄漏");
      if (signal?.aborted) throw new DOMException("stopped", "AbortError");
      return "候选内容不应泄漏";
    },
    review: async () => ({ approved: false }),
  });
  const result = await runtime.runCompanionTurn({ auth: { tenant: { id: "tenant-1" }, membership: { id: "member-1" } }, sessionId: "session-1", clientMessageId: "client-4", text: "我需要医疗建议" }, (event) => events.push(event));
  assert.equal(result.status, "rejected");
  assert.equal(result.replyText, null);
  assert.equal(events.at(-1).type, "turn_incomplete");
  assert.equal(events.at(-1).visibleText, "");
});

test("minimizes current-fact search to the current question and reports failed verification", async () => {
  let query = "";
  let generated = false;
  const runtime = new CompanionRuntime({
    persistence: {
      getAssignment: () => ({ tenantId: "tenant-1", membershipId: "member-1", sessionId: "session-1", configVersionId: "config-1" }),
      getConfig: () => ({ id: "config-1", tenantId: "tenant-1", version: 1, status: "published", behaviorDocument: "", modelProvider: "test", modelId: "test-model", thinkingLevel: "off", temperature: 0, maxOutputTokens: 300, createdAt: "2026-01-01T00:00:00.000Z", publishedAt: "2026-01-01T00:00:00.000Z" }),
      findTurn: () => null,
      beginTurn: (_context, input) => ({ ...input, id: "turn-5", status: "running" }),
      completeTurn: (_context, _turnId, input) => ({ id: "turn-5", tenantId: "tenant-1", membershipId: "member-1", sessionId: "session-1", clientMessageId: "client-5", configVersionId: "config-1", classification: "current_fact", buffered: true, createdAt: "2026-01-01T00:00:00.000Z", replyText: input.replyText ?? null, failureType: null, firstVisibleAt: null, completedAt: null, status: input.status }),
    },
    context: () => [{ role: "user", text: "与问题无关的个人住址", status: "complete" }],
    search: async (currentQuestion) => { query = currentQuestion; return null; },
    generate: async () => { generated = true; return "不应把模型常识当成最新事实"; },
  });
  const result = await runtime.runCompanionTurn({ auth: { tenant: { id: "tenant-1" }, membership: { id: "member-1" } }, sessionId: "session-1", clientMessageId: "client-5", text: "今天北京天气怎么样" }, () => undefined);
  assert.equal(query, "今天北京天气怎么样");
  assert.equal(generated, true);
  assert.match(result.replyText, /暂时无法核实/);
});

test("prepares layered context against the current member message", async () => {
  let contextQuery = "";
  let modelContext = [];
  const lifecycle = [];
  const runtime = new CompanionRuntime({
    persistence: {
      getAssignment: () => ({ tenantId: "tenant-1", membershipId: "member-1", sessionId: "session-1", configVersionId: "config-1" }),
      getConfig: () => ({ id: "config-1", tenantId: "tenant-1", version: 1, status: "published", behaviorDocument: "", modelProvider: "test", modelId: "test-model", thinkingLevel: "off", temperature: 0, maxOutputTokens: 300, createdAt: "2026-01-01T00:00:00.000Z", publishedAt: "2026-01-01T00:00:00.000Z" }),
      findTurn: () => null,
      beginTurn: (_context, input) => ({ ...input, id: "turn-6", status: "running" }),
      completeTurn: (_context, _turnId, input) => ({ id: "turn-6", tenantId: "tenant-1", membershipId: "member-1", sessionId: "session-1", clientMessageId: "client-6", configVersionId: "config-1", classification: "ordinary", buffered: false, createdAt: "2026-01-01T00:00:00.000Z", replyText: input.replyText ?? null, failureType: null, firstVisibleAt: null, completedAt: null, status: input.status }),
    },
    beforeContext: (input) => { lifecycle.push(`before:${input.text}`); },
    context: (_auth, _assignment, currentText) => {
      lifecycle.push("context");
      contextQuery = currentText;
      return [{ role: "user", text: "我可能记得：您喜欢茉莉花茶。如果不对请纠正。", status: "complete", source: "memory" }];
    },
    generate: async (request) => { modelContext = request.context; return "我们接着聊茶。"; },
    afterCompleted: (input) => { lifecycle.push(`after:${input.text}`); },
  });

  await runtime.runCompanionTurn({ auth: { tenant: { id: "tenant-1" }, membership: { id: "member-1" } }, sessionId: "session-1", clientMessageId: "client-6", text: "今天还想聊茶" }, () => undefined);
  assert.equal(contextQuery, "今天还想聊茶");
  assert.equal(modelContext[0].source, "memory");
  assert.deepEqual(lifecycle, ["before:今天还想聊茶", "context", "after:今天还想聊茶"]);
});
