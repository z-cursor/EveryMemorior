# Tenant data model — phase 1

Pi Web uses SQLite for its first tenant-aware persistence layer. The default file is
`~/.pi/agent/pi-web.sqlite`; `lib/tenant-store.ts` owns schema migration and access.

## Isolation boundary

- A **User** is a global human identity and may belong to more than one tenant.
- A **Tenant Membership** connects a user to one tenant and carries the tenant role.
- A **Workspace** belongs to exactly one tenant. Slugs are tenant-scoped, while a physical root path
  can belong to only one tenant on an installation.
- An **Agent Session Binding** assigns each existing Pi JSONL session to one tenant and workspace.
- Every tenant-owned lookup in `TenantStore` requires `tenantId`; composite foreign keys reject
  cross-tenant workspace, membership, and agent-session relationships.
- SQLite has no row-level security. API handlers must derive `tenantId` and `membershipId` from a
  validated authentication session, never accept either value as authority from the request body.

## Schema

| Table | Purpose | Important fields and constraints |
| --- | --- | --- |
| `tenants` | Organization/security boundary | `slug` (case-insensitive unique), `status`, `plan_code`, `seat_limit`, timestamps, soft-delete marker |
| `users` | Global person/profile | normalized unique email, display name, avatar, locale, status, login/delete timestamps |
| `auth_identities` | Password or future OAuth/OIDC identity | unique `(provider, provider_subject)`, optional credential hash and algorithm; never stores plaintext secrets |
| `tenant_memberships` | User-to-tenant authorization link | unique `(tenant_id, user_id)`, fixed phase-1 roles `owner/admin/member`, active/suspended status |
| `workspaces` | Tenant-owned project context | tenant-scoped slug, root path, lifecycle status, creating membership |
| `agent_session_bindings` | Ownership index for Pi JSONL sessions | globally unique Pi session id plus tenant, workspace, and creator membership |
| `tenant_invitations` | Pending member invitation | tenant/email/role, hashed token, inviter, expiry/accept/revoke timestamps; one pending invite per email |
| `auth_sessions` | Browser login session | hashed token, user and active membership, expiry/last-seen/revoke timestamps |
| `audit_events` | Append-only administrative/security trail | tenant, optional actor, action, target, valid JSON metadata, timestamp |

## Deliberately deferred

- Custom roles and permission tables: phase 1 has three fixed roles; add RBAC when real permission
  requirements exist.
- Billing, subscriptions, and entitlements: `plan_code` and `seat_limit` are sufficient integration
  points without coupling the schema to a payment vendor.
- Enterprise SSO/domain verification and SCIM: `auth_identities.provider` can represent future
  providers; provider-specific configuration should get dedicated tables in a later migration.
- Moving Pi session contents into SQLite: JSONL remains the runtime source of truth; the binding
  table provides ownership without rewriting pi-agent-core persistence.

## Backend contract

`tenant-auth.ts` resolves an opaque browser cookie to `auth_sessions`; `tenant-agent-runtime.ts` owns
Agent authorization, legacy-session adoption, tenant-visible session ids, workspace file roots, and the
Docker sandbox registry. API routes call those narrow functions and never receive a SQLite connection,
raw tenant id, container name, or Docker option.

## Organization and administration flows

- A user with more than one active membership must choose an organization at login. Switching creates
  a new authentication session for the selected membership and revokes the previous browser session.
- Any authenticated user may create a new organization and becomes its first owner.
- Owners and admins may invite, revoke invitations, and manage non-owner roles. Only owners may grant
  or remove owner access, and the last active owner cannot be demoted.
- Invitation tokens are stored only as SHA-256 hashes and expire after seven days. Existing users must
  confirm their password before an invitation can create another membership for their global identity.
- The installation creator retains host filesystem, terminal, worktree, and global-configuration access.
  Organization roles never grant host access to invited users, even after promotion to Owner or Admin.
- Other users see `/workspace` in the browser. The server maps it to
  `getAgentDir()/tenant-workspaces/<tenantId>`; raw host paths and traversal are rejected on file,
  directory, model, Git, and Agent entry points. Session JSONL paths stay server-only. This is an
  application-level virtual path namespace over a dedicated directory, not an operating-system
  filesystem or a process sandbox.
- Invited users have chat-only Agent sessions: no shell/terminal, coding tools, extensions, skills,
  or host context files. Direct Agent commands and existing-session reloads enforce the same policy.
  A future coding-capable tenant workspace needs a sandboxed filesystem/tool bridge before enabling tools.
- Pi's HTML session exporter still embeds physical session metadata, so it is disabled for tenant
  members until the exported artifact can be redacted; ordinary session browsing remains available.
- Models configuration, provider authentication, plugins, skills, subagent profiles/settings, shell-tool
  settings, and project trust remain host-global. Only the installation creator may read or change
  those host-level administration surfaces.
