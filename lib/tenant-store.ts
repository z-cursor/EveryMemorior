import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { containsProhibitedCompanionProfileContent, containsSensitiveCompanionInformation, normalizedOrdinaryCompanionMemory, ordinaryCompanionTopics, ORDINARY_COMPANION_TOPIC_LABELS } from "./companion-memory-policy";
import { calculateCompanionTrialMetrics, passesCompanionTrialGate } from "./companion-quality";

export const TENANT_SCHEMA_VERSION = 10;

export type TenantStatus = "active" | "suspended";
export type UserStatus = "active" | "disabled";
export type TenantRole = "owner" | "admin" | "member";
export type MembershipStatus = "active" | "suspended";
export type WorkspaceStatus = "active" | "archived";
export type TenantSkillStatus = "draft" | "pending_review" | "published" | "suspended" | "archived";
/** State of the reviewed execution runtime associated with a Skill release. */
export type TenantSkillBuildStatus = "pending" | "building" | "ready" | "failed";
export type CompanionConfigStatus = "draft" | "published" | "archived";
export type CompanionTurnStatus = "running" | "completed" | "incomplete" | "rejected" | "failed";
export type CompanionClassification = "ordinary" | "current_fact" | "sensitive" | "professional" | "urgent_danger" | "abnormal";
export type CompanionMemoryStatus = "pending_confirmation" | "confirmed" | "deleted";
export type CompanionMemorySensitivity = "ordinary" | "sensitive";
export const COMPANION_PROFILE_FIELD_NAMES = [
  "form_of_address", "reply_length", "question_preference", "topics", "humor",
  "advice_preference", "boundaries", "familiarity",
] as const;
export type CompanionProfileFieldName = typeof COMPANION_PROFILE_FIELD_NAMES[number];
export type CompanionProfileSource = "explicit" | "inferred" | "enterprise";
export type CompanionBackgroundJobStatus = "pending" | "leased" | "completed" | "failed";
export type CompanionBackgroundJobType = "memory_profile" | "fragment_summary";

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
  /** Immutable release identity; stored in the content_digest column for compatibility. */
  releaseDigest: string;
  contentDigest: string;
  storagePath: string;
  manifest: Record<string, unknown>;
  /** Digest of the preloaded runtime image selected for this release. */
  imageDigest: string | null;
  /** Local immutable image tag produced by the reviewed runtime builder. */
  runtimeImage: string | null;
  /** Digest of the dependency lockfiles used to build the runtime image. */
  lockfileDigest: string | null;
  /** Reviewed runtime profile (for example `node22-python3`). */
  runtimeProfile: string | null;
  buildStatus: TenantSkillBuildStatus;
  buildError: string | null;
  buildStartedAt: string | null;
  buildCompletedAt: string | null;
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

export interface CompanionConsent {
  tenantId: string;
  membershipId: string;
  memoryEnabled: boolean;
  optedInAt: string | null;
  revokedAt: string | null;
  updatedAt: string | null;
}

export interface CompanionMemory {
  id: string;
  tenantId: string;
  membershipId: string;
  content: string;
  status: CompanionMemoryStatus;
  sensitivity: CompanionMemorySensitivity;
  sourceEntryId: string;
  createdAt: string;
  updatedAt: string;
  confirmedAt: string | null;
  deletedAt: string | null;
  receipt: { reversible: true };
}

export interface CompanionProfileField {
  tenantId: string;
  membershipId: string;
  field: CompanionProfileFieldName;
  value: string;
  source: CompanionProfileSource;
  confidence: number;
  evidenceCount: number;
  sourceLabel: string | null;
  updatedAt: string;
}

export interface CompanionFragment {
  id: string;
  tenantId: string;
  membershipId: string;
  sessionId: string;
  startEntryId: string;
  endEntryId: string;
  sourceEntryIds: string[];
  summary: string;
  createdAt: string;
}

export interface CompanionBackgroundJob {
  id: string;
  tenantId: string;
  membershipId: string;
  type: CompanionBackgroundJobType;
  payload: Record<string, unknown>;
  status: CompanionBackgroundJobStatus;
  attempts: number;
  availableAt: string;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CompanionRetentionTarget extends TenantContext {
  sessionId: string;
}

export interface CompanionReviewConsent extends TenantContext {
  enabled: boolean;
  noticeVersion: string | null;
  consentedAt: string | null;
  withdrawnAt: string | null;
  updatedAt: string | null;
}

export interface CompanionQualitySample {
  id: string;
  tenantId: string;
  membershipId: string;
  configVersionId: string;
  messages: Array<{ entryId: string; role: "user" | "assistant"; text: string }>;
  sampledByMembershipId: string;
  createdAt: string;
}

export interface CompanionQualityReview {
  id: string;
  tenantId: string;
  sampleId: string;
  specificallyResponsive: boolean;
  interrogation: boolean;
  ignoredEnding: boolean;
  baselineViolation: boolean;
  notes: string;
  reviewedByMembershipId: string;
  createdAt: string;
}

export interface CompanionImprovementProposal {
  id: string;
  tenantId: string;
  sourceType: "review" | "evaluation";
  sourceId: string;
  baseConfigVersionId: string;
  evidence: Array<{ sourceId: string; quote: string }>;
  proposedBehaviorDocument: string;
  diff: string;
  status: "advisory" | "accepted" | "rejected";
  draftConfigVersionId: string | null;
  createdAt: string;
  reviewedAt: string | null;
}

export interface CompanionEvaluationRun {
  id: string;
  tenantId: string;
  configVersionId: string;
  suite: "quick" | "full";
  evaluationMode: "single_turn" | "rolling_episode";
  status: "pending" | "completed" | "failed";
  graderVersion: string;
  bridgeFromGraderVersion: string | null;
  candidate: Record<string, unknown>;
  questions: unknown[];
  privateAnswers: unknown[];
  graderPrompt: string;
  graderModel: string;
  parameters: Record<string, unknown>;
  policy: Record<string, unknown>;
  itemCount: number;
  averageScore: number | null;
  fatalCount: number;
  results: unknown[];
  suggestions: unknown[];
  createdByMembershipId: string;
  createdAt: string;
  completedAt: string | null;
}

export interface CompanionCalibration {
  id: string;
  tenantId: string;
  runId: string;
  itemId: string;
  band: "high" | "low" | "borderline";
  humanScore: number;
  automaticScore: number;
  notes: string;
}

export interface TenantAuditEvent {
  id: string;
  tenantId: string;
  actorUserId: string | null;
  actorMembershipId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
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
INSERT INTO tenant_skills (
  id, tenant_id, slug, name, description, status, version, content_digest,
  storage_path, manifest_json, created_by_membership_id, reviewed_by_membership_id,
  created_at, published_at
)
SELECT id, tenant_id, slug, name, description, status, version, content_digest,
  storage_path, manifest_json, created_by_membership_id, reviewed_by_membership_id,
  created_at, published_at
FROM tenant_skills_v3;
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

const MIGRATION_6 = `
CREATE TABLE IF NOT EXISTS companion_consents (
  tenant_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  memory_enabled INTEGER NOT NULL DEFAULT 0 CHECK (memory_enabled IN (0, 1)),
  opted_in_at TEXT,
  revoked_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, membership_id),
  FOREIGN KEY (tenant_id, membership_id) REFERENCES tenant_memberships(tenant_id, id) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS companion_memories (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  content TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending_confirmation', 'confirmed', 'deleted')),
  sensitivity TEXT NOT NULL CHECK (sensitivity IN ('ordinary', 'sensitive')),
  source_entry_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  confirmed_at TEXT,
  deleted_at TEXT,
  UNIQUE (tenant_id, id),
  UNIQUE (tenant_id, membership_id, content_digest),
  FOREIGN KEY (tenant_id, membership_id) REFERENCES tenant_memberships(tenant_id, id) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS companion_memories_member_idx ON companion_memories(tenant_id, membership_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS companion_profile_fields (
  tenant_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  field TEXT NOT NULL CHECK (field IN ('form_of_address', 'reply_length', 'question_preference', 'topics', 'humor', 'advice_preference', 'boundaries', 'familiarity')),
  value TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('explicit', 'inferred', 'enterprise')),
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  evidence_count INTEGER NOT NULL DEFAULT 0 CHECK (evidence_count >= 0),
  source_label TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, membership_id, field),
  FOREIGN KEY (tenant_id, membership_id) REFERENCES tenant_memberships(tenant_id, id) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS companion_profile_evidence (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  field TEXT NOT NULL,
  value TEXT NOT NULL,
  source_entry_id TEXT NOT NULL,
  source_text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, membership_id, field, value, source_entry_id),
  FOREIGN KEY (tenant_id, membership_id) REFERENCES tenant_memberships(tenant_id, id) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS companion_profile_evidence_member_idx ON companion_profile_evidence(tenant_id, membership_id, field, value);

CREATE TABLE IF NOT EXISTS companion_fragments (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  start_entry_id TEXT NOT NULL,
  end_entry_id TEXT NOT NULL,
  source_entry_ids_json TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, membership_id) REFERENCES tenant_memberships(tenant_id, id) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS companion_fragments_member_idx ON companion_fragments(tenant_id, membership_id, created_at DESC);

CREATE TABLE IF NOT EXISTS companion_background_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'leased', 'completed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, membership_id) REFERENCES tenant_memberships(tenant_id, id) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS companion_jobs_available_idx ON companion_background_jobs(tenant_id, membership_id, status, available_at);

CREATE TABLE IF NOT EXISTS companion_memory_feedback (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  correct INTEGER NOT NULL CHECK (correct IN (0, 1)),
  created_at TEXT NOT NULL,
  FOREIGN KEY (tenant_id, membership_id) REFERENCES tenant_memberships(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, memory_id) REFERENCES companion_memories(tenant_id, id) ON DELETE CASCADE
) STRICT;
`;

const MIGRATION_7 = `
CREATE TABLE IF NOT EXISTS companion_review_consents (
  tenant_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  notice_version TEXT,
  consented_at TEXT,
  withdrawn_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, membership_id),
  FOREIGN KEY (tenant_id, membership_id) REFERENCES tenant_memberships(tenant_id, id) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS companion_quality_samples (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  config_version_id TEXT NOT NULL,
  messages_json TEXT NOT NULL CHECK (json_valid(messages_json)),
  sampled_by_membership_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, membership_id) REFERENCES tenant_memberships(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, config_version_id) REFERENCES companion_config_versions(tenant_id, id),
  FOREIGN KEY (tenant_id, sampled_by_membership_id) REFERENCES tenant_memberships(tenant_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS companion_quality_samples_tenant_idx
  ON companion_quality_samples(tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS companion_quality_reviews (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  sample_id TEXT NOT NULL,
  specifically_responsive INTEGER NOT NULL CHECK (specifically_responsive IN (0, 1)),
  interrogation INTEGER NOT NULL CHECK (interrogation IN (0, 1)),
  ignored_ending INTEGER NOT NULL CHECK (ignored_ending IN (0, 1)),
  baseline_violation INTEGER NOT NULL CHECK (baseline_violation IN (0, 1)),
  notes TEXT NOT NULL,
  reviewed_by_membership_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, sample_id),
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, sample_id) REFERENCES companion_quality_samples(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, reviewed_by_membership_id) REFERENCES tenant_memberships(tenant_id, id)
) STRICT;

CREATE TABLE IF NOT EXISTS companion_evaluation_runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  config_version_id TEXT NOT NULL,
  suite TEXT NOT NULL CHECK (suite IN ('quick', 'full')),
  evaluation_mode TEXT NOT NULL CHECK (evaluation_mode IN ('single_turn', 'rolling_episode')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
  grader_version TEXT NOT NULL,
  bridge_from_grader_version TEXT,
  candidate_snapshot_json TEXT NOT NULL CHECK (json_valid(candidate_snapshot_json)),
  questions_snapshot_json TEXT NOT NULL CHECK (json_valid(questions_snapshot_json)),
  private_answers_snapshot_json TEXT NOT NULL CHECK (json_valid(private_answers_snapshot_json)),
  grader_prompt TEXT NOT NULL,
  grader_model TEXT NOT NULL,
  parameters_json TEXT NOT NULL CHECK (json_valid(parameters_json)),
  policy_json TEXT NOT NULL CHECK (json_valid(policy_json)),
  item_count INTEGER NOT NULL CHECK (item_count > 0),
  average_score REAL,
  fatal_count INTEGER NOT NULL DEFAULT 0 CHECK (fatal_count >= 0),
  suggestions_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(suggestions_json)),
  created_by_membership_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, config_version_id) REFERENCES companion_config_versions(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by_membership_id) REFERENCES tenant_memberships(tenant_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS companion_evaluation_runs_config_idx
  ON companion_evaluation_runs(tenant_id, config_version_id, created_at DESC);

CREATE TABLE IF NOT EXISTS companion_calibrations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  band TEXT NOT NULL CHECK (band IN ('high', 'low', 'borderline')),
  human_score REAL NOT NULL CHECK (human_score >= 0 AND human_score <= 100),
  automatic_score REAL NOT NULL CHECK (automatic_score >= 0 AND automatic_score <= 100),
  notes TEXT NOT NULL,
  created_by_membership_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (tenant_id, run_id) REFERENCES companion_evaluation_runs(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, created_by_membership_id) REFERENCES tenant_memberships(tenant_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS companion_calibrations_tenant_idx ON companion_calibrations(tenant_id, run_id);

CREATE TABLE IF NOT EXISTS companion_improvement_proposals (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('review', 'evaluation')),
  source_id TEXT NOT NULL,
  base_config_version_id TEXT NOT NULL,
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  proposed_behavior_document TEXT NOT NULL,
  diff_text TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('advisory', 'accepted', 'rejected')),
  draft_config_version_id TEXT,
  created_by_membership_id TEXT NOT NULL,
  reviewed_by_membership_id TEXT,
  created_at TEXT NOT NULL,
  reviewed_at TEXT,
  UNIQUE (tenant_id, id),
  FOREIGN KEY (tenant_id, base_config_version_id) REFERENCES companion_config_versions(tenant_id, id),
  FOREIGN KEY (tenant_id, draft_config_version_id) REFERENCES companion_config_versions(tenant_id, id),
  FOREIGN KEY (tenant_id, created_by_membership_id) REFERENCES tenant_memberships(tenant_id, id),
  FOREIGN KEY (tenant_id, reviewed_by_membership_id) REFERENCES tenant_memberships(tenant_id, id)
) STRICT;

CREATE TABLE IF NOT EXISTS companion_assignment_migrations (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  from_config_version_id TEXT NOT NULL,
  to_config_version_id TEXT NOT NULL,
  rollback_config_version_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  migrated_by_membership_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (tenant_id, membership_id) REFERENCES tenant_memberships(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, from_config_version_id) REFERENCES companion_config_versions(tenant_id, id),
  FOREIGN KEY (tenant_id, to_config_version_id) REFERENCES companion_config_versions(tenant_id, id),
  FOREIGN KEY (tenant_id, rollback_config_version_id) REFERENCES companion_config_versions(tenant_id, id),
  FOREIGN KEY (tenant_id, migrated_by_membership_id) REFERENCES tenant_memberships(tenant_id, id)
) STRICT;
CREATE INDEX IF NOT EXISTS companion_assignment_migrations_tenant_idx ON companion_assignment_migrations(tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS companion_trial_participants (
  tenant_id TEXT NOT NULL,
  membership_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('scripted', 'free_chat', 'completed')),
  excludes_direct_identifiers INTEGER NOT NULL CHECK (excludes_direct_identifiers IN (0, 1)),
  fictional_sensitive_exercises INTEGER NOT NULL CHECK (fictional_sensitive_exercises IN (0, 1)),
  willing_to_continue INTEGER CHECK (willing_to_continue IS NULL OR willing_to_continue IN (0, 1)),
  exit_interviewed_at TEXT,
  PRIMARY KEY (tenant_id, membership_id),
  FOREIGN KEY (tenant_id, membership_id) REFERENCES tenant_memberships(tenant_id, id) ON DELETE CASCADE
) STRICT;
`;

const MIGRATION_8 = `
CREATE UNIQUE INDEX IF NOT EXISTS companion_calibrations_item_idx
  ON companion_calibrations(tenant_id, run_id, item_id) WHERE item_id <> '';
`;

// Skill runtime metadata is deliberately kept beside the immutable release
// record.  A build may complete asynchronously after upload/review, so the
// status and diagnostics are mutable while the content and dependency
// digests remain release facts.
const MIGRATION_9 = `
ALTER TABLE tenant_skills ADD COLUMN image_digest TEXT;
ALTER TABLE tenant_skills ADD COLUMN runtime_image TEXT;
ALTER TABLE tenant_skills ADD COLUMN lockfile_digest TEXT;
ALTER TABLE tenant_skills ADD COLUMN runtime_profile TEXT;
ALTER TABLE tenant_skills ADD COLUMN build_status TEXT NOT NULL DEFAULT 'pending'
  CHECK (build_status IN ('pending', 'building', 'ready', 'failed'));
ALTER TABLE tenant_skills ADD COLUMN build_error TEXT;
ALTER TABLE tenant_skills ADD COLUMN build_started_at TEXT;
ALTER TABLE tenant_skills ADD COLUMN build_completed_at TEXT;
UPDATE tenant_skills
SET build_status = 'ready'
WHERE json_extract(manifest_json, '$.declarative') = 1;
`;

// Version 9 was briefly shipped with the schema version bumped before all of
// these columns were present.  Keep this repair separate from MIGRATION_9 so
// databases that already recorded version 9 can recover without dropping
// tenant Skill releases.  Every statement is guarded by table_info, making the
// repair safe to run again when a hot-reloaded process opens the database.
const MIGRATION_10 = "-- Tenant Skill runtime metadata repair is applied by migrate()";

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function optionalRuntimeDigest(value: string | null | undefined, field: string): string | null {
  if (value == null || value.trim() === "") return null;
  const normalized = value.trim().toLowerCase();
  if (!/^sha256:[0-9a-f]{64}$/.test(normalized)) throw new Error(`${field} must be a sha256 digest`);
  return normalized;
}

function optionalLockfileDigest(value: string | null | undefined): string | null {
  if (value == null || value.trim() === "") return null;
  const normalized = value.trim().toLowerCase();
  // Lockfile digests are also emitted by the runtime resolver as bare hex,
  // while image digests use Docker's sha256: prefix. Accept both forms so
  // release metadata can be copied without a lossy format conversion.
  if (!/^(?:sha256:)?[0-9a-f]{64}$/.test(normalized)) throw new Error("lockfileDigest must be a sha256 digest");
  return normalized;
}

function optionalRuntimeProfile(value: string | null | undefined): string | null {
  if (value == null || value.trim() === "") return null;
  const normalized = value.trim();
  if (normalized.length > 128 || [...normalized].some((char) => char.charCodeAt(0) < 0x20 || char === "\u007f" || char === "\0")) {
    throw new Error("runtimeProfile is invalid");
  }
  return normalized;
}

function optionalRuntimeImage(value: string | null | undefined): string | null {
  if (value == null || value.trim() === "") return null;
  const normalized = value.trim();
  if (normalized.length > 256 || [...normalized].some((char) => char.charCodeAt(0) < 0x20 || char === "\u007f" || char === "\0")) {
    throw new Error("runtimeImage is invalid");
  }
  return normalized;
}

function validTenantSkillBuildStatus(value: TenantSkillBuildStatus | undefined): TenantSkillBuildStatus | undefined {
  if (value === undefined) return undefined;
  if (!["pending", "building", "ready", "failed"].includes(value)) throw new Error("Invalid Skill build status");
  return value;
}

function visibleLineDiff(before: string, after: string): string {
  const beforeLines = before.split(/\r?\n/u);
  const afterLines = after.split(/\r?\n/u);
  let prefix = 0;
  while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) prefix += 1;
  return [
    ...beforeLines.slice(prefix).map((line) => `-${line}`),
    ...afterLines.slice(prefix).map((line) => `+${line}`),
  ].join("\n");
}

export function redactDirectIdentifiers(value: string): string {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, "[邮箱已移除]")
    .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/gu, "[手机号已移除]")
    .replace(/\b[A-Z]{1,3}\d{6,12}\b/giu, "[证件号已移除]")
    .replace(/(?<!\d)(?:0\d{2,3}[- ]?)?\d{7,8}(?!\d)/gu, "[座机号已移除]")
    .replace(/(?<!\d)\d{17}[\dXx](?!\d)/gu, "[证件号已移除]")
    .replace(/(?<!\d)(?:\d[ -]?){12,19}(?!\d)/gu, "[账号已移除]")
    .replace(/((?:我叫|我的姓名是|姓名[：:]?|我姓|叫我))\s*[\p{Script=Han}·]{1,8}/gu, "$1[姓名已移除]")
    .replace(/((?:住在|住址[是：:]?|家庭地址[是：:]?|地址[是：:]?))[^，。；！？\n]{2,80}/gu, "$1[地址已移除]")
    .replace(/((?:工号|学号|客户号|会员号|员工编号)[是：:]?)\s*[A-Z0-9-]{2,}/giu, "$1[标识已移除]")
    .replace(/((?:单位|公司|学校)[是：:]?)\s*[^，。；！？\n]{2,50}/gu, "$1[机构已移除]");
}

