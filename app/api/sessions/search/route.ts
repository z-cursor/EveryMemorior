import { NextResponse } from "next/server";
import { listAllSessions } from "@/lib/session-reader";
import { searchSessionContents } from "@/lib/session-search";
import { tenantSessionsForRequest } from "@/lib/tenant-agent-runtime";
import { requireTenantSession } from "@/lib/tenant-auth";
import { workspaceErrorMessageForClient, workspaceSessionInfoToClient } from "@/lib/tenant-workspace";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const query = (new URL(request.url).searchParams.get("q") ?? "").trim();
  const headers = { "Cache-Control": "no-store" };
  if (query.length > 200) {
    return NextResponse.json({ error: "Search query exceeds 200 characters" }, { status: 400, headers });
  }
  try {
    // Paths come only from the same catalog used by the sidebar.
    const sessions = query && !request.signal.aborted
      ? tenantSessionsForRequest(request, await listAllSessions()) : [];
    const response = await searchSessionContents(sessions, query, request.signal);
    const auth = requireTenantSession(request);
    return NextResponse.json({ ...response, results: response.results.flatMap((result) => {
      const session = workspaceSessionInfoToClient(auth, result.session);
      return session ? [{ ...result, session }] : [];
    }) }, { headers });
  } catch (error) {
    return NextResponse.json({ error: workspaceErrorMessageForClient(request, error) }, { status: 500, headers });
  }
}
