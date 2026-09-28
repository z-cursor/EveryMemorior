import { basename } from "node:path";
import { AgentSandbox, type SandboxRunOptions, type SandboxRunResult } from "./agent-sandbox";
import { canManageHostConfiguration, requireTenantSession, TenantAuthenticationError } from "./tenant-auth";
import { canAccessWorkspacePath, tenantManagedWorkspaceRoot } from "./tenant-workspace";
import { getTenantStore } from "./tenant-store";
import { readSessionHeader } from "./session-reader";

declare global {
  var __piAgentSandboxes: Map<string, Promise<AgentSandbox>> | undefined;
}

function sandboxes(): Map<string, Promise<AgentSandbox>> {
  return globalThis.__piAgentSandboxes ??= new Map();
}

function bindAgentSession(
  request: Request,
  agentSessionId: string,
  workspacePath: string,
): void {
  const auth = requireTenantSession(request);
  const store = getTenantStore();
  if (!canAccessWorkspacePath(auth, workspacePath)) {
    throw new TenantAuthenticationError("Workspace is not available to this account", 403);
  }
  const existing = store.getAgentSessionExecution(agentSessionId);
  if (existing) {
    if (existing.tenantId !== auth.tenant.id
      || (!canManageHostConfiguration(auth) && existing.createdByMembershipId !== auth.membership.id)) {
      throw new TenantAuthenticationError("Agent session belongs to another tenant", 403);
    }
    return;
  }
  const context = { tenantId: auth.tenant.id, membershipId: auth.membership.id };
  const workspace = store.ensureWorkspace(context, {
    name: basename(workspacePath) || "Workspace",
    rootPath: workspacePath,
  });
  store.bindAgentSession(context, workspace.id, agentSessionId);
}

/** Register a newly-created session as belonging to the signed-in tenant. */
export function bindNewAgentSessionToRequest(
  request: Request,
  agentSessionId: string,
  workspacePath: string,
): void {
  bindAgentSession(request, agentSessionId, workspacePath);
}

/**
 * Authorize access to an existing session. Only the installation's first
 * tenant may adopt pre-migration sessions that have no ownership record.
 */
export function authorizeAgentSessionRequest(
  request: Request,
  agentSessionId: string,
  workspacePath?: string,
): void {
  const auth = requireTenantSession(request);
  const store = getTenantStore();
  const existing = store.getAgentSessionExecution(agentSessionId);
  if (existing) {
    if (existing.tenantId !== auth.tenant.id
      || (!canManageHostConfiguration(auth)
        && (existing.createdByMembershipId !== auth.membership.id
          || !canAccessWorkspacePath(auth, existing.workspacePath)))) {
      throw new TenantAuthenticationError("Agent session belongs to another tenant", 403);
    }
    return;
  }
  if (!workspacePath || !canManageHostConfiguration(auth)) {
    throw new TenantAuthenticationError("Agent session is not available to this tenant", 403);
  }
  bindAgentSession(request, agentSessionId, workspacePath);
}

export function authorizeAgentSessionFileRequest(
  request: Request,
  agentSessionId: string,
  sessionFile: string,
): void {
  authorizeAgentSessionRequest(request, agentSessionId, readSessionHeader(sessionFile)?.cwd);
}

export function tenantWorkspaceRootsForRequest(request: Request): string[] {
  const auth = requireTenantSession(request);
  return canManageHostConfiguration(auth)
    ? getTenantStore().listActiveWorkspaceRoots(auth.tenant.id)
    : [tenantManagedWorkspaceRoot(auth)];
}

export function tenantAgentSessionIdsForRequest(request: Request, sessionIds: string[]): string[] {
  const auth = requireTenantSession(request);
  const store = getTenantStore();
  const hostAccess = canManageHostConfiguration(auth);
  return sessionIds.filter((id) => {
    const binding = store.getAgentSessionExecution(id);
    return binding?.tenantId === auth.tenant.id
      && (hostAccess
        || (binding.createdByMembershipId === auth.membership.id
          && canAccessWorkspacePath(auth, binding.workspacePath)));
  });
}

export function tenantSessionsForRequest<T extends { id: string; cwd: string }>(
  request: Request,
  sessions: T[],
): T[] {
  const auth = requireTenantSession(request);
  const store = getTenantStore();
  const hostAccess = canManageHostConfiguration(auth);
  const mayAdoptLegacy = hostAccess;
  return sessions.filter((session) => {
    const binding = store.getAgentSessionExecution(session.id);
    if (binding) return binding.tenantId === auth.tenant.id
      && (hostAccess || (binding.createdByMembershipId === auth.membership.id
        && canAccessWorkspacePath(auth, binding.workspacePath)));
    if (!mayAdoptLegacy || !session.cwd) return false;
    authorizeAgentSessionRequest(request, session.id, session.cwd);
    return true;
  });
}

export async function runAgentSandboxCommand(
  agentSessionId: string,
  command: string,
  options?: SandboxRunOptions,
): Promise<SandboxRunResult> {
  const execution = getTenantStore().getAgentSessionExecution(agentSessionId);
  if (!execution) throw new TenantAuthenticationError("Agent session has no tenant sandbox binding", 403);
  let sandbox = sandboxes().get(agentSessionId);
  if (!sandbox) {
    const creator = getTenantStore().getMembership(execution.tenantId, execution.createdByMembershipId);
    sandbox = AgentSandbox.open({
      tenantId: execution.tenantId,
      agentId: agentSessionId,
      workspacePath: execution.workspacePath,
      skillPaths: creator && creator.role !== "member"
        ? getTenantStore().listPublishedTenantSkillPathsForTenant(execution.tenantId)
        : getTenantStore().listPublishedTenantSkillPaths(execution.tenantId, execution.createdByMembershipId),
      includeGlobalSkills: getTenantStore().getInstallationOwnerMembershipId() === execution.createdByMembershipId,
    });
    sandboxes().set(agentSessionId, sandbox);
    sandbox.catch(() => sandboxes().delete(agentSessionId));
  }
  return (await sandbox).run(command, options);
}

export async function closeAgentSandbox(agentSessionId: string): Promise<void> {
  const pending = sandboxes().get(agentSessionId);
  sandboxes().delete(agentSessionId);
  if (pending) await (await pending).close();
}
