import { NextRequest, NextResponse } from "next/server";
import { stat } from "fs/promises";
import {
  getBrowseStartDirectory,
  getParentDirectory,
  listDirectories,
  listWindowsDrives,
  resolveDirectory,
  shouldShowWindowsDrivePicker,
} from "@/lib/directory-browser";
import { canManageHostConfiguration, requireTenantSession } from "@/lib/tenant-auth";
import { canAccessWorkspacePath, tenantManagedWorkspaceRoot, workspaceErrorMessageForClient, workspacePathFromClient, workspacePathToClient } from "@/lib/tenant-workspace";
import { isFilePathAllowed } from "@/lib/file-access";

// GET /api/cwd/browse?path=...：列出文件系统中的可读子目录。
export async function GET(request: NextRequest) {
  try {
    const session = requireTenantSession(request);
    const hostAccess = canManageHostConfiguration(session);
    const requested = request.nextUrl.searchParams.get("path")?.trim();

    if (hostAccess && shouldShowWindowsDrivePicker(requested)) {
      return NextResponse.json({
        path: "",
        parentPath: null,
        drives: await listWindowsDrives(),
        directories: [],
      });
    }

    const candidate = hostAccess ? getBrowseStartDirectory(requested)
      : workspacePathFromClient(session, requested || "/workspace");
    if (!candidate || (!hostAccess && !isFilePathAllowed(candidate, new Set([tenantManagedWorkspaceRoot(session)])))) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    let resolved: string;
    try {
      resolved = await resolveDirectory(candidate);
    } catch {
      return NextResponse.json({ error: "Directory does not exist" }, { status: 404 });
    }

    const directoryStat = await stat(resolved);
    if (!directoryStat.isDirectory()) {
      return NextResponse.json({ error: "Path is not a directory" }, { status: 400 });
    }
    if (!canAccessWorkspacePath(session, resolved)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const listed = await listDirectories(resolved);
    const directories = hostAccess ? listed : listed.flatMap((entry) => {
      const publicPath = workspacePathToClient(session, entry.path);
      return publicPath ? [{ name: entry.name, path: publicPath }] : [];
    });

    return NextResponse.json({
      path: workspacePathToClient(session, resolved),
      parentPath: hostAccess ? getParentDirectory(resolved)
        : resolved === tenantManagedWorkspaceRoot(session) ? null : workspacePathToClient(session, getParentDirectory(resolved)!),
      directories,
    });
  } catch (error) {
    return NextResponse.json({ error: workspaceErrorMessageForClient(request, error) }, { status: 500 });
  }
}
