import { NextResponse } from "next/server";
import { requireTenantSession } from "@/lib/tenant-auth";
import { tenantManagedWorkspaceRoot, VIRTUAL_WORKSPACE_ROOT } from "@/lib/tenant-workspace";
import { getTenantStore } from "@/lib/tenant-store";

// POST /api/default-cwd
// Creates ~/pi-cwd-<YYYYMMDD> if it doesn't exist and returns the path.
export async function POST(request: Request) {
  try {
    const session = requireTenantSession(request);
    const root = tenantManagedWorkspaceRoot(session);
    getTenantStore().ensureWorkspace(
      { tenantId: session.tenant.id, membershipId: session.membership.id },
      { name: "Workspace", rootPath: root },
    );
    return NextResponse.json({ cwd: VIRTUAL_WORKSPACE_ROOT });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
