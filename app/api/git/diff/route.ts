import { NextRequest, NextResponse } from "next/server";
import { getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed, isWindowsAbsolutePath } from "@/lib/file-access";
import { getGitFileDiff } from "@/lib/git-changes";
import { tenantWorkspaceRootsForRequest } from "@/lib/tenant-agent-runtime";
import { requireTenantSession } from "@/lib/tenant-auth";
import { workspaceErrorMessageForClient, workspacePathFromClient } from "@/lib/tenant-workspace";

export async function GET(request: NextRequest) {
  try {
    const requestedCwd = request.nextUrl.searchParams.get("cwd")?.trim() ?? "";
    const requestedFilePath = request.nextUrl.searchParams.get("path")?.trim() ?? "";
    if (!requestedCwd || (!requestedCwd.startsWith("/") && !isWindowsAbsolutePath(requestedCwd))) {
      return NextResponse.json({ error: "cwd must be an absolute path" }, { status: 400 });
    }
    if (!requestedFilePath || (!requestedFilePath.startsWith("/") && !isWindowsAbsolutePath(requestedFilePath))) {
      return NextResponse.json({ error: "path must be an absolute path" }, { status: 400 });
    }
    const auth = requireTenantSession(request);
    const cwd = workspacePathFromClient(auth, requestedCwd);
    const filePath = workspacePathFromClient(auth, requestedFilePath);
    if (!cwd || !filePath) return NextResponse.json({ error: "Access denied" }, { status: 403 });

    const globalRoots = await getAllowedFileRoots();
    const allowedRoots = new Set(tenantWorkspaceRootsForRequest(request)
      .filter((root) => isFilePathAllowed(root, globalRoots)));
    if (!isFilePathAllowed(cwd, allowedRoots) || !isFilePathAllowed(filePath, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }
    // The cwd must resolve inside an allowed root. The file itself may no
    // longer exist when Git reports it as deleted; getGitFileDiff verifies
    // that the requested path belongs to this repository and its status.
    if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    return NextResponse.json(await getGitFileDiff(cwd, filePath));
  } catch (error) {
    return NextResponse.json({ error: workspaceErrorMessageForClient(request, error) }, { status: 500 });
  }
}
