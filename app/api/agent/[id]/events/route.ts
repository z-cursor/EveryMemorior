import { createAgentEventStream } from "@/lib/agent-event-stream";
import { resolveSessionPath } from "@/lib/session-reader";
import { ensureRpcSessionTenantSkills, getRpcSession, isPersistedTenantSession, startRpcSession, TenantSkillSnapshotError } from "@/lib/rpc-manager";
import { authorizeAgentSessionFileRequest, authorizeAgentSessionRequest } from "@/lib/tenant-agent-runtime";
import { canManageHostConfiguration, requireTenantSession, TenantAuthenticationError } from "@/lib/tenant-auth";
import { publishedTenantSkillPaths } from "@/lib/tenant-skills";
import { tenantManagedWorkspaceRoot } from "@/lib/tenant-workspace";
import { getTenantStore } from "@/lib/tenant-store";

export const dynamic = "force-dynamic";

// GET /api/agent/[id]/events - SSE stream of agent events
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  if (req.signal.aborted) return new Response(null, { status: 204 });

  try {
    const auth = requireTenantSession(req);
    const hostAccess = canManageHostConfiguration(auth);
    const tenantSkillPaths = publishedTenantSkillPaths(auth);
    // Fast path: already-running session
    let session = getRpcSession(id);
    let sessionPromise;
    if (session?.isAlive()) {
      authorizeAgentSessionRequest(req, id, session.cwd);
      session = await ensureRpcSessionTenantSkills(session, tenantSkillPaths);
      if (!session) sessionPromise = undefined;
    }
    if (session?.isAlive()) {
      if (!session.isTenantIsolated()) {
        // Dev hot reload can leave an idle wrapper created before tenant
        // isolation was enabled. Reopen it with the current policy; never
        // replace a wrapper while it is running.
        if (session.isRunning()) {
          return new Response("Agent session is not tenant-isolated", { status: 403 });
        }
        await session.shutdown();
        session = undefined;
      } else {
        sessionPromise = Promise.resolve(session);
      }
    }
    if (!sessionPromise) {
      const filePath = await resolveSessionPath(id);
      if (!filePath) {
        // A new session is intentionally kept in memory until its first
        // assistant message. If a dev reload evicted that wrapper before the
        // first prompt, recover it from the tenant binding instead of turning
        // the next SSE connection into a misleading 404.
        const binding = getTenantStore().getAgentSessionExecution(id);
        if (!binding) return new Response("Session not found", { status: 404 });
        authorizeAgentSessionRequest(req, id, binding.workspacePath);
        sessionPromise = startRpcSession(id, "", binding.workspacePath, {
          initialSessionId: id,
          toolNames: hostAccess ? undefined : [],
          tenantIsolated: true,
          tenantSkillPaths,
          tenantWorkspaceRoot: tenantManagedWorkspaceRoot(auth),
        }).then((result) => {
          if (!result.session.isTenantIsolated()) {
            throw new TenantAuthenticationError("Agent session is not tenant-isolated", 403);
          }
          return result.session;
        });
      } else {
        authorizeAgentSessionFileRequest(req, id, filePath);
        if (!hostAccess && !isPersistedTenantSession(filePath)) {
          return new Response("This Agent session has tools unavailable to members", { status: 403 });
        }
        if (req.signal.aborted) return new Response(null, { status: 204 });
        sessionPromise = startRpcSession(id, filePath, undefined, {
          tenantIsolated: true,
          tenantSkillPaths,
          tenantWorkspaceRoot: tenantManagedWorkspaceRoot(auth),
        })
          .then((result) => {
            if (!result.session.isTenantIsolated()) {
              throw new TenantAuthenticationError("Agent session is not tenant-isolated", 403);
            }
            return result.session;
          });
      }
    }

    const stream = createAgentEventStream(req, id, sessionPromise);

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    const status = error instanceof TenantAuthenticationError || error instanceof TenantSkillSnapshotError ? error.status : 500;
    return new Response(error instanceof Error ? error.message : String(error), { status });
  }
}
