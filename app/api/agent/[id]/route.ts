import { NextResponse } from "next/server";
import { resolveSessionPath } from "@/lib/session-reader";
import { startRpcSession, getRpcSession, isPersistedTenantSession, setRpcSessionTools } from "@/lib/rpc-manager";
import { authorizeAgentSessionRequest } from "@/lib/tenant-agent-runtime";
import { canManageHostConfiguration, requireTenantSession, TenantAuthenticationError } from "@/lib/tenant-auth";
import { readSessionHeader } from "@/lib/session-reader";
import { tenantManagedWorkspaceRoot, workspaceAgentStateToClient, workspaceErrorMessageForClient } from "@/lib/tenant-workspace";
import { publishedTenantSkillPaths } from "@/lib/tenant-skills";
import { isTenantWorkspaceToolSelection } from "@/lib/tenant-tool-policy";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

// POST /api/agent/[id] - Send a command to an existing session
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  let commandType: string | undefined;
  let promptAccepted = false;

  try {
    const hostAccess = canManageHostConfiguration(requireTenantSession(req));
    const body = await req.json() as { type: string; [key: string]: unknown };
    commandType = typeof body.type === "string" ? body.type : undefined;
    const requestedToolNames = body.toolNames;
    if (
      requestedToolNames !== undefined
      && (!Array.isArray(requestedToolNames) || requestedToolNames.some((name) => typeof name !== "string"))
    ) {
      throw new Error("toolNames must be an array of strings");
    }
    const toolNames = requestedToolNames as string[] | undefined;
    if (!hostAccess && (body.type === "bash"
      || body.type === "set_tools" && toolNames !== undefined && !(toolNames.length === 0 || isTenantWorkspaceToolSelection(toolNames))
      || body.type !== "set_tools" && toolNames?.length)) {
      return NextResponse.json({ error: "Members may use only Chat or virtual-workspace Work tools" }, { status: 403 });
    }

    // Fast path: already-running session
    let existing = getRpcSession(id);
    if (existing?.isAlive()) authorizeAgentSessionRequest(req, id, existing.cwd);
    if (!hostAccess && existing?.isAlive() && !existing.isChatOnly() && !existing.isTenantIsolated()) {
      // A dev hot reload can leave an idle wrapper created before tenant
      // isolation was enabled. Reopen it with the current policy; never
      // replace a wrapper while it is handling a prompt or tool call.
      if (existing.isRunning()) {
        return NextResponse.json({ error: "This Agent session is not tenant-isolated" }, { status: 403 });
      }
      await existing.shutdown();
      existing = undefined;
    }
    if (body.type === "reload" && body.refreshTenantSkills === true) {
      const auth = requireTenantSession(req);
      if (existing?.isRunning()) {
        return NextResponse.json({ error: "Cannot refresh Tenant Skills while the session is running" }, { status: 409 });
      }
      const filePath = existing?.sessionFile || await resolveSessionPath(id);
      if (!filePath) {
        // A transient session has no durable file, but its resource loader
        // still captured the old Skill paths at construction time. Rebuild it
        // in place so publishing a Skill while an empty chat is open takes
        // effect immediately. Preserve the id/model/tools that the composer
        // is already using; there is no persisted transcript to reopen.
        if (!existing?.isAlive()) {
          return NextResponse.json({ success: true, data: { refreshed: false } });
        }
        const sessionCwd = existing.cwd;
        const model = existing.inner.model;
        const currentThinkingLevel = existing.inner.agent.state?.thinkingLevel;
        const activeToolNames = existing.isChatOnly() ? [] : existing.inner.getActiveToolNames();
        const thinkingLevel = typeof currentThinkingLevel === "string"
          && ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(currentThinkingLevel)
          ? currentThinkingLevel as ThinkingLevel
          : undefined;
        await existing.shutdown();
        const started = await startRpcSession(id, "", sessionCwd, {
          initialSessionId: id,
          toolNames: activeToolNames,
          tenantIsolated: !hostAccess,
          tenantSkillPaths: publishedTenantSkillPaths(auth),
          ...(!hostAccess ? { tenantWorkspaceRoot: tenantManagedWorkspaceRoot(auth) } : {}),
          ...(model ? { initialModel: { provider: model.provider, modelId: model.id } } : {}),
          ...(model ? { allowInitialModelFallback: true } : {}),
          ...(thinkingLevel ? { thinkingLevel } : {}),
        });
        return NextResponse.json({ success: true, data: { refreshed: true, sessionId: started.realSessionId } });
      }
      authorizeAgentSessionRequest(req, id, readSessionHeader(filePath)?.cwd);
      if (!hostAccess && !isPersistedTenantSession(filePath)) {
        return NextResponse.json({ error: "This Agent session has tools unavailable to members" }, { status: 403 });
      }
      if (existing?.isAlive()) await existing.shutdown();
      const started = await startRpcSession(id, filePath, undefined, {
        tenantIsolated: !hostAccess,
        tenantSkillPaths: publishedTenantSkillPaths(auth),
        ...(!hostAccess ? { tenantWorkspaceRoot: tenantManagedWorkspaceRoot(auth) } : {}),
      });
      return NextResponse.json({ success: true, data: { refreshed: true, sessionId: started.realSessionId } });
    }
    if (body.type === "set_tools") {
      const filePath = existing?.sessionFile || await resolveSessionPath(id) || undefined;
      if (!existing?.isAlive() && !filePath) {
        return NextResponse.json({ error: "Session not found" }, { status: 404 });
      }
      const auth = requireTenantSession(req);
      const changed = await setRpcSessionTools(id, filePath, toolNames, {
        tenantIsolated: !hostAccess,
        tenantSkillPaths: publishedTenantSkillPaths(auth),
        ...(!hostAccess ? { tenantWorkspaceRoot: tenantManagedWorkspaceRoot(auth) } : {}),
      });
      return NextResponse.json({
        success: true,
        data: { sessionId: changed.sessionId, recreated: changed.recreated },
      });
    }
    if (existing?.isAlive()) {
      const result = await existing.send(body);
      promptAccepted = body.type === "prompt";
      return NextResponse.json({ success: true, data: (body.type === "get_state" || body.type === "get_session_stats")
        ? workspaceAgentStateToClient(requireTenantSession(req), result) : result });
    }

    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({
        error: "Session not found",
        ...(body.type === "prompt"
          ? { code: "prompt_rejected", accepted: false }
          : {}),
      }, { status: 404 });
    }

    authorizeAgentSessionRequest(req, id, readSessionHeader(filePath)?.cwd);
    if (!hostAccess && !isPersistedTenantSession(filePath)) {
      return NextResponse.json({ error: "This Agent session has tools unavailable to members" }, { status: 403 });
    }

    const { session } = await startRpcSession(id, filePath, undefined, {
      ...(toolNames !== undefined ? { toolNames } : {}),
      tenantIsolated: !hostAccess,
      tenantSkillPaths: publishedTenantSkillPaths(requireTenantSession(req)),
      ...(!hostAccess ? { tenantWorkspaceRoot: tenantManagedWorkspaceRoot(requireTenantSession(req)) } : {}),
    });
    authorizeAgentSessionRequest(req, id, session.cwd);
    if (!hostAccess && !session.isChatOnly() && !session.isTenantIsolated()) {
      return NextResponse.json({ error: "This Agent session is not tenant-isolated" }, { status: 403 });
    }
    const result = await session.send(body);
    promptAccepted = body.type === "prompt";

    return NextResponse.json({ success: true, data: (body.type === "get_state" || body.type === "get_session_stats")
      ? workspaceAgentStateToClient(requireTenantSession(req), result) : result });
  } catch (error) {
    const status = error instanceof TenantAuthenticationError ? error.status : 500;
    return NextResponse.json({
      error: workspaceErrorMessageForClient(req, error),
      ...(commandType === "prompt" && !promptAccepted
        ? { code: "prompt_rejected", accepted: false }
        : {}),
    }, { status });
  }
}

// GET /api/agent/[id] - Get current agent state
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    const session = getRpcSession(id);
    if (!session || !session.isAlive()) {
      return NextResponse.json({ running: false });
    }

    authorizeAgentSessionRequest(req, id, session.cwd);
    if (!canManageHostConfiguration(requireTenantSession(req)) && !session.isChatOnly() && !session.isTenantIsolated()) {
      return NextResponse.json({ error: "This Agent session is not tenant-isolated" }, { status: 403 });
    }

    const state = await session.send({ type: "get_state" });
    return NextResponse.json({ running: true, state: workspaceAgentStateToClient(requireTenantSession(req), state) });
  } catch (error) {
    const status = error instanceof TenantAuthenticationError ? error.status : 500;
    return NextResponse.json({ error: workspaceErrorMessageForClient(req, error) }, { status });
  }
}
