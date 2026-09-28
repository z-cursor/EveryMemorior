import fs from "fs";
import { NextRequest, NextResponse } from "next/server";
import { getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed, isWindowsAbsolutePath } from "@/lib/file-access";
import { getGitStatus } from "@/lib/git-changes";
import { tenantWorkspaceRootsForRequest } from "@/lib/tenant-agent-runtime";
import { requireTenantSession } from "@/lib/tenant-auth";
import { workspaceErrorMessageForClient, workspacePathFromClient, workspacePathToClient } from "@/lib/tenant-workspace";

export async function GET(request: NextRequest) {
  try {
    const requestedCwd = request.nextUrl.searchParams.get("cwd")?.trim() ?? "";
    if (!requestedCwd || (!requestedCwd.startsWith("/") && !isWindowsAbsolutePath(requestedCwd))) {
      return NextResponse.json({ error: "cwd must be an absolute path" }, { status: 400 });
    }
    const auth = requireTenantSession(request);
    const cwd = workspacePathFromClient(auth, requestedCwd);
    if (!cwd) return NextResponse.json({ error: "Access denied" }, { status: 403 });

    const globalRoots = await getAllowedFileRoots();
    const allowedRoots = new Set(tenantWorkspaceRootsForRequest(request)
      .filter((root) => isFilePathAllowed(root, globalRoots)));
    if (!isFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(cwd);
    } catch {
      return NextResponse.json({ error: "Directory not found" }, { status: 404 });
    }
    if (!stat.isDirectory()) {
      return NextResponse.json({ error: "Not a directory" }, { status: 400 });
    }
    if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const status = await getGitStatus(cwd);
    return NextResponse.json({
      ...status,
      repositoryRoot: status.repositoryRoot ? workspacePathToClient(auth, status.repositoryRoot) : null,
      files: status.files.flatMap((file) => {
        const filePath = workspacePathToClient(auth, file.filePath);
        return filePath ? [{ ...file, filePath }] : [];
      }),
    });
  } catch (error) {
    return NextResponse.json({ error: workspaceErrorMessageForClient(request, error) }, { status: 500 });
  }
}
