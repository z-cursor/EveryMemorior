import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const TENANT_SCHEMA_VERSION = 5;

export type TenantStatus = "active" | "suspended";
export type UserStatus = "active" | "disabled";
export type TenantRole = "owner" | "admin" | "member";
export type MembershipStatus = "active" | "suspended";
export type WorkspaceStatus = "active" | "archived";
export type TenantSkillStatus = "draft" | "pending_review" | "published" | "suspended" | "archived";
export type CompanionConfigStatus = "draft" | "published" | "archived";
export type CompanionTurnStatus = "running" | "completed" | "incomplete" | "rejected" | "failed";
export type CompanionClassification = "ordinary" | "current_fact" | "sensitive" | "professional" | "urgent_danger" | "abnormal";

export interface Tenant {
  id: string;
  slug: string;
  name: string;
  status: TenantStatus;
  planCode: string;
  seatLimit: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface User {
  id: string;
  primaryEmail: string;
  displayName: string;
  avatarUrl: string | null;
  status: UserStatus;
  locale: string;
  createdAt: string;
  updatedAt: string;
}

export interface Membership {
  id: string;
  tenantId: string;
  userId: string;
  role: TenantRole;
  status: MembershipStatus;
  joinedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface Workspace {
  id: string;
  tenantId: string;
  slug: string;
  name: string;
  rootPath: string;
  status: WorkspaceStatus;
  createdByMembershipId: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentSessionBinding {
  agentSessionId: string;
  tenantId: string;
  workspaceId: string;
  createdByMembershipId: string;
  createdAt: string;
}

export interface CreateTenantWithOwnerInput {
  tenant: { name: string; slug: string; planCode?: string; seatLimit?: number | null };
  owner: { email: string; displayName: string; locale?: string };
  credential?: { hash: string; algorithm: string };
  claimInstallation?: boolean;
}

export interface TenantContext {
  tenantId: string;
  membershipId: string;
}

export interface CreateWorkspaceInput {
  name: string;
  slug: string;
  rootPath: string;
}

export interface PasswordCredential {
  userId: string;
  hash: string;
  algorithm: string;
}

export interface AuthenticatedTenantSession {
  sessionId: string;
  user: User;
  tenant: Tenant;
  membership: Membership;
  expiresAt: string;
}

export interface TenantMember {
  membershipId: string;
  userId: string;
  email: string;
  displayName: string;
  role: TenantRole;
  status: MembershipStatus;
  joinedAt: string;
}

export interface UserTenantMembership {
  membershipId: string;
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  role: TenantRole;
  status: MembershipStatus;
}

export interface TenantInvitation {
  id: string;
  tenantId: string;
  email: string;
  role: TenantRole;
  expiresAt: string;
  createdAt: string;
}

export interface TenantSkill {
  id: string;
  tenantId: string;
  slug: string;
  name: string;
  description: string;
  status: TenantSkillStatus;
  version: number;
  contentDigest: string;
  storagePath: string;
  manifest: Record<string, unknown>;
  createdByMembershipId: string;
  reviewedByMembershipId: string | null;
  createdAt: string;
  publishedAt: string | null;
}

export interface CompanionConfigVersion {
  id: string;
  tenantId: string;
  version: number;
  status: CompanionConfigStatus;
  behaviorDocument: string;
  modelProvider: string;
  modelId: string;
  thinkingLevel: string;
  temperature: number;
  maxOutputTokens: number;
  contentDigest: string;
  createdByMembershipId: string;
  createdAt: string;
  publishedAt: string | null;
}

export interface CompanionAssignment {
  tenantId: string;
  membershipId: string;
  sessionId: string;
  configVersionId: string;
  assignedAt: string;
  updatedAt: string;
}

export interface CompanionTurnRecord {
  id: string;
  tenantId: string;
  membershipId: string;
  sessionId: string;
  clientMessageId: string;
  configVersionId: string;
  status: CompanionTurnStatus;
  classification: CompanionClassification;
  buffered: boolean;
  replyText: string | null;
  failureType: string | null;
  firstVisibleAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

type SqlRow = Record<string, SQLInputValue>;

const MIGRATION_1 = `
CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL COLLATE NOCASE UNIQUE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  plan_code TEXT NOT NULL DEFAULT 'team',
  seat_limit INTEGER CHECK (seat_limit IS NULL OR seat_limit > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
) STRICT;

CREATE TABLE app_installation (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  primary_tenant_id TEXT NOT NULL UNIQUE REFERENCES tenants(id),
  initialized_at TEXT NOT NULL
) STRICT;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  primary_email TEXT NOT NULL,
  normalized_email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  locale TEXT NOT NULL DEFAULT 'zh-CN',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_login_at TEXT,
  deleted_at TEXT
) STRICT;

CREATE TABLE auth_identities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_subject TEXT NOT NULL,
  credential_hash TEXT,
  credential_algorithm TEXT,
  email_verified_at TEXT,
  last_authenticated_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (provider, provider_subject),
  CHECK ((credential_hash IS NULL) = (credential_algorithm IS NULL))
) STRICT;

CREATE INDEX auth_identities_user_idx ON auth_identities(user_id);

CREATE TABLE tenant_memberships (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  joined_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, user_id),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, user_id, id)
) STRICT;

CREATE INDEX tenant_memberships_user_idx ON tenant_memberships(user_id, status);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  slug TEXT NOT NULL COLLATE NOCASE,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_by_membership_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  UNIQUE (tenant_id, slug),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, created_by_membership_id)
    REFERENCES tenant_memberships(tenant_id, id)
) STRICT;

CREATE INDEX workspaces_tenant_status_idx ON workspaces(tenant_id, status);
CREATE UNIQUE INDEX workspaces_root_owner_idx ON workspaces(root_path COLLATE NOCASE);

CREATE TABLE agent_session_bindings (
  agent_session_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  created_by_membership_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (tenant_id, workspace_id) REFERENCES workspaces(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, created_by_membership_id)
    REFERENCES tenant_memberships(tenant_id, id)
) STRICT;

CREATE INDEX agent_session_bindings_tenant_workspace_idx
  ON agent_session_bindings(tenant_id, workspace_id);

CREATE TABLE tenant_invitations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  normalized_email TEXT NOT NULL COLLATE NOCASE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  token_hash TEXT NOT NULL UNIQUE,
  invited_by_membership_id TEXT NOT NULL,
  accepted_by_user_id TEXT REFERENCES users(id),
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (tenant_id, invited_by_membership_id)
    REFERENCES tenant_memberships(tenant_id, id),
  CHECK (accepted_at IS NULL OR revoked_at IS NULL)
) STRICT;

CREATE UNIQUE INDEX tenant_invitations_pending_idx
  ON tenant_invitations(tenant_id, normalized_email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE TABLE auth_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (tenant_id, user_id, membership_id)
    REFERENCES tenant_memberships(tenant_id, user_id, id)
) STRICT;

CREATE INDEX auth_sessions_user_idx ON auth_sessions(user_id, expires_at);

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  actor_user_id TEXT REFERENCES users(id),
  actor_membership_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  metadata_json TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json)),
  created_at TEXT NOT NULL,
  FOREIGN KEY (tenant_id, actor_membership_id)
    REFERENCES tenant_memberships(tenant_id, id)
) STRICT;

CREATE INDEX audit_events_tenant_created_idx ON audit_events(tenant_id, created_at DESC);
`;

const MIGRATION_2 = `
CREATE TABLE IF NOT EXISTS app_installation (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  primary_tenant_id TEXT NOT NULL UNIQUE REFERENCES tenants(id),
  initialized_at TEXT NOT NULL
) STRICT;
INSERT INTO app_installation (id, primary_tenant_id, initialized_at)
SELECT 1, id, created_at FROM tenants
WHERE deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM app_installation WHERE id = 1)
ORDER BY created_at ASC LIMIT 1;
CREATE UNIQUE INDEX IF NOT EXISTS workspaces_root_owner_idx
  ON workspaces(root_path COLLATE NOCASE);
`;

const MIGRATION_3 = `
CREATE TABLE IF NOT EXISTS tenant_skills (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  slug TEXT NOT NULL COLLATE NOCASE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'pending_review', 'published', 'suspended', 'archived')),
  version INTEGER NOT NULL CHECK (version > 0),
  content_digest TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),
  created_by_membership_id TEXT NOT NULL,
  reviewed_by_membership_id TEXT,
  created_at TEXT NOT NULL,
  published_at TEXT,
  UNIQUE (tenant_id, slug, version),
  UNIQUE (tenant_id, content_digest),
  FOREIGN KEY (tenant_id, created_by_membership_id) REFERENCES tenant_memberships(tenant_id, id),
  FOREIGN KEY (tenant_id, reviewed_by_membership_id) REFERENCES tenant_memberships(tenant_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS tenant_skills_listing_idx ON tenant_skills(tenant_id, status, slug, version DESC);
`;

const MIGRATION_4 = `
DROP INDEX IF EXISTS tenant_skills_listing_idx;
ALTER TABLE tenant_skills RENAME TO tenant_skills_v3;
CREATE TABLE tenant_skills (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  slug TEXT NOT NULL COLLATE NOCASE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'pending_review', 'published', 'suspended', 'archived')),
  version INTEGER NOT NULL CHECK (version > 0),
  content_digest TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),
  created_by_membership_id TEXT NOT NULL,
  reviewed_by_membership_id TEXT,
  created_at TEXT NOT NULL,
  published_at TEXT,
  UNIQUE (tenant_id, created_by_membership_id, slug, version),
  UNIQUE (tenant_id, created_by_membership_id, content_digest),
  FOREIGN KEY (tenant_id, created_by_membership_id) REFERENCES tenant_memberships(tenant_id, id),
  FOREIGN KEY (tenant_id, reviewed_by_membership_id) REFERENCES tenant_memberships(tenant_id, id)
) STRICT;
INSERT INTO tenant_skills SELECT * FROM tenant_skills_v3;
DROP TABLE tenant_skills_v3;
CREATE INDEX tenant_skills_listing_idx ON tenant_skills(tenant_id, created_by_membership_id, status, slug, version DESC);
`;

const MIGRATION_5 = `
CREATE TABLE IF NOT EXISTS companion_config_versions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  version INTEGER NOT NULL CHECK (version > 0),
  status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'archived')),
  behavior_document TEXT NOT NULL,
  model_provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  thinking_level TEXT NOT NULL,
  temperature REAL NOT NULL CHECK (temperature >= 0 AND temperature <= 2),
  max_output_tokens INTEGER NOT NULL CHECK (max_output_tokens > 0),
  content_digest TEXT NOT NULL,
  created_by_membership_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  published_at TEXT,
  UNIQUE (tenant_id, version),
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, content_digest),
  FOREIGN KEY (tenant_id, created_by_membership_id) REFERENCES tenant_memberships(tenant_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS companion_config_listing_idx ON companion_config_versions(tenant_id, status, version DESC);

CREATE TABLE IF NOT EXISTS companion_assignments (
  tenant_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  config_version_id TEXT NOT NULL,
  assigned_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, membership_id),
  UNIQUE (session_id),
  FOREIGN KEY (tenant_id, membership_id) REFERENCES tenant_memberships(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, config_version_id) REFERENCES companion_config_versions(tenant_id, id)
) STRICT;

CREATE TABLE IF NOT EXISTS companion_turns (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  client_message_id TEXT NOT NULL,
  config_version_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'incomplete', 'rejected', 'failed')),
  classification TEXT NOT NULL CHECK (classification IN ('ordinary', 'current_fact', 'sensitive', 'professional', 'urgent_danger', 'abnormal')),
  buffered INTEGER NOT NULL CHECK (buffered IN (0, 1)),
  reply_text TEXT,
  failure_type TEXT,
  first_visible_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, membership_id, client_message_id),
  FOREIGN KEY (tenant_id, membership_id) REFERENCES tenant_memberships(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, config_version_id) REFERENCES companion_config_versions(tenant_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS companion_turns_membership_idx ON companion_turns(tenant_id, membership_id, created_at DESC);
`;

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function normalizedEmail(value: string): string {
  const email = requiredText(value, "email").toLocaleLowerCase("en-US");
  if (!email.includes("@")) throw new Error("email is invalid");
  return email;
}

function normalizedSlug(value: string, field = "slug"): string {
  const slug = requiredText(value, field).toLocaleLowerCase("en-US");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug)) {
    throw new Error(`${field} must contain only lowercase letters, numbers, and hyphens`);
  }
  return slug;
}

function asString(row: SqlRow, key: string): string {
  return row[key] as string;
}

function mapTenant(row: SqlRow): Tenant {
  return {
    id: asString(row, "id"),
    slug: asString(row, "slug"),
    name: asString(row, "name"),
    status: asString(row, "status") as TenantStatus,
    planCode: asString(row, "plan_code"),
    seatLimit: row.seat_limit as number | null,
    createdAt: asString(row, "created_at"),
    updatedAt: asString(row, "updated_at"),
  };
}

function mapUser(row: SqlRow): User {
  return {
    id: asString(row, "id"),
    primaryEmail: asString(row, "primary_email"),
    displayName: asString(row, "display_name"),
    avatarUrl: row.avatar_url as string | null,
    status: asString(row, "status") as UserStatus,
    locale: asString(row, "locale"),
    createdAt: asString(row, "created_at"),
    updatedAt: asString(row, "updated_at"),
  };
}

function mapMembership(row: SqlRow): Membership {
  return {
    id: asString(row, "id"),
    tenantId: asString(row, "tenant_id"),
    userId: asString(row, "user_id"),
    role: asString(row, "role") as TenantRole,
    status: asString(row, "status") as MembershipStatus,
    joinedAt: asString(row, "joined_at"),
    createdAt: asString(row, "created_at"),
    updatedAt: asString(row, "updated_at"),
  };
}

function mapWorkspace(row: SqlRow): Workspace {
  return {
    id: asString(row, "id"),
    tenantId: asString(row, "tenant_id"),
    slug: asString(row, "slug"),
    name: asString(row, "name"),
    rootPath: asString(row, "root_path"),
    status: asString(row, "status") as WorkspaceStatus,
    createdByMembershipId: asString(row, "created_by_membership_id"),
    createdAt: asString(row, "created_at"),
    updatedAt: asString(row, "updated_at"),
  };
}

function mapBinding(row: SqlRow): AgentSessionBinding {
  return {
    agentSessionId: asString(row, "agent_session_id"),
    tenantId: asString(row, "tenant_id"),
    workspaceId: asString(row, "workspace_id"),
    createdByMembershipId: asString(row, "created_by_membership_id"),
    createdAt: asString(row, "created_at"),
  };
}

function mapTenantSkill(row: SqlRow): TenantSkill {
  return {
    id: asString(row, "id"), tenantId: asString(row, "tenant_id"), slug: asString(row, "slug"),
    name: asString(row, "name"), description: asString(row, "description"),
    status: asString(row, "status") as TenantSkillStatus, version: Number(row.version),
    contentDigest: asString(row, "content_digest"), storagePath: asString(row, "storage_path"),
    manifest: JSON.parse(asString(row, "manifest_json")) as Record<string, unknown>,
    createdByMembershipId: asString(row, "created_by_membership_id"),
    reviewedByMembershipId: row.reviewed_by_membership_id as string | null,
    createdAt: asString(row, "created_at"), publishedAt: row.published_at as string | null,
  };
}

function mapCompanionConfig(row: SqlRow): CompanionConfigVersion {
  return {
    id: asString(row, "id"), tenantId: asString(row, "tenant_id"), version: Number(row.version),
    status: asString(row, "status") as CompanionConfigStatus,
    behaviorDocument: asString(row, "behavior_document"), modelProvider: asString(row, "model_provider"),
    modelId: asString(row, "model_id"), thinkingLevel: asString(row, "thinking_level"),
    temperature: Number(row.temperature), maxOutputTokens: Number(row.max_output_tokens),
    contentDigest: asString(row, "content_digest"), createdByMembershipId: asString(row, "created_by_membership_id"),
    createdAt: asString(row, "created_at"), publishedAt: row.published_at as string | null,
  };
}

function mapCompanionAssignment(row: SqlRow): CompanionAssignment {
  return {
    tenantId: asString(row, "tenant_id"), membershipId: asString(row, "membership_id"),
    sessionId: asString(row, "session_id"), configVersionId: asString(row, "config_version_id"),
    assignedAt: asString(row, "assigned_at"), updatedAt: asString(row, "updated_at"),
  };
}

function mapCompanionTurn(row: SqlRow): CompanionTurnRecord {
  return {
    id: asString(row, "id"), tenantId: asString(row, "tenant_id"), membershipId: asString(row, "membership_id"),
    sessionId: asString(row, "session_id"), clientMessageId: asString(row, "client_message_id"),
    configVersionId: asString(row, "config_version_id"), status: asString(row, "status") as CompanionTurnStatus,
    classification: asString(row, "classification") as CompanionClassification, buffered: Boolean(row.buffered),
    replyText: row.reply_text as string | null, failureType: row.failure_type as string | null,
    firstVisibleAt: row.first_visible_at as string | null, completedAt: row.completed_at as string | null,
    createdAt: asString(row, "created_at"),
  };
}

export function getTenantDatabasePath(): string {
  return process.env.PI_WEB_DATABASE_PATH?.trim() || join(getAgentDir(), "pi-web.sqlite");
}

declare global {
  var __piTenantStore: TenantStore | undefined;
  var __piTenantStorePath: string | undefined;
}

export function getTenantStore(): TenantStore {
  const path = getTenantDatabasePath();
  if (
    !globalThis.__piTenantStore
    || globalThis.__piTenantStorePath !== path
    || globalThis.__piTenantStore.schemaVersion() < TENANT_SCHEMA_VERSION
  ) {
    globalThis.__piTenantStore?.close();
    globalThis.__piTenantStore = new TenantStore(path);
    globalThis.__piTenantStorePath = path;
  }
  return globalThis.__piTenantStore;
}

export function closeTenantStore(): void {
  globalThis.__piTenantStore?.close();
  globalThis.__piTenantStore = undefined;
  globalThis.__piTenantStorePath = undefined;
}

export class TenantStore {
  private readonly database: DatabaseSync;

