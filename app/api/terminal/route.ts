import { stat } from "fs/promises";
import { resolve } from "path";
import { NextResponse } from "next/server";
import { isExistingFilePathAllowed } from "@/lib/file-access";
import { createTerminal } from "@/lib/terminal-manager";
import { canManageHostConfiguration, requireTenantSession } from "@/lib/tenant-auth";
import { tenantWorkspaceRootsForRequest } from "@/lib/tenant-agent-runtime";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const session = requireTenantSession(req);
    if (!canManageHostConfiguration(session)) {
      return NextResponse.json({ error: "Terminal is unavailable for tenant members" }, { status: 403 });
    }
    const body = await req.json() as { id?: unknown; cwd?: unknown; cols?: unknown; rows?: unknown };
    if (body.id !== undefined && (typeof body.id !== "string" || !/^[a-f0-9]{32}$/.test(body.id))) {
      return NextResponse.json({ error: "Invalid terminal id" }, { status: 400 });
    }
    if (typeof body.cwd !== "string" || !body.cwd.trim()) {
      return NextResponse.json({ error: "cwd required" }, { status: 400 });
    }
    const cwd = resolve(body.cwd);
    if (!(await stat(cwd)).isDirectory()) {
      return NextResponse.json({ error: "cwd must be a directory" }, { status: 400 });
    }
    const roots = new Set(tenantWorkspaceRootsForRequest(req));
    if (!isExistingFilePathAllowed(cwd, roots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }
    const id = createTerminal(
      cwd,
      typeof body.cols === "number" ? body.cols : 80,
      typeof body.rows === "number" ? body.rows : 24,
      body.id as string | undefined,
      session.tenant.id,
    );
    return NextResponse.json({ id });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
