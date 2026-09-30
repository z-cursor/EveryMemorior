import { NextResponse } from "next/server";
import { statSync, type Stats } from "fs";
import { homedir } from "os";
import { basename, isAbsolute, resolve } from "path";
import { allowFileRoot, isFilePathAllowed } from "@/lib/file-access";
import { projectIdentityKey } from "@/lib/project-identity";
import { resolveProject } from "@/lib/worktree";
import { canManageHostConfiguration, requireTenantSession } from "@/lib/tenant-auth";
import { getTenantStore } from "@/lib/tenant-store";
import { canAccessWorkspacePath, tenantManagedWorkspaceRoot, workspaceErrorMessageForClient, workspacePathFromClient, workspacePathToClient } from "@/lib/tenant-workspace";

function normalizeCwd(cwd: string): string {
  if (cwd === "~") return homedir();
  if (cwd.startsWith("~/")) return resolve(homedir(), cwd.slice(2));
  return isAbsolute(cwd) ? cwd : resolve(cwd);
}

// POST /api/cwd/validate  body: { cwd: string }
// Validates a candidate workspace before the UI selects it.
export async function POST(req: Request) {
  try {
    const session = requireTenantSession(req);
    const body = await req.json() as { cwd?: unknown };
    const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";

    if (!cwd) {
      return NextResponse.json({ error: "Path is required" }, { status: 400 });
    }

    const physicalCwd = workspacePathFromClient(session, cwd);
    if (!physicalCwd) return NextResponse.json({ error: "Access denied" }, { status: 403 });
    const normalizedCwd = canManageHostConfiguration(session) ? normalizeCwd(physicalCwd) : physicalCwd;
    if (!canManageHostConfiguration(session)
      && !isFilePathAllowed(normalizedCwd, new Set([tenantManagedWorkspaceRoot(session)]))) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }
    let stat: Stats;
    try {
      stat = statSync(normalizedCwd);
    } catch {
      return NextResponse.json({ error: `Directory does not exist: ${cwd}` }, { status: 400 });
    }

    if (!stat.isDirectory()) {
      return NextResponse.json({ error: `Path is not a directory: ${cwd}` }, { status: 400 });
    }

    if (!canAccessWorkspacePath(session, normalizedCwd)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    allowFileRoot(normalizedCwd);
    getTenantStore().ensureWorkspace(
      { tenantId: session.tenant.id, membershipId: session.membership.id },
      { name: basename(normalizedCwd) || "Workspace", rootPath: normalizedCwd },
    );
    const hostAccess = canManageHostConfiguration(session);
    const projectRoot = hostAccess
      ? (await resolveProject(normalizedCwd)).projectRoot
      : tenantManagedWorkspaceRoot(session);
    return NextResponse.json({
      success: true,
      cwd: workspacePathToClient(session, normalizedCwd),
      projectRoot: workspacePathToClient(session, projectRoot),
      projectKey: projectIdentityKey(workspacePathToClient(session, projectRoot) ?? ""),
    });
  } catch (error) {
    return NextResponse.json({ error: workspaceErrorMessageForClient(req, error) }, { status: 500 });
  }
}
