import { NextResponse } from "next/server";
import { mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { allowFileRoot } from "@/lib/file-access";
import { canManageHostConfiguration, requireTenantSession } from "@/lib/tenant-auth";
import { tenantManagedWorkspaceRoot, VIRTUAL_WORKSPACE_ROOT } from "@/lib/tenant-workspace";

// POST /api/default-cwd
// Creates ~/pi-cwd-<YYYYMMDD> if it doesn't exist and returns the path.
export async function POST(request: Request) {
  try {
    const session = requireTenantSession(request);
    if (!canManageHostConfiguration(session)) {
      tenantManagedWorkspaceRoot(session);
      return NextResponse.json({ cwd: VIRTUAL_WORKSPACE_ROOT });
    }
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const dir = join(homedir(), `pi-cwd-${date}`);
    mkdirSync(dir, { recursive: true });
    allowFileRoot(dir);
    return NextResponse.json({ cwd: dir });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
