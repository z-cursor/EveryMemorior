import { NextResponse } from "next/server";
import { requireTenantSession, TenantAuthenticationError } from "@/lib/tenant-auth";
import { getTenantStore } from "@/lib/tenant-store";
import { COMPANION_RAW_RETENTION_DAYS } from "@/lib/companion-continuity";
import { resolveSessionPath } from "@/lib/session-reader";
import { deleteCompanionSourceMessage } from "@/lib/companion-retention";
import { abortTenantCompanionTurn } from "@/lib/companion-service";
import { getRpcSession } from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

function memberContext(request: Request) {
  const auth = requireTenantSession(request);
  return {
    auth,
    context: { tenantId: auth.tenant.id, membershipId: auth.membership.id },
    store: getTenantStore(),
  };
}

function companionUnderstandingState(request: Request) {
  const { context, store } = memberContext(request);
  return {
    explanation: "凡小忆是 AI。长期记忆与正常聊天分开选择；不开启也能继续聊天。开启后，普通稳定偏好会显示可撤销回执，敏感信息仍需逐条确认。",
    consent: store.getCompanionConsent(context),
    reviewConsent: store.getCompanionReviewConsent(context),
    memories: store.listCompanionMemories(context),
    profile: store.listCompanionProfileFields(context),
    fragments: store.listCompanionFragments(context, 20),
    memoryErrorMeasurement: store.getCompanionMemoryErrorMeasurement(context),
    privacy: {
      rawRetentionDays: COMPANION_RAW_RETENTION_DAYS,
      transcriptSource: "Pi JSONL",
      persistentUnderstandingIsEditable: true,
    },
  };
}

export async function GET(request: Request) {
  try {
    return NextResponse.json(companionUnderstandingState(request), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = error instanceof TenantAuthenticationError ? error.status : 400;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load companion understanding" }, { status });
  }
}

export async function PATCH(request: Request) {
  try {
    const { auth, context, store } = memberContext(request);
    const body = await request.json() as Record<string, unknown>;
    switch (body.action) {
      case "set_consent":
        if (typeof body.enabled !== "boolean") throw new Error("enabled must be a boolean");
        return NextResponse.json({ consent: store.setCompanionMemoryConsent(context, body.enabled) });
      case "set_review_consent":
        if (typeof body.enabled !== "boolean") throw new Error("enabled must be a boolean");
        return NextResponse.json({ reviewConsent: store.setCompanionReviewConsent(context, body.enabled, "internal-trial-v1") });
      case "confirm_memory":
        if (typeof body.memoryId !== "string") throw new Error("memoryId is required");
        return NextResponse.json({ memory: store.confirmCompanionMemory(context, body.memoryId) });
      case "correct_memory":
        if (typeof body.memoryId !== "string" || typeof body.content !== "string") throw new Error("memoryId and content are required");
        {
          const previous = store.listCompanionMemories(context).find((memory) => memory.id === body.memoryId);
          const memory = store.correctCompanionMemory(context, body.memoryId, body.content);
          if (previous && previous.content !== memory.content) store.recordCompanionMemoryFeedback(context, previous.id, false);
          return NextResponse.json({ memory });
        }
      case "delete_memory":
        if (typeof body.memoryId !== "string") throw new Error("memoryId is required");
        store.deleteCompanionMemory(context, body.memoryId);
        return NextResponse.json({ ok: true });
      case "reset_memories":
        store.resetCompanionMemories(context);
        return NextResponse.json({ ok: true });
      case "set_profile":
        if (typeof body.field !== "string" || typeof body.value !== "string") throw new Error("profile field and value are required");
        if (!store.getCompanionConsent(context).memoryEnabled) throw new Error("Enable long-term memory before saving a Companion Profile preference");
        return NextResponse.json({ profile: store.setCompanionProfileField(context, {
          field: body.field, value: body.value, source: "explicit", confidence: 1,
        }) });
      case "delete_profile":
        if (typeof body.field !== "string") throw new Error("profile field is required");
        store.deleteCompanionProfileField(context, body.field);
        return NextResponse.json({ ok: true });
      case "reset_profile":
        store.resetCompanionProfile(context);
        return NextResponse.json({ ok: true });
      case "correct_fragment":
        if (typeof body.fragmentId !== "string" || typeof body.summary !== "string") throw new Error("fragmentId and summary are required");
        return NextResponse.json({ fragment: store.updateCompanionFragment(context, body.fragmentId, body.summary) });
      case "delete_fragment":
        if (typeof body.fragmentId !== "string") throw new Error("fragmentId is required");
        store.deleteCompanionFragment(context, body.fragmentId);
        return NextResponse.json({ ok: true });
      case "reset_fragments":
        store.resetCompanionFragments(context);
        return NextResponse.json({ ok: true });
      case "memory_feedback":
        if (typeof body.memoryId !== "string" || typeof body.correct !== "boolean") throw new Error("memoryId and correct are required");
        store.recordCompanionMemoryFeedback(context, body.memoryId, body.correct);
        return NextResponse.json({ measurement: store.getCompanionMemoryErrorMeasurement(context) });
      case "preview_source_deletion":
        if (typeof body.sourceEntryId !== "string") throw new Error("sourceEntryId is required");
        return NextResponse.json({ confirmedMemories: store.listConfirmedCompanionMemoriesForSource(context, body.sourceEntryId) });
      case "delete_source": {
        if (typeof body.sourceEntryId !== "string") throw new Error("sourceEntryId is required");
        const assignment = store.getCompanionAssignment(context);
        const path = assignment ? await resolveSessionPath(assignment.sessionId) : null;
        if (!path) throw new Error("Companion session not found");
        abortTenantCompanionTurn(auth);
        getRpcSession(assignment!.sessionId)?.destroy();
        return NextResponse.json(deleteCompanionSourceMessage(store, context, path, body.sourceEntryId, body.removeConfirmedMemories === true));
      }
      default:
        return NextResponse.json({ error: "Unknown companion understanding action" }, { status: 400 });
    }
  } catch (error) {
    const status = error instanceof TenantAuthenticationError ? error.status : 400;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to update companion understanding" }, { status });
  }
}
