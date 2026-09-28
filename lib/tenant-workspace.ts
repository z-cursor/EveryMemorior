import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { allowFileRoot, isExistingFilePathAllowed, isFilePathAllowed } from "./file-access";
import { canManageHostConfiguration, requireTenantSession, TenantAuthenticationError } from "./tenant-auth";
import { projectIdentityKey } from "./project-identity";
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

export function canAccessWorkspacePath(session: AuthenticatedTenantSession, path: string): boolean {
  return canManageHostConfiguration(session)
    || isExistingFilePathAllowed(path, new Set([tenantManagedWorkspaceRoot(session)]));
}

export const VIRTUAL_WORKSPACE_ROOT = "/workspace";

/** Translate a browser path to a server-only path. Non-host accounts never submit host paths. */
export function workspacePathFromClient(session: AuthenticatedTenantSession, input: string): string | null {
  if (canManageHostConfiguration(session)) return input;
  if (input === VIRTUAL_WORKSPACE_ROOT || input === `${VIRTUAL_WORKSPACE_ROOT}/`) {
    return tenantManagedWorkspaceRoot(session);
  }
  if (!input.startsWith(`${VIRTUAL_WORKSPACE_ROOT}/`)) return null;
  const segments = input.slice(VIRTUAL_WORKSPACE_ROOT.length + 1).split("/");
  if (segments.some((part) => !part || part === "." || part === ".."
    || /[<>:"\\|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part)
    || (process.platform === "win32" && /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)))) return null;
  return join(tenantManagedWorkspaceRoot(session), ...segments);
}

/** Never include an out-of-workspace host path in a tenant response. */
export function workspacePathToClient(session: AuthenticatedTenantSession, physicalPath: string): string | null {
  if (canManageHostConfiguration(session)) return physicalPath;
  const root = tenantManagedWorkspaceRoot(session);
  const roots = new Set([root]);
  if (!isFilePathAllowed(physicalPath, roots)
    || !isExistingFilePathAllowed(existsSync(physicalPath) ? physicalPath : dirname(physicalPath), roots)) return null;
  const suffix = relative(root, physicalPath);
  if (!suffix) return VIRTUAL_WORKSPACE_ROOT;
  if (suffix === ".." || suffix.startsWith(`..${sep}`)) return null;
  return `${VIRTUAL_WORKSPACE_ROOT}/${suffix.split(sep).join("/")}`;
}

export function workspaceSessionInfoToClient(
  session: AuthenticatedTenantSession,
  info: SessionInfo,
): SessionInfo | null {
  if (canManageHostConfiguration(session)) return info;
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
