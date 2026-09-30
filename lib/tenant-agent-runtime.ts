import { basename } from "node:path";
import {
  AgentSandbox,
  type SandboxProcessOptions,
  type SandboxProcessResult,
  type SandboxRunOptions,
  type SandboxRunResult,
} from "./agent-sandbox";
import { canManageHostConfiguration, requireTenantSession, TenantAuthenticationError } from "./tenant-auth";
import { canAccessWorkspacePath, tenantManagedWorkspaceRoot } from "./tenant-workspace";
import { getTenantStore } from "./tenant-store";
import { readSessionHeader } from "./session-reader";
import { resolveSkillRuntime, SKILL_RUNTIME_POLICY_VERSION } from "./skill-runtime";
import type { ModelGatewayRoute } from "./model-gateway";
import { resolveSkillExecutionTimeoutMs, resolveSkillLlmTimeoutSeconds, resolveSkillStageTimeoutSeconds } from "./skill-timeouts";

declare global {
  var __piAgentSandboxes: Map<string, Promise<AgentSandbox>> | undefined;
}

function sandboxes(): Map<string, Promise<AgentSandbox>> {
  return globalThis.__piAgentSandboxes ??= new Map();
}

type TenantSandboxConfig = {
  execution: NonNullable<ReturnType<ReturnType<typeof getTenantStore>["getAgentSessionExecution"]>>;
  skillPaths: string[];
  runtime: ReturnType<typeof resolveSkillRuntime>;
};

