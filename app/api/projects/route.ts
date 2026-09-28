import { mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import { canManageHostConfiguration, requireTenantSession, TenantAuthenticationError } from "@/lib/tenant-auth";
import { getTenantStore } from "@/lib/tenant-store";
import { canAccessWorkspacePath, tenantManagedWorkspaceRoot, workspacePathFromClient, workspacePathToClient } from "@/lib/tenant-workspace";
import { projectIdentityKey } from "@/lib/project-identity";
import { resolveProject } from "@/lib/worktree";
import { allowFileRoot } from "@/lib/file-access";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isApiRequestAllowed(request)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  try {
    const auth = requireTenantSession(request);
    const store = getTenantStore();
    const host = canManageHostConfiguration(auth);
    const active = await Promise.all(store.listActiveWorkspaces(auth.tenant.id).map(async (workspace) => {
      const physicalRoot = host ? (await resolveProject(workspace.rootPath)).projectRoot : workspace.rootPath;
      const root = workspacePathToClient(auth, physicalRoot);
      return root ? { key: projectIdentityKey(root), root, name: workspace.name, primary: projectIdentityKey(physicalRoot) === projectIdentityKey(workspace.rootPath) } : null;
    }));
    const projectMap = new Map<string, { key: string; root: string; name: string }>();
    for (const project of active) {
      if (!project) continue;
      if (!projectMap.has(project.key) || project.primary) projectMap.set(project.key, project);
    }
    const projects = [...projectMap.values()];
    const archivedKeys = (await Promise.all(store.listArchivedWorkspaces(auth.tenant.id).map(async (workspace) => {
      const physicalRoot = host ? (await resolveProject(workspace.rootPath)).projectRoot : workspace.rootPath;
      const root = workspacePathToClient(auth, physicalRoot);
      return root ? projectIdentityKey(root) : null;
    }))).filter((key): key is string => key !== null);
    return NextResponse.json({ projects, archivedKeys }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: "Unable to list projects" }, { status: error instanceof TenantAuthenticationError ? error.status : 500 });
  }
}

export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(request)) return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  try {
    const auth = requireTenantSession(request);
    const body = await request.json() as { name?: unknown };
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 80 || /[\x00-\x1f\x7f]/.test(name)) return NextResponse.json({ error: "Project name must be 1–80 visible characters" }, { status: 400 });
    const parent = canManageHostConfiguration(auth)
      ? join(homedir(), "EveryMemorior Projects")
      : join(tenantManagedWorkspaceRoot(auth), "projects");
    const slug = name.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "project";
    const rootPath = join(parent, `${slug}-${randomUUID().slice(0, 8)}`);
    mkdirSync(rootPath, { recursive: true });
    allowFileRoot(rootPath);
    const context = { tenantId: auth.tenant.id, membershipId: auth.membership.id };
    const workspace = getTenantStore().ensureWorkspace(context, { name, rootPath });
    const root = workspacePathToClient(auth, workspace.rootPath);
    return NextResponse.json({ project: { key: projectIdentityKey(root ?? ""), root, name: workspace.name } }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof TenantAuthenticationError ? error.message : "Unable to create project" }, { status: error instanceof TenantAuthenticationError ? error.status : 500 });
  }
}

export async function PATCH(request: Request) {
  if (!isApiRequestAllowed(request)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(request)) return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  try {
    const auth = requireTenantSession(request);
    const body = await request.json() as { root?: unknown; name?: unknown };
    const clientRoot = typeof body.root === "string" ? body.root : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 80 || /[\x00-\x1f\x7f]/.test(name)) return NextResponse.json({ error: "Project name must be 1–80 visible characters" }, { status: 400 });
    const physicalPath = workspacePathFromClient(auth, clientRoot);
    if (!physicalPath || !canAccessWorkspacePath(auth, physicalPath)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }
    if (!statSync(physicalPath).isDirectory()) return NextResponse.json({ error: "Project path is not a directory" }, { status: 400 });
    const rootPath = canManageHostConfiguration(auth)
      ? (await resolveProject(physicalPath)).projectRoot
      : physicalPath;
    const context = { tenantId: auth.tenant.id, membershipId: auth.membership.id };
    const store = getTenantStore();
    const workspace = store.ensureWorkspace(context, { name: basename(rootPath) || "Workspace", rootPath });
    const renamed = store.renameWorkspace(context, workspace.id, name);
    const root = workspacePathToClient(auth, renamed.rootPath);
    return NextResponse.json({ project: { key: projectIdentityKey(root ?? clientRoot), root, name: renamed.name } });
  } catch (error) {
    return NextResponse.json({ error: "Unable to rename project" }, { status: error instanceof TenantAuthenticationError ? error.status : 400 });
  }
}

export async function DELETE(request: Request) {
  if (!isApiRequestAllowed(request)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(request)) return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  try {
    const auth = requireTenantSession(request);
    const body = await request.json() as { root?: unknown };
    const clientRoot = typeof body.root === "string" ? body.root : "";
    const physicalPath = workspacePathFromClient(auth, clientRoot);
    if (!physicalPath || !canAccessWorkspacePath(auth, physicalPath)) return NextResponse.json({ error: "Access denied" }, { status: 403 });
    const rootPath = canManageHostConfiguration(auth)
      ? (await resolveProject(physicalPath)).projectRoot
      : physicalPath;
    const context = { tenantId: auth.tenant.id, membershipId: auth.membership.id };
    const store = getTenantStore();
    store.ensureWorkspace(context, { name: basename(rootPath) || "Workspace", rootPath });
    store.archiveWorkspaceByRoot(context, rootPath);
    return NextResponse.json({ success: true, key: projectIdentityKey(clientRoot) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof TenantAuthenticationError ? error.message : "Unable to remove project" }, { status: error instanceof TenantAuthenticationError ? error.status : 400 });
  }
}
