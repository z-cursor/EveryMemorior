import { NextResponse } from "next/server";
import { jsonResponse } from "@/lib/json-response";
import {
  attachSessionProjectInfo,
  getSessionListVersion,
  listAllSessions,
  mergeSessionLists,
} from "@/lib/session-reader";
import {
  getCompletionNotificationSuppressedRpcSessionIds,
  getRpcSessionInfos,
  getRunningRpcSessionIds,
} from "@/lib/rpc-manager";
import { tenantSessionsForRequest } from "@/lib/tenant-agent-runtime";
import { requireTenantSession } from "@/lib/tenant-auth";
import { workspaceErrorMessageForClient, workspaceSessionInfoToClient } from "@/lib/tenant-workspace";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const force = new URL(req.url).searchParams.get("force") === "1";
    const persistedSessionsPromise = listAllSessions({ force });
    // Capture before awaiting: mutations during the scan still require a later refresh.
    const sessionListVersion = getSessionListVersion();
    const [persistedSessions, runtimeSessions] = await Promise.all([
      persistedSessionsPromise,
      attachSessionProjectInfo(getRpcSessionInfos()),
    ]);
    const visibleSessions = tenantSessionsForRequest(req, mergeSessionLists(persistedSessions, runtimeSessions));
    const auth = requireTenantSession(req);
    const sessions = visibleSessions.flatMap((info) => {
      const projected = workspaceSessionInfoToClient(auth, info);
      return projected ? [projected] : [];
    });
    const visibleIds = new Set(sessions.map((session) => session.id));
    return jsonResponse(
      req,
      {
        sessions,
        sessionListVersion,
        runningSessionIds: getRunningRpcSessionIds().filter((id) => visibleIds.has(id)),
        completionNotificationSuppressedSessionIds: getCompletionNotificationSuppressedRpcSessionIds().filter((id) => visibleIds.has(id)),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: workspaceErrorMessageForClient(req, error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