function sandboxConfig(agentSessionId: string): TenantSandboxConfig {
  const store = getTenantStore();
  const execution = store.getAgentSessionExecution(agentSessionId);
  if (!execution) throw new TenantAuthenticationError("Agent session has no tenant sandbox binding", 403);
  const membership = store.getMembership(execution.tenantId, execution.createdByMembershipId);
  if (!membership || membership.status !== "active") {
    throw new TenantAuthenticationError("Agent session membership is no longer active", 403);
  }
  // Keep the sandbox's mount set identical to the set used by the request
  // routes and the session's Skill snapshot. Owners/admins may see the
  // tenant's published releases; members see only their own releases.
  const releases = store.listPublishedTenantSkills(
    execution.tenantId,
    execution.createdByMembershipId,
    membership.role !== "member",
  );
  const skillPaths = releases.map((skill) => skill.storagePath);
  const runtime = resolveSkillRuntime(releases.map((skill) => ({
    storagePath: skill.storagePath,
    image: skill.runtimeImage,
    declarative: skill.manifest.declarative === true,
    releaseDigest: skill.releaseDigest,
    lockfileDigest: skill.lockfileDigest,
    runtimeProfile: skill.runtimeProfile,
    imageDigest: skill.imageDigest,
    buildStatus: skill.buildStatus,
  })));
  return { execution, skillPaths, runtime };
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
  const known = store.getAgentSessionBindingAnyTenant(agentSessionId);
  if (known) {
    if (known.tenantId !== auth.tenant.id || known.createdByMembershipId !== auth.membership.id) {
      throw new TenantAuthenticationError("Agent session belongs to another tenant", 403);
    }
    if (known.workspaceStatus !== "active") {
      throw new TenantAuthenticationError("Agent session workspace is archived", 403);
    }
  }
  const workspaceRecord = store.getWorkspaceByRoot(auth.tenant.id, workspacePath);
  if (workspaceRecord && workspaceRecord.createdByMembershipId === auth.membership.id && workspaceRecord.status !== "active") {
    throw new TenantAuthenticationError("Workspace is archived", 403);
  }
  const existing = store.getAgentSessionExecution(agentSessionId);
  if (existing) {
    if (existing.tenantId !== auth.tenant.id
      || existing.createdByMembershipId !== auth.membership.id
      || !canAccessWorkspacePath(auth, existing.workspacePath)) {
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
  const known = store.getAgentSessionBindingAnyTenant(agentSessionId);
  if (known) {
    if (known.tenantId !== auth.tenant.id || known.createdByMembershipId !== auth.membership.id) {
      throw new TenantAuthenticationError("Agent session belongs to another tenant", 403);
    }
    if (known.workspaceStatus !== "active") {
      throw new TenantAuthenticationError("Agent session workspace is archived", 403);
    }
  }
  const existing = store.getAgentSessionExecution(agentSessionId);
  if (existing) {
    if (existing.tenantId !== auth.tenant.id
      || existing.createdByMembershipId !== auth.membership.id
      || !canAccessWorkspacePath(auth, existing.workspacePath)) {
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
  const managed = tenantManagedWorkspaceRoot(auth);
  const owned = getTenantStore().listActiveWorkspaceRootsForMembership(auth.tenant.id, auth.membership.id);
  return owned.length > 0 ? [...new Set(owned)] : [managed];
}

export function tenantAgentSessionIdsForRequest(request: Request, sessionIds: string[]): string[] {
  const auth = requireTenantSession(request);
  const store = getTenantStore();
  return sessionIds.filter((id) => {
    const known = store.getAgentSessionBindingAnyTenant(id);
    if (known && (known.tenantId !== auth.tenant.id || known.createdByMembershipId !== auth.membership.id)) return false;
    const binding = store.getAgentSessionExecution(id);
    return binding?.tenantId === auth.tenant.id
      && binding.createdByMembershipId === auth.membership.id
      && canAccessWorkspacePath(auth, binding.workspacePath);
  });
}

export function tenantSessionsForRequest<T extends { id: string; cwd: string; created?: string; transient?: boolean }>(
  request: Request,
  sessions: T[],
): T[] {
  const auth = requireTenantSession(request);
  const store = getTenantStore();
  return sessions.filter((session) => {
    const known = store.getAgentSessionBindingAnyTenant(session.id);
    if (known) {
      if (known.tenantId !== auth.tenant.id || known.createdByMembershipId !== auth.membership.id) return false;
      // Archived bindings are tombstones. They must not fall through to the
      // legacy adoption path, which would reactivate the deleted project.
      const binding = store.getAgentSessionExecution(session.id);
      return Boolean(binding && canAccessWorkspacePath(auth, binding.workspacePath));
    }
    const binding = store.getAgentSessionExecution(session.id);
    if (binding) return binding.tenantId === auth.tenant.id
      && binding.createdByMembershipId === auth.membership.id
      && canAccessWorkspacePath(auth, binding.workspacePath);
    // A newly-created runtime is visible in memory before its ownership row is
    // written. Never let the host's legacy-adoption path claim that window:
    // doing so would permanently bind another membership's session to the
    // account that happened to refresh at the wrong moment.
    if (session.transient) return false;
    if (!canManageHostConfiguration(auth) || !session.cwd || !canAccessWorkspacePath(auth, session.cwd)) return false;
    authorizeAgentSessionRequest(request, session.id, session.cwd);
    return true;
  });
}

export async function runAgentSandboxCommand(
  agentSessionId: string,
  command: string,
  options?: SandboxRunOptions,
): Promise<SandboxRunResult> {
  return (await getAgentSandbox(agentSessionId)).run(command, options);
}

/**
 * Invoke a server-selected container worker without a shell. This is the
 * execution seam for model-facing Skill adapters: tenant-controlled strings
 * belong in argv/stdin, never in a shell command assembled on the host.
 */
export async function runAgentSandboxProcess(
  agentSessionId: string,
  argv: readonly string[],
  options?: SandboxProcessOptions,
): Promise<SandboxProcessResult> {
  return (await getAgentSandbox(agentSessionId)).runProcess(argv, options);
}

/**
 * Invoke an executable relative to a mounted tenant Skill root. The host-side
 * root is only used to select the corresponding read-only mount; the process
 * receives a `/opt/pi-agent/skills/<index>` path inside the container.
 */
export async function runAgentSandboxSkillCommand(
  agentSessionId: string,
  skillPath: string,
  relativeExecutable: string,
  args: readonly string[] = [],
  options?: SandboxProcessOptions,
): Promise<SandboxProcessResult> {
  const modelRoute = options?.modelRoute;
  return (await getAgentSandbox(agentSessionId, modelRoute)).runSkillCommand(
    skillPath,
    relativeExecutable,
    args,
    options,
  );
}

async function getAgentSandbox(agentSessionId: string, modelRoute?: ModelGatewayRoute): Promise<AgentSandbox> {
  const config = sandboxConfig(agentSessionId);
  const { execution, skillPaths, runtime } = config;
  // Timeout settings are part of the container environment. Include them in
  // the cache identity so an operator changing them does not keep reusing a
  // sandbox created with the old values; the next command gets a fresh,
  // correctly configured container without requiring a process restart.
  const sandboxKey = `${agentSessionId}\0${runtime.releaseDigest}\0${runtime.imageDigest ?? ""}\0${resolveSkillLlmTimeoutSeconds()}\0${resolveSkillStageTimeoutSeconds()}\0${resolveSkillExecutionTimeoutMs()}\0${modelRoute?.provider ?? ""}\0${modelRoute?.modelId ?? ""}`;
  let sandbox = sandboxes().get(sandboxKey);
  if (!sandbox) {
    const prefix = `${agentSessionId}\0`;
    for (const [key, previous] of [...sandboxes().entries()]) {
      if (key === sandboxKey || !key.startsWith(prefix)) continue;
      sandboxes().delete(key);
      void previous.then((instance) => instance.close()).catch(() => undefined);
    }
    sandbox = AgentSandbox.open({
      tenantId: execution.tenantId,
      agentId: agentSessionId,
      workspacePath: execution.workspacePath,
      skillPaths,
      image: runtime.image,
      imageDigest: runtime.imageDigest,
      releaseDigest: runtime.releaseDigest,
      runtimeProfile: `${runtime.profile}:${runtime.dependencyDigest}`,
      policyVersion: SKILL_RUNTIME_POLICY_VERSION,
      modelRoute,
    });
    sandboxes().set(sandboxKey, sandbox);
    sandbox.catch(() => sandboxes().delete(sandboxKey));
  }
  return sandbox;
}

export async function closeAgentSandbox(agentSessionId: string): Promise<void> {
  const prefix = `${agentSessionId}\0`;
  const pending = [...sandboxes().entries()]
    .filter(([key]) => key === agentSessionId || key.startsWith(prefix));
  await Promise.all(pending.map(async ([key, promise]) => {
    sandboxes().delete(key);
    await (await promise).close();
  }));
}