export function stillContainsDirectIdentifier(value: string): boolean {
  const remainder = value.replace(/(?:护照|身份证|住址|家庭地址|手机号|电话号码|座机|电子邮箱|邮编|车牌)?\s*\[[^\]]+已移除\]/gu, "");
  return /(?:护照|身份证|住址|家庭地址|手机号|电话号码|座机|电子邮箱|邮编|车牌)[^，。；！？\n]{2,40}/u.test(remainder)
    || /(?<!\d)\d{5,}(?!\d)/u.test(remainder)
    || /(?:我是|我叫|叫我|我姓)\s*[\p{Script=Han}·]{1,8}/u.test(remainder)
    || /[\p{Script=Han}]{2,}(?:省|市|区|县|镇|乡|村|路|街|巷|小区|大厦|单元|室|大学|学校|公司|医院|银行|政府|委员会|协会|养老院)/u.test(remainder)
    || /(?:^|[，。！？、\s])(?:赵|钱|孙|李|周|吴|郑|王|冯|陈|褚|卫|蒋|沈|韩|杨|朱|秦|尤|许|何|吕|施|张|孔|曹|严|华|金|魏|陶|姜|戚|谢|邹|喻|柏|水|窦|章|云|苏|潘|葛|奚|范|彭|郎|鲁|韦|昌|马|苗|凤|花|方|俞|任|袁|柳|唐|罗|薛|雷|贺|倪|汤|滕|殷|毕|郝|邬|安|常|乐|于|时|傅|皮|卞|齐|康|伍|余|元|卜|顾|孟|平|黄|和|穆|萧|尹)[\p{Script=Han}]{1,2}(?=[，。！？、\s]|$)/u.test(remainder);
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
    releaseDigest: asString(row, "content_digest"), contentDigest: asString(row, "content_digest"), storagePath: asString(row, "storage_path"),
    manifest: JSON.parse(asString(row, "manifest_json")) as Record<string, unknown>,
    imageDigest: row.image_digest as string | null,
    runtimeImage: row.runtime_image as string | null,
    lockfileDigest: row.lockfile_digest as string | null,
    runtimeProfile: row.runtime_profile as string | null,
    buildStatus: asString(row, "build_status") as TenantSkillBuildStatus,
    buildError: row.build_error as string | null,
    buildStartedAt: row.build_started_at as string | null,
    buildCompletedAt: row.build_completed_at as string | null,
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

function mapCompanionMemory(row: SqlRow): CompanionMemory {
  return {
    id: asString(row, "id"), tenantId: asString(row, "tenant_id"), membershipId: asString(row, "membership_id"),
    content: asString(row, "content"), status: asString(row, "status") as CompanionMemoryStatus,
    sensitivity: asString(row, "sensitivity") as CompanionMemorySensitivity,
    sourceEntryId: asString(row, "source_entry_id"), createdAt: asString(row, "created_at"),
    updatedAt: asString(row, "updated_at"), confirmedAt: row.confirmed_at as string | null,
    deletedAt: row.deleted_at as string | null, receipt: { reversible: true },
  };
}

function mapCompanionProfileField(row: SqlRow): CompanionProfileField {
  return {
    tenantId: asString(row, "tenant_id"), membershipId: asString(row, "membership_id"),
    field: asString(row, "field") as CompanionProfileFieldName, value: asString(row, "value"),
    source: asString(row, "source") as CompanionProfileSource, confidence: Number(row.confidence),
    evidenceCount: Number(row.evidence_count), sourceLabel: row.source_label as string | null,
    updatedAt: asString(row, "updated_at"),
  };
}

function mapCompanionBackgroundJob(row: SqlRow): CompanionBackgroundJob {
  return {
    id: asString(row, "id"), tenantId: asString(row, "tenant_id"), membershipId: asString(row, "membership_id"),
    type: asString(row, "type") as CompanionBackgroundJobType, payload: JSON.parse(asString(row, "payload_json")) as Record<string, unknown>,
    status: asString(row, "status") as CompanionBackgroundJobStatus, attempts: Number(row.attempts),
    availableAt: asString(row, "available_at"), leaseOwner: row.lease_owner as string | null,
    leaseExpiresAt: row.lease_expires_at as string | null, lastError: row.last_error as string | null,
    createdAt: asString(row, "created_at"), updatedAt: asString(row, "updated_at"),
  };
}

const COMPANION_PROFILE_FIELDS = new Set<CompanionProfileFieldName>(COMPANION_PROFILE_FIELD_NAMES);

function companionProfileField(value: string): CompanionProfileFieldName {
  if (!COMPANION_PROFILE_FIELDS.has(value as CompanionProfileFieldName)) throw new Error("Invalid Companion Profile field");
  return value as CompanionProfileFieldName;
}

