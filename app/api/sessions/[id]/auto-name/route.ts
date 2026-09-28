import { NextResponse } from "next/server";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { generateSessionTitle } from "@/lib/session-title";
import { getRpcSession, isPersistedChatOnlySession, startRpcSession } from "@/lib/rpc-manager";
import { invalidateSessionListCache, resolveSessionPath } from "@/lib/session-reader";
import { authorizeAgentSessionFileRequest } from "@/lib/tenant-agent-runtime";
import { canManageHostConfiguration, requireTenantSession, TenantAuthenticationError } from "@/lib/tenant-auth";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const auth = requireTenantSession(req);
    const hostAccess = canManageHostConfiguration(auth);
    const adminAccess = auth.membership.role === "admin" || auth.membership.role === "owner";
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    authorizeAgentSessionFileRequest(req, id, filePath);

    const existing = getRpcSession(id);
    if (!hostAccess && (
      (existing?.isAlive() && !existing.isTenantIsolated())
      || (!adminAccess && (existing?.isAlive() ? !existing.isChatOnly() : !isPersistedChatOnlySession(filePath)))
    )) {
      return NextResponse.json({ error: "Agent session is not tenant-isolated" }, { status: 403 });
    }
    const { session } = existing?.isAlive()
      ? { session: existing }
      : await startRpcSession(id, filePath, undefined, { tenantIsolated: !hostAccess });
    if (!hostAccess && (!session.isTenantIsolated() || (!adminAccess && !session.isChatOnly()))) {
      return NextResponse.json({ error: "Agent session is not tenant-isolated" }, { status: 403 });
    }

    // globalThis keeps wrappers alive across dev hot reloads; older instances
    // may predate waitUntilReady(), but those have already completed startup.
    await session.waitUntilReady?.();
    const result = await generateSessionTitle(session.inner as unknown as AgentSession);

    if (!session.isAlive()) {
      return NextResponse.json(
        { error: "The session was closed while its title was being generated. Please try again." },
        { status: 409 },
      );
    }

    session.inner.setSessionName(result.title);
    invalidateSessionListCache();
    return NextResponse.json({ title: result.title, usage: result.usage ?? null });
  } catch (error) {
    const status = error instanceof TenantAuthenticationError ? error.status : 500;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status },
    );
  }
}
