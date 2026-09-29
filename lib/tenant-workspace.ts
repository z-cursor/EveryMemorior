import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { allowFileRoot, isExistingFilePathAllowed, isFilePathAllowed } from "./file-access";
import { canManageHostConfiguration, requireTenantSession, TenantAuthenticationError } from "./tenant-auth";
import { projectIdentityKey } from "./project-identity";
import { getTenantStore } from "./tenant-store";
import type { AuthenticatedTenantSession } from "./tenant-store";
import type { SessionInfo } from "./types";

/** A tenant-owned host directory, not an OS sandbox. Untrusted Agent tools stay disabled. */
export function tenantManagedWorkspaceRoot(session: AuthenticatedTenantSession): string {
  const root = join(getAgentDir(), "tenant-workspaces", session.tenant.id, session.membership.id);
  mkdirSync(root, { recursive: true });
  const realRoot = realpathSync(root);
  allowFileRoot(realRoot);
  return realRoot;
}

function ownedWorkspaceRoots(session: AuthenticatedTenantSession): string[] {
  const roots = getTenantStore().listActiveWorkspaceRootsForMembership(
    session.tenant.id,
    session.membership.id,
  );
  const managed = tenantManagedWorkspaceRoot(session);
  return [...new Set([managed, ...roots])];
}

function belongsToAnotherMembershipWorkspace(session: AuthenticatedTenantSession, path: string): boolean {
  // The per-membership managed root is authoritative even when a legacy
  // workspace record points at a broad parent directory that contains it.
  if (isFilePathAllowed(path, new Set([tenantManagedWorkspaceRoot(session)]))) return false;
  return getTenantStore().listActiveWorkspaces(session.tenant.id)
    .some((workspace) => workspace.createdByMembershipId !== session.membership.id
      && isFilePathAllowed(path, new Set([workspace.rootPath])));
}

export function canAccessWorkspacePath(session: AuthenticatedTenantSession, path: string): boolean {
  const roots = new Set(ownedWorkspaceRoots(session));
  if (isFilePathAllowed(path, roots) && !belongsToAnotherMembershipWorkspace(session, path)) return true;
  // The installation owner may register a new private workspace, but can
  // never enter a workspace already owned by another membership.
  return canManageHostConfiguration(session) && !belongsToAnotherMembershipWorkspace(session, path);
}

export const VIRTUAL_WORKSPACE_ROOT = "/workspace";

/** Translate a browser path to a server-only path. Non-host accounts never submit host paths. */
export function workspacePathFromClient(session: AuthenticatedTenantSession, input: string): string | null {
  if (input === VIRTUAL_WORKSPACE_ROOT || input === `${VIRTUAL_WORKSPACE_ROOT}/`) {
    return tenantManagedWorkspaceRoot(session);
  }
  if (input.startsWith(`${VIRTUAL_WORKSPACE_ROOT}/`)) {
    const segments = input.slice(VIRTUAL_WORKSPACE_ROOT.length + 1).split("/");
    if (segments.some((part) => !part || part === "." || part === ".."
      || /[<>:"\\|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part)
      || (process.platform === "win32" && /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))) return null;
    return join(tenantManagedWorkspaceRoot(session), ...segments);
  }
  if (!canManageHostConfiguration(session)) return null;
  // Host accounts may retain physical paths for workspaces they own, but the
  // path must already belong to this membership. This prevents an owner from
  // selecting another member's workspace by submitting its host path.
  return canAccessWorkspacePath(session, input) ? input : null;
}

/** Never include an out-of-workspace host path in a tenant response. */
export function workspacePathToClient(session: AuthenticatedTenantSession, physicalPath: string): string | null {
  if (canManageHostConfiguration(session) && canAccessWorkspacePath(session, physicalPath)) return physicalPath;
  const root = tenantManagedWorkspaceRoot(session);
  const roots = new Set([root]);
  if (!isFilePathAllowed(physicalPath, roots)
    || !isExistingFilePathAllowed(existsSync(physicalPath) ? physicalPath : dirname(physicalPath), roots)
    || belongsToAnotherMembershipWorkspace(session, physicalPath)) return null;
  const suffix = relative(root, physicalPath);
  if (!suffix) return VIRTUAL_WORKSPACE_ROOT;
  if (suffix === ".." || suffix.startsWith(`..${sep}`)) return null;
  return `${VIRTUAL_WORKSPACE_ROOT}/${suffix.split(sep).join("/")}`;
}

export function workspaceSessionInfoToClient(
  session: AuthenticatedTenantSession,
  info: SessionInfo,
): SessionInfo | null {
  if (canManageHostConfiguration(session)) {
    return canAccessWorkspacePath(session, info.cwd) ? info : null;
  }
  const cwd = workspacePathToClient(session, info.cwd);
  if (!cwd) return null;
  const projectRoot = workspacePathToClient(session, info.projectRoot ?? info.cwd) ?? cwd;
  return { ...info, path: "", cwd, projectRoot, projectKey: projectIdentityKey(projectRoot) };
}

export function workspaceAgentStateToClient<T>(session: AuthenticatedTenantSession, state: T): T {
  if (canManageHostConfiguration(session) || !state || typeof state !== "object" || Array.isArray(state)) return state;
  return { ...state, sessionFile: "" };
}

export function workspaceErrorMessageForClient(request: Request, error: unknown): string {
  try {
    if (canManageHostConfiguration(requireTenantSession(request))) {
      return error instanceof Error ? error.message : String(error);
    }
  } catch { /* Unauthenticated responses are also redacted. */ }
  return error instanceof TenantAuthenticationError ? error.message : "Workspace operation failed";
}