  constructor(databasePath = getTenantDatabasePath()) {
    if (databasePath !== ":memory:") mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(databasePath, {
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
    });
    this.database.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
    this.migrate();
    if (databasePath !== ":memory:") {
      try { chmodSync(databasePath, 0o600); } catch { /* Windows does not expose POSIX modes. */ }
    }
  }

  close(): void {
    this.database.close();
  }

  schemaVersion(): number {
    const row = this.database.prepare("PRAGMA user_version").get() as SqlRow;
    return Number(row.user_version);
  }

  createTenantWithOwner(input: CreateTenantWithOwnerInput): {
    tenant: Tenant;
    owner: User;
    membership: Membership;
  } {
    const now = new Date().toISOString();
    const tenantId = randomUUID();
    let userId: string = randomUUID();
    const membershipId = randomUUID();
    const email = requiredText(input.owner.email, "owner.email");
    const normalized = normalizedEmail(email);
    const tenantName = requiredText(input.tenant.name, "tenant.name");
    const tenantSlug = normalizedSlug(input.tenant.slug, "tenant.slug");
    const displayName = requiredText(input.owner.displayName, "owner.displayName");
    const planCode = requiredText(input.tenant.planCode ?? "team", "tenant.planCode");
    const seatLimit = input.tenant.seatLimit ?? null;
    if (seatLimit !== null && (!Number.isInteger(seatLimit) || seatLimit < 1)) {
      throw new Error("tenant.seatLimit must be a positive integer or null");
    }

    this.transaction(() => {
      this.database.prepare(`
        INSERT INTO tenants (id, slug, name, plan_code, seat_limit, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(tenantId, tenantSlug, tenantName, planCode, seatLimit, now, now);
      const existingUser = this.database.prepare(`
        SELECT id FROM users WHERE normalized_email = ? AND deleted_at IS NULL
      `).get(normalized) as SqlRow | undefined;
      if (existingUser) {
        userId = asString(existingUser, "id");
      } else {
        this.database.prepare(`
          INSERT INTO users (
            id, primary_email, normalized_email, display_name, locale, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(userId, email, normalized, displayName, input.owner.locale ?? "zh-CN", now, now);
      }
      if (input.credential) {
        this.database.prepare(`
          INSERT INTO auth_identities (
            id, user_id, provider, provider_subject, credential_hash,
            credential_algorithm, email_verified_at, created_at, updated_at
          ) VALUES (?, ?, 'password', ?, ?, ?, ?, ?, ?)
        `).run(
          randomUUID(), userId, normalized, input.credential.hash,
          input.credential.algorithm, now, now, now,
        );
      }
      this.database.prepare(`
        INSERT INTO tenant_memberships (
          id, tenant_id, user_id, role, joined_at, created_at, updated_at
        ) VALUES (?, ?, ?, 'owner', ?, ?, ?)
      `).run(membershipId, tenantId, userId, now, now, now);
      this.insertAuditEvent(tenantId, userId, membershipId, "tenant.created", "tenant", tenantId, now);
      if (input.claimInstallation) {
        this.database.prepare(`
          INSERT INTO app_installation (id, primary_tenant_id, initialized_at) VALUES (1, ?, ?)
        `).run(tenantId, now);
      }
    });

    return {
      tenant: this.getTenant(tenantId)!,
      owner: this.getUser(userId)!,
      membership: this.getMembership(tenantId, membershipId)!,
    };
  }

  getTenant(tenantId: string): Tenant | null {
    const row = this.database.prepare(`
      SELECT id, slug, name, status, plan_code, seat_limit, created_at, updated_at
      FROM tenants WHERE id = ? AND deleted_at IS NULL
    `).get(tenantId) as SqlRow | undefined;
    return row ? mapTenant(row) : null;
  }

  getTenantBySlug(slug: string): Tenant | null {
    const row = this.database.prepare(`
      SELECT id, slug, name, status, plan_code, seat_limit, created_at, updated_at
      FROM tenants WHERE slug = ? AND deleted_at IS NULL
    `).get(normalizedSlug(slug, "tenant.slug")) as SqlRow | undefined;
    return row ? mapTenant(row) : null;
  }

  getUser(userId: string): User | null {
    const row = this.database.prepare(`
      SELECT id, primary_email, display_name, avatar_url, status, locale, created_at, updated_at
      FROM users WHERE id = ? AND deleted_at IS NULL
    `).get(userId) as SqlRow | undefined;
    return row ? mapUser(row) : null;
  }

  getUserByEmail(email: string): User | null {
    const row = this.database.prepare(`
      SELECT id, primary_email, display_name, avatar_url, status, locale, created_at, updated_at
      FROM users WHERE normalized_email = ? AND deleted_at IS NULL
    `).get(normalizedEmail(email)) as SqlRow | undefined;
    return row ? mapUser(row) : null;
  }

  hasUsers(): boolean {
    return Number((this.database.prepare(
      "SELECT COUNT(*) AS count FROM users WHERE deleted_at IS NULL",
    ).get() as SqlRow).count) > 0;
  }

  isInitialized(): boolean {
    return Boolean(this.database.prepare("SELECT 1 FROM app_installation WHERE id = 1").get());
  }

  getPrimaryTenantId(): string | null {
    const row = this.database.prepare(
      "SELECT primary_tenant_id FROM app_installation WHERE id = 1",
    ).get() as SqlRow | undefined;
    return row ? asString(row, "primary_tenant_id") : null;
  }

  getInstallationOwnerMembershipId(): string | null {
    const row = this.database.prepare(`
      SELECT e.actor_membership_id FROM audit_events e
      JOIN app_installation i ON i.primary_tenant_id = e.tenant_id
      WHERE i.id = 1 AND e.action = 'tenant.created'
      ORDER BY e.created_at ASC LIMIT 1
    `).get() as SqlRow | undefined;
    return row ? asString(row, "actor_membership_id") : null;
  }

  findPasswordCredential(email: string): PasswordCredential | null {
    const row = this.database.prepare(`
      SELECT user_id, credential_hash, credential_algorithm
      FROM auth_identities
      WHERE provider = 'password' AND provider_subject = ?
    `).get(normalizedEmail(email)) as SqlRow | undefined;
    if (!row || row.credential_hash === null || row.credential_algorithm === null) return null;
    return {
      userId: asString(row, "user_id"),
      hash: asString(row, "credential_hash"),
      algorithm: asString(row, "credential_algorithm"),
    };
  }

  getMembership(tenantId: string, membershipId: string): Membership | null {
    const row = this.database.prepare(`
      SELECT id, tenant_id, user_id, role, status, joined_at, created_at, updated_at
      FROM tenant_memberships WHERE tenant_id = ? AND id = ?
    `).get(tenantId, membershipId) as SqlRow | undefined;
    return row ? mapMembership(row) : null;
  }

  listUserMemberships(userId: string): Membership[] {
    const rows = this.database.prepare(`
      SELECT id, tenant_id, user_id, role, status, joined_at, created_at, updated_at
      FROM tenant_memberships WHERE user_id = ? ORDER BY created_at
    `).all(userId) as SqlRow[];
    return rows.map(mapMembership);
  }

  listUserTenants(userId: string): UserTenantMembership[] {
    const rows = this.database.prepare(`
      SELECT m.id AS membership_id, m.tenant_id, t.name AS tenant_name, t.slug AS tenant_slug,
             m.role, m.status
      FROM tenant_memberships m
      JOIN tenants t ON t.id = m.tenant_id
      WHERE m.user_id = ? AND t.deleted_at IS NULL
      ORDER BY t.name COLLATE NOCASE
    `).all(userId) as SqlRow[];
    return rows.map((row) => ({
      membershipId: asString(row, "membership_id"),
      tenantId: asString(row, "tenant_id"),
      tenantName: asString(row, "tenant_name"),
      tenantSlug: asString(row, "tenant_slug"),
      role: asString(row, "role") as TenantRole,
      status: asString(row, "status") as MembershipStatus,
    }));
  }

  listTenantMembers(tenantId: string): TenantMember[] {
    const rows = this.database.prepare(`
      SELECT m.id AS membership_id, m.user_id, u.primary_email, u.display_name,
             m.role, m.status, m.joined_at
      FROM tenant_memberships m
      JOIN users u ON u.id = m.user_id
      WHERE m.tenant_id = ? AND u.deleted_at IS NULL
      ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
               u.display_name COLLATE NOCASE
    `).all(tenantId) as SqlRow[];
    return rows.map((row) => ({
      membershipId: asString(row, "membership_id"),
      userId: asString(row, "user_id"),
      email: asString(row, "primary_email"),
      displayName: asString(row, "display_name"),
      role: asString(row, "role") as TenantRole,
      status: asString(row, "status") as MembershipStatus,
      joinedAt: asString(row, "joined_at"),
    }));
  }

  createInvitation(
    context: TenantContext,
    input: { email: string; role: TenantRole; tokenHash: string; expiresAt: string },
  ): TenantInvitation {
    const actor = this.requireTenantAdmin(context);
    const email = normalizedEmail(input.email);
    if (!(["owner", "admin", "member"] as string[]).includes(input.role)) throw new Error("Invalid tenant role");
    if (actor.role === "admin" && input.role === "owner") throw new Error("Only owners can invite owners");
    const now = new Date().toISOString();
    if (this.database.prepare(`
      SELECT 1 FROM tenant_memberships m JOIN users u ON u.id = m.user_id
      WHERE m.tenant_id = ? AND u.normalized_email = ?
    `).get(context.tenantId, email)) throw new Error("User is already a tenant member");
    const tenant = this.getTenant(context.tenantId)!;
    const activeMembers = this.listTenantMembers(context.tenantId).filter((member) => member.status === "active").length;
    const pendingInvites = Number((this.database.prepare(`
      SELECT COUNT(*) AS count FROM tenant_invitations
      WHERE tenant_id = ? AND normalized_email <> ?
        AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?
    `).get(context.tenantId, email, now) as SqlRow).count);
    if (tenant.seatLimit !== null && activeMembers + pendingInvites >= tenant.seatLimit) {
      throw new Error("Tenant seat limit reached");
    }
    const row = this.database.prepare(`
      INSERT INTO tenant_invitations (
        id, tenant_id, normalized_email, role, token_hash,
        invited_by_membership_id, expires_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (tenant_id, normalized_email)
        WHERE accepted_at IS NULL AND revoked_at IS NULL
      DO UPDATE SET
        role = excluded.role,
        token_hash = excluded.token_hash,
        invited_by_membership_id = excluded.invited_by_membership_id,
        expires_at = excluded.expires_at,
        created_at = excluded.created_at
      RETURNING id
    `).get(randomUUID(), context.tenantId, email, input.role, input.tokenHash, context.membershipId, input.expiresAt, now) as SqlRow;
    const id = asString(row, "id");
    this.insertAuditEvent(context.tenantId, actor.userId, actor.id, "tenant.invitation.created", "tenant_invitation", id, now);
    return { id, tenantId: context.tenantId, email, role: input.role, expiresAt: input.expiresAt, createdAt: now };
  }

  listPendingInvitations(context: TenantContext): TenantInvitation[] {
    this.requireTenantAdmin(context);
    const rows = this.database.prepare(`
      SELECT id, tenant_id, normalized_email, role, expires_at, created_at
      FROM tenant_invitations
      WHERE tenant_id = ? AND accepted_at IS NULL AND revoked_at IS NULL
      ORDER BY created_at DESC
    `).all(context.tenantId) as SqlRow[];
    return rows.map((row) => ({
      id: asString(row, "id"), tenantId: asString(row, "tenant_id"),
      email: asString(row, "normalized_email"), role: asString(row, "role") as TenantRole,
      expiresAt: asString(row, "expires_at"), createdAt: asString(row, "created_at"),
    }));
  }

  getPendingInvitationEmail(tokenHash: string): string | null {
    const row = this.database.prepare(`
      SELECT normalized_email FROM tenant_invitations
      WHERE token_hash = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?
    `).get(tokenHash, new Date().toISOString()) as SqlRow | undefined;
    return row ? asString(row, "normalized_email") : null;
  }

  revokeInvitation(context: TenantContext, invitationId: string): void {
    const actor = this.requireTenantAdmin(context);
    const now = new Date().toISOString();
    const result = this.database.prepare(`
      UPDATE tenant_invitations SET revoked_at = ?
      WHERE tenant_id = ? AND id = ? AND accepted_at IS NULL AND revoked_at IS NULL
    `).run(now, context.tenantId, invitationId);
    if (result.changes !== 1) throw new Error("Invitation not found");
    this.insertAuditEvent(context.tenantId, actor.userId, actor.id, "tenant.invitation.revoked", "tenant_invitation", invitationId, now);
  }

  acceptInvitation(input: {
    tokenHash: string;
    displayName?: string;
    credential?: { hash: string; algorithm: string };
  }): { tenant: Tenant; user: User; membership: Membership } {
    const now = new Date().toISOString();
    let result: { tenant: Tenant; user: User; membership: Membership } | null = null;
    this.transaction(() => {
      const invite = this.database.prepare(`
        SELECT id, tenant_id, normalized_email, role FROM tenant_invitations
        WHERE token_hash = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?
      `).get(input.tokenHash, now) as SqlRow | undefined;
      if (!invite) throw new Error("Invitation is invalid or expired");
      const email = asString(invite, "normalized_email");
      let user = this.getUserByEmail(email);
      if (!user) {
        if (!input.credential || !input.displayName?.trim()) throw new Error("Display name and password are required");
        const userId = randomUUID();
        const name = requiredText(input.displayName, "displayName");
        this.database.prepare(`
          INSERT INTO users (id, primary_email, normalized_email, display_name, locale, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'zh-CN', ?, ?)
        `).run(userId, email, email, name, now, now);
        this.database.prepare(`
          INSERT INTO auth_identities (
            id, user_id, provider, provider_subject, credential_hash,
            credential_algorithm, email_verified_at, created_at, updated_at
          ) VALUES (?, ?, 'password', ?, ?, ?, ?, ?, ?)
        `).run(randomUUID(), userId, email, input.credential.hash, input.credential.algorithm, now, now, now);
        user = this.getUser(userId)!;
      }
      const tenantId = asString(invite, "tenant_id");
      const membershipId = randomUUID();
      this.database.prepare(`
        INSERT INTO tenant_memberships (id, tenant_id, user_id, role, joined_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(membershipId, tenantId, user.id, asString(invite, "role"), now, now, now);
      this.database.prepare(`
        UPDATE tenant_invitations SET accepted_by_user_id = ?, accepted_at = ? WHERE id = ?
      `).run(user.id, now, asString(invite, "id"));
      this.insertAuditEvent(tenantId, user.id, membershipId, "tenant.invitation.accepted", "tenant_invitation", asString(invite, "id"), now);
      result = { tenant: this.getTenant(tenantId)!, user, membership: this.getMembership(tenantId, membershipId)! };
    });
    return result!;
  }

  updateMembershipRole(context: TenantContext, membershipId: string, role: TenantRole): Membership {
    const actor = this.requireTenantAdmin(context);
    if (!(["owner", "admin", "member"] as string[]).includes(role)) throw new Error("Invalid tenant role");
    const target = this.getMembership(context.tenantId, membershipId);
    if (!target) throw new Error("Tenant member not found");
    if (actor.role !== "owner" && (target.role === "owner" || role === "owner")) {
      throw new Error("Only owners can change owner access");
    }
    if (target.role === "owner" && role !== "owner") {
      const owners = Number((this.database.prepare(`
        SELECT COUNT(*) AS count FROM tenant_memberships
        WHERE tenant_id = ? AND role = 'owner' AND status = 'active'
      `).get(context.tenantId) as SqlRow).count);
      if (owners <= 1) throw new Error("A tenant must keep at least one owner");
    }
    const now = new Date().toISOString();
    this.database.prepare(`
      UPDATE tenant_memberships SET role = ?, updated_at = ? WHERE tenant_id = ? AND id = ?
    `).run(role, now, context.tenantId, membershipId);
    this.insertAuditEvent(context.tenantId, actor.userId, actor.id, "tenant.membership.role_changed", "tenant_membership", membershipId, now);
    return this.getMembership(context.tenantId, membershipId)!;
  }

  createWorkspace(context: TenantContext, input: CreateWorkspaceInput): Workspace {
    this.requireActiveMembership(context);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO workspaces (
        id, tenant_id, slug, name, root_path, created_by_membership_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      context.tenantId,
      normalizedSlug(input.slug, "workspace.slug"),
      requiredText(input.name, "workspace.name"),
      requiredText(input.rootPath, "workspace.rootPath"),
      context.membershipId,
      now,
      now,
    );
    return this.getWorkspace(context.tenantId, id)!;
  }

  getWorkspace(tenantId: string, workspaceId: string): Workspace | null {
    const row = this.database.prepare(`
      SELECT id, tenant_id, slug, name, root_path, status, created_by_membership_id, created_at, updated_at
      FROM workspaces WHERE tenant_id = ? AND id = ?
    `).get(tenantId, workspaceId) as SqlRow | undefined;
    return row ? mapWorkspace(row) : null;
  }

  listActiveWorkspaceRoots(tenantId: string): string[] {
    const rows = this.database.prepare(`
      SELECT root_path FROM workspaces
      WHERE tenant_id = ? AND status = 'active'
      ORDER BY created_at ASC
    `).all(tenantId) as SqlRow[];
    return rows.map((row) => asString(row, "root_path"));
  }

  bindAgentSession(
    context: TenantContext,
    workspaceId: string,
    agentSessionId: string,
  ): AgentSessionBinding {
    this.requireActiveMembership(context);
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO agent_session_bindings (
        agent_session_id, tenant_id, workspace_id, created_by_membership_id, created_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      requiredText(agentSessionId, "agentSessionId"),
      context.tenantId,
      workspaceId,
      context.membershipId,
      now,
    );
    return this.getAgentSessionBinding(context.tenantId, agentSessionId)!;
  }

  getAgentSessionBinding(tenantId: string, agentSessionId: string): AgentSessionBinding | null {
    const row = this.database.prepare(`
      SELECT agent_session_id, tenant_id, workspace_id, created_by_membership_id, created_at
      FROM agent_session_bindings WHERE tenant_id = ? AND agent_session_id = ?
    `).get(tenantId, agentSessionId) as SqlRow | undefined;
    return row ? mapBinding(row) : null;
  }

  getAgentSessionExecution(agentSessionId: string): (AgentSessionBinding & { workspacePath: string }) | null {
    const row = this.database.prepare(`
      SELECT b.agent_session_id, b.tenant_id, b.workspace_id,
             b.created_by_membership_id, b.created_at, w.root_path
      FROM agent_session_bindings b
      JOIN workspaces w ON w.tenant_id = b.tenant_id AND w.id = b.workspace_id
      WHERE b.agent_session_id = ? AND w.status = 'active'
    `).get(agentSessionId) as SqlRow | undefined;
    return row ? { ...mapBinding(row), workspacePath: asString(row, "root_path") } : null;
  }

  createTenantSkillDraft(context: TenantContext, input: {
    slug: string; name: string; description: string; contentDigest: string;
    storagePath: string; manifest: Record<string, unknown>;
  }): TenantSkill {
    const actor = this.requireActiveMembership(context);
    const slug = normalizedSlug(input.slug, "skill.slug");
    const version = Number((this.database.prepare(
      "SELECT COALESCE(MAX(version), 0) + 1 AS version FROM tenant_skills WHERE tenant_id = ? AND created_by_membership_id = ? AND slug = ?",
    ).get(context.tenantId, context.membershipId, slug) as SqlRow).version);
    const now = new Date().toISOString();
    const id = randomUUID();
    this.database.prepare(`
      INSERT INTO tenant_skills (
        id, tenant_id, slug, name, description, status, version, content_digest,
        storage_path, manifest_json, created_by_membership_id, created_at
      ) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?)
    `).run(id, context.tenantId, slug, requiredText(input.name, "skill.name"), input.description.trim(), version,
      input.contentDigest, input.storagePath, JSON.stringify(input.manifest), context.membershipId, now);
    this.insertAuditEvent(context.tenantId, actor.userId, actor.id, "tenant.skill.created", "tenant_skill", id, now);
    return this.getTenantSkill(context.tenantId, id)!;
  }

  getTenantSkill(tenantId: string, skillId: string): TenantSkill | null {
    const row = this.database.prepare("SELECT * FROM tenant_skills WHERE tenant_id = ? AND id = ?")
      .get(tenantId, skillId) as SqlRow | undefined;
    return row ? mapTenantSkill(row) : null;
  }

  listPublishedTenantSkillPaths(tenantId: string, membershipId: string): string[] {
    const rows = this.database.prepare(`SELECT storage_path FROM tenant_skills
      WHERE tenant_id = ? AND created_by_membership_id = ? AND status = 'published'
        AND version = (SELECT MAX(v.version) FROM tenant_skills v WHERE v.tenant_id = tenant_skills.tenant_id AND v.created_by_membership_id = tenant_skills.created_by_membership_id AND v.slug = tenant_skills.slug AND v.status = 'published')
      ORDER BY slug COLLATE NOCASE, version DESC`).all(tenantId, membershipId) as SqlRow[];
    return rows.map((row) => asString(row, "storage_path"));
  }

  listTenantSkills(context: TenantContext, includeAll = false): TenantSkill[] {
    const membership = this.requireActiveMembership(context);
    const mayGovern = includeAll && membership.role !== "member";
    const rows = this.database.prepare(`SELECT * FROM tenant_skills WHERE tenant_id = ?
      ${mayGovern ? "" : "AND created_by_membership_id = ?"}
      ORDER BY slug COLLATE NOCASE, version DESC`).all(...(mayGovern
        ? [context.tenantId]
        : [context.tenantId, context.membershipId])) as SqlRow[];
    return rows.map(mapTenantSkill);
  }

  submitTenantSkillForReview(context: TenantContext, skillId: string): TenantSkill {
    const actor = this.requireActiveMembership(context);
    const skill = this.getTenantSkill(context.tenantId, skillId);
    if (!skill || skill.status !== "draft" || skill.createdByMembershipId !== context.membershipId) throw new Error("Draft skill not found");
    const now = new Date().toISOString();
    this.database.prepare("UPDATE tenant_skills SET status = 'pending_review' WHERE tenant_id = ? AND id = ?")
      .run(context.tenantId, skillId);
    this.insertAuditEvent(context.tenantId, actor.userId, actor.id, "tenant.skill.submitted", "tenant_skill", skillId, now);
    return this.getTenantSkill(context.tenantId, skillId)!;
  }

  activatePersonalDeclarativeSkill(context: TenantContext, skillId: string): TenantSkill {
    const actor = this.requireActiveMembership(context);
    const skill = this.getTenantSkill(context.tenantId, skillId);
    if (!skill || skill.status !== "draft" || skill.createdByMembershipId !== context.membershipId || skill.manifest.declarative !== true) {
      throw new Error("Declarative Skill draft not found");
    }
    const now = new Date().toISOString();
    this.database.prepare("UPDATE tenant_skills SET status = 'published', published_at = ? WHERE tenant_id = ? AND id = ?")
      .run(now, context.tenantId, skillId);
    this.insertAuditEvent(context.tenantId, actor.userId, actor.id, "tenant.skill.personal_activated", "tenant_skill", skillId, now);
    return this.getTenantSkill(context.tenantId, skillId)!;
  }

  publishTenantSkill(context: TenantContext, skillId: string): TenantSkill {
    const actor = this.requireTenantAdmin(context);
    const skill = this.getTenantSkill(context.tenantId, skillId);
    if (!skill || skill.status !== "pending_review") throw new Error("Skill is not pending review");
    const now = new Date().toISOString();
    this.database.prepare(`UPDATE tenant_skills SET status = 'published', reviewed_by_membership_id = ?, published_at = ?
      WHERE tenant_id = ? AND id = ?`).run(context.membershipId, now, context.tenantId, skillId);
    this.insertAuditEvent(context.tenantId, actor.userId, actor.id, "tenant.skill.published", "tenant_skill", skillId, now);
    return this.getTenantSkill(context.tenantId, skillId)!;
  }

  suspendTenantSkill(context: TenantContext, skillId: string): TenantSkill {
    const actor = this.requireTenantAdmin(context);
    const skill = this.getTenantSkill(context.tenantId, skillId);
    if (!skill || skill.status !== "published") throw new Error("Published skill not found");
    const now = new Date().toISOString();
    this.database.prepare("UPDATE tenant_skills SET status = 'suspended' WHERE tenant_id = ? AND id = ?")
      .run(context.tenantId, skillId);
    this.insertAuditEvent(context.tenantId, actor.userId, actor.id, "tenant.skill.suspended", "tenant_skill", skillId, now);
    return this.getTenantSkill(context.tenantId, skillId)!;
  }

  getCompanionConfigVersion(tenantId: string, configVersionId: string): CompanionConfigVersion | null {
    const row = this.database.prepare("SELECT * FROM companion_config_versions WHERE tenant_id = ? AND id = ?")
      .get(tenantId, configVersionId) as SqlRow | undefined;
    return row ? mapCompanionConfig(row) : null;
  }

  listCompanionConfigVersions(context: TenantContext): CompanionConfigVersion[] {
    this.requireActiveMembership(context);
    const rows = this.database.prepare(`SELECT * FROM companion_config_versions
      WHERE tenant_id = ? ORDER BY version DESC`).all(context.tenantId) as SqlRow[];
    return rows.map(mapCompanionConfig);
  }

  createCompanionConfigDraft(context: TenantContext, input: {
    behaviorDocument: string;
    modelProvider: string;
    modelId: string;
    thinkingLevel: string;
    temperature: number;
    maxOutputTokens: number;
  }): CompanionConfigVersion {
    const actor = this.requireTenantAdmin(context);
    const behaviorDocument = requiredText(input.behaviorDocument, "behaviorDocument");
    if (!Number.isFinite(input.temperature) || input.temperature < 0 || input.temperature > 2) throw new Error("temperature must be between 0 and 2");
    if (!Number.isInteger(input.maxOutputTokens) || input.maxOutputTokens < 1) throw new Error("maxOutputTokens must be positive");
    const now = new Date().toISOString();
    const version = Number((this.database.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM companion_config_versions WHERE tenant_id = ?").get(context.tenantId) as SqlRow).version) + 1;
    const digest = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const id = randomUUID();
    this.database.prepare(`INSERT INTO companion_config_versions
      (id, tenant_id, version, status, behavior_document, model_provider, model_id, thinking_level, temperature, max_output_tokens, content_digest, created_by_membership_id, created_at)
      VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, context.tenantId, version, behaviorDocument, requiredText(input.modelProvider, "modelProvider"),
      requiredText(input.modelId, "modelId"), requiredText(input.thinkingLevel, "thinkingLevel"), input.temperature,
      input.maxOutputTokens, digest, context.membershipId, now,
    );
    this.insertAuditEvent(context.tenantId, actor.userId, actor.id, "companion.config.created", "companion_config", id, now);
    return this.getCompanionConfigVersion(context.tenantId, id)!;
  }

  ensureCompanionConfig(context: TenantContext): CompanionConfigVersion {
    const membership = this.requireActiveMembership(context);
    const existing = this.database.prepare(`SELECT * FROM companion_config_versions
      WHERE tenant_id = ? AND status = 'published' ORDER BY version DESC LIMIT 1`).get(context.tenantId) as SqlRow | undefined;
    if (existing) return mapCompanionConfig(existing);
    const now = new Date().toISOString();
    const behaviorDocument = "以尊重、具体承接和不过度追问为默认。使用‘您’，明确自己是 AI，不虚构现实经历，不承诺现实救援。用户明确求助时再提供低风险建议。";
    const input = { behaviorDocument, modelProvider: "qwen", modelId: "FY-Qwen3.8-27B-NVFP4", thinkingLevel: "off", temperature: 0.2, maxOutputTokens: 600 };
    const version = Number((this.database.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM companion_config_versions WHERE tenant_id = ?").get(context.tenantId) as SqlRow).version) + 1;
    const digest = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const id = randomUUID();
    this.database.prepare(`INSERT INTO companion_config_versions
      (id, tenant_id, version, status, behavior_document, model_provider, model_id, thinking_level, temperature, max_output_tokens, content_digest, created_by_membership_id, created_at, published_at)
      VALUES (?, ?, ?, 'published', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, context.tenantId, version, input.behaviorDocument, input.modelProvider, input.modelId, input.thinkingLevel,
      input.temperature, input.maxOutputTokens, digest, membership.id, now, now,
    );
    this.insertAuditEvent(context.tenantId, membership.userId, membership.id, "companion.config.initialized", "companion_config", id, now);
    return this.getCompanionConfigVersion(context.tenantId, id)!;
  }

  publishCompanionConfig(context: TenantContext, configVersionId: string): CompanionConfigVersion {
    const actor = this.requireTenantAdmin(context);
    const config = this.getCompanionConfigVersion(context.tenantId, configVersionId);
    if (!config || config.status !== "draft") throw new Error("Companion config draft not found");
    const now = new Date().toISOString();
    this.database.prepare("UPDATE companion_config_versions SET status = 'published', published_at = ? WHERE tenant_id = ? AND id = ?")
      .run(now, context.tenantId, configVersionId);
    this.insertAuditEvent(context.tenantId, actor.userId, actor.id, "companion.config.published", "companion_config", configVersionId, now);
    return this.getCompanionConfigVersion(context.tenantId, configVersionId)!;
  }

  getCompanionAssignment(context: TenantContext): CompanionAssignment | null {
    this.requireActiveMembership(context);
    const row = this.database.prepare("SELECT * FROM companion_assignments WHERE tenant_id = ? AND membership_id = ?")
      .get(context.tenantId, context.membershipId) as SqlRow | undefined;
    return row ? mapCompanionAssignment(row) : null;
  }

  ensureCompanionAssignment(context: TenantContext, sessionId: string): CompanionAssignment {
    const membership = this.requireActiveMembership(context);
    const existing = this.getCompanionAssignment(context);
    if (existing) return existing;
    const config = this.ensureCompanionConfig(context);
    const now = new Date().toISOString();
    this.database.prepare(`INSERT INTO companion_assignments
      (tenant_id, membership_id, session_id, config_version_id, assigned_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(context.tenantId, membership.id, requiredText(sessionId, "sessionId"), config.id, now, now);
    this.insertAuditEvent(context.tenantId, membership.userId, membership.id, "companion.assignment.created", "companion_assignment", membership.id, now);
    return this.getCompanionAssignment(context)!;
  }

  migrateCompanionAssignment(context: TenantContext, membershipId: string, configVersionId: string): CompanionAssignment {
    const actor = this.requireTenantAdmin(context);
    const target = this.getCompanionConfigVersion(context.tenantId, configVersionId);
    if (!target || target.status !== "published") throw new Error("Published companion config not found");
    const assignment = this.database.prepare("SELECT * FROM companion_assignments WHERE tenant_id = ? AND membership_id = ?")
      .get(context.tenantId, membershipId) as SqlRow | undefined;
    if (!assignment) throw new Error("Companion assignment not found");
    const now = new Date().toISOString();
    this.database.prepare("UPDATE companion_assignments SET config_version_id = ?, updated_at = ? WHERE tenant_id = ? AND membership_id = ?")
      .run(configVersionId, now, context.tenantId, membershipId);
    this.insertAuditEvent(context.tenantId, actor.userId, actor.id, "companion.assignment.migrated", "companion_assignment", membershipId, now);
    return this.getCompanionAssignment({ tenantId: context.tenantId, membershipId })!;
  }

  findCompanionTurn(context: TenantContext, clientMessageId: string): CompanionTurnRecord | null {
    this.requireActiveMembership(context);
    const row = this.database.prepare("SELECT * FROM companion_turns WHERE tenant_id = ? AND membership_id = ? AND client_message_id = ?")
      .get(context.tenantId, context.membershipId, clientMessageId) as SqlRow | undefined;
    return row ? mapCompanionTurn(row) : null;
  }

  listCompanionTurns(context: TenantContext, limit = 100): CompanionTurnRecord[] {
    this.requireActiveMembership(context);
    const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    const rows = this.database.prepare(`SELECT * FROM companion_turns
      WHERE tenant_id = ? AND membership_id = ? ORDER BY created_at DESC LIMIT ?`)
      .all(context.tenantId, context.membershipId, boundedLimit) as SqlRow[];
    return rows.map(mapCompanionTurn);
  }

  beginCompanionTurn(context: TenantContext, input: {
    sessionId: string; clientMessageId: string; configVersionId: string;
    classification: CompanionClassification; buffered: boolean;
  }): CompanionTurnRecord {
    this.requireActiveMembership(context);
    const now = new Date().toISOString();
    const id = randomUUID();
    this.database.prepare(`INSERT INTO companion_turns
      (id, tenant_id, membership_id, session_id, client_message_id, config_version_id, status, classification, buffered, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)`).run(
      id, context.tenantId, context.membershipId, input.sessionId, requiredText(input.clientMessageId, "clientMessageId"),
      input.configVersionId, input.classification, input.buffered ? 1 : 0, now,
    );
    return this.findCompanionTurn(context, input.clientMessageId)!;
  }

  completeCompanionTurn(context: TenantContext, turnId: string, input: {
    status: CompanionTurnStatus; replyText?: string | null; failureType?: string | null;
    firstVisibleAt?: string | null; completedAt?: string | null;
  }): CompanionTurnRecord {
    this.requireActiveMembership(context);
    this.database.prepare(`UPDATE companion_turns SET status = ?, reply_text = ?, failure_type = ?, first_visible_at = ?, completed_at = ?
      WHERE tenant_id = ? AND membership_id = ? AND id = ?`).run(
      input.status, input.replyText ?? null, input.failureType ?? null, input.firstVisibleAt ?? null,
      input.completedAt ?? new Date().toISOString(), context.tenantId, context.membershipId, turnId,
    );
    const row = this.database.prepare("SELECT * FROM companion_turns WHERE tenant_id = ? AND membership_id = ? AND id = ?")
      .get(context.tenantId, context.membershipId, turnId) as SqlRow | undefined;
    if (!row) throw new Error("Companion turn not found");
    return mapCompanionTurn(row);
  }

  ensureWorkspace(context: TenantContext, input: Omit<CreateWorkspaceInput, "slug">): Workspace {
    this.requireActiveMembership(context);
    const existing = this.database.prepare(`
      SELECT id, tenant_id, slug, name, root_path, status,
             created_by_membership_id, created_at, updated_at
      FROM workspaces WHERE tenant_id = ? AND root_path = ?
    `).get(context.tenantId, input.rootPath) as SqlRow | undefined;
    if (existing) {
      const workspace = mapWorkspace(existing);
      if (workspace.status === "archived") {
        this.database.prepare(`
          UPDATE workspaces SET status = 'active', archived_at = NULL, updated_at = ?
          WHERE tenant_id = ? AND id = ?
        `).run(new Date().toISOString(), context.tenantId, workspace.id);
        return this.getWorkspace(context.tenantId, workspace.id)!;
      }
      return workspace;
    }
    const base = input.name.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "workspace";
    const suffix = createHash("sha256").update(input.rootPath).digest("hex").slice(0, 8);
    return this.createWorkspace(context, { ...input, slug: `${base.slice(0, 50)}-${suffix}` });
  }

  archiveWorkspaceByRoot(context: TenantContext, rootPath: string): void {
    this.requireActiveMembership(context);
    const now = new Date().toISOString();
    this.database.prepare(`
      UPDATE workspaces SET status = 'archived', archived_at = ?, updated_at = ?
      WHERE tenant_id = ? AND root_path = ? AND status = 'active'
    `).run(now, now, context.tenantId, rootPath);
  }

  createAuthenticationSession(input: {
    tokenHash: string;
    userId: string;
    tenantId: string;
    membershipId: string;
    expiresAt: string;
  }): string {
    const id = randomUUID();
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO auth_sessions (
        id, token_hash, user_id, tenant_id, membership_id,
        expires_at, last_seen_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.tokenHash, input.userId, input.tenantId, input.membershipId,
      input.expiresAt, now, now,
    );
    return id;
  }

  resolveAuthenticationSession(tokenHash: string, now = new Date().toISOString()): AuthenticatedTenantSession | null {
    const row = this.database.prepare(`
      SELECT s.id AS session_id, s.expires_at,
             u.id AS user_id, u.primary_email, u.display_name, u.avatar_url,
             u.status AS user_status, u.locale, u.created_at AS user_created_at,
             u.updated_at AS user_updated_at,
             t.id AS tenant_id, t.slug, t.name AS tenant_name, t.status AS tenant_status,
             t.plan_code, t.seat_limit, t.created_at AS tenant_created_at,
             t.updated_at AS tenant_updated_at,
             m.id AS membership_id, m.role, m.status AS membership_status,
             m.joined_at, m.created_at AS membership_created_at,
             m.updated_at AS membership_updated_at
      FROM auth_sessions s
      JOIN users u ON u.id = s.user_id
      JOIN tenants t ON t.id = s.tenant_id
      JOIN tenant_memberships m ON m.id = s.membership_id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?
        AND u.status = 'active' AND u.deleted_at IS NULL
        AND t.status = 'active' AND t.deleted_at IS NULL
        AND m.status = 'active'
    `).get(tokenHash, now) as SqlRow | undefined;
    if (!row) return null;
    return {
      sessionId: asString(row, "session_id"),
      expiresAt: asString(row, "expires_at"),
      user: {
        id: asString(row, "user_id"),
        primaryEmail: asString(row, "primary_email"),
        displayName: asString(row, "display_name"),
        avatarUrl: row.avatar_url as string | null,
        status: asString(row, "user_status") as UserStatus,
        locale: asString(row, "locale"),
        createdAt: asString(row, "user_created_at"),
        updatedAt: asString(row, "user_updated_at"),
      },
      tenant: {
        id: asString(row, "tenant_id"),
        slug: asString(row, "slug"),
        name: asString(row, "tenant_name"),
        status: asString(row, "tenant_status") as TenantStatus,
        planCode: asString(row, "plan_code"),
        seatLimit: row.seat_limit as number | null,
        createdAt: asString(row, "tenant_created_at"),
        updatedAt: asString(row, "tenant_updated_at"),
      },
      membership: {
        id: asString(row, "membership_id"),
        tenantId: asString(row, "tenant_id"),
        userId: asString(row, "user_id"),
        role: asString(row, "role") as TenantRole,
        status: asString(row, "membership_status") as MembershipStatus,
        joinedAt: asString(row, "joined_at"),
        createdAt: asString(row, "membership_created_at"),
        updatedAt: asString(row, "membership_updated_at"),
      },
    };
  }

  revokeAuthenticationSession(tokenHash: string): void {
    this.database.prepare(`
      UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL
    `).run(new Date().toISOString(), tokenHash);
  }

  private migrate(): void {
    const current = this.schemaVersion();
    if (current > TENANT_SCHEMA_VERSION) {
      throw new Error(`Tenant database schema ${current} is newer than supported ${TENANT_SCHEMA_VERSION}`);
    }
    if (current === 0) {
      this.transaction(() => {
        this.database.exec(MIGRATION_1);
        this.database.exec(MIGRATION_2);
        this.database.exec(MIGRATION_3);
        this.database.exec(MIGRATION_4);
        this.database.exec(MIGRATION_5);
        this.database.exec(`PRAGMA user_version = ${TENANT_SCHEMA_VERSION}`);
      });
    } else if (current === 1) {
      this.transaction(() => {
        this.database.exec(MIGRATION_2);
        this.database.exec(MIGRATION_3);
        this.database.exec(MIGRATION_4);
        this.database.exec(MIGRATION_5);
        this.database.exec(`PRAGMA user_version = ${TENANT_SCHEMA_VERSION}`);
      });
    } else if (current === 2) {
      this.transaction(() => {
        this.database.exec(MIGRATION_3);
        this.database.exec(MIGRATION_4);
        this.database.exec(MIGRATION_5);
        this.database.exec(`PRAGMA user_version = ${TENANT_SCHEMA_VERSION}`);
      });
    } else if (current === 3) {
      this.transaction(() => {
        this.database.exec(MIGRATION_4);
        this.database.exec(MIGRATION_5);
        this.database.exec(`PRAGMA user_version = ${TENANT_SCHEMA_VERSION}`);
      });
    } else if (current === 4) {
      this.transaction(() => {
        this.database.exec(MIGRATION_5);
        this.database.exec(`PRAGMA user_version = ${TENANT_SCHEMA_VERSION}`);
      });
    }
  }

  private requireActiveMembership(context: TenantContext): Membership {
    const membership = this.getMembership(context.tenantId, context.membershipId);
    if (!membership || membership.status !== "active") {
      throw new Error("Active tenant membership required");
    }
    return membership;
  }

  private requireTenantAdmin(context: TenantContext): Membership {
    const membership = this.requireActiveMembership(context);
    if (membership.role !== "owner" && membership.role !== "admin") throw new Error("Owner or admin access required");
    return membership;
  }

  private insertAuditEvent(
    tenantId: string,
    actorUserId: string,
    actorMembershipId: string,
    action: string,
    targetType: string,
    targetId: string,
    createdAt: string,
  ): void {
    this.database.prepare(`
      INSERT INTO audit_events (
        id, tenant_id, actor_user_id, actor_membership_id, action, target_type, target_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(), tenantId, actorUserId, actorMembershipId, action, targetType, targetId, createdAt,
    );
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}
