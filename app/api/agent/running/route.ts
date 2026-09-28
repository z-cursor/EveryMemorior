import { NextResponse } from "next/server";
import { getSessionListVersion } from "@/lib/session-reader";
import {
  getCompletionNotificationSuppressedRpcSessionIds,
  getRunningRpcSessionIds,
} from "@/lib/rpc-manager";
import { tenantAgentSessionIdsForRequest } from "@/lib/tenant-agent-runtime";

export const dynamic = "force-dynamic";

// GET /api/agent/running - Lightweight snapshot for visible-tab polling.
export async function GET(request: Request) {
  const runningSessionIds = tenantAgentSessionIdsForRequest(request, getRunningRpcSessionIds());
  const suppressedSessionIds = tenantAgentSessionIdsForRequest(
    request,
    getCompletionNotificationSuppressedRpcSessionIds(),
  );
  return NextResponse.json(
    {
      sessionListVersion: getSessionListVersion(),
      runningSessionIds,
      completionNotificationSuppressedSessionIds: suppressedSessionIds,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
