import { NextResponse } from "next/server";
import { getSessionEntries, resolveSessionPath, buildSessionContext } from "@/lib/session-reader";
import { publishCompanionEvent, companionEventKey } from "@/lib/companion-events";
import { abortTenantCompanionTurn, getCompanionSession, runTenantCompanionTurn } from "@/lib/companion-service";
import { requireTenantSession, TenantAuthenticationError } from "@/lib/tenant-auth";
import { getTenantStore } from "@/lib/tenant-store";
import { pruneCompanionRawMessages, scheduleCompanionRetentionSweep } from "@/lib/companion-retention";
import { getRpcSession } from "@/lib/rpc-manager";
import { scheduleCompanionContinuityWorker } from "@/lib/companion-continuity";

export const dynamic = "force-dynamic";

function contextFor(request: Request) {
  const auth = requireTenantSession(request);
  return { auth, key: companionEventKey(auth.tenant.id, auth.membership.id), store: getTenantStore() };
}

export async function GET(request: Request) {
  try {
    const { auth, key, store } = contextFor(request);
    const context = { tenantId: auth.tenant.id, membershipId: auth.membership.id };
    let assignment = store.getCompanionAssignment(context);
    const existingPath = assignment ? await resolveSessionPath(assignment.sessionId) : null;
    const retention = existingPath && !getRpcSession(assignment!.sessionId)?.isAlive()
      ? pruneCompanionRawMessages(store, context, existingPath)
      : { removedEntryIds: [], confirmedMemoryIds: [] };
    const session = await getCompanionSession(auth);
    scheduleCompanionRetentionSweep(store);
    scheduleCompanionContinuityWorker(store, context, `companion-${process.pid}`, (event, clientMessageId) => {
      if (clientMessageId) publishCompanionEvent(key, { ...event, clientMessageId });
    }, 250);
    assignment = store.getCompanionAssignment(context);
    const config = assignment ? store.getCompanionConfigVersion(auth.tenant.id, assignment.configVersionId) : null;
    const path = assignment ? await resolveSessionPath(assignment.sessionId) : null;
    const loadedContext = path ? buildSessionContext(getSessionEntries(path), null, { tail: 100 }) : null;
    const history = loadedContext
      ? loadedContext.messages.flatMap((message, index) => {
          if (message.role !== "user" && message.role !== "assistant") return [];
          const text = typeof message.content === "string"
            ? message.content
            : Array.isArray(message.content)
              ? message.content.flatMap((block) => block && typeof block === "object" && "type" in block && block.type === "text" && "text" in block && typeof block.text === "string" ? [block.text] : []).join("")
              : "";
          return text ? [{ role: message.role, text, entryId: loadedContext.entryIds[index] }] : [];
        })
      : [];
    void session;
    return NextResponse.json({
      companion: { name: "凡小忆", isAi: true, relationshipId: assignment?.membershipId ?? auth.membership.id },
      assignment: assignment ? { sessionId: assignment.sessionId, configVersionId: assignment.configVersionId, assignedAt: assignment.assignedAt } : null,
      config: config ? { version: config.version, publishedAt: config.publishedAt, thinkingLevel: config.thinkingLevel } : null,
      history,
      retention,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = error instanceof TenantAuthenticationError ? error.status : 500;
    return NextResponse.json({ error: error instanceof TenantAuthenticationError ? error.message : "无法加载陪伴对话，请刷新后重试。" }, { status });
  }
}

export async function POST(request: Request) {
  try {
    const { auth, key, store } = contextFor(request);
    scheduleCompanionRetentionSweep(store);
    const body = await request.json() as { action?: unknown; clientMessageId?: unknown; text?: unknown; level?: unknown };
    if (body.action === "stop") {
      abortTenantCompanionTurn(auth);
      return NextResponse.json({ ok: true });
    }
    if (body.action === "compact" || body.action === "set_thinking_level") {
      if (body.action === "set_thinking_level" && !["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(body.level))) {
        return NextResponse.json({ error: "Invalid thinking level" }, { status: 400 });
      }
      const session = await getCompanionSession(auth);
      const result = body.action === "compact"
        ? await session.send({ type: "compact" })
        : await session.send({ type: "set_thinking_level", level: body.level as "auto" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" });
      return NextResponse.json({ result });
    }
    if (typeof body.clientMessageId !== "string" || typeof body.text !== "string" || !body.clientMessageId.trim() || !body.text.trim()) {
      return NextResponse.json({ error: "clientMessageId and text are required" }, { status: 400 });
    }
    const result = await runTenantCompanionTurn({ auth, clientMessageId: body.clientMessageId, text: body.text, signal: request.signal }, (event) => {
      publishCompanionEvent(key, event);
    });
    return NextResponse.json({ turn: result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = error instanceof TenantAuthenticationError ? error.status : 500;
    return NextResponse.json({ error: error instanceof TenantAuthenticationError ? error.message : "凡小忆暂时无法回复，请稍后重试。" }, { status });
  }
}
