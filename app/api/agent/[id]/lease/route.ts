import { NextResponse } from "next/server";
import { renewSessionLivenessLeases } from "@/lib/session-liveness";
import { getRpcSession } from "@/lib/rpc-manager";
import { resolveSessionPath } from "@/lib/session-reader";
import { authorizeAgentSessionFileRequest, authorizeAgentSessionRequest } from "@/lib/tenant-agent-runtime";
import { TenantAuthenticationError } from "@/lib/tenant-auth";

// POST /api/agent/[id]/lease - Renew selected-session SSE leases.
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const session = getRpcSession(id);
    if (session?.isAlive()) authorizeAgentSessionRequest(req, id, session.cwd);
    else {
      const filePath = await resolveSessionPath(id);
      if (!filePath) return NextResponse.json({ error: "Session not found" }, { status: 404 });
      authorizeAgentSessionFileRequest(req, id, filePath);
    }
    return NextResponse.json({
      success: true,
      renewed: renewSessionLivenessLeases(id),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = error instanceof TenantAuthenticationError ? error.status : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status });
  }
}