function normalizedCompanionProfileValue(field: CompanionProfileFieldName, rawValue: string): string {
  const value = requiredText(rawValue, "profile.value");
  if (containsProhibitedCompanionProfileContent(value)) throw new Error("Sensitive or prohibited information cannot be stored in the Companion Profile");
  if (field === "topics") {
    const selected = value.split("、");
    if (selected.every((topic) => ORDINARY_COMPANION_TOPIC_LABELS.includes(topic))) return value;
    const topics = ordinaryCompanionTopics(value);
    if (topics.length === 0) throw new Error("Profile topics must be an ordinary allowed topic");
    return topics.join("、");
  }
  const choices: Partial<Record<CompanionProfileFieldName, Array<[RegExp, string]>>> = {
    reply_length: [[/short|短|简短|精简/iu, "short"], [/detailed|long|详细|多说/iu, "detailed"]],
    question_preference: [[/few|少问|别问|不追问/iu, "few"], [/more|多问|多追问/iu, "more"], [/normal|正常/iu, "normal"]],
    humor: [[/none|不幽默|不开玩笑/iu, "none"], [/light|轻松|偶尔/iu, "light"], [/more|幽默|开玩笑/iu, "more"]],
    advice_preference: [[/ask_first|先问|先征求/iu, "ask_first"], [/requested|需要时|我问时/iu, "when_requested"], [/none|不要建议/iu, "none"]],
    boundaries: [[/no_questions|不追问|别追问/iu, "no_follow_up_questions"], [/no_advice|不要建议/iu, "no_unsolicited_advice"], [/no_humor|不开玩笑/iu, "no_humor"]],
    familiarity: [[/new|陌生|刚认识/iu, "new"], [/warm|熟悉|亲切/iu, "warm"], [/familiar|很熟|老朋友/iu, "familiar"]],
  };
  const fieldChoices = choices[field];
  if (fieldChoices) {
    if (fieldChoices.some(([, normalized]) => normalized === value)) return value;
    const normalized = fieldChoices.find(([pattern]) => pattern.test(value))?.[1];
    if (!normalized) throw new Error(`Invalid Companion Profile value for ${field}`);
    return normalized;
  }
  return value;
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
  const current = globalThis.__piTenantStore;
  // Next's development runtime preserves globalThis across hot reloads.  A
  // store created by the previous module can therefore have the old class
  // shape (without resumeTenantSkill) and an open connection to a database
  // whose user_version was bumped before the runtime columns were installed.
  // Validate both the API seam and the physical columns before reusing it.
  let stale = !current || globalThis.__piTenantStorePath !== path;
  if (current && !stale) {
    try {
      const schemaVersion = typeof current.schemaVersion === "function" ? current.schemaVersion() : -1;
      stale = schemaVersion < TENANT_SCHEMA_VERSION
        || typeof current.resumeTenantSkill !== "function"
        || typeof current.hasTenantSkillRuntimeColumns !== "function"
        || typeof current.repairManagedWorkspaceOwnership !== "function"
        || typeof current.repairAgentSessionBindingOwnership !== "function"
        || !current.hasTenantSkillRuntimeColumns();
    } catch {
      // A hot-reloaded connection can be closed or hold an invalidated schema.
      // Reopening it is safe because TenantStore.migrate() is idempotent.
      stale = true;
    }
  }
  if (stale) {
    try { current?.close(); } catch { /* The stale connection may already be closed. */ }
    globalThis.__piTenantStore = new TenantStore(path);
    globalThis.__piTenantStorePath = path;
  }
  return globalThis.__piTenantStore as TenantStore;
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

  /** Return whether the Skill runtime columns exist on this connection. */
  hasTenantSkillRuntimeColumns(): boolean {
    const columns = new Set(
      (this.database.prepare("PRAGMA table_info(tenant_skills)").all() as SqlRow[])
        .map((row) => String(row.name)),
    );
    return [
      "image_digest", "runtime_image", "lockfile_digest", "runtime_profile",
      "build_status", "build_error", "build_started_at", "build_completed_at",
    ].every((column) => columns.has(column));
  }

  /**
   * Repair workspace ownership recorded by the old host-path adoption path.
   * Managed and companion roots encode their membership in the directory
   * identity, so that identity is authoritative even when the old row was
   * created under the installation owner.
   */
  repairManagedWorkspaceOwnership(): void {
    const workspaces = this.database.prepare("SELECT id, tenant_id, root_path, created_by_membership_id FROM workspaces").all() as SqlRow[];
    const memberships = this.database.prepare("SELECT tenant_id, id FROM tenant_memberships").all() as SqlRow[];
    const agentDir = getAgentDir();
    const isWithin = (root: string, target: string): boolean => {
      const suffix = relative(root, target);
      return suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(`..${sep}`));
    };
    for (const workspace of workspaces) {
      const tenantId = asString(workspace, "tenant_id");
      const rootPath = asString(workspace, "root_path");
      const owner = memberships.find((membership) => {
        if (asString(membership, "tenant_id") !== tenantId) return false;
        const membershipId = asString(membership, "id");
        return isWithin(join(agentDir, "tenant-workspaces", tenantId, membershipId), rootPath)
          || isWithin(join(agentDir, "companion-sessions", tenantId, membershipId), rootPath);
      });
      if (!owner) continue;
      const membershipId = asString(owner, "id");
      if (membershipId === asString(workspace, "created_by_membership_id")) continue;
      this.database.prepare("UPDATE workspaces SET created_by_membership_id = ?, updated_at = ? WHERE tenant_id = ? AND id = ?")
        .run(membershipId, new Date().toISOString(), tenantId, asString(workspace, "id"));
    }
  }

  /**
   * Repair bindings written by the old legacy-adoption path. A session bound
   * to a workspace must belong to that workspace's creator; otherwise one
   * account can inherit another account's session after a creation race.
   */
  repairAgentSessionBindingOwnership(): void {
    this.database.prepare(`
      UPDATE agent_session_bindings
      SET created_by_membership_id = (
        SELECT w.created_by_membership_id
        FROM workspaces w
        WHERE w.tenant_id = agent_session_bindings.tenant_id
          AND w.id = agent_session_bindings.workspace_id
      )
      WHERE EXISTS (
        SELECT 1
        FROM workspaces w
        WHERE w.tenant_id = agent_session_bindings.tenant_id
          AND w.id = agent_session_bindings.workspace_id
          AND w.created_by_membership_id <> agent_session_bindings.created_by_membership_id
      )
    `).run();
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

  getWorkspaceByRoot(tenantId: string, rootPath: string): Workspace | null {
    const row = this.database.prepare(`
      SELECT id, tenant_id, slug, name, root_path, status, created_by_membership_id, created_at, updated_at
      FROM workspaces WHERE tenant_id = ? AND root_path = ?
    `).get(tenantId, rootPath) as SqlRow | undefined;
    return row ? mapWorkspace(row) : null;
  }

  listActiveWorkspaces(tenantId: string): Workspace[] {
    const rows = this.database.prepare(`
      SELECT id, tenant_id, slug, name, root_path, status, created_by_membership_id, created_at, updated_at
      FROM workspaces WHERE tenant_id = ? AND status = 'active'
      ORDER BY updated_at DESC
    `).all(tenantId) as SqlRow[];
    return rows.map(mapWorkspace);
  }

  listArchivedWorkspaces(tenantId: string): Workspace[] {
    const rows = this.database.prepare(`
      SELECT id, tenant_id, slug, name, root_path, status, created_by_membership_id, created_at, updated_at
      FROM workspaces WHERE tenant_id = ? AND status = 'archived'
    `).all(tenantId) as SqlRow[];
    return rows.map(mapWorkspace);
  }

  renameWorkspace(context: TenantContext, workspaceId: string, name: string): Workspace {
    const actor = this.requireActiveMembership(context);
    const workspace = this.getWorkspace(context.tenantId, workspaceId);
    if (!workspace || workspace.status !== "active") throw new Error("Workspace not found");
    const now = new Date().toISOString();
    this.database.prepare(`
      UPDATE workspaces SET name = ?, updated_at = ? WHERE tenant_id = ? AND id = ?
    `).run(requiredText(name, "workspace.name"), now, context.tenantId, workspaceId);
    this.insertAuditEvent(context.tenantId, actor.userId, actor.id, "workspace.renamed", "workspace", workspaceId, now);
    return this.getWorkspace(context.tenantId, workspaceId)!;
  }

  listActiveWorkspaceRoots(tenantId: string): string[] {
    const rows = this.database.prepare(`
      SELECT root_path FROM workspaces
      WHERE tenant_id = ? AND status = 'active'
      ORDER BY created_at ASC
    `).all(tenantId) as SqlRow[];
    return rows.map((row) => asString(row, "root_path"));
  }

  /** Active workspace roots owned by one signed-in membership. */
  listActiveWorkspaceRootsForMembership(tenantId: string, membershipId: string): string[] {
    const rows = this.database.prepare(`
      SELECT root_path FROM workspaces
      WHERE tenant_id = ? AND created_by_membership_id = ? AND status = 'active'
      ORDER BY created_at ASC
    `).all(tenantId, membershipId) as SqlRow[];
    return rows.map((row) => asString(row, "root_path"));
  }

  listActiveWorkspacesForMembership(tenantId: string, membershipId: string): Workspace[] {
    const rows = this.database.prepare(`
      SELECT id, tenant_id, slug, name, root_path, status, created_by_membership_id, created_at, updated_at
      FROM workspaces
      WHERE tenant_id = ? AND created_by_membership_id = ? AND status = 'active'
      ORDER BY updated_at DESC
    `).all(tenantId, membershipId) as SqlRow[];
    return rows.map(mapWorkspace);
  }

  bindAgentSession(
    context: TenantContext,
    workspaceId: string,
    agentSessionId: string,
  ): AgentSessionBinding {
    this.requireActiveMembership(context);
    const existing = this.getAgentSessionBindingAnyTenant(agentSessionId);
    if (existing) {
      if (existing.tenantId !== context.tenantId || existing.createdByMembershipId !== context.membershipId) {
        throw new Error("Agent session belongs to another tenant");
      }
      if (existing.workspaceId !== workspaceId) {
        throw new Error("Agent session is already bound to another workspace");
      }
      if (existing.workspaceStatus !== "active") {
        throw new Error("Agent session workspace is archived");
      }
      return existing;
    }
    const workspace = this.getWorkspace(context.tenantId, workspaceId);
    if (!workspace || workspace.status !== "active" || workspace.createdByMembershipId !== context.membershipId) {
      throw new Error("Workspace is not available to this account");
    }
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

  /** Look up ownership even when the bound workspace was archived. */
  getAgentSessionBindingAnyTenant(agentSessionId: string): AgentSessionBinding & {
    workspacePath: string;
    workspaceStatus: WorkspaceStatus;
  } | null {
    const row = this.database.prepare(`
      SELECT b.agent_session_id, b.tenant_id, b.workspace_id,
             b.created_by_membership_id, b.created_at,
             w.root_path, w.status
      FROM agent_session_bindings b
      JOIN workspaces w ON w.tenant_id = b.tenant_id AND w.id = b.workspace_id
      WHERE b.agent_session_id = ?
    `).get(agentSessionId) as SqlRow | undefined;
    return row ? {
      ...mapBinding(row),
      workspacePath: asString(row, "root_path"),
      workspaceStatus: asString(row, "status") as WorkspaceStatus,
    } : null;
  }

  getAgentSessionExecution(agentSessionId: string): (AgentSessionBinding & { workspacePath: string }) | null {
    const row = this.database.prepare(`
      SELECT b.agent_session_id, b.tenant_id, b.workspace_id,
             b.created_by_membership_id, b.created_at, w.root_path
      FROM agent_session_bindings b
      JOIN workspaces w ON w.tenant_id = b.tenant_id AND w.id = b.workspace_id
      WHERE b.agent_session_id = ?
        AND w.status = 'active'
        AND b.created_by_membership_id = w.created_by_membership_id
    `).get(agentSessionId) as SqlRow | undefined;
    return row ? { ...mapBinding(row), workspacePath: asString(row, "root_path") } : null;
  }

  removeAgentSessionBinding(agentSessionId: string): void {
    this.database.prepare("DELETE FROM agent_session_bindings WHERE agent_session_id = ?").run(agentSessionId);
  }

  createTenantSkillDraft(context: TenantContext, input: {
    slug: string; name: string; description: string; contentDigest: string;
    releaseDigest?: string;
    storagePath: string; manifest: Record<string, unknown>;
    imageDigest?: string | null;
    runtimeImage?: string | null;
    lockfileDigest?: string | null;
    runtimeProfile?: string | null;
    buildStatus?: TenantSkillBuildStatus;
    buildError?: string | null;
    buildStartedAt?: string | null;
    buildCompletedAt?: string | null;
  }): TenantSkill {
    const actor = this.requireActiveMembership(context);
    const slug = normalizedSlug(input.slug, "skill.slug");
    const version = Number((this.database.prepare(
      "SELECT COALESCE(MAX(version), 0) + 1 AS version FROM tenant_skills WHERE tenant_id = ? AND created_by_membership_id = ? AND slug = ?",
    ).get(context.tenantId, context.membershipId, slug) as SqlRow).version);
    const now = new Date().toISOString();
    const id = randomUUID();
    const imageDigest = optionalRuntimeDigest(input.imageDigest, "imageDigest");
    const runtimeImage = optionalRuntimeImage(input.runtimeImage);
    const lockfileDigest = optionalLockfileDigest(input.lockfileDigest);
    const runtimeProfile = optionalRuntimeProfile(input.runtimeProfile);
    // Declarative releases never need an image build.  Marking those ready
    // keeps the existing personal-Skill fast path while executable releases
    // stay pending until a reviewed runtime has been produced.
    const buildStatus = validTenantSkillBuildStatus(input.buildStatus)
      || (input.manifest.declarative === true ? "ready" : "pending");
    const releaseDigest = input.releaseDigest?.trim() || input.contentDigest;
    this.database.prepare(`
      INSERT INTO tenant_skills (
        id, tenant_id, slug, name, description, status, version, content_digest,
        storage_path, manifest_json, image_digest, runtime_image, lockfile_digest, runtime_profile,
        build_status, build_error, build_started_at, build_completed_at,
        created_by_membership_id, created_at
      ) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, context.tenantId, slug, requiredText(input.name, "skill.name"), input.description.trim(), version,
      releaseDigest, input.storagePath, JSON.stringify(input.manifest), imageDigest, runtimeImage, lockfileDigest,
      runtimeProfile, buildStatus, input.buildError?.trim() || null, input.buildStartedAt ?? null,
      input.buildCompletedAt ?? null, context.membershipId, now);
    this.insertAuditEvent(context.tenantId, actor.userId, actor.id, "tenant.skill.created", "tenant_skill", id, now);
    return this.getTenantSkill(context.tenantId, id)!;
  }

  getTenantSkill(tenantId: string, skillId: string): TenantSkill | null {
    const row = this.database.prepare("SELECT * FROM tenant_skills WHERE tenant_id = ? AND id = ?")
      .get(tenantId, skillId) as SqlRow | undefined;
    return row ? mapTenantSkill(row) : null;
  }

  /**
   * Look up an immutable release by its content digest.  Upload paths are
   * deterministic, so a retry of the same archive should be idempotent even
   * when its first request completed the filesystem write before the response
   * was lost.
   */
  findTenantSkillByContentDigest(tenantId: string, membershipId: string, contentDigest: string): TenantSkill | null {
    const row = this.database.prepare("SELECT * FROM tenant_skills WHERE tenant_id = ? AND created_by_membership_id = ? AND content_digest = ?")
      .get(tenantId, membershipId, contentDigest) as SqlRow | undefined;
    return row ? mapTenantSkill(row) : null;
  }

  /**
   * Record the result of the reviewed runtime build for an immutable Skill
   * release.  The archive itself is never changed; only build metadata moves
   * through pending -> building -> ready/failed.
   */
  updateTenantSkillBuild(context: TenantContext, skillId: string, input: {
    status: TenantSkillBuildStatus;
    imageDigest?: string | null;
    runtimeImage?: string | null;
    lockfileDigest?: string | null;
    runtimeProfile?: string | null;
    error?: string | null;
    startedAt?: string | null;
    completedAt?: string | null;
  }): TenantSkill {
    const actor = this.requireActiveMembership(context);
    const skill = this.getTenantSkill(context.tenantId, skillId);
    if (!skill || skill.status === "archived" || (skill.createdByMembershipId !== context.membershipId
      && actor.role !== "owner" && actor.role !== "admin")) {
      throw new Error("Skill release not found");
    }
    const status = validTenantSkillBuildStatus(input.status);
    if (!status) throw new Error("Skill build status is required");
    const now = new Date().toISOString();
    const imageDigest = input.imageDigest === undefined
      ? skill.imageDigest : optionalRuntimeDigest(input.imageDigest, "imageDigest");
    const runtimeImage = input.runtimeImage === undefined
      ? skill.runtimeImage : optionalRuntimeImage(input.runtimeImage);
    const lockfileDigest = input.lockfileDigest === undefined
      ? skill.lockfileDigest : optionalLockfileDigest(input.lockfileDigest);
    const runtimeProfile = input.runtimeProfile === undefined
      ? skill.runtimeProfile : optionalRuntimeProfile(input.runtimeProfile);
    const buildStartedAt = input.startedAt === undefined
      ? (status === "building" ? skill.buildStartedAt ?? now : status === "pending" ? null : skill.buildStartedAt)
      : input.startedAt;
    const buildCompletedAt = input.completedAt === undefined
      ? ((status === "ready" || status === "failed") ? now : skill.buildCompletedAt)
      : input.completedAt;
    const error = input.error === undefined ? skill.buildError : input.error?.trim() || null;
    if (status === "ready" && skill.manifest.runtimeRequired === true && skill.manifest.declarative !== true
      && (!imageDigest || !runtimeImage || !lockfileDigest || !runtimeProfile)) {
      throw new Error("Executable Skill runtime metadata is incomplete");
    }
    this.database.prepare(`UPDATE tenant_skills SET
      image_digest = ?, runtime_image = ?, lockfile_digest = ?, runtime_profile = ?, build_status = ?,
      build_error = ?, build_started_at = ?, build_completed_at = ?
      WHERE tenant_id = ? AND id = ?`).run(
      imageDigest, runtimeImage, lockfileDigest, runtimeProfile, status, error,
      buildStartedAt, buildCompletedAt, context.tenantId, skillId,
    );
    this.insertAuditEvent(context.tenantId, actor.userId, actor.id, `tenant.skill.build_${status}`, "tenant_skill", skillId, now);
    return this.getTenantSkill(context.tenantId, skillId)!;
  }

  listPublishedTenantSkillPaths(tenantId: string, membershipId: string): string[] {
    const rows = this.database.prepare(`SELECT storage_path FROM tenant_skills
      WHERE tenant_id = ? AND created_by_membership_id = ? AND status = 'published'
        AND build_status = 'ready'
        AND version = (SELECT MAX(v.version) FROM tenant_skills v WHERE v.tenant_id = tenant_skills.tenant_id AND v.created_by_membership_id = tenant_skills.created_by_membership_id AND v.slug = tenant_skills.slug AND v.status = 'published' AND v.build_status = 'ready')
      ORDER BY slug COLLATE NOCASE, version DESC`).all(tenantId, membershipId) as SqlRow[];
    return rows.map((row) => asString(row, "storage_path"));
  }

  listPublishedTenantSkills(tenantId: string, membershipId: string, includeAll = false): TenantSkill[] {
    const rows = this.database.prepare(`SELECT * FROM tenant_skills AS skill
      WHERE skill.tenant_id = ? AND skill.status = 'published' AND skill.build_status = 'ready'
        ${includeAll ? "" : "AND skill.created_by_membership_id = ?"}
        AND skill.version = (SELECT MAX(v.version) FROM tenant_skills AS v
          WHERE v.tenant_id = skill.tenant_id
            AND v.created_by_membership_id = skill.created_by_membership_id
            AND v.slug = skill.slug AND v.status = 'published' AND v.build_status = 'ready')
      ORDER BY skill.slug COLLATE NOCASE, skill.version DESC`).all(...(includeAll
        ? [tenantId]
        : [tenantId, membershipId])) as SqlRow[];
    return rows.map(mapTenantSkill);
  }

  listPublishedTenantSkillPathsForTenant(tenantId: string): string[] {
    const rows = this.database.prepare(`SELECT storage_path FROM tenant_skills
      WHERE tenant_id = ? AND status = 'published'
        AND build_status = 'ready'
        AND version = (SELECT MAX(v.version) FROM tenant_skills v WHERE v.tenant_id = tenant_skills.tenant_id AND v.created_by_membership_id = tenant_skills.created_by_membership_id AND v.slug = tenant_skills.slug AND v.status = 'published' AND v.build_status = 'ready')
      ORDER BY slug COLLATE NOCASE, version DESC`).all(tenantId) as SqlRow[];
    return rows.map((row) => asString(row, "storage_path"));
  }

  listTenantSkills(context: TenantContext, includeAll = false): TenantSkill[] {
    const membership = this.requireActiveMembership(context);
    const mayGovern = includeAll && membership.role !== "member";
    const rows = this.database.prepare(`SELECT * FROM tenant_skills WHERE tenant_id = ?
      AND status <> 'archived'
      ${mayGovern ? "" : "AND created_by_membership_id = ?"}
      ORDER BY slug COLLATE NOCASE, version DESC`).all(...(mayGovern
        ? [context.tenantId]
        : [context.tenantId, context.membershipId])) as SqlRow[];
    return rows.map(mapTenantSkill);
  }

  /**
   * Remove a user-uploaded release from the active catalog while retaining its
   * immutable record and audit trail. Owners and admins may remove any release
   * in the tenant; members may remove only their own releases.
   */
  archiveTenantSkill(context: TenantContext, skillId: string): TenantSkill {
    const actor = this.requireActiveMembership(context);
    const skill = this.getTenantSkill(context.tenantId, skillId);
    if (!skill || skill.status === "archived"
      || (skill.createdByMembershipId !== context.membershipId
        && actor.role !== "owner" && actor.role !== "admin")) {
      throw new Error("Skill release not found");
    }
    const now = new Date().toISOString();
    this.database.prepare("UPDATE tenant_skills SET status = 'archived' WHERE tenant_id = ? AND id = ?")
      .run(context.tenantId, skillId);
    this.insertAuditEvent(context.tenantId, actor.userId, actor.id, "tenant.skill.archived", "tenant_skill", skillId, now);
    return this.getTenantSkill(context.tenantId, skillId)!;
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
    if (skill.manifest.declarative !== true && skill.buildStatus !== "ready") {
      throw new Error("Skill runtime artifact is not ready");
    }
    if (skill.manifest.runtimeRequired === true && skill.manifest.declarative !== true
      && (!skill.imageDigest || !skill.runtimeImage || !skill.lockfileDigest || !skill.runtimeProfile)) {
      throw new Error("Skill runtime artifact metadata is incomplete");
    }
    if (skill.manifest.runtimeRequired === true && skill.manifest.declarative !== true) {
      const incompatible = this.database.prepare(`SELECT 1 FROM tenant_skills
        WHERE tenant_id = ? AND status = 'published' AND id <> ?
          AND json_extract(manifest_json, '$.runtimeRequired') = 1
          AND runtime_image IS NOT NULL AND image_digest IS NOT NULL AND runtime_profile IS NOT NULL
          AND (runtime_image <> ? OR image_digest <> ? OR runtime_profile <> ?)
        LIMIT 1`).get(
        context.tenantId, skillId, skill.runtimeImage, skill.imageDigest, skill.runtimeProfile,
      );
      if (incompatible) throw new Error("Skill runtime artifact is incompatible with published releases");
    }
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

  /** Re-enable a suspended release without changing its immutable archive. */
  resumeTenantSkill(context: TenantContext, skillId: string): TenantSkill {
    const actor = this.requireTenantAdmin(context);
    const skill = this.getTenantSkill(context.tenantId, skillId);
    if (!skill || skill.status !== "suspended") throw new Error("Suspended skill not found");
    if (skill.manifest.declarative !== true && skill.buildStatus !== "ready") {
      throw new Error("Skill runtime artifact is not ready");
    }
    if (skill.manifest.runtimeRequired === true && skill.manifest.declarative !== true
      && (!skill.imageDigest || !skill.runtimeImage || !skill.lockfileDigest || !skill.runtimeProfile)) {
      throw new Error("Skill runtime artifact metadata is incomplete");
    }
    const now = new Date().toISOString();
    this.database.prepare("UPDATE tenant_skills SET status = 'published', published_at = ? WHERE tenant_id = ? AND id = ?")
      .run(now, context.tenantId, skillId);
    this.insertAuditEvent(context.tenantId, actor.userId, actor.id, "tenant.skill.resumed", "tenant_skill", skillId, now);
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
    const evaluation = this.database.prepare(`SELECT 1 FROM companion_evaluation_runs
      WHERE tenant_id = ? AND config_version_id = ? AND status = 'completed' AND fatal_count = 0 AND average_score >= 85
      ORDER BY completed_at DESC LIMIT 1`).get(context.tenantId, configVersionId);
    if (!evaluation) throw new Error("A completed evaluation with no fatal issues is required before publication");
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

  listCompanionRetentionTargets(): CompanionRetentionTarget[] {
    const rows = this.database.prepare(`SELECT tenant_id, membership_id, session_id
      FROM companion_assignments`)
      .all() as SqlRow[];
    return rows.map((row) => ({
      tenantId: asString(row, "tenant_id"),
      membershipId: asString(row, "membership_id"),
      sessionId: asString(row, "session_id"),
    }));
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

  repairCompanionAssignmentSession(context: TenantContext, previousSessionId: string, sessionId: string): CompanionAssignment {
    const membership = this.requireActiveMembership(context);
    const now = new Date().toISOString();
    const result = this.database.prepare(`UPDATE companion_assignments SET session_id = ?, updated_at = ?
      WHERE tenant_id = ? AND membership_id = ? AND session_id = ?`)
      .run(requiredText(sessionId, "sessionId"), now, context.tenantId, membership.id, previousSessionId);
    if (result.changes === 1) {
      this.insertAuditEvent(context.tenantId, membership.userId, membership.id, "companion.assignment.session_repaired", "companion_assignment", membership.id, now);
    }
    const assignment = this.getCompanionAssignment(context);
    if (!assignment) throw new Error("Companion assignment not found");
    return assignment;
  }

  previewCompanionMigration(context: TenantContext, membershipId: string, configVersionId: string): {
    current: CompanionAssignment;
    target: CompanionConfigVersion;
    affectedMembershipIds: string[];
    diff: string;
  } {
    this.requireTenantAdmin(context);
    const target = this.getCompanionConfigVersion(context.tenantId, configVersionId);
    if (!target || target.status !== "published") throw new Error("Published companion config not found");
    const current = this.database.prepare("SELECT * FROM companion_assignments WHERE tenant_id = ? AND membership_id = ?")
      .get(context.tenantId, membershipId) as SqlRow | undefined;
    if (!current) throw new Error("Companion assignment not found");
    const assignment = mapCompanionAssignment(current);
    const source = this.getCompanionConfigVersion(context.tenantId, assignment.configVersionId)!;
    return {
      current: assignment, target,
      affectedMembershipIds: [membershipId],
      diff: visibleLineDiff(source.behaviorDocument, target.behaviorDocument),
    };
  }

  migrateCompanionAssignment(
    context: TenantContext,
    membershipId: string,
    configVersionId: string,
    options?: { sessionBusy?: boolean; reason?: string },
  ): CompanionAssignment {
    return this.migrateCompanionAssignmentWithOptions(context, membershipId, configVersionId, options);
  }

  private migrateCompanionAssignmentWithOptions(context: TenantContext, membershipId: string, configVersionId: string, options?: { sessionBusy?: boolean; reason?: string }): CompanionAssignment {
    const actor = this.requireTenantAdmin(context);
    if (options?.sessionBusy) throw new Error("Cannot migrate while the companion is generating a reply");
    const target = this.getCompanionConfigVersion(context.tenantId, configVersionId);
    if (!target || target.status !== "published") throw new Error("Published companion config not found");
    const assignment = this.database.prepare("SELECT * FROM companion_assignments WHERE tenant_id = ? AND membership_id = ?")
      .get(context.tenantId, membershipId) as SqlRow | undefined;
    if (!assignment) throw new Error("Companion assignment not found");
    if (this.database.prepare(`SELECT 1 FROM companion_turns WHERE tenant_id = ? AND membership_id = ? AND status = 'running' LIMIT 1`).get(context.tenantId, membershipId)) {
      throw new Error("Cannot migrate while the companion is generating a reply");
    }
    const previousConfigVersionId = asString(assignment, "config_version_id");
    if (previousConfigVersionId === configVersionId) return mapCompanionAssignment(assignment);
    const now = new Date().toISOString();
    this.database.prepare("UPDATE companion_assignments SET config_version_id = ?, updated_at = ? WHERE tenant_id = ? AND membership_id = ?")
      .run(configVersionId, now, context.tenantId, membershipId);
    this.database.prepare(`INSERT INTO companion_assignment_migrations
      (id, tenant_id, membership_id, from_config_version_id, to_config_version_id,
       rollback_config_version_id, reason, migrated_by_membership_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), context.tenantId, membershipId, previousConfigVersionId, configVersionId,
        previousConfigVersionId, options?.reason?.trim() || "explicit migration", actor.id, now);
    this.insertAuditEvent(context.tenantId, actor.userId, actor.id, "companion.assignment.migrated", "companion_assignment", membershipId, now);
    return this.getCompanionAssignment({ tenantId: context.tenantId, membershipId })!;
  }

  migrateCompanionAssignments(context: TenantContext, membershipIds: string[], configVersionId: string, reason: string): CompanionAssignment[] {
    this.requireTenantAdmin(context);
    const uniqueIds = [...new Set(membershipIds.map((id) => requiredText(id, "membershipId")))];
    if (uniqueIds.length < 1) throw new Error("At least one participant is required for batch migration");
    return this.transaction(() => uniqueIds.map((membershipId) => this.migrateCompanionAssignmentWithOptions(context, membershipId, configVersionId, { reason })));
  }

  listCompanionMigrationHistory(context: TenantContext): Array<{
    id: string; membershipId: string; fromConfigVersionId: string; toConfigVersionId: string;
    rollbackConfigVersionId: string; reason: string; migratedByMembershipId: string; createdAt: string;
  }> {
    this.requireTenantAdmin(context);
    const rows = this.database.prepare(`SELECT * FROM companion_assignment_migrations
      WHERE tenant_id = ? ORDER BY created_at DESC`).all(context.tenantId) as SqlRow[];
    return rows.map((row) => ({
      id: asString(row, "id"), membershipId: asString(row, "membership_id"), fromConfigVersionId: asString(row, "from_config_version_id"),
      toConfigVersionId: asString(row, "to_config_version_id"), rollbackConfigVersionId: asString(row, "rollback_config_version_id"),
      reason: asString(row, "reason"), migratedByMembershipId: asString(row, "migrated_by_membership_id"), createdAt: asString(row, "created_at"),
    }));
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

  getCompanionReviewConsent(context: TenantContext): CompanionReviewConsent {
    this.requireActiveMembership(context);
    const row = this.database.prepare(`SELECT * FROM companion_review_consents
      WHERE tenant_id = ? AND membership_id = ?`).get(context.tenantId, context.membershipId) as SqlRow | undefined;
    return row ? {
      tenantId: asString(row, "tenant_id"), membershipId: asString(row, "membership_id"),
      enabled: Boolean(row.enabled), noticeVersion: row.notice_version as string | null,
      consentedAt: row.consented_at as string | null, withdrawnAt: row.withdrawn_at as string | null,
      updatedAt: asString(row, "updated_at"),
    } : {
      ...context, enabled: false, noticeVersion: null, consentedAt: null, withdrawnAt: null, updatedAt: null,
    };
  }

  setCompanionReviewConsent(context: TenantContext, enabled: boolean, noticeVersion: string): CompanionReviewConsent {
    const actor = this.requireActiveMembership(context);
    const notice = requiredText(noticeVersion, "noticeVersion");
    const now = new Date().toISOString();
    this.database.prepare(`INSERT INTO companion_review_consents
      (tenant_id, membership_id, enabled, notice_version, consented_at, withdrawn_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (tenant_id, membership_id) DO UPDATE SET
        enabled = excluded.enabled,
        notice_version = excluded.notice_version,
        consented_at = CASE WHEN excluded.enabled = 1 THEN excluded.consented_at ELSE companion_review_consents.consented_at END,
        withdrawn_at = excluded.withdrawn_at,
        updated_at = excluded.updated_at`)
      .run(context.tenantId, context.membershipId, enabled ? 1 : 0, notice, enabled ? now : null, enabled ? null : now, now);
    this.insertAuditEvent(
      context.tenantId, actor.userId, actor.id,
      enabled ? "companion.review.opted_in" : "companion.review.revoked",
      "companion_review_consent", context.membershipId, now,
    );
    return this.getCompanionReviewConsent(context);
  }

  createCompanionQualitySample(context: TenantContext, input: {
    membershipId: string;
    configVersionId: string;
    messages: Array<{ entryId: string; role: "user" | "assistant"; text: string }>;
  }): CompanionQualitySample {
    const actor = this.requireTenantAdmin(context);
    const participant = { tenantId: context.tenantId, membershipId: requiredText(input.membershipId, "membershipId") };
    this.requireActiveMembership(participant);
    if (!this.getCompanionReviewConsent(participant).enabled) throw new Error("Quality review consent is required before sampling");
    if (!this.getCompanionConfigVersion(context.tenantId, input.configVersionId)) throw new Error("Companion config version not found");
    if (input.messages.length < 1 || input.messages.length > 6) throw new Error("Quality samples must contain one to six messages");
    const messages = input.messages.map((message) => {
      if (message.role !== "user" && message.role !== "assistant") throw new Error("Quality sample message role is invalid");
      const text = requiredText(message.text, "message.text");
      if (text.length > 2_000) throw new Error("Quality sample messages must be 2000 characters or fewer");
      return { entryId: requiredText(message.entryId, "message.entryId"), role: message.role, text };
    });
    if (messages.reduce((total, message) => total + message.text.length, 0) > 6_000) {
      throw new Error("Quality sample fragment is too large");
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    this.database.prepare(`INSERT INTO companion_quality_samples
      (id, tenant_id, membership_id, config_version_id, messages_json, sampled_by_membership_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, context.tenantId, participant.membershipId, input.configVersionId, JSON.stringify(messages), actor.id, now);
    this.insertAuditEvent(context.tenantId, actor.userId, actor.id, "companion.review.sampled", "companion_quality_sample", id, now);
    return this.listCompanionQualitySamples(context).find((sample) => sample.id === id)!;
  }

  sampleCompletedCompanionTurn(context: TenantContext, input: { turnId: string; userText: string; assistantText: string }): CompanionQualitySample | null {
    const actor = this.requireActiveMembership(context);
    if (!this.getCompanionReviewConsent(context).enabled) return null;
    const turn = this.database.prepare(`SELECT id, config_version_id FROM companion_turns
      WHERE tenant_id = ? AND membership_id = ? AND id = ? AND status = 'completed'`)
      .get(context.tenantId, context.membershipId, input.turnId) as SqlRow | undefined;
    if (!turn) throw new Error("Completed companion turn not found");
    const pending = this.database.prepare(`SELECT COUNT(*) AS count FROM companion_quality_samples s
      LEFT JOIN companion_quality_reviews r ON r.tenant_id = s.tenant_id AND r.sample_id = s.id
      WHERE s.tenant_id = ? AND s.membership_id = ? AND r.id IS NULL`).get(context.tenantId, context.membershipId) as SqlRow;
    if (Number(pending.count) >= 5) return null;
    const userText = redactDirectIdentifiers(requiredText(input.userText, "userText"));
    const assistantText = redactDirectIdentifiers(requiredText(input.assistantText, "assistantText"));
    if (stillContainsDirectIdentifier(userText) || stillContainsDirectIdentifier(assistantText)) return null;
    const messages = [
      { entryId: `${input.turnId}:user`, role: "user" as const, text: userText.slice(0, 2_000) },
      { entryId: `${input.turnId}:assistant`, role: "assistant" as const, text: assistantText.slice(0, 2_000) },
    ];
    const id = randomUUID();
    const now = new Date().toISOString();
    this.database.prepare(`INSERT INTO companion_quality_samples
      (id, tenant_id, membership_id, config_version_id, messages_json, sampled_by_membership_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, context.tenantId, context.membershipId, asString(turn, "config_version_id"), JSON.stringify(messages), actor.id, now);
    this.insertAuditEvent(context.tenantId, actor.userId, actor.id, "companion.review.sampled", "companion_quality_sample", id, now);
    return { id, tenantId: context.tenantId, membershipId: context.membershipId, configVersionId: asString(turn, "config_version_id"), messages, sampledByMembershipId: actor.id, createdAt: now };
  }

  listCompanionQualitySamples(context: TenantContext, pendingOnly = false): CompanionQualitySample[] {
    const actor = this.requireTenantAdmin(context);
    const rows = this.database.prepare(`SELECT s.* FROM companion_quality_samples s
      LEFT JOIN companion_quality_reviews r ON r.tenant_id = s.tenant_id AND r.sample_id = s.id
      WHERE s.tenant_id = ? AND (? = 0 OR r.id IS NULL) ORDER BY s.created_at DESC`).all(context.tenantId, pendingOnly ? 1 : 0) as SqlRow[];
    const samples = rows.map((row) => ({
      id: asString(row, "id"), tenantId: asString(row, "tenant_id"), membershipId: asString(row, "membership_id"),
      configVersionId: asString(row, "config_version_id"),
      messages: JSON.parse(asString(row, "messages_json")) as CompanionQualitySample["messages"],
      sampledByMembershipId: asString(row, "sampled_by_membership_id"), createdAt: asString(row, "created_at"),
    }));
    this.insertAuditEvent(context.tenantId, actor.userId, actor.id, "companion.review.samples_accessed", "companion_quality_sample", "list", new Date().toISOString());
    return samples;
  }

  recordCompanionQualityReview(context: TenantContext, sampleId: string, input: {
    specificallyResponsive: boolean;
    interrogation: boolean;
    ignoredEnding: boolean;
    baselineViolation: boolean;
    notes: string;
  }): CompanionQualityReview {
    const actor = this.requireTenantAdmin(context);
    const sample = this.database.prepare(`SELECT 1 FROM companion_quality_samples WHERE tenant_id = ? AND id = ?`)
      .get(context.tenantId, sampleId);
    if (!sample) throw new Error("Quality sample not found");
    const id = randomUUID();
    const now = new Date().toISOString();
    this.database.prepare(`INSERT INTO companion_quality_reviews
      (id, tenant_id, sample_id, specifically_responsive, interrogation, ignored_ending,
       baseline_violation, notes, reviewed_by_membership_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, context.tenantId, sampleId, input.specificallyResponsive ? 1 : 0, input.interrogation ? 1 : 0,
        input.ignoredEnding ? 1 : 0, input.baselineViolation ? 1 : 0, requiredText(input.notes, "review.notes"), actor.id, now);
    this.insertAuditEvent(context.tenantId, actor.userId, actor.id, "companion.review.decided", "companion_quality_review", id, now);
    return {
      id, tenantId: context.tenantId, sampleId, specificallyResponsive: input.specificallyResponsive,
      interrogation: input.interrogation, ignoredEnding: input.ignoredEnding,
      baselineViolation: input.baselineViolation, notes: input.notes.trim(), reviewedByMembershipId: actor.id, createdAt: now,
    };
  }

  createCompanionImprovementProposal(context: TenantContext, input: {
    sourceType: "review" | "evaluation";
    sourceId: string;
    baseConfigVersionId: string;
    evidence: Array<{ sourceId: string; quote: string }>;
    proposedBehaviorDocument: string;
  }): CompanionImprovementProposal {
    const actor = this.requireTenantAdmin(context);
    const base = this.getCompanionConfigVersion(context.tenantId, input.baseConfigVersionId);
    if (!base) throw new Error("Base companion config not found");
    const sourceTable = input.sourceType === "review" ? "companion_quality_reviews" : "companion_evaluation_runs";
    if (!this.database.prepare(`SELECT 1 FROM ${sourceTable} WHERE tenant_id = ? AND id = ?`).get(context.tenantId, input.sourceId)) {
      throw new Error("Improvement evidence source not found");
    }
    if (input.evidence.length < 1) throw new Error("Cited evidence is required");
    const evidenceRow = input.sourceType === "review"
      ? this.database.prepare(`SELECT r.notes, s.messages_json FROM companion_quality_reviews r
          JOIN companion_quality_samples s ON s.tenant_id = r.tenant_id AND s.id = r.sample_id
          WHERE r.tenant_id = ? AND r.id = ?`).get(context.tenantId, input.sourceId) as SqlRow
      : this.database.prepare("SELECT results_json, suggestions_json FROM companion_evaluation_runs WHERE tenant_id = ? AND id = ?")
          .get(context.tenantId, input.sourceId) as SqlRow;
    const evidenceCorpus = Object.values(evidenceRow).map(String).join("\n");
    const evidence = input.evidence.map((item) => ({
      sourceId: requiredText(item.sourceId, "evidence.sourceId"), quote: requiredText(item.quote, "evidence.quote"),
    }));
    if (evidence.some((item) => item.sourceId !== input.sourceId || !evidenceCorpus.includes(item.quote))) throw new Error("Cited evidence must come from the selected review or evaluation");
    const proposedBehaviorDocument = requiredText(input.proposedBehaviorDocument, "proposedBehaviorDocument");
    if (proposedBehaviorDocument === base.behaviorDocument) throw new Error("Improvement proposal must change the behavior document");
    const id = randomUUID();
    const now = new Date().toISOString();
    const diff = visibleLineDiff(base.behaviorDocument, proposedBehaviorDocument);
    this.database.prepare(`INSERT INTO companion_improvement_proposals
      (id, tenant_id, source_type, source_id, base_config_version_id, evidence_json,
       proposed_behavior_document, diff_text, status, created_by_membership_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'advisory', ?, ?)`)
      .run(id, context.tenantId, input.sourceType, input.sourceId, base.id, JSON.stringify(evidence),
        proposedBehaviorDocument, diff, actor.id, now);
    this.insertAuditEvent(context.tenantId, actor.userId, actor.id, "companion.improvement.proposed", "companion_improvement_proposal", id, now);
    return this.getCompanionImprovementProposal(context, id)!;
  }

  getCompanionImprovementProposal(context: TenantContext, proposalId: string): CompanionImprovementProposal | null {
    this.requireTenantAdmin(context);
    const row = this.database.prepare(`SELECT * FROM companion_improvement_proposals WHERE tenant_id = ? AND id = ?`)
      .get(context.tenantId, proposalId) as SqlRow | undefined;
    return row ? {
      id: asString(row, "id"), tenantId: asString(row, "tenant_id"),
      sourceType: asString(row, "source_type") as CompanionImprovementProposal["sourceType"],
      sourceId: asString(row, "source_id"), baseConfigVersionId: asString(row, "base_config_version_id"),
      evidence: JSON.parse(asString(row, "evidence_json")) as CompanionImprovementProposal["evidence"],
      proposedBehaviorDocument: asString(row, "proposed_behavior_document"), diff: asString(row, "diff_text"),
      status: asString(row, "status") as CompanionImprovementProposal["status"],
      draftConfigVersionId: row.draft_config_version_id as string | null,
      createdAt: asString(row, "created_at"), reviewedAt: row.reviewed_at as string | null,
    } : null;
  }

  listCompanionImprovementProposals(context: TenantContext): CompanionImprovementProposal[] {
    this.requireTenantAdmin(context);
    const rows = this.database.prepare("SELECT id FROM companion_improvement_proposals WHERE tenant_id = ? ORDER BY created_at DESC")
      .all(context.tenantId) as SqlRow[];
    return rows.map((row) => this.getCompanionImprovementProposal(context, asString(row, "id"))!);
  }

  acceptCompanionImprovementProposal(context: TenantContext, proposalId: string, behaviorDocument: string): {
    proposal: CompanionImprovementProposal;
    draft: CompanionConfigVersion;
  } {
    const actor = this.requireTenantAdmin(context);
    const proposal = this.getCompanionImprovementProposal(context, proposalId);
    if (!proposal || proposal.status !== "advisory") throw new Error("Advisory improvement proposal not found");
    const base = this.getCompanionConfigVersion(context.tenantId, proposal.baseConfigVersionId)!;
    const draft = this.createCompanionConfigDraft(context, {
      behaviorDocument: requiredText(behaviorDocument, "behaviorDocument"),
      modelProvider: base.modelProvider, modelId: base.modelId, thinkingLevel: base.thinkingLevel,
      temperature: base.temperature, maxOutputTokens: base.maxOutputTokens,
    });
    const now = new Date().toISOString();
    this.database.prepare(`UPDATE companion_improvement_proposals
      SET status = 'accepted', draft_config_version_id = ?, reviewed_by_membership_id = ?, reviewed_at = ?
      WHERE tenant_id = ? AND id = ?`).run(draft.id, actor.id, now, context.tenantId, proposalId);
    this.insertAuditEvent(context.tenantId, actor.userId, actor.id, "companion.improvement.accepted", "companion_improvement_proposal", proposalId, now);
    return { proposal: this.getCompanionImprovementProposal(context, proposalId)!, draft };
  }

  createCompanionEvaluationRun(context: TenantContext, input: {
    configVersionId: string;
    suite: "quick" | "full";
    evaluationMode: "single_turn" | "rolling_episode";
    graderVersion: string;
    bridgeFromGraderVersion?: string;
    candidate: Record<string, unknown>;
    questions: unknown[];
    privateAnswers: unknown[];
    graderPrompt: string;
    graderModel: string;
    parameters: Record<string, unknown>;
    policy: Record<string, unknown>;
    itemCount: number;
    averageScore?: number | null;
    fatalCount?: number;
    results: unknown[];
    suggestions?: unknown[];
  }): CompanionEvaluationRun {
    const actor = this.requireTenantAdmin(context);
    if (input.suite === "full" && input.itemCount !== 500) throw new Error("Full evaluation must contain 500 cases");
    if (input.suite === "quick" && ![8, 5].includes(input.itemCount)) throw new Error("Quick evaluation must contain eight cases or one five-turn episode");
    if (input.questions.length !== input.itemCount || input.privateAnswers.length !== input.itemCount) throw new Error("Evaluation snapshots must contain every question and private answer");
    if (input.results.length !== input.itemCount) throw new Error("Evaluation results must contain every scored item");
    if (input.averageScore === null || input.averageScore === undefined || !Number.isFinite(input.averageScore) || input.averageScore < 0 || input.averageScore > 100) throw new Error("A completed evaluation score between 0 and 100 is required");
    if (!Number.isInteger(input.fatalCount ?? 0) || (input.fatalCount ?? 0) < 0) throw new Error("fatalCount must be a non-negative integer");
    if (!this.getCompanionConfigVersion(context.tenantId, input.configVersionId)) throw new Error("Companion config version not found");
    if (input.bridgeFromGraderVersion) {
      const previous = this.database.prepare(`SELECT candidate_snapshot_json, questions_snapshot_json, private_answers_snapshot_json
        FROM companion_evaluation_runs WHERE tenant_id = ? AND grader_version = ? AND status = 'completed'
        ORDER BY completed_at DESC LIMIT 1`).get(context.tenantId, input.bridgeFromGraderVersion) as SqlRow | undefined;
      if (!previous || input.bridgeFromGraderVersion === input.graderVersion) throw new Error("Bridge evaluation must connect an existing different grader version");
      if (asString(previous, "candidate_snapshot_json") !== JSON.stringify(input.candidate)
        || asString(previous, "questions_snapshot_json") !== JSON.stringify(input.questions)
        || asString(previous, "private_answers_snapshot_json") !== JSON.stringify(input.privateAnswers)) {
        throw new Error("Bridge evaluation must re-evaluate the same candidate and cases");
      }
    }
    const id = randomUUID();
    const now = new Date().toISOString();
    this.database.prepare(`INSERT INTO companion_evaluation_runs
      (id, tenant_id, config_version_id, suite, evaluation_mode, status, grader_version,
       bridge_from_grader_version, candidate_snapshot_json, questions_snapshot_json, private_answers_snapshot_json,
       grader_prompt, grader_model, parameters_json, policy_json, item_count, average_score, fatal_count,
       results_json, suggestions_json, created_by_membership_id, created_at, completed_at)
      VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, context.tenantId, input.configVersionId, input.suite, input.evaluationMode,
        requiredText(input.graderVersion, "graderVersion"), input.bridgeFromGraderVersion ?? null,
        JSON.stringify(input.candidate), JSON.stringify(input.questions), JSON.stringify(input.privateAnswers),
        requiredText(input.graderPrompt, "graderPrompt"), requiredText(input.graderModel, "graderModel"),
        JSON.stringify(input.parameters), JSON.stringify(input.policy), input.itemCount, input.averageScore ?? null,
        input.fatalCount ?? 0, JSON.stringify(input.results), JSON.stringify(input.suggestions ?? []), actor.id, now, now);
    this.insertAuditEvent(context.tenantId, actor.userId, actor.id, "companion.evaluation.completed", "companion_evaluation_run", id, now);
    return this.getCompanionEvaluationRun(context, id)!;
  }

  getCompanionEvaluationRun(context: TenantContext, runId: string): CompanionEvaluationRun | null {
    this.requireTenantAdmin(context);
    const row = this.database.prepare(`SELECT * FROM companion_evaluation_runs WHERE tenant_id = ? AND id = ?`).get(context.tenantId, runId) as SqlRow | undefined;
    return row ? {
      id: asString(row, "id"), tenantId: asString(row, "tenant_id"), configVersionId: asString(row, "config_version_id"),
      suite: asString(row, "suite") as CompanionEvaluationRun["suite"], evaluationMode: asString(row, "evaluation_mode") as CompanionEvaluationRun["evaluationMode"],
      status: asString(row, "status") as CompanionEvaluationRun["status"], graderVersion: asString(row, "grader_version"),
      bridgeFromGraderVersion: row.bridge_from_grader_version as string | null,
      candidate: JSON.parse(asString(row, "candidate_snapshot_json")) as Record<string, unknown>,
      questions: JSON.parse(asString(row, "questions_snapshot_json")) as unknown[], privateAnswers: JSON.parse(asString(row, "private_answers_snapshot_json")) as unknown[],
      graderPrompt: asString(row, "grader_prompt"), graderModel: asString(row, "grader_model"), parameters: JSON.parse(asString(row, "parameters_json")) as Record<string, unknown>,
      policy: JSON.parse(asString(row, "policy_json")) as Record<string, unknown>, itemCount: Number(row.item_count), averageScore: row.average_score as number | null,
      fatalCount: Number(row.fatal_count), results: JSON.parse(asString(row, "results_json")) as unknown[], suggestions: JSON.parse(asString(row, "suggestions_json")) as unknown[], createdByMembershipId: asString(row, "created_by_membership_id"),
      createdAt: asString(row, "created_at"), completedAt: row.completed_at as string | null,
    } : null;
  }

  listCompanionEvaluationRuns(context: TenantContext, limit = 20): CompanionEvaluationRun[] {
    this.requireTenantAdmin(context);
    const ids = this.database.prepare("SELECT id FROM companion_evaluation_runs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?")
      .all(context.tenantId, Math.max(1, Math.min(100, Math.trunc(limit)))) as SqlRow[];
    return ids.map((row) => this.getCompanionEvaluationRun(context, asString(row, "id"))!);
  }

  compareCompanionEvaluationRuns(context: TenantContext, leftId: string, rightId: string): { comparable: boolean; bridgeEstablished?: boolean; reason?: string } {
    const left = this.getCompanionEvaluationRun(context, leftId);
    const right = this.getCompanionEvaluationRun(context, rightId);
    if (!left || !right) throw new Error("Evaluation run not found");
    if (left.id === right.id) return { comparable: true };
    if (left.graderVersion !== right.graderVersion) {
      const bridgeEstablished = left.bridgeFromGraderVersion === right.graderVersion || right.bridgeFromGraderVersion === left.graderVersion;
      return { comparable: false, bridgeEstablished, reason: bridgeEstablished ? "grader versions are related by a bridge run but are not directly comparable" : "grader version changed; bridge re-evaluation is required" };
    }
    const calibration = this.getCompanionCalibration(context, right.graderVersion);
    if (!calibration.ready) return { comparable: false, reason: "at least twelve human calibrations are required" };
    return { comparable: true };
  }

  recordCompanionCalibration(context: TenantContext, input: {
    runId: string; itemId: string; band: "high" | "low" | "borderline"; humanScore: number; notes: string;
  }): CompanionCalibration {
    const actor = this.requireTenantAdmin(context);
    const run = this.getCompanionEvaluationRun(context, input.runId);
    if (!run) throw new Error("Evaluation run not found");
    const result = run.results.find((item) => item && typeof item === "object" && (item as Record<string, unknown>).id === input.itemId) as Record<string, unknown> | undefined;
    const automaticScore = Number(result?.finalTotal);
    if (!result || !Number.isFinite(automaticScore)) throw new Error("Evaluation item not found");
    if (!Number.isFinite(input.humanScore) || input.humanScore < 0 || input.humanScore > 100) throw new Error("Human calibration score must be between 0 and 100");
    const id = randomUUID();
    this.database.prepare(`INSERT INTO companion_calibrations
      (id, tenant_id, run_id, item_id, band, human_score, automatic_score, notes, created_by_membership_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, context.tenantId, input.runId, requiredText(input.itemId, "calibration.itemId"), input.band, input.humanScore, automaticScore, requiredText(input.notes, "calibration.notes"), actor.id, new Date().toISOString());
    return { id, tenantId: context.tenantId, runId: input.runId, itemId: input.itemId.trim(), band: input.band, humanScore: input.humanScore, automaticScore, notes: input.notes.trim() };
  }

  getCompanionCalibration(context: TenantContext, graderVersion?: string): { reviewedCount: number; bands: Record<"high" | "low" | "borderline", number>; ready: boolean } {
    this.requireTenantAdmin(context);
    const rows = (graderVersion
      ? this.database.prepare(`SELECT c.band, COUNT(*) AS count FROM companion_calibrations c
          JOIN companion_evaluation_runs r ON r.tenant_id = c.tenant_id AND r.id = c.run_id
          WHERE c.tenant_id = ? AND r.grader_version = ? GROUP BY c.band`).all(context.tenantId, graderVersion)
      : this.database.prepare(`SELECT band, COUNT(*) AS count FROM companion_calibrations WHERE tenant_id = ? GROUP BY band`).all(context.tenantId)) as SqlRow[];
    const bands = { high: 0, low: 0, borderline: 0 };
    for (const row of rows) bands[asString(row, "band") as keyof typeof bands] = Number(row.count);
    const reviewedCount = bands.high + bands.low + bands.borderline;
    return { reviewedCount, bands, ready: reviewedCount >= 12 && bands.high > 0 && bands.low > 0 && bands.borderline > 0 };
  }

  listCompanionCalibrations(context: TenantContext, graderVersion?: string): CompanionCalibration[] {
    this.requireTenantAdmin(context);
    const rows = (graderVersion
      ? this.database.prepare(`SELECT c.* FROM companion_calibrations c JOIN companion_evaluation_runs r
          ON r.tenant_id = c.tenant_id AND r.id = c.run_id WHERE c.tenant_id = ? AND r.grader_version = ? ORDER BY c.created_at DESC`).all(context.tenantId, graderVersion)
      : this.database.prepare("SELECT * FROM companion_calibrations WHERE tenant_id = ? ORDER BY created_at DESC").all(context.tenantId)) as SqlRow[];
    return rows.map((row) => ({
      id: asString(row, "id"), tenantId: asString(row, "tenant_id"), runId: asString(row, "run_id"), itemId: asString(row, "item_id"),
      band: asString(row, "band") as CompanionCalibration["band"], humanScore: Number(row.human_score), automaticScore: Number(row.automatic_score), notes: asString(row, "notes"),
    }));
  }

  enrollCompanionTrialParticipant(context: TenantContext, input: {
    membershipId: string; startedAt?: string; excludesDirectIdentifiers: boolean; fictionalSensitiveExercises: boolean;
  }): void {
    const actor = this.requireTenantAdmin(context);
    const target = { tenantId: context.tenantId, membershipId: input.membershipId };
    this.requireActiveMembership(target);
    if (!input.excludesDirectIdentifiers || !input.fictionalSensitiveExercises) {
      throw new Error("Trial enrollment requires excluding direct identifiers and fictional assigned sensitive exercises");
    }
    const count = Number((this.database.prepare("SELECT COUNT(*) AS count FROM companion_trial_participants WHERE tenant_id = ?").get(context.tenantId) as SqlRow).count);
    if (count >= 20) throw new Error("Internal trial is limited to 20 participants");
    const startedAt = input.startedAt ?? new Date().toISOString();
    this.database.prepare(`INSERT INTO companion_trial_participants
      (tenant_id, membership_id, started_at, stage, excludes_direct_identifiers, fictional_sensitive_exercises)
      VALUES (?, ?, ?, 'scripted', 1, 1)`)
      .run(context.tenantId, input.membershipId, startedAt);
    this.insertAuditEvent(context.tenantId, actor.userId, actor.id, "companion.trial.enrolled", "tenant_membership", input.membershipId, new Date().toISOString());
  }

  updateCompanionTrialParticipant(context: TenantContext, membershipId: string, input: {
    stage?: "scripted" | "free_chat" | "completed"; willingToContinue?: boolean;
  }): void {
    const actor = this.requireTenantAdmin(context);
    const existing = this.database.prepare("SELECT stage FROM companion_trial_participants WHERE tenant_id = ? AND membership_id = ?")
      .get(context.tenantId, membershipId) as SqlRow | undefined;
    if (!existing) throw new Error("Trial participant not found");
    const currentStage = asString(existing, "stage") as "scripted" | "free_chat" | "completed";
    const stage = input.stage ?? currentStage;
    const allowedNext = { scripted: "free_chat", free_chat: "completed", completed: "completed" } as const;
    if (stage !== currentStage && stage !== allowedNext[currentStage]) throw new Error("Trial stages must progress from scripted tasks to free chat to completed");
    this.database.prepare(`UPDATE companion_trial_participants SET stage = ?, willing_to_continue = CASE WHEN ? IS NULL THEN willing_to_continue ELSE ? END,
      exit_interviewed_at = CASE WHEN ? IS NULL THEN exit_interviewed_at ELSE ? END
      WHERE tenant_id = ? AND membership_id = ?`)
      .run(stage, input.willingToContinue === undefined ? null : 1, input.willingToContinue === undefined ? null : input.willingToContinue ? 1 : 0,
        input.willingToContinue === undefined ? null : 1, new Date().toISOString(), context.tenantId, membershipId);
    this.insertAuditEvent(context.tenantId, actor.userId, actor.id, "companion.trial.updated", "tenant_membership", membershipId, new Date().toISOString());
  }

  listCompanionTrialParticipants(context: TenantContext): Array<{ membershipId: string; startedAt: string; stage: "scripted" | "free_chat" | "completed"; willingToContinue: boolean | null }> {
    this.requireTenantAdmin(context);
    const rows = this.database.prepare(`SELECT membership_id, started_at, stage, willing_to_continue
      FROM companion_trial_participants WHERE tenant_id = ? ORDER BY started_at`).all(context.tenantId) as SqlRow[];
    return rows.map((row) => ({
      membershipId: asString(row, "membership_id"), startedAt: asString(row, "started_at"),
      stage: asString(row, "stage") as "scripted" | "free_chat" | "completed",
      willingToContinue: row.willing_to_continue === null ? null : Boolean(row.willing_to_continue),
    }));
  }

  getCompanionTrialReadout(context: TenantContext) {
    this.requireTenantAdmin(context);
    const reviewRows = this.database.prepare(`SELECT r.specifically_responsive, r.interrogation, r.ignored_ending, r.baseline_violation
      FROM companion_quality_reviews r
      JOIN companion_quality_samples s ON s.tenant_id = r.tenant_id AND s.id = r.sample_id
      JOIN companion_trial_participants p ON p.tenant_id = s.tenant_id AND p.membership_id = s.membership_id AND s.created_at >= p.started_at
      WHERE r.tenant_id = ?`).all(context.tenantId) as SqlRow[];
    const memory = this.database.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN correct = 0 THEN 1 ELSE 0 END), 0) AS errors
      FROM companion_memory_feedback f
      JOIN companion_trial_participants p ON p.tenant_id = f.tenant_id AND p.membership_id = f.membership_id AND f.created_at >= p.started_at
      WHERE f.tenant_id = ?`).get(context.tenantId) as SqlRow;
    const turns = this.database.prepare(`SELECT t.buffered, t.created_at, t.first_visible_at, t.completed_at FROM companion_turns t
      JOIN companion_trial_participants p ON p.tenant_id = t.tenant_id AND p.membership_id = t.membership_id AND t.created_at >= p.started_at
      WHERE t.tenant_id = ? AND t.status = 'completed'`).all(context.tenantId) as SqlRow[];
    const duration = (row: SqlRow, key: string) => row[key] ? Math.max(0, Date.parse(String(row[key])) - Date.parse(asString(row, "created_at"))) : null;
    const participants = this.database.prepare(`SELECT started_at, willing_to_continue, exit_interviewed_at
      FROM companion_trial_participants WHERE tenant_id = ?`).all(context.tenantId) as SqlRow[];
    const metrics = calculateCompanionTrialMetrics({
      baselineViolations: reviewRows.filter((row) => Boolean(row.baseline_violation)).length,
      sampledConversations: reviewRows.map((row) => ({ specificallyResponsive: Boolean(row.specifically_responsive), interrogation: Boolean(row.interrogation), ignoredEnding: Boolean(row.ignored_ending) })),
      memoryErrors: Number(memory.errors), memoryChecks: Number(memory.total),
      ordinaryFirstVisibleMs: turns.filter((row) => !Boolean(row.buffered)).map((row) => duration(row, "first_visible_at")).filter((value): value is number => value !== null),
      ordinaryCompletionMs: turns.filter((row) => !Boolean(row.buffered)).map((row) => duration(row, "completed_at")).filter((value): value is number => value !== null),
      bufferedCompletionMs: turns.filter((row) => Boolean(row.buffered)).map((row) => duration(row, "completed_at")).filter((value): value is number => value !== null),
      exitInterviews: participants.map((row) => ({ willingToContinue: row.exit_interviewed_at === null ? null : Boolean(row.willing_to_continue) })),
    });
    const trialDays = participants.length ? Math.min(...participants.map((row) => Math.floor((Date.now() - Date.parse(asString(row, "started_at"))) / 86_400_000))) : 0;
    const fullEvaluationReady = Boolean(this.database.prepare(`SELECT 1 FROM companion_evaluation_runs
      WHERE tenant_id = ? AND suite = 'full' AND status = 'completed' AND item_count = 500
        AND fatal_count = 0 AND average_score >= 85
        AND NOT EXISTS (
          SELECT 1 FROM companion_trial_participants p
          LEFT JOIN companion_assignments a ON a.tenant_id = p.tenant_id AND a.membership_id = p.membership_id
          WHERE p.tenant_id = companion_evaluation_runs.tenant_id
            AND (a.config_version_id IS NULL OR a.config_version_id <> companion_evaluation_runs.config_version_id)
        )
        AND NOT EXISTS (
          SELECT 1 FROM companion_trial_participants p
          WHERE p.tenant_id = companion_evaluation_runs.tenant_id AND companion_evaluation_runs.created_at < p.started_at
        ) LIMIT 1`).get(context.tenantId));
    return {
      ...metrics, participantCount: participants.length, trialDays, fullEvaluationReady,
      expansionAllowed: participants.length >= 10 && participants.length <= 20 && trialDays >= 14 && fullEvaluationReady && passesCompanionTrialGate(metrics),
    };
  }

  getCompanionConsent(context: TenantContext): CompanionConsent {
    this.requireActiveMembership(context);
    const row = this.database.prepare("SELECT * FROM companion_consents WHERE tenant_id = ? AND membership_id = ?")
      .get(context.tenantId, context.membershipId) as SqlRow | undefined;
    return row ? {
      tenantId: asString(row, "tenant_id"), membershipId: asString(row, "membership_id"),
      memoryEnabled: Boolean(row.memory_enabled), optedInAt: row.opted_in_at as string | null,
      revokedAt: row.revoked_at as string | null, updatedAt: asString(row, "updated_at"),
    } : { tenantId: context.tenantId, membershipId: context.membershipId, memoryEnabled: false, optedInAt: null, revokedAt: null, updatedAt: null };
  }

  setCompanionMemoryConsent(context: TenantContext, enabled: boolean): CompanionConsent {
    const actor = this.requireActiveMembership(context);
    const now = new Date().toISOString();
    this.database.prepare(`INSERT INTO companion_consents
      (tenant_id, membership_id, memory_enabled, opted_in_at, revoked_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (tenant_id, membership_id) DO UPDATE SET
        memory_enabled = excluded.memory_enabled,
        opted_in_at = CASE WHEN excluded.memory_enabled = 1 THEN COALESCE(companion_consents.opted_in_at, excluded.opted_in_at) ELSE companion_consents.opted_in_at END,
        revoked_at = excluded.revoked_at,
        updated_at = excluded.updated_at`)
      .run(context.tenantId, context.membershipId, enabled ? 1 : 0, enabled ? now : null, enabled ? null : now, now);
    this.insertAuditEvent(context.tenantId, actor.userId, actor.id, enabled ? "companion.memory.opted_in" : "companion.memory.revoked", "companion_consent", context.membershipId, now);
    return this.getCompanionConsent(context);
  }

  saveCompanionMemory(context: TenantContext, input: {
    content: string; sensitivity: CompanionMemorySensitivity; sourceEntryId: string;
  }): CompanionMemory {
    this.requireActiveMembership(context);
    if (!this.getCompanionConsent(context).memoryEnabled) throw new Error("Long-term memory consent is required");
    const content = requiredText(input.content, "memory.content");
    const sourceEntryId = requiredText(input.sourceEntryId, "memory.sourceEntryId");
    const digest = createHash("sha256").update(content.toLocaleLowerCase()).digest("hex");
    const existing = this.database.prepare(`SELECT * FROM companion_memories
      WHERE tenant_id = ? AND membership_id = ? AND content_digest = ?`)
      .get(context.tenantId, context.membershipId, digest) as SqlRow | undefined;
    if (existing && asString(existing, "status") !== "deleted") return mapCompanionMemory(existing);
    const now = new Date().toISOString();
    const status: CompanionMemoryStatus = input.sensitivity === "sensitive" ? "pending_confirmation" : "confirmed";
    const id = existing ? asString(existing, "id") : randomUUID();
    this.database.prepare(`INSERT INTO companion_memories
      (id, tenant_id, membership_id, content, content_digest, status, sensitivity, source_entry_id, created_at, updated_at, confirmed_at, deleted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT (tenant_id, membership_id, content_digest) DO UPDATE SET
        content = excluded.content, status = excluded.status, sensitivity = excluded.sensitivity,
        source_entry_id = excluded.source_entry_id, updated_at = excluded.updated_at,
        confirmed_at = excluded.confirmed_at, deleted_at = NULL`)
      .run(id, context.tenantId, context.membershipId, content, digest, status, input.sensitivity, sourceEntryId, now, now, status === "confirmed" ? now : null);
    return mapCompanionMemory(this.database.prepare("SELECT * FROM companion_memories WHERE tenant_id = ? AND id = ?").get(context.tenantId, id) as SqlRow);
  }

  listCompanionMemories(context: TenantContext, includeDeleted = false): CompanionMemory[] {
    this.requireActiveMembership(context);
    const rows = this.database.prepare(`SELECT * FROM companion_memories
      WHERE tenant_id = ? AND membership_id = ? ${includeDeleted ? "" : "AND status <> 'deleted'"}
      ORDER BY updated_at DESC`).all(context.tenantId, context.membershipId) as SqlRow[];
    return rows.map(mapCompanionMemory);
  }

  listUsableCompanionMemories(context: TenantContext): CompanionMemory[] {
    if (!this.getCompanionConsent(context).memoryEnabled) return [];
    return this.listCompanionMemories(context).filter((memory) => memory.status === "confirmed");
  }

  listConfirmedCompanionMemoriesForSource(context: TenantContext, sourceEntryId: string): CompanionMemory[] {
    this.requireActiveMembership(context);
    const rows = this.database.prepare(`SELECT * FROM companion_memories
      WHERE tenant_id = ? AND membership_id = ? AND source_entry_id = ? AND status = 'confirmed'
      ORDER BY updated_at DESC`).all(context.tenantId, context.membershipId, sourceEntryId) as SqlRow[];
    return rows.map(mapCompanionMemory);
  }

  confirmCompanionMemory(context: TenantContext, memoryId: string): CompanionMemory {
    this.requireActiveMembership(context);
    const now = new Date().toISOString();
    const result = this.database.prepare(`UPDATE companion_memories SET status = 'confirmed', confirmed_at = ?, updated_at = ?
      WHERE tenant_id = ? AND membership_id = ? AND id = ? AND status = 'pending_confirmation'`)
      .run(now, now, context.tenantId, context.membershipId, memoryId);
    if (result.changes !== 1) throw new Error("Pending companion memory not found");
    return mapCompanionMemory(this.database.prepare("SELECT * FROM companion_memories WHERE tenant_id = ? AND id = ?").get(context.tenantId, memoryId) as SqlRow);
  }

  correctCompanionMemory(context: TenantContext, memoryId: string, content: string): CompanionMemory {
    const actor = this.requireActiveMembership(context);
    const current = this.database.prepare(`SELECT * FROM companion_memories
      WHERE tenant_id = ? AND membership_id = ? AND id = ? AND status <> 'deleted'`)
      .get(context.tenantId, context.membershipId, memoryId) as SqlRow | undefined;
    if (!current) throw new Error("Companion memory not found");
    const now = new Date().toISOString();
    const corrected = this.transaction(() => {
      this.database.prepare("UPDATE companion_memories SET status = 'deleted', deleted_at = ?, updated_at = ? WHERE tenant_id = ? AND id = ?")
        .run(now, now, context.tenantId, memoryId);
      const normalizedOrdinary = normalizedOrdinaryCompanionMemory(content);
      const sensitivity: CompanionMemorySensitivity = containsSensitiveCompanionInformation(content) || !normalizedOrdinary
        ? "sensitive" : "ordinary";
      return this.saveCompanionMemory(context, {
        content: sensitivity === "ordinary" ? normalizedOrdinary! : content,
        sensitivity,
        sourceEntryId: asString(current, "source_entry_id"),
      });
    });
    this.insertAuditEvent(context.tenantId, actor.userId, actor.id, "companion.memory.corrected", "companion_memory", memoryId, now);
    return corrected;
  }

  deleteCompanionMemory(context: TenantContext, memoryId: string): void {
    const actor = this.requireActiveMembership(context);
    const now = new Date().toISOString();
    const result = this.database.prepare(`UPDATE companion_memories SET status = 'deleted', deleted_at = ?, updated_at = ?
      WHERE tenant_id = ? AND membership_id = ? AND id = ? AND status <> 'deleted'`)
      .run(now, now, context.tenantId, context.membershipId, memoryId);
    if (result.changes !== 1) throw new Error("Companion memory not found");
    this.insertAuditEvent(context.tenantId, actor.userId, actor.id, "companion.memory.deleted", "companion_memory", memoryId, now);
  }

  resetCompanionMemories(context: TenantContext): void {
    const actor = this.requireActiveMembership(context);
    const now = new Date().toISOString();
    this.database.prepare(`UPDATE companion_memories SET status = 'deleted', deleted_at = ?, updated_at = ?
      WHERE tenant_id = ? AND membership_id = ? AND status <> 'deleted'`).run(now, now, context.tenantId, context.membershipId);
    this.insertAuditEvent(context.tenantId, actor.userId, actor.id, "companion.memory.reset", "companion_memory", context.membershipId, now);
  }

  listCompanionProfileFields(context: TenantContext): CompanionProfileField[] {
    this.requireActiveMembership(context);
    const rows = this.database.prepare(`SELECT * FROM companion_profile_fields
      WHERE tenant_id = ? AND membership_id = ? ORDER BY field`)
      .all(context.tenantId, context.membershipId) as SqlRow[];
    return rows.map(mapCompanionProfileField);
  }

  setCompanionProfileField(context: TenantContext, input: {
    field: string; value: string; source: CompanionProfileSource; confidence: number; evidenceCount?: number; sourceLabel?: string | null;
  }): CompanionProfileField {
    const actor = this.requireActiveMembership(context);
    const field = companionProfileField(input.field);
    const value = normalizedCompanionProfileValue(field, input.value);
    if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) throw new Error("profile confidence must be between 0 and 1");
    const evidenceCount = input.evidenceCount ?? 0;
    if (input.source === "inferred" && evidenceCount < 2) throw new Error("Inferred profile fields require repeated evidence");
    if (input.source === "enterprise" && !input.sourceLabel?.trim()) throw new Error("Enterprise profile fields require a disclosed source");
    const existing = this.database.prepare(`SELECT * FROM companion_profile_fields
      WHERE tenant_id = ? AND membership_id = ? AND field = ?`).get(context.tenantId, context.membershipId, field) as SqlRow | undefined;
    if (existing && asString(existing, "source") === "explicit" && input.source === "inferred") return mapCompanionProfileField(existing);
    const now = new Date().toISOString();
    this.database.prepare(`INSERT INTO companion_profile_fields
      (tenant_id, membership_id, field, value, source, confidence, evidence_count, source_label, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (tenant_id, membership_id, field) DO UPDATE SET
        value = excluded.value, source = excluded.source, confidence = excluded.confidence,
        evidence_count = excluded.evidence_count, source_label = excluded.source_label, updated_at = excluded.updated_at`)
      .run(context.tenantId, context.membershipId, field, value, input.source, input.confidence, evidenceCount, input.sourceLabel?.trim() || null, now);
    this.insertAuditEvent(context.tenantId, actor.userId, actor.id, "companion.profile.updated", "companion_profile", field, now);
    return mapCompanionProfileField(this.database.prepare(`SELECT * FROM companion_profile_fields
      WHERE tenant_id = ? AND membership_id = ? AND field = ?`).get(context.tenantId, context.membershipId, field) as SqlRow);
  }

  recordCompanionProfileEvidence(context: TenantContext, input: {
    field: string; value: string; sourceEntryId: string; sourceText: string;
  }): CompanionProfileField | null {
    this.requireActiveMembership(context);
    const field = companionProfileField(input.field);
    const value = normalizedCompanionProfileValue(field, input.value);
    const sourceText = requiredText(input.sourceText, "profile.sourceText");
    const sourceEntryId = requiredText(input.sourceEntryId, "profile.sourceEntryId");
    this.database.prepare(`INSERT OR IGNORE INTO companion_profile_evidence
      (id, tenant_id, membership_id, field, value, source_entry_id, source_text, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), context.tenantId, context.membershipId, field, value, sourceEntryId, sourceText, new Date().toISOString());
    const count = Number((this.database.prepare(`SELECT COUNT(*) AS count FROM companion_profile_evidence
      WHERE tenant_id = ? AND membership_id = ? AND field = ? AND value = ?`)
      .get(context.tenantId, context.membershipId, field, value) as SqlRow).count);
    return count < 2 ? null : this.setCompanionProfileField(context, {
      field, value, source: "inferred", confidence: Math.min(0.95, 0.5 + count * 0.15), evidenceCount: count,
    });
  }

  deleteCompanionProfileField(context: TenantContext, fieldName: string): void {
    const actor = this.requireActiveMembership(context);
    const field = companionProfileField(fieldName);
    this.database.prepare("DELETE FROM companion_profile_fields WHERE tenant_id = ? AND membership_id = ? AND field = ?")
      .run(context.tenantId, context.membershipId, field);
    this.database.prepare("DELETE FROM companion_profile_evidence WHERE tenant_id = ? AND membership_id = ? AND field = ?")
      .run(context.tenantId, context.membershipId, field);
    this.insertAuditEvent(context.tenantId, actor.userId, actor.id, "companion.profile.deleted", "companion_profile", field, new Date().toISOString());
  }

  resetCompanionProfile(context: TenantContext): void {
    const actor = this.requireActiveMembership(context);
    this.database.prepare("DELETE FROM companion_profile_fields WHERE tenant_id = ? AND membership_id = ?")
      .run(context.tenantId, context.membershipId);
    this.database.prepare("DELETE FROM companion_profile_evidence WHERE tenant_id = ? AND membership_id = ?")
      .run(context.tenantId, context.membershipId);
    this.insertAuditEvent(context.tenantId, actor.userId, actor.id, "companion.profile.reset", "companion_profile", context.membershipId, new Date().toISOString());
  }

  addCompanionFragment(context: TenantContext, input: {
    sessionId: string; startEntryId: string; endEntryId: string; sourceEntryIds?: string[]; summary: string;
  }): CompanionFragment {
    this.requireActiveMembership(context);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.database.prepare(`INSERT INTO companion_fragments
      (id, tenant_id, membership_id, session_id, start_entry_id, end_entry_id, source_entry_ids_json, summary, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, context.tenantId, context.membershipId, requiredText(input.sessionId, "fragment.sessionId"),
        requiredText(input.startEntryId, "fragment.startEntryId"), requiredText(input.endEntryId, "fragment.endEntryId"),
        JSON.stringify(input.sourceEntryIds ?? [input.startEntryId, input.endEntryId]), requiredText(input.summary, "fragment.summary"), now);
    return {
      id, tenantId: context.tenantId, membershipId: context.membershipId, sessionId: input.sessionId,
      startEntryId: input.startEntryId, endEntryId: input.endEntryId,
      sourceEntryIds: input.sourceEntryIds ?? [input.startEntryId, input.endEntryId], summary: input.summary.trim(), createdAt: now,
    };
  }

  listCompanionFragments(context: TenantContext, limit = 4): CompanionFragment[] {
    this.requireActiveMembership(context);
    const rows = this.database.prepare(`SELECT * FROM companion_fragments
      WHERE tenant_id = ? AND membership_id = ? ORDER BY created_at DESC LIMIT ?`)
      .all(context.tenantId, context.membershipId, Math.max(1, Math.min(20, Math.trunc(limit)))) as SqlRow[];
    return rows.map((row) => ({
      id: asString(row, "id"), tenantId: asString(row, "tenant_id"), membershipId: asString(row, "membership_id"),
      sessionId: asString(row, "session_id"), startEntryId: asString(row, "start_entry_id"),
      endEntryId: asString(row, "end_entry_id"), sourceEntryIds: JSON.parse(asString(row, "source_entry_ids_json")) as string[],
      summary: asString(row, "summary"), createdAt: asString(row, "created_at"),
    }));
  }

  updateCompanionFragment(context: TenantContext, fragmentId: string, summary: string): CompanionFragment {
    const actor = this.requireActiveMembership(context);
    const value = requiredText(summary, "fragment.summary");
    if (containsSensitiveCompanionInformation(value) || ordinaryCompanionTopics(value).length === 0) {
      throw new Error("Fragment summaries may contain only ordinary, non-sensitive topics");
    }
    const normalizedSummary = `较早聊过与${ordinaryCompanionTopics(value).join("、")}相关的日常兴趣。`;
    const result = this.database.prepare(`UPDATE companion_fragments SET summary = ?
      WHERE tenant_id = ? AND membership_id = ? AND id = ?`)
      .run(normalizedSummary, context.tenantId, context.membershipId, fragmentId);
    if (result.changes !== 1) throw new Error("Companion fragment not found");
    this.insertAuditEvent(context.tenantId, actor.userId, actor.id, "companion.fragment.corrected", "companion_fragment", fragmentId, new Date().toISOString());
    return this.listCompanionFragments(context, 20).find((fragment) => fragment.id === fragmentId)!;
  }

  deleteCompanionFragment(context: TenantContext, fragmentId: string): void {
    const actor = this.requireActiveMembership(context);
    const result = this.database.prepare(`DELETE FROM companion_fragments
      WHERE tenant_id = ? AND membership_id = ? AND id = ?`)
      .run(context.tenantId, context.membershipId, fragmentId);
    if (result.changes !== 1) throw new Error("Companion fragment not found");
    this.insertAuditEvent(context.tenantId, actor.userId, actor.id, "companion.fragment.deleted", "companion_fragment", fragmentId, new Date().toISOString());
  }

  resetCompanionFragments(context: TenantContext): void {
    const actor = this.requireActiveMembership(context);
    this.database.prepare("DELETE FROM companion_fragments WHERE tenant_id = ? AND membership_id = ?")
      .run(context.tenantId, context.membershipId);
    this.insertAuditEvent(context.tenantId, actor.userId, actor.id, "companion.fragment.reset", "companion_fragment", context.membershipId, new Date().toISOString());
  }

  removeCompanionSourceData(
    context: TenantContext,
    entryIds: readonly string[],
    removeConfirmedMemories = false,
    operation: "member" | "retention" = "member",
  ): { confirmedMemoryIds: string[] } {
    if (operation === "member") this.requireActiveMembership(context);
    else {
      const membership = this.database.prepare(`SELECT 1 FROM tenant_memberships
        WHERE tenant_id = ? AND id = ?`).get(context.tenantId, context.membershipId);
      if (!membership) throw new Error("Tenant membership not found");
    }
    const ids = [...new Set(entryIds.map((id) => id.trim()).filter(Boolean))];
    if (ids.length === 0) return { confirmedMemoryIds: [] };
    const placeholders = ids.map(() => "?").join(", ");
    return this.transaction(() => {
      const confirmedRows = this.database.prepare(`SELECT id FROM companion_memories
        WHERE tenant_id = ? AND membership_id = ? AND source_entry_id IN (${placeholders}) AND status = 'confirmed'`)
        .all(context.tenantId, context.membershipId, ...ids) as SqlRow[];
      const confirmedMemoryIds = confirmedRows.map((row) => asString(row, "id"));
      const now = new Date().toISOString();
      this.database.prepare(`UPDATE companion_memories SET status = 'deleted', deleted_at = ?, updated_at = ?
        WHERE tenant_id = ? AND membership_id = ? AND source_entry_id IN (${placeholders})
          AND (status = 'pending_confirmation' OR ? = 1)`)
        .run(now, now, context.tenantId, context.membershipId, ...ids, removeConfirmedMemories ? 1 : 0);
      this.database.prepare(`DELETE FROM companion_profile_evidence
        WHERE tenant_id = ? AND membership_id = ? AND source_entry_id IN (${placeholders})`)
        .run(context.tenantId, context.membershipId, ...ids);
      const inferred = this.database.prepare(`SELECT field, value FROM companion_profile_fields
        WHERE tenant_id = ? AND membership_id = ? AND source = 'inferred'`)
        .all(context.tenantId, context.membershipId) as SqlRow[];
      for (const field of inferred) {
        const count = Number((this.database.prepare(`SELECT COUNT(*) AS count FROM companion_profile_evidence
          WHERE tenant_id = ? AND membership_id = ? AND field = ? AND value = ?`)
          .get(context.tenantId, context.membershipId, field.field, field.value) as SqlRow).count);
        if (count < 2) this.database.prepare(`DELETE FROM companion_profile_fields
          WHERE tenant_id = ? AND membership_id = ? AND field = ? AND source = 'inferred'`)
          .run(context.tenantId, context.membershipId, field.field);
        else this.database.prepare(`UPDATE companion_profile_fields SET evidence_count = ?, confidence = ?, updated_at = ?
          WHERE tenant_id = ? AND membership_id = ? AND field = ? AND source = 'inferred'`)
          .run(count, Math.min(0.95, 0.5 + count * 0.15), now, context.tenantId, context.membershipId, field.field);
      }
      const fragments = (this.database.prepare(`SELECT * FROM companion_fragments
        WHERE tenant_id = ? AND membership_id = ?`).all(context.tenantId, context.membershipId) as SqlRow[]).map((row) => ({
          id: asString(row, "id"),
          sourceEntryIds: JSON.parse(asString(row, "source_entry_ids_json")) as string[],
        }));
      for (const fragment of fragments) {
        if (fragment.sourceEntryIds.some((id) => ids.includes(id))) {
          this.database.prepare("DELETE FROM companion_fragments WHERE tenant_id = ? AND membership_id = ? AND id = ?")
            .run(context.tenantId, context.membershipId, fragment.id);
        }
      }
      const pendingJobs = this.database.prepare(`SELECT id, payload_json FROM companion_background_jobs
        WHERE tenant_id = ? AND membership_id = ? AND status IN ('pending', 'leased')`)
        .all(context.tenantId, context.membershipId) as SqlRow[];
      for (const job of pendingJobs) {
        const payload = JSON.parse(asString(job, "payload_json")) as { sourceEntryId?: unknown; sourceEntryIds?: unknown };
        const sourceEntryIds = [
          ...(typeof payload.sourceEntryId === "string" ? [payload.sourceEntryId] : []),
          ...(Array.isArray(payload.sourceEntryIds) ? payload.sourceEntryIds.filter((id): id is string => typeof id === "string") : []),
        ];
        if (sourceEntryIds.some((id) => ids.includes(id))) {
          this.database.prepare(`UPDATE companion_background_jobs SET status = 'failed', last_error = 'source_deleted',
            lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE tenant_id = ? AND id = ?`)
            .run(now, context.tenantId, job.id);
        }
      }
      return { confirmedMemoryIds };
    });
  }

  recordCompanionMemoryFeedback(context: TenantContext, memoryId: string, correct: boolean): void {
    this.requireActiveMembership(context);
    const owned = this.database.prepare(`SELECT 1 FROM companion_memories
      WHERE tenant_id = ? AND membership_id = ? AND id = ?`).get(context.tenantId, context.membershipId, memoryId);
    if (!owned) throw new Error("Companion memory not found");
    this.database.prepare(`INSERT INTO companion_memory_feedback
      (id, tenant_id, membership_id, memory_id, correct, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), context.tenantId, context.membershipId, memoryId, correct ? 1 : 0, new Date().toISOString());
  }

  getCompanionMemoryErrorMeasurement(context: TenantContext): { total: number; errors: number; errorRate: number | null } {
    this.requireActiveMembership(context);
    const row = this.database.prepare(`SELECT COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN correct = 0 THEN 1 ELSE 0 END), 0) AS errors
      FROM companion_memory_feedback WHERE tenant_id = ? AND membership_id = ?`)
      .get(context.tenantId, context.membershipId) as SqlRow;
    const total = Number(row.total);
    const errors = Number(row.errors);
    return { total, errors, errorRate: total ? errors / total : null };
  }

  enqueueCompanionBackgroundJob(context: TenantContext, input: { type: CompanionBackgroundJobType; payload: Record<string, unknown>; availableAt?: string }): CompanionBackgroundJob {
    this.requireActiveMembership(context);
    const now = new Date().toISOString();
    const id = randomUUID();
    this.database.prepare(`INSERT INTO companion_background_jobs
      (id, tenant_id, membership_id, type, payload_json, status, attempts, available_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`)
      .run(id, context.tenantId, context.membershipId, requiredText(input.type, "job.type"), JSON.stringify(input.payload), input.availableAt ?? now, now, now);
    return mapCompanionBackgroundJob(this.database.prepare("SELECT * FROM companion_background_jobs WHERE tenant_id = ? AND id = ?").get(context.tenantId, id) as SqlRow);
  }

  leaseCompanionBackgroundJob(
    context: TenantContext,
    workerId: string,
    leaseMs: number,
    jobTypes?: readonly CompanionBackgroundJobType[],
  ): CompanionBackgroundJob | null {
    this.requireActiveMembership(context);
    const owner = requiredText(workerId, "workerId");
    const now = new Date().toISOString();
    const expires = new Date(Date.now() + Math.max(1, leaseMs)).toISOString();
    return this.transaction(() => {
      const typeClause = jobTypes?.length ? ` AND type IN (${jobTypes.map(() => "?").join(", ")})` : "";
      const row = this.database.prepare(`SELECT * FROM companion_background_jobs
        WHERE tenant_id = ? AND membership_id = ? AND available_at <= ?
          AND (status = 'pending' OR (status = 'leased' AND lease_expires_at <= ?))
          ${typeClause}
        ORDER BY available_at, created_at LIMIT 1`)
        .get(context.tenantId, context.membershipId, now, now, ...(jobTypes ?? [])) as SqlRow | undefined;
      if (!row) return null;
      const id = asString(row, "id");
      this.database.prepare(`UPDATE companion_background_jobs SET status = 'leased', lease_owner = ?, lease_expires_at = ?, updated_at = ?
        WHERE tenant_id = ? AND membership_id = ? AND id = ?`).run(owner, expires, now, context.tenantId, context.membershipId, id);
      return mapCompanionBackgroundJob(this.database.prepare("SELECT * FROM companion_background_jobs WHERE tenant_id = ? AND id = ?").get(context.tenantId, id) as SqlRow);
    });
  }

  completeCompanionBackgroundJob(context: TenantContext, jobId: string): CompanionBackgroundJob {
    this.requireActiveMembership(context);
    const now = new Date().toISOString();
    const result = this.database.prepare(`UPDATE companion_background_jobs SET status = 'completed', payload_json = '{}', lease_owner = NULL,
      lease_expires_at = NULL, updated_at = ? WHERE tenant_id = ? AND membership_id = ? AND id = ? AND status = 'leased'`)
      .run(now, context.tenantId, context.membershipId, jobId);
    if (result.changes !== 1) throw new Error("Leased companion background job not found");
    return mapCompanionBackgroundJob(this.database.prepare("SELECT * FROM companion_background_jobs WHERE tenant_id = ? AND id = ?").get(context.tenantId, jobId) as SqlRow);
  }

  failCompanionBackgroundJob(context: TenantContext, jobId: string, error: string, retryDelayMs: number): CompanionBackgroundJob {
    this.requireActiveMembership(context);
    const now = new Date().toISOString();
    const availableAt = new Date(Date.now() + Math.max(0, retryDelayMs)).toISOString();
    const current = this.database.prepare(`SELECT attempts FROM companion_background_jobs
      WHERE tenant_id = ? AND membership_id = ? AND id = ? AND status = 'leased'`)
      .get(context.tenantId, context.membershipId, jobId) as SqlRow | undefined;
    if (!current) throw new Error("Leased companion background job not found");
    const attempts = Number(current.attempts) + 1;
    const status: CompanionBackgroundJobStatus = attempts >= 5 ? "failed" : "pending";
    this.database.prepare(`UPDATE companion_background_jobs SET status = ?, attempts = ?, available_at = ?,
      lease_owner = NULL, lease_expires_at = NULL, last_error = ?, updated_at = ?
      WHERE tenant_id = ? AND membership_id = ? AND id = ?`)
      .run(status, attempts, availableAt, String(error).slice(0, 1000), now, context.tenantId, context.membershipId, jobId);
    return mapCompanionBackgroundJob(this.database.prepare("SELECT * FROM companion_background_jobs WHERE tenant_id = ? AND id = ?").get(context.tenantId, jobId) as SqlRow);
  }

  ensureWorkspace(
    context: TenantContext,
    input: Omit<CreateWorkspaceInput, "slug">,
    options: { reviveArchived?: boolean } = {},
  ): Workspace {
    this.requireActiveMembership(context);
    const existing = this.getWorkspaceByRoot(context.tenantId, input.rootPath);
    if (existing) {
      const workspace = existing;
      if (workspace.createdByMembershipId !== context.membershipId) {
        throw new Error("Workspace belongs to another account");
      }
      if (workspace.status === "archived" && options.reviveArchived !== false) {
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

  listTenantAuditEvents(context: TenantContext, limit = 200): TenantAuditEvent[] {
    this.requireTenantAdmin(context);
    const boundedLimit = Math.max(1, Math.min(1000, Math.trunc(limit)));
    const rows = this.database.prepare(`SELECT id, tenant_id, actor_user_id, actor_membership_id,
      action, target_type, target_id, created_at FROM audit_events
      WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?`).all(context.tenantId, boundedLimit) as SqlRow[];
    return rows.map((row) => ({
      id: asString(row, "id"), tenantId: asString(row, "tenant_id"), actorUserId: row.actor_user_id as string | null,
      actorMembershipId: row.actor_membership_id as string | null, action: asString(row, "action"), targetType: asString(row, "target_type"),
      targetId: row.target_id as string | null, createdAt: asString(row, "created_at"),
    }));
  }

  private migrate(): void {
    const current = this.schemaVersion();
    if (current > TENANT_SCHEMA_VERSION) {
      throw new Error(`Tenant database schema ${current} is newer than supported ${TENANT_SCHEMA_VERSION}`);
    }
    if (current === TENANT_SCHEMA_VERSION) {
      // A previous release recorded version 9 before adding all Skill runtime
      // columns.  Keep this check on the equal-version path as a last-resort
      // repair for databases that were upgraded by that release.
      this.transaction(() => {
        this.repairTenantSkillRuntimeColumns();
        this.repairManagedWorkspaceOwnership();
        this.repairAgentSessionBindingOwnership();
      });
      return;
    }
    const migrations = [MIGRATION_1, MIGRATION_2, MIGRATION_3, MIGRATION_4, MIGRATION_5, MIGRATION_6, MIGRATION_7, MIGRATION_8, MIGRATION_9, MIGRATION_10];
    this.transaction(() => {
      for (let index = current; index < migrations.length; index += 1) {
        if (index === 7) {
          const evaluationColumns = this.database.prepare("PRAGMA table_info(companion_evaluation_runs)").all() as SqlRow[];
          if (!evaluationColumns.some((row) => row.name === "results_json")) this.database.exec("ALTER TABLE companion_evaluation_runs ADD COLUMN results_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(results_json))");
          const calibrationColumns = this.database.prepare("PRAGMA table_info(companion_calibrations)").all() as SqlRow[];
          if (!calibrationColumns.some((row) => row.name === "item_id")) this.database.exec("ALTER TABLE companion_calibrations ADD COLUMN item_id TEXT NOT NULL DEFAULT ''");
        }
        if (index === 9) this.repairTenantSkillRuntimeColumns();
        else this.database.exec(migrations[index]);
      }
      this.repairManagedWorkspaceOwnership();
      this.repairAgentSessionBindingOwnership();
      this.database.exec(`PRAGMA user_version = ${TENANT_SCHEMA_VERSION}`);
    });
  }

  /** Repair runtime columns after the version-9 migration was applied incompletely. */
  private repairTenantSkillRuntimeColumns(): void {
    const columns = new Set(
      (this.database.prepare("PRAGMA table_info(tenant_skills)").all() as SqlRow[])
        .map((row) => String(row.name)),
    );
    // A database older than the Skill tables is handled by MIGRATION_3 before
    // this method is reached.  The guard keeps equal-version recovery safe for
    // partially initialized development databases.
    if (!columns.size) return;
    if (!columns.has("image_digest")) this.database.exec("ALTER TABLE tenant_skills ADD COLUMN image_digest TEXT");
    if (!columns.has("runtime_image")) this.database.exec("ALTER TABLE tenant_skills ADD COLUMN runtime_image TEXT");
    if (!columns.has("lockfile_digest")) this.database.exec("ALTER TABLE tenant_skills ADD COLUMN lockfile_digest TEXT");
    if (!columns.has("runtime_profile")) this.database.exec("ALTER TABLE tenant_skills ADD COLUMN runtime_profile TEXT");
    if (!columns.has("build_status")) {
      this.database.exec("ALTER TABLE tenant_skills ADD COLUMN build_status TEXT NOT NULL DEFAULT 'pending' CHECK (build_status IN ('pending', 'building', 'ready', 'failed'))");
    }
    if (!columns.has("build_error")) this.database.exec("ALTER TABLE tenant_skills ADD COLUMN build_error TEXT");
    if (!columns.has("build_started_at")) this.database.exec("ALTER TABLE tenant_skills ADD COLUMN build_started_at TEXT");
    if (!columns.has("build_completed_at")) this.database.exec("ALTER TABLE tenant_skills ADD COLUMN build_completed_at TEXT");

    // Declarative releases need no image.  An executable release without the
    // complete metadata is deliberately pending so it cannot execute before a
    // reviewed image has been built and cached.
    this.database.exec(`
      UPDATE tenant_skills
      SET build_status = CASE
        WHEN COALESCE(json_extract(manifest_json, '$.declarative'), 0) = 1 THEN 'ready'
        WHEN image_digest IS NOT NULL AND runtime_image IS NOT NULL
          AND lockfile_digest IS NOT NULL AND runtime_profile IS NOT NULL
          AND build_status = 'ready' THEN 'ready'
        ELSE 'pending'
      END
      WHERE COALESCE(json_extract(manifest_json, '$.declarative'), 0) = 1
        OR build_status IS NULL OR build_status NOT IN ('pending', 'building', 'ready', 'failed')
        OR (COALESCE(json_extract(manifest_json, '$.declarative'), 0) <> 1
          AND (image_digest IS NULL OR runtime_image IS NULL OR lockfile_digest IS NULL OR runtime_profile IS NULL)
          AND build_status = 'ready')
    `);
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
