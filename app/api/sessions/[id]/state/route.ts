import { NextResponse } from "next/server";
import { getRpcSession } from "@/lib/rpc-manager";
import { resolveSessionPath } from "@/lib/session-reader";
import { authorizeAgentSessionFileRequest, authorizeAgentSessionRequest } from "@/lib/tenant-agent-runtime";
import { requireTenantSession, TenantAuthenticationError } from "@/lib/tenant-auth";
import { workspaceAgentStateToClient, workspaceErrorMessageForClient } from "@/lib/tenant-workspace";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const rpc = getRpcSession(id);
    if (rpc?.isAlive()) {
      authorizeAgentSessionRequest(req, id, rpc.cwd);
      const state = await rpc.send({ type: "get_state" });
      return NextResponse.json({ running: true, state: workspaceAgentStateToClient(requireTenantSession(req), state) });
    }

    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    authorizeAgentSessionFileRequest(req, id, filePath);
    return NextResponse.json({ running: false });
  } catch (error) {
    const status = error instanceof TenantAuthenticationError ? error.status : 500;
    return NextResponse.json({ error: workspaceErrorMessageForClient(req, error) }, { status });
  }
}
