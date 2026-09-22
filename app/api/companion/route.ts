import { NextResponse } from "next/server";
import { getSessionEntries, resolveSessionPath, buildSessionContext } from "@/lib/session-reader";
import { publishCompanionEvent, companionEventKey } from "@/lib/companion-events";
import { abortTenantCompanionTurn, getCompanionSession, runTenantCompanionTurn } from "@/lib/companion-service";
import { requireTenantSession, TenantAuthenticationError } from "@/lib/tenant-auth";
import { getTenantStore } from "@/lib/tenant-store";

export const dynamic = "force-dynamic";

function contextFor(request: Request) {
  const auth = requireTenantSession(request);
  return { auth, key: companionEventKey(auth.tenant.id, auth.membership.id), store: getTenantStore() };
}

export async function GET(request: Request) {
  try {
    const { auth, store } = contextFor(request);
    const session = await getCompanionSession(auth);
    const assignment = store.getCompanionAssignment({ tenantId: auth.tenant.id, membershipId: auth.membership.id });
    const config = assignment ? store.getCompanionConfigVersion(auth.tenant.id, assignment.configVersionId) : null;
    const path = assignment ? await resolveSessionPath(assignment.sessionId) : null;
    const history = path
      ? buildSessionContext(getSessionEntries(path), null, { tail: 100 }).messages.flatMap((message) => {
          if (message.role !== "user" && message.role !== "assistant") return [];
          const text = typeof message.content === "string"
            ? message.content
            : Array.isArray(message.content)
              ? message.content.flatMap((block) => block && typeof block === "object" && "type" in block && block.type === "text" && "text" in block && typeof block.text === "string" ? [block.text] : []).join("")
              : "";
          return text ? [{ role: message.role, text }] : [];
        })
      : [];
    void session;
    return NextResponse.json({
      companion: { name: "凡小忆", isAi: true, relationshipId: assignment?.membershipId ?? auth.membership.id },
      assignment: assignment ? { sessionId: assignment.sessionId, configVersionId: assignment.configVersionId, assignedAt: assignment.assignedAt } : null,
      config: config ? { version: config.version, publishedAt: config.publishedAt } : null,
      history,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = error instanceof TenantAuthenticationError ? error.status : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load companion" }, { status });
  }
}

export async function POST(request: Request) {
  try {
    const { auth, key } = contextFor(request);
    const body = await request.json() as { action?: unknown; clientMessageId?: unknown; text?: unknown };
    if (body.action === "stop") {
      abortTenantCompanionTurn(auth);
      return NextResponse.json({ ok: true });
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
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to run companion turn" }, { status });
  }
}
