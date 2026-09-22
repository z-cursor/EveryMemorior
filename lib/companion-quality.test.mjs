import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const root = mkdtempSync(join(tmpdir(), "pi-web-companion-quality-"));
const jiti = createJiti(import.meta.url, { moduleCache: false });
const { TenantStore } = await jiti.import("./tenant-store.ts");
const { calculateCompanionTrialMetrics, passesCompanionTrialGate, shouldSampleCompanionTurn } = await jiti.import("./companion-quality.ts");
const store = new TenantStore(join(root, "tenant.sqlite"));

function invite(context, email, role, token) {
  store.createInvitation(context, {
    email,
    role,
    tokenHash: token.repeat(64),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  return store.acceptInvitation({
    tokenHash: token.repeat(64),
    displayName: email,
    credential: { hash: "hash", algorithm: "test" },
  }).membership;
}

const first = store.createTenantWithOwner({
  tenant: { name: "First", slug: "first-quality" },
  owner: { email: "owner@first-quality.test", displayName: "Owner" },
});
const owner = { tenantId: first.tenant.id, membershipId: first.membership.id };
const adminMember = invite(owner, "admin@first-quality.test", "admin", "a");
const member = invite(owner, "member@first-quality.test", "member", "b");
const nonTrialMember = invite(owner, "outside@first-quality.test", "member", "c");
const admin = { tenantId: first.tenant.id, membershipId: adminMember.id };
const participant = { tenantId: first.tenant.id, membershipId: member.id };

after(() => {
  store.close();
  rmSync(root, { recursive: true, force: true });
});

test("quality review requires independent consent and exposes only a minimized tenant-scoped fragment", () => {
  const config = store.ensureCompanionConfig(owner);
  assert.equal(store.getCompanionReviewConsent(participant).enabled, false);
  assert.throws(() => store.createCompanionQualitySample(admin, {
    membershipId: member.id,
    configVersionId: config.id,
    messages: [{ entryId: "entry-1", role: "user", text: "今天去公园走了走。" }],
  }), /consent/i);

  store.setCompanionReviewConsent(participant, true, "internal-trial-v1");
  const sample = store.createCompanionQualitySample(admin, {
    membershipId: member.id,
    configVersionId: config.id,
    messages: [
      { entryId: "entry-1", role: "user", text: "今天去公园走了走。" },
      { entryId: "entry-2", role: "assistant", text: "秋风吹着，走一走也很舒服。" },
    ],
  });
  assert.deepEqual(sample.messages.map(({ role, text }) => ({ role, text })), [
    { role: "user", text: "今天去公园走了走。" },
    { role: "assistant", text: "秋风吹着，走一走也很舒服。" },
  ]);
  assert.equal(sample.configVersionId, config.id);
  assert.equal(store.listCompanionQualitySamples(admin).length, 1);
  assert.throws(() => store.listCompanionQualitySamples(participant), /Owner or admin/i);
  assert.throws(() => store.createCompanionQualitySample(admin, {
    membershipId: member.id,
    configVersionId: config.id,
    messages: Array.from({ length: 7 }, (_, index) => ({
      entryId: `entry-${index + 10}`,
      role: index % 2 ? "assistant" : "user",
      text: "不应允许整段历史进入抽样。",
    })),
  }), /six messages/i);

  store.setCompanionReviewConsent(participant, false, "internal-trial-v1");
  assert.throws(() => store.createCompanionQualitySample(admin, {
    membershipId: member.id,
    configVersionId: config.id,
    messages: [{ entryId: "entry-3", role: "user", text: "撤回后不能继续抽样。" }],
  }), /consent/i);
});

test("completed turns create trusted two-message samples only while consent remains active", () => {
  const assignment = store.ensureCompanionAssignment(participant, "trusted-sampling-session");
  store.setCompanionReviewConsent(participant, true, "internal-trial-v1");
  const turn = store.beginCompanionTurn(participant, {
    sessionId: assignment.sessionId, clientMessageId: "trusted-sample-turn", configVersionId: assignment.configVersionId,
    classification: "ordinary", buffered: false,
  });
  store.completeCompanionTurn(participant, turn.id, { status: "completed", replyText: "傍晚走一走，风也柔和些。" });
  const sample = store.sampleCompletedCompanionTurn(participant, { turnId: turn.id, userText: "我叫张三，住在北京市朝阳区幸福路12号，电话是 13812345678，护照 E12345678。", assistantText: "傍晚走一走，风也柔和些。" });
  assert.equal(sample.messages.length, 2);
  assert.equal(sample.configVersionId, assignment.configVersionId);
  assert.equal(sample.messages[0].text.includes("13812345678"), false);
  assert.equal(sample.messages[0].text.includes("张三"), false);
  assert.equal(sample.messages[0].text.includes("幸福路"), false);
  assert.equal(sample.messages[0].text.includes("E12345678"), false);
  assert.equal(store.sampleCompletedCompanionTurn(participant, { turnId: turn.id, userText: "我是张三，今天很开心。", assistantText: "听起来今天心情不错。" }), null);
  assert.equal(store.sampleCompletedCompanionTurn(participant, { turnId: turn.id, userText: "北京朝阳区幸福路12号是我家。", assistantText: "您很熟悉那一带。" }), null);
  assert.equal(store.sampleCompletedCompanionTurn(participant, { turnId: turn.id, userText: "我在北京大学退休。", assistantText: "退休后节奏会不一样。" }), null);
  store.setCompanionReviewConsent(participant, false, "internal-trial-v1");
  assert.equal(store.sampleCompletedCompanionTurn(participant, { turnId: turn.id, userText: "不再抽样", assistantText: "好的" }), null);
});

test("review evidence creates only an advisory diff and publication remains human-gated", () => {
  const config = store.ensureCompanionConfig(owner);
  store.setCompanionReviewConsent(participant, true, "internal-trial-v1");
  const sample = store.createCompanionQualitySample(admin, {
    membershipId: member.id,
    configVersionId: config.id,
    messages: [
      { entryId: "review-user-1", role: "user", text: "我先歇一会儿，不聊了。" },
      { entryId: "review-assistant-1", role: "assistant", text: "您最想聊哪一件事？" },
    ],
  });
  const review = store.recordCompanionQualityReview(admin, sample.id, {
    specificallyResponsive: false,
    interrogation: true,
    ignoredEnding: true,
    baselineViolation: false,
    notes: "明确结束后仍追问。",
  });
  const proposedDocument = `${config.behaviorDocument}\n用户明确结束时自然收束，不再追问。`;
  const proposal = store.createCompanionImprovementProposal(admin, {
    sourceType: "review",
    sourceId: review.id,
    baseConfigVersionId: config.id,
    evidence: [{ sourceId: review.id, quote: "我先歇一会儿，不聊了。" }],
    proposedBehaviorDocument: proposedDocument,
  });

  assert.equal(proposal.status, "advisory");
  assert.match(proposal.diff, /\+用户明确结束时自然收束/);
  assert.equal(store.listCompanionConfigVersions(owner).length, 1);

  const accepted = store.acceptCompanionImprovementProposal(admin, proposal.id, proposedDocument);
  assert.equal(accepted.proposal.status, "accepted");
  assert.equal(accepted.draft.status, "draft");
  assert.throws(() => store.publishCompanionConfig(admin, accepted.draft.id), /completed evaluation/i);
});

test("evaluation snapshots compare only matching graders and require calibration before small deltas", () => {
  const config = store.ensureCompanionConfig(owner);
  const fullQuestions = Array.from({ length: 500 }, (_, index) => ({ id: `q-${index}` }));
  const fullAnswers = Array.from({ length: 500 }, (_, index) => ({ id: `q-${index}`, answer: "reference" }));
  const run = store.createCompanionEvaluationRun(admin, {
    configVersionId: config.id, suite: "full", evaluationMode: "single_turn", graderVersion: "grader-v1",
    candidate: { behaviorDocument: config.behaviorDocument }, questions: fullQuestions,
    privateAnswers: fullAnswers, graderPrompt: "grade", graderModel: "FY-Qwen",
    parameters: { temperature: 0, thinking: false }, policy: { fatal: ["identity_deception"] }, itemCount: 500,
    averageScore: 86, fatalCount: 0, results: fullQuestions.map(({ id }) => ({ id, finalTotal: 86 })),
  });
  assert.equal(store.compareCompanionEvaluationRuns(admin, run.id, run.id).comparable, true);
  const changedGrader = store.createCompanionEvaluationRun(admin, {
    configVersionId: config.id, suite: "full", evaluationMode: "single_turn", graderVersion: "grader-v2",
    candidate: { behaviorDocument: config.behaviorDocument }, questions: fullQuestions,
    privateAnswers: fullAnswers, graderPrompt: "grade v2", graderModel: "FY-Qwen",
    parameters: { temperature: 0, thinking: false }, policy: { fatal: ["identity_deception"] }, itemCount: 500,
    averageScore: 87, fatalCount: 0, results: fullQuestions.map(({ id }) => ({ id, finalTotal: 87 })),
  });
  assert.equal(store.compareCompanionEvaluationRuns(admin, run.id, changedGrader.id).comparable, false);
  const bridge = store.createCompanionEvaluationRun(admin, {
    configVersionId: config.id, suite: "full", evaluationMode: "single_turn", graderVersion: "grader-v2",
    bridgeFromGraderVersion: "grader-v1", candidate: { behaviorDocument: config.behaviorDocument }, questions: fullQuestions,
    privateAnswers: fullAnswers, graderPrompt: "grade v2", graderModel: "FY-Qwen",
    parameters: { temperature: 0, thinking: false }, policy: { fatal: ["identity_deception"] }, itemCount: 500,
    averageScore: 86, fatalCount: 0, results: fullQuestions.map(({ id }) => ({ id, finalTotal: 86 })),
  });
  assert.equal(bridge.status, "completed");
  assert.deepEqual(store.compareCompanionEvaluationRuns(admin, run.id, bridge.id), {
    comparable: false,
    bridgeEstablished: true,
    reason: "grader versions are related by a bridge run but are not directly comparable",
  });
  assert.equal(store.getCompanionCalibration(admin).ready, false);
  for (let index = 0; index < 12; index += 1) store.recordCompanionCalibration(admin, {
    runId: bridge.id, itemId: `q-${index}`, band: index < 4 ? "high" : index < 8 ? "low" : "borderline", humanScore: index < 4 ? 90 : index < 8 ? 30 : 60,
    notes: "人工校准",
  });
  assert.equal(store.getCompanionCalibration(admin).ready, true);
});

test("migration previews affected participants, refuses busy sessions, and reconstructs audit history", () => {
  const current = store.ensureCompanionConfig(owner);
  store.ensureCompanionAssignment(participant, "companion-member-session");
  const draft = store.createCompanionConfigDraft(owner, {
    behaviorDocument: "新版本行为", modelProvider: "qwen", modelId: "FY-Qwen3.8-27B-NVFP4",
    thinkingLevel: "off", temperature: 0.2, maxOutputTokens: 600,
  });
  store.createCompanionEvaluationRun(owner, {
    configVersionId: draft.id, suite: "quick", evaluationMode: "single_turn", graderVersion: "grader-migration",
    candidate: {}, questions: Array.from({ length: 8 }, (_, index) => ({ id: `migration-q-${index}` })), privateAnswers: Array.from({ length: 8 }, (_, index) => ({ id: `migration-q-${index}`, answer: "private" })),
    graderPrompt: "grade", graderModel: "FY-Qwen", parameters: {}, policy: {}, itemCount: 8, averageScore: 90, fatalCount: 0,
    results: Array.from({ length: 8 }, (_, index) => ({ id: `migration-q-${index}`, finalTotal: 90 })),
  });
  const target = store.publishCompanionConfig(owner, draft.id);
  const preview = store.previewCompanionMigration(admin, member.id, target.id);
  assert.equal(preview.current.configVersionId, current.id);
  assert.equal(preview.target.id, target.id);
  assert.deepEqual(preview.affectedMembershipIds, [member.id]);
  assert.throws(() => store.migrateCompanionAssignment(admin, member.id, target.id, { sessionBusy: true }), /generating/i);
  const migrated = store.migrateCompanionAssignment(admin, member.id, target.id, { reason: "trial rollback test" });
  assert.equal(migrated.configVersionId, target.id);
  assert.equal(store.listTenantAuditEvents(admin).some((event) => event.action === "companion.assignment.migrated"), true);
});

test("trial readout excludes pre-enrollment activity and obsolete configuration gates", () => {
  store.enrollCompanionTrialParticipant(admin, {
    membershipId: member.id,
    startedAt: new Date(Date.now() - 15 * 86_400_000).toISOString(),
    excludesDirectIdentifiers: true,
    fictionalSensitiveExercises: true,
  });
  const outside = { tenantId: first.tenant.id, membershipId: nonTrialMember.id };
  store.setCompanionReviewConsent(outside, true, "internal-trial-v1");
  const config = store.ensureCompanionConfig(owner);
  const sample = store.createCompanionQualitySample(admin, {
    membershipId: nonTrialMember.id, configVersionId: config.id,
    messages: [{ entryId: "outside-1", role: "assistant", text: "不应进入试用统计。" }],
  });
  store.recordCompanionQualityReview(admin, sample.id, {
    specificallyResponsive: false, interrogation: true, ignoredEnding: true, baselineViolation: true, notes: "非试用成员",
  });
  store.enrollCompanionTrialParticipant(admin, {
    membershipId: nonTrialMember.id,
    startedAt: new Date(Date.now() + 86_400_000).toISOString(),
    excludesDirectIdentifiers: true,
    fictionalSensitiveExercises: true,
  });
  const readout = store.getCompanionTrialReadout(admin);
  assert.equal(readout.participantCount, 2);
  assert.equal(readout.baselineViolations, 0, "reviews from before enrollment are outside the trial window");
  assert.equal(readout.fullEvaluationReady, false, "a full run for an obsolete assignment cannot unlock expansion");
});

test("trial metrics report denominators and enforce every expansion gate", () => {
  const metrics = calculateCompanionTrialMetrics({
    baselineViolations: 0,
    sampledConversations: [
      { specificallyResponsive: true, interrogation: false, ignoredEnding: false },
      { specificallyResponsive: true, interrogation: false, ignoredEnding: false },
      { specificallyResponsive: false, interrogation: true, ignoredEnding: false },
    ],
    memoryErrors: 1,
    memoryChecks: 100,
    ordinaryFirstVisibleMs: [900, 1_400, 2_900],
    ordinaryCompletionMs: [4_000, 8_000, 9_500],
    bufferedCompletionMs: [11_000, 12_000],
    exitInterviews: [{ willingToContinue: true }, { willingToContinue: false }, { willingToContinue: null }],
  });
  assert.equal(metrics.specificResponsive.numerator, 2);
  assert.equal(metrics.specificResponsive.denominator, 3);
  assert.equal(metrics.interrogationFailures.numerator, 1);
  assert.equal(metrics.ignoredEndingFailures.numerator, 0);
  assert.equal(metrics.willingnessToContinue.missing, 1);
  assert.equal(metrics.willingnessToContinue.percentage, 50);
  assert.equal(passesCompanionTrialGate(metrics), false);
  assert.equal(passesCompanionTrialGate(calculateCompanionTrialMetrics({
    baselineViolations: 0,
    sampledConversations: Array.from({ length: 10 }, (_, index) => ({ specificallyResponsive: index < 8, interrogation: false, ignoredEnding: false })),
    memoryErrors: 1, memoryChecks: 100,
    ordinaryFirstVisibleMs: [1_000, 1_400, 2_900], ordinaryCompletionMs: [5_000, 9_000], bufferedCompletionMs: [14_000],
    exitInterviews: [{ willingToContinue: true }, { willingToContinue: true }, { willingToContinue: true }, { willingToContinue: false }, { willingToContinue: null }],
  })), true);
});

test("quality sampling is stable and limited rather than capturing every turn", () => {
  const decisions = Array.from({ length: 1_000 }, (_, index) => shouldSampleCompanionTurn(`turn-${index}`));
  assert.deepEqual(decisions, Array.from({ length: 1_000 }, (_, index) => shouldSampleCompanionTurn(`turn-${index}`)));
  assert.ok(decisions.filter(Boolean).length >= 150);
  assert.ok(decisions.filter(Boolean).length <= 250);
});
