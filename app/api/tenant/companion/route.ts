import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { requireTenantSession, TenantAuthenticationError } from "@/lib/tenant-auth";
import { getTenantStore } from "@/lib/tenant-store";
import { getRpcSession } from "@/lib/rpc-manager";
import { COMPANION_EVALUATOR_VERSION, loadCompanionEvaluationBank, runCompanionEvaluation, selectCompanionEvaluationCases } from "@/lib/companion-evaluations";
import { buildCompanionSystemPrompt } from "@/lib/companion-runtime";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveCompanionModel } from "@/lib/companion-model";

export const dynamic = "force-dynamic";

function admin(request: Request) {
  const auth = requireTenantSession(request);
  if (auth.membership.role === "member") throw new TenantAuthenticationError("Owner or admin access required", 403);
  return auth;
}

function assistantText(message: Awaited<ReturnType<ModelRuntime["completeSimple"]>>): string {
  if (message.stopReason === "error" || message.stopReason === "aborted") throw new Error(message.errorMessage || "Evaluation model failed");
  return message.content.flatMap((content) => content.type === "text" ? [content.text] : []).join("").trim();
}

export async function GET(request: Request) {
  try {
    const auth = admin(request);
    const store = getTenantStore();
    const context = { tenantId: auth.tenant.id, membershipId: auth.membership.id };
    const evaluations = store.listCompanionEvaluationRuns(context);
    const calibration = store.getCompanionCalibration(context, evaluations[0]?.graderVersion);
    const members = store.listTenantMembers(context.tenantId).filter((member) => member.role === "member" && member.status === "active");
    return NextResponse.json({ members, configs: store.listCompanionConfigVersions(context), samples: store.listCompanionQualitySamples(context, true), evaluations, proposals: store.listCompanionImprovementProposals(context), calibration, calibrationCount: calibration.reviewedCount, calibrations: store.listCompanionCalibrations(context, evaluations[0]?.graderVersion), trial: store.getCompanionTrialReadout(context), trialParticipants: store.listCompanionTrialParticipants(context), migrations: store.listCompanionMigrationHistory(context), audit: store.listTenantAuditEvents(context) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = error instanceof TenantAuthenticationError ? error.status : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load companion configuration" }, { status });
  }
}

export async function POST(request: Request) {
  try {
    const auth = admin(request);
    const store = getTenantStore();
    const context = { tenantId: auth.tenant.id, membershipId: auth.membership.id };
    const body = await request.json() as Record<string, unknown>;
    if (body.action === "draft") {
      const modelProvider = String(body.modelProvider ?? "qwen");
      const modelId = String(body.modelId ?? "FY-Qwen3.8-27B-NVFP4");
      const model = await resolveCompanionModel(await ModelRuntime.create(), modelProvider, modelId);
      return NextResponse.json({ config: store.createCompanionConfigDraft(context, {
        behaviorDocument: String(body.behaviorDocument ?? ""), modelProvider: model.provider, modelId: model.id,
        thinkingLevel: String(body.thinkingLevel ?? "off"), temperature: Number(body.temperature ?? 0.2), maxOutputTokens: Number(body.maxOutputTokens ?? 600),
      }) }, { status: 201 });
    }
    if (body.action === "publish" && typeof body.configVersionId === "string") return NextResponse.json({ config: store.publishCompanionConfig(context, body.configVersionId) });
    if (body.action === "preview_migration" && typeof body.membershipId === "string" && typeof body.configVersionId === "string") return NextResponse.json({ preview: store.previewCompanionMigration(context, body.membershipId, body.configVersionId) });
    if (body.action === "preview_batch_migration" && Array.isArray(body.membershipIds) && typeof body.configVersionId === "string") {
      const membershipIds = body.membershipIds.filter((id): id is string => typeof id === "string");
      return NextResponse.json({ previews: membershipIds.map((membershipId) => store.previewCompanionMigration(context, membershipId, body.configVersionId as string)) });
    }
    if (body.action === "migrate" && typeof body.membershipId === "string" && typeof body.configVersionId === "string") {
      const preview = store.previewCompanionMigration(context, body.membershipId, body.configVersionId);
      return NextResponse.json({ assignment: store.migrateCompanionAssignment(context, body.membershipId, body.configVersionId, { sessionBusy: getRpcSession(preview.current.sessionId)?.isRunning() === true, reason: typeof body.reason === "string" ? body.reason : undefined }) });
    }
    if (body.action === "batch_migrate" && Array.isArray(body.membershipIds) && typeof body.configVersionId === "string") {
      const membershipIds = body.membershipIds.filter((id): id is string => typeof id === "string");
      if (membershipIds.some((membershipId) => getRpcSession(store.previewCompanionMigration(context, membershipId, body.configVersionId as string).current.sessionId)?.isRunning() === true)) throw new Error("Cannot migrate while a companion is generating a reply");
      return NextResponse.json({ assignments: store.migrateCompanionAssignments(context, membershipIds, body.configVersionId, typeof body.reason === "string" ? body.reason : "administrator approved batch migration") });
    }
    if (body.action === "review" && typeof body.sampleId === "string") return NextResponse.json({ review: store.recordCompanionQualityReview(context, body.sampleId, {
      specificallyResponsive: body.specificallyResponsive === true, interrogation: body.interrogation === true,
      ignoredEnding: body.ignoredEnding === true, baselineViolation: body.baselineViolation === true,
      notes: String(body.notes ?? "quality review"),
    }) });
    if (body.action === "propose" && typeof body.sourceId === "string" && typeof body.baseConfigVersionId === "string" && typeof body.proposedBehaviorDocument === "string") return NextResponse.json({ proposal: store.createCompanionImprovementProposal(context, {
      sourceType: body.sourceType === "evaluation" ? "evaluation" : "review", sourceId: body.sourceId, baseConfigVersionId: body.baseConfigVersionId,
      evidence: Array.isArray(body.evidence) ? body.evidence as Array<{ sourceId: string; quote: string }> : [], proposedBehaviorDocument: body.proposedBehaviorDocument,
    }) }, { status: 201 });
    if (body.action === "accept_proposal" && typeof body.proposalId === "string" && typeof body.behaviorDocument === "string") return NextResponse.json({ result: store.acceptCompanionImprovementProposal(context, body.proposalId, body.behaviorDocument) });
    if (body.action === "evaluation" && typeof body.configVersionId === "string") {
      const suite = body.suite === "full" ? "full" : "quick";
      const evaluationMode = body.evaluationMode === "rolling_episode" ? "rolling_episode" : "single_turn";
      const bridgeFromGraderVersion = typeof body.bridgeFromGraderVersion === "string" ? body.bridgeFromGraderVersion : undefined;
      const bridgeSource = bridgeFromGraderVersion
        ? store.listCompanionEvaluationRuns(context, 100).find((run) => run.graderVersion === bridgeFromGraderVersion && run.status === "completed")
        : undefined;
      if (bridgeFromGraderVersion && !bridgeSource) throw new Error("Bridge source evaluation not found");
      if (bridgeSource && (bridgeSource.suite !== suite || bridgeSource.evaluationMode !== evaluationMode)) throw new Error("Bridge evaluation must use the source suite and mode");
      const selected = bridgeSource
        ? bridgeSource.questions.map((question, index) => ({ question, privateAnswer: bridgeSource.privateAnswers[index] })) as ReturnType<typeof selectCompanionEvaluationCases>
        : selectCompanionEvaluationCases(loadCompanionEvaluationBank(), suite, evaluationMode);
      const config = store.getCompanionConfigVersion(context.tenantId, body.configVersionId);
      if (!config) throw new Error("Companion config version not found");
      const runtime = await ModelRuntime.create();
      const model = await resolveCompanionModel(runtime, config.modelProvider, config.modelId);
      const graderPrompt = readFileSync(join(process.cwd(), "prompts", "grader.system.md"), "utf8");
      const dialogueGraderPrompt = readFileSync(join(process.cwd(), "prompts", "dialogue-grader.system.md"), "utf8");
      const policy = JSON.parse(readFileSync(join(process.cwd(), "evals", "evaluation-policy.json"), "utf8")) as Record<string, unknown>;
      const graderVersion = createHash("sha256").update(JSON.stringify({ evaluator: COMPANION_EVALUATOR_VERSION, graderPrompt, dialogueGraderPrompt, policy, modelProvider: model.provider, modelId: model.id })).digest("hex").slice(0, 16);
      const evaluation = await runCompanionEvaluation({
        cases: selected,
        candidateSystemPrompt: buildCompanionSystemPrompt(config, new Date().toISOString()),
        graderPrompt,
        dialogueGraderPrompt,
        candidateTemperature: config.temperature,
        candidateMaxTokens: config.maxOutputTokens,
        evaluationMode,
        complete: async (request) => assistantText(await runtime.completeSimple(model, {
          systemPrompt: request.systemPrompt,
          messages: request.messages.map((message): Message => message.role === "user"
            ? { role: "user", content: message.content, timestamp: Date.now() }
            : {
                role: "assistant", content: [{ type: "text", text: message.content }], api: model.api,
                provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
                stopReason: "stop", timestamp: Date.now(),
              }),
        }, { temperature: request.temperature, maxTokens: request.maxTokens })),
      });
      return NextResponse.json({ run: store.createCompanionEvaluationRun(context, {
      configVersionId: body.configVersionId, suite, evaluationMode,
      graderVersion, bridgeFromGraderVersion,
      candidate: config as unknown as Record<string, unknown>,
      questions: selected.map((item) => item.question), privateAnswers: selected.map((item) => item.privateAnswer),
      graderPrompt: JSON.stringify({ singleTurn: graderPrompt, dialogue: dialogueGraderPrompt }),
      graderModel: `${model.provider}/${model.id}`, parameters: { temperature: 0, thinking: false, structuredOutput: "strict-json-validation", evaluator: COMPANION_EVALUATOR_VERSION },
      policy,
      itemCount: selected.length, averageScore: evaluation.averageScore, fatalCount: evaluation.fatalCount, results: evaluation.results, suggestions: evaluation.suggestions,
    }) });
    }
    if (body.action === "calibration" && typeof body.runId === "string" && typeof body.itemId === "string") return NextResponse.json({ calibration: store.recordCompanionCalibration(context, { runId: body.runId, itemId: body.itemId, band: body.band === "low" || body.band === "borderline" ? body.band : "high", humanScore: Number(body.humanScore), notes: String(body.notes ?? "calibration") }) });
    if (body.action === "enroll_trial" && typeof body.membershipId === "string") {
      store.enrollCompanionTrialParticipant(context, { membershipId: body.membershipId, startedAt: typeof body.startedAt === "string" ? body.startedAt : undefined, excludesDirectIdentifiers: body.excludesDirectIdentifiers === true, fictionalSensitiveExercises: body.fictionalSensitiveExercises === true });
      return NextResponse.json({ trial: store.getCompanionTrialReadout(context) }, { status: 201 });
    }
    if (body.action === "update_trial" && typeof body.membershipId === "string") {
      store.updateCompanionTrialParticipant(context, body.membershipId, { stage: body.stage === "scripted" || body.stage === "free_chat" || body.stage === "completed" ? body.stage : undefined, willingToContinue: typeof body.willingToContinue === "boolean" ? body.willingToContinue : undefined });
      return NextResponse.json({ trial: store.getCompanionTrialReadout(context) });
    }
    return NextResponse.json({ error: "Unsupported companion configuration action" }, { status: 400 });
  } catch (error) {
    const status = error instanceof TenantAuthenticationError ? error.status : 400;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to change companion configuration" }, { status });
  }
}
