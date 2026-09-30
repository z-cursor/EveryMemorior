import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { TENANT_SCHEMA_VERSION, TenantStore, closeTenantStore, getTenantStore } = await jiti.import("./tenant-store.ts");

function createStore(t) {
  const store = new TenantStore(":memory:");
  t.after(() => store.close());
  return store;
}

test("initializes the tenant schema and creates an owner atomically", (t) => {
  const store = createStore(t);
  const result = store.createTenantWithOwner({
    tenant: { name: "Acme AI", slug: "acme-ai", seatLimit: 25 },
    owner: { email: "Owner@Example.com", displayName: "Owner" },
  });

  assert.equal(store.schemaVersion(), TENANT_SCHEMA_VERSION);
  assert.equal(result.tenant.slug, "acme-ai");
  assert.equal(result.tenant.seatLimit, 25);
  assert.equal(result.membership.role, "owner");
  assert.equal(result.membership.tenantId, result.tenant.id);
  assert.equal(result.membership.userId, result.owner.id);
  assert.equal(store.listUserMemberships(result.owner.id).length, 1);
});

test("all workspace reads and agent-session reads require the tenant id", (t) => {
  const store = createStore(t);
  const first = store.createTenantWithOwner({
    tenant: { name: "First", slug: "first" },
    owner: { email: "first@example.com", displayName: "First Owner" },
  });
  const second = store.createTenantWithOwner({
    tenant: { name: "Second", slug: "second" },
    owner: { email: "second@example.com", displayName: "Second Owner" },
  });
  const context = { tenantId: first.tenant.id, membershipId: first.membership.id };
  const workspace = store.createWorkspace(context, {
    name: "Main workspace",
    slug: "main",
    rootPath: "D:/code/acme",
  });
  const binding = store.bindAgentSession(context, workspace.id, "pi-session-1");

  assert.equal(store.getWorkspace(first.tenant.id, workspace.id)?.id, workspace.id);
  assert.equal(store.getWorkspace(second.tenant.id, workspace.id), null);
  assert.equal(store.getAgentSessionBinding(first.tenant.id, binding.agentSessionId)?.workspaceId, workspace.id);
  assert.equal(store.getAgentSessionBinding(second.tenant.id, binding.agentSessionId), null);
});

test("workspace display names can change without changing their paths or session bindings", (t) => {
  const store = createStore(t);
  const owner = store.createTenantWithOwner({
    tenant: { name: "Acme", slug: "acme" },
    owner: { email: "owner@acme.test", displayName: "Owner" },
  });
  const context = { tenantId: owner.tenant.id, membershipId: owner.membership.id };
  const workspace = store.ensureWorkspace(context, { name: "Original", rootPath: "D:/code/project" });
  store.bindAgentSession(context, workspace.id, "session-1");

  const renamed = store.renameWorkspace(context, workspace.id, "Personal notes");
  assert.equal(renamed.name, "Personal notes");
  assert.equal(renamed.rootPath, workspace.rootPath);
  assert.equal(store.getAgentSessionBinding(context.tenantId, "session-1")?.workspaceId, workspace.id);
  assert.equal(store.listActiveWorkspaces(context.tenantId)[0].name, "Personal notes");
  store.archiveWorkspaceByRoot(context, workspace.rootPath);
  assert.equal(store.listActiveWorkspaces(context.tenantId).length, 0);
  assert.equal(store.listArchivedWorkspaces(context.tenantId)[0].id, workspace.id);
  assert.equal(store.ensureWorkspace(context, { name: "Still archived", rootPath: workspace.rootPath }, { reviveArchived: false }).id, workspace.id);
  assert.equal(store.listArchivedWorkspaces(context.tenantId).length, 1);
  assert.equal(store.ensureWorkspace(context, { name: "Restored", rootPath: workspace.rootPath }, { reviveArchived: true }).id, workspace.id);
  assert.equal(store.listArchivedWorkspaces(context.tenantId).length, 0);
});

test("database constraints reject cross-tenant writes", (t) => {
  const store = createStore(t);
  const first = store.createTenantWithOwner({
    tenant: { name: "First", slug: "first" },
    owner: { email: "first@example.com", displayName: "First Owner" },
  });
  const second = store.createTenantWithOwner({
    tenant: { name: "Second", slug: "second" },
    owner: { email: "second@example.com", displayName: "Second Owner" },
  });

  assert.throws(() => store.createWorkspace(
    { tenantId: first.tenant.id, membershipId: second.membership.id },
    { name: "Leaked", slug: "leaked", rootPath: "D:/code/leaked" },
  ), /Active tenant membership required/);

  const firstWorkspace = store.createWorkspace(
    { tenantId: first.tenant.id, membershipId: first.membership.id },
    { name: "First workspace", slug: "main", rootPath: "D:/code/first" },
  );
  assert.throws(() => store.bindAgentSession(
    { tenantId: second.tenant.id, membershipId: second.membership.id },
    firstWorkspace.id,
    "pi-session-cross-tenant",
  ), /Workspace is not available to this account/);

  assert.throws(() => store.createWorkspace(
    { tenantId: second.tenant.id, membershipId: second.membership.id },
    { name: "Same host path", slug: "same-path", rootPath: "D:/CODE/FIRST" },
  ), /UNIQUE constraint failed/);
});

test("repairs legacy bindings that point at the wrong membership", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-binding-repair-"));
  const path = join(root, "tenant.sqlite");
  const store = new TenantStore(path);
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const created = store.createTenantWithOwner({
    tenant: { name: "Repair", slug: "repair" },
    owner: { email: "owner@repair.test", displayName: "Owner" },
  });
  store.createInvitation(
    { tenantId: created.tenant.id, membershipId: created.membership.id },
    {
      email: "member@repair.test", role: "member", tokenHash: "repair-token",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  );
  const member = store.acceptInvitation({
    tokenHash: "repair-token",
    displayName: "Member",
    credential: { hash: "hash", algorithm: "test" },
  });
  // Use the first tenant's workspace and membership so the corruption stays
  // inside one tenant, matching the old adoption race we are repairing.
  const workspace = store.createWorkspace(
    { tenantId: created.tenant.id, membershipId: created.membership.id },
    { name: "Owner workspace", slug: "owner-workspace", rootPath: join(root, "workspace") },
  );
  store.bindAgentSession(
    { tenantId: created.tenant.id, membershipId: created.membership.id },
    workspace.id,
    "repair-session",
  );
  const raw = new DatabaseSync(path);
  raw.prepare("UPDATE agent_session_bindings SET created_by_membership_id = ? WHERE agent_session_id = ?")
    .run(member.membership.id, "repair-session");
  raw.close();
  assert.notEqual(store.getAgentSessionExecution("repair-session")?.createdByMembershipId, created.membership.id);
  store.repairAgentSessionBindingOwnership();
  assert.equal(store.getAgentSessionExecution("repair-session")?.createdByMembershipId, created.membership.id);
});

test("repairs managed workspace ownership from the directory identity", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-workspace-repair-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  const store = new TenantStore(":memory:");
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });
  const created = store.createTenantWithOwner({
    tenant: { name: "Managed repair", slug: "managed-repair" },
    owner: { email: "owner@managed-repair.test", displayName: "Owner" },
  });
  store.createInvitation(
    { tenantId: created.tenant.id, membershipId: created.membership.id },
    {
      email: "member@managed-repair.test", role: "member", tokenHash: "managed-repair-token",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  );
  const member = store.acceptInvitation({
    tokenHash: "managed-repair-token",
    displayName: "Member",
    credential: { hash: "hash", algorithm: "test" },
  });
  const memberRoot = join(root, "agent", "tenant-workspaces", created.tenant.id, member.membership.id, "projects", "notes");
  const workspace = store.createWorkspace(
    { tenantId: created.tenant.id, membershipId: created.membership.id },
    { name: "Member notes", slug: "member-notes", rootPath: memberRoot },
  );
  store.repairManagedWorkspaceOwnership();
  assert.equal(store.getWorkspace(created.tenant.id, workspace.id)?.createdByMembershipId, member.membership.id);
});

test("one global user can own more than one tenant", (t) => {
  const store = createStore(t);
  const first = store.createTenantWithOwner({
    tenant: { name: "First", slug: "first" },
    owner: { email: "same@example.com", displayName: "First Owner" },
  });
  const second = store.createTenantWithOwner({
    tenant: { name: "Second", slug: "second" },
    owner: { email: "SAME@example.com", displayName: "Second Owner" },
  });

  assert.equal(second.owner.id, first.owner.id);
  assert.equal(store.listUserMemberships(first.owner.id).length, 2);
  assert.deepEqual(store.listUserTenants(first.owner.id).map((item) => item.tenantSlug), ["first", "second"]);
});

test("owner invites a user, the user accepts, and roles stay tenant-scoped", (t) => {
  const store = createStore(t);
  const created = store.createTenantWithOwner({
    tenant: { name: "Acme", slug: "acme" },
    owner: { email: "owner@acme.test", displayName: "Owner" },
  });
  const context = { tenantId: created.tenant.id, membershipId: created.membership.id };
  const invitation = store.createInvitation(context, {
    email: "Admin@Acme.test",
    role: "admin",
    tokenHash: "a".repeat(64),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.equal(store.listPendingInvitations(context)[0].email, "admin@acme.test");

  const accepted = store.acceptInvitation({
    tokenHash: "a".repeat(64),
    displayName: "Admin",
    credential: { hash: "hash", algorithm: "test" },
  });
  assert.equal(accepted.membership.role, "admin");
  assert.equal(store.listPendingInvitations(context).length, 0);
  assert.throws(
    () => store.updateMembershipRole(
      { tenantId: created.tenant.id, membershipId: accepted.membership.id },
      created.membership.id,
      "member",
    ),
    /Only owners/,
  );
  assert.equal(store.updateMembershipRole(context, accepted.membership.id, "owner").role, "owner");
  assert.equal(store.updateMembershipRole(context, created.membership.id, "admin").role, "admin");
});

test("owner can revoke an invitation and the token cannot be accepted", (t) => {
  const store = createStore(t);
  const created = store.createTenantWithOwner({
    tenant: { name: "Acme", slug: "acme" },
    owner: { email: "owner@acme.test", displayName: "Owner" },
  });
  const context = { tenantId: created.tenant.id, membershipId: created.membership.id };
  const invitation = store.createInvitation(context, {
    email: "member@acme.test", role: "member", tokenHash: "b".repeat(64),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  store.revokeInvitation(context, invitation.id);
  assert.throws(() => store.acceptInvitation({ tokenHash: "b".repeat(64) }), /invalid or expired/);
});

test("reissuing a pending invitation rotates its token instead of creating a duplicate", (t) => {
  const store = createStore(t);
  const created = store.createTenantWithOwner({
    tenant: { name: "Acme", slug: "acme" },
    owner: { email: "owner@acme.test", displayName: "Owner" },
  });
  const context = { tenantId: created.tenant.id, membershipId: created.membership.id };
  const first = store.createInvitation(context, {
    email: "member@acme.test", role: "member", tokenHash: "c".repeat(64),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const reissued = store.createInvitation(context, {
    email: "MEMBER@acme.test", role: "admin", tokenHash: "d".repeat(64),
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
  });

  assert.equal(reissued.id, first.id);
  assert.equal(store.listPendingInvitations(context).length, 1);
  assert.equal(store.listPendingInvitations(context)[0].role, "admin");
  assert.throws(() => store.acceptInvitation({ tokenHash: "c".repeat(64) }), /invalid or expired/);
  assert.equal(store.acceptInvitation({
    tokenHash: "d".repeat(64),
    displayName: "Member",
    credential: { hash: "hash", algorithm: "test" },
  }).membership.role, "admin");
});

test("tenant creation is atomic when its slug is already taken", (t) => {
  const store = createStore(t);
  store.createTenantWithOwner({
    tenant: { name: "First", slug: "same-slug" },
    owner: { email: "first@example.com", displayName: "First Owner" },
  });

  assert.throws(() => store.createTenantWithOwner({
    tenant: { name: "Duplicate", slug: "SAME-SLUG" },
    owner: { email: "orphan@example.com", displayName: "Would-be Owner" },
  }), /UNIQUE constraint failed/);
  assert.equal(store.getUserByEmail("orphan@example.com"), null);
});

test("persists data and reopens an already migrated SQLite file", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-tenants-"));
  const path = join(root, "pi-web.sqlite");

  const firstStore = new TenantStore(path);
  const created = firstStore.createTenantWithOwner({
    tenant: { name: "Persistent", slug: "persistent" },
    owner: { email: "owner@persistent.test", displayName: "Owner" },
  });
  firstStore.close();

  const reopenedStore = new TenantStore(path);
  t.after(() => {
    reopenedStore.close();
    rmSync(root, { recursive: true, force: true });
  });
  assert.equal(reopenedStore.schemaVersion(), TENANT_SCHEMA_VERSION);
  assert.equal(reopenedStore.getTenantBySlug("persistent")?.id, created.tenant.id);
});

test("upgrades an earlier phase-one database without replacing its data", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-tenants-v1-"));
  const path = join(root, "pi-web.sqlite");
  const initial = new TenantStore(path);
  const created = initial.createTenantWithOwner({
    tenant: { name: "Before migration", slug: "before-migration" },
    owner: { email: "before@migration.test", displayName: "Owner" },
  });
  initial.close();

  const legacy = new DatabaseSync(path);
  legacy.exec("DROP INDEX workspaces_root_owner_idx; DROP TABLE app_installation; PRAGMA user_version = 1;");
  legacy.close();

  const upgraded = new TenantStore(path);
  t.after(() => {
    upgraded.close();
    rmSync(root, { recursive: true, force: true });
  });
  assert.equal(upgraded.schemaVersion(), TENANT_SCHEMA_VERSION);
  assert.equal(upgraded.getTenant(created.tenant.id)?.name, "Before migration");
  assert.equal(upgraded.getPrimaryTenantId(), created.tenant.id);
});

test("persists Skill runtime metadata and build state independently of the release archive", (t) => {
  const store = createStore(t);
  const created = store.createTenantWithOwner({
    tenant: { name: "Runtime Skills", slug: "runtime-skills" },
    owner: { email: "owner@runtime-skills.test", displayName: "Owner" },
  });
  const context = { tenantId: created.tenant.id, membershipId: created.membership.id };
  const imageDigest = `sha256:${"a".repeat(64)}`;
  const lockfileDigest = "b".repeat(64);
  const draft = store.createTenantSkillDraft(context, {
    slug: "biography-agent",
    name: "Biography Agent",
    description: "Runs the reviewed biography runtime",
    contentDigest: "content-digest",
    storagePath: "/tmp/biography-agent",
    manifest: { declarative: false },
    imageDigest,
    runtimeImage: "pi-web-skill-runtime:release-test",
    lockfileDigest,
    runtimeProfile: "node22-python3",
  });
  assert.equal(draft.buildStatus, "pending");
  assert.equal(draft.imageDigest, imageDigest);
  assert.equal(draft.runtimeImage, "pi-web-skill-runtime:release-test");
  assert.equal(draft.lockfileDigest, lockfileDigest);
  assert.equal(draft.runtimeProfile, "node22-python3");
  assert.equal(draft.buildError, null);

  const building = store.updateTenantSkillBuild(context, draft.id, { status: "building" });
  assert.equal(building.buildStatus, "building");
  assert.ok(building.buildStartedAt);
  const ready = store.updateTenantSkillBuild(context, draft.id, {
    status: "ready",
    completedAt: "2026-09-28T00:00:00.000Z",
  });
  assert.equal(ready.buildStatus, "ready");
  assert.equal(ready.buildCompletedAt, "2026-09-28T00:00:00.000Z");
  assert.equal(ready.contentDigest, "content-digest");
  assert.equal(ready.releaseDigest, "content-digest");
  assert.throws(() => store.updateTenantSkillBuild(context, draft.id, {
    status: "failed", imageDigest: "sha256:bad",
  }), /sha256 digest/);

  const declarative = store.createTenantSkillDraft(context, {
    slug: "declarative-helper",
    name: "Declarative Helper",
    description: "No execution runtime",
    contentDigest: "declarative-content",
    storagePath: "/tmp/declarative-helper",
    manifest: { declarative: true },
  });
  assert.equal(declarative.buildStatus, "ready");
});

test("tenant administrators can resume a suspended ready Skill release", (t) => {
  const store = createStore(t);
  const created = store.createTenantWithOwner({
    tenant: { name: "Resumable Skills", slug: "resumable-skills" },
    owner: { email: "owner@resumable-skills.test", displayName: "Owner" },
  });
  const context = { tenantId: created.tenant.id, membershipId: created.membership.id };
  const draft = store.createTenantSkillDraft(context, {
    slug: "biography-book-assembler",
    name: "Biography Book Assembler",
    description: "Assembles approved chapters",
    contentDigest: "biography-content",
    storagePath: "/tmp/biography-book-assembler",
    manifest: { declarative: true },
  });
  const published = store.activatePersonalDeclarativeSkill(context, draft.id);
  assert.equal(published.status, "published");
  const suspended = store.suspendTenantSkill(context, draft.id);
  assert.equal(suspended.status, "suspended");
  const resumed = store.resumeTenantSkill(context, draft.id);
  assert.equal(resumed.status, "published");
  assert.ok(resumed.publishedAt);
});

test("Skill deletion archives the release and enforces ownership", (t) => {
  const store = createStore(t);
  const created = store.createTenantWithOwner({
    tenant: { name: "Delete Skills", slug: "delete-skills" },
    owner: { email: "owner@delete-skills.test", displayName: "Owner" },
  });
  const context = { tenantId: created.tenant.id, membershipId: created.membership.id };
  const draft = store.createTenantSkillDraft(context, {
    slug: "removable", name: "Removable", description: "Delete me",
    contentDigest: "removable-content", storagePath: "/tmp/removable", manifest: { declarative: true },
  });
  const archived = store.archiveTenantSkill(context, draft.id);
  assert.equal(archived.status, "archived");
  assert.equal(store.listTenantSkills(context).length, 0);
  assert.equal(store.getTenantSkill(context.tenantId, draft.id)?.status, "archived");
  assert.throws(() => store.archiveTenantSkill(context, draft.id), /Skill release not found/);
});

test("repairs a database that recorded schema version 9 before runtime columns were added", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-runtime-migration-"));
  const path = join(root, "tenant.sqlite");
  const initial = new TenantStore(path);
  const created = initial.createTenantWithOwner({
    tenant: { name: "Migration Skills", slug: "migration-skills" },
    owner: { email: "owner@migration-skills.test", displayName: "Owner" },
  });
  const draft = initial.createTenantSkillDraft(
    { tenantId: created.tenant.id, membershipId: created.membership.id },
    {
      slug: "declarative-helper", name: "Declarative Helper", description: "No runtime",
      contentDigest: "migration-content", storagePath: "/tmp/migration-helper", manifest: { declarative: true },
    },
  );
  const executable = initial.createTenantSkillDraft(
    { tenantId: created.tenant.id, membershipId: created.membership.id },
    {
      slug: "biography-book-assembler", name: "Biography Book Assembler", description: "Needs a reviewed runtime",
      contentDigest: "migration-executable", storagePath: "/tmp/migration-biography", manifest: { declarative: false },
    },
  );
  initial.close();

  // Simulate the released version-9 migration that recorded the version but
  // did not add the runtime columns. SQLite keeps the release row intact.
  const legacy = new DatabaseSync(path);
  for (const column of ["image_digest", "runtime_image", "lockfile_digest", "runtime_profile", "build_status", "build_error", "build_started_at", "build_completed_at"]) {
    legacy.exec(`ALTER TABLE tenant_skills DROP COLUMN ${column}`);
  }
  legacy.prepare("UPDATE tenant_skills SET status = 'published' WHERE id = ?").run(executable.id);
  legacy.exec("PRAGMA user_version = 9");
  legacy.close();

  const repaired = new TenantStore(path);
  t.after(() => {
    repaired.close();
    rmSync(root, { recursive: true, force: true });
  });
  // The public mapping is enough to prove all columns were restored; a
  // declarative release should be immediately runnable after repair.
  const restored = repaired.getTenantSkill(created.tenant.id, draft.id);
  assert.equal(restored?.buildStatus, "ready");
  assert.equal(restored?.imageDigest, null);
  assert.equal(restored?.runtimeImage, null);
  assert.equal(restored?.runtimeProfile, null);
  assert.equal(restored?.lockfileDigest, null);
  assert.equal(repaired.getTenantSkill(created.tenant.id, executable.id)?.buildStatus, "pending");
});

test("refreshes the preserved global store when runtime columns are missing", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-runtime-hot-reload-"));
  const path = join(root, "tenant.sqlite");
  const previousPath = process.env.PI_WEB_DATABASE_PATH;
  process.env.PI_WEB_DATABASE_PATH = path;
  closeTenantStore();
  const initial = getTenantStore();
  initial.createTenantWithOwner({
    tenant: { name: "Hot reload", slug: "hot-reload" },
    owner: { email: "owner@hot-reload.test", displayName: "Owner" },
  });

  // Simulate a development process that retained a connection after a
  // version bump, before the runtime ALTER TABLE statements were installed.
  const legacy = new DatabaseSync(path);
  for (const column of ["image_digest", "runtime_image", "lockfile_digest", "runtime_profile", "build_status", "build_error", "build_started_at", "build_completed_at"]) {
    legacy.exec(`ALTER TABLE tenant_skills DROP COLUMN ${column}`);
  }
  legacy.exec(`PRAGMA user_version = ${TENANT_SCHEMA_VERSION}`);
  legacy.close();

  const refreshed = getTenantStore();
  t.after(() => {
    closeTenantStore();
    if (previousPath === undefined) delete process.env.PI_WEB_DATABASE_PATH;
    else process.env.PI_WEB_DATABASE_PATH = previousPath;
    rmSync(root, { recursive: true, force: true });
  });
  assert.notEqual(refreshed, initial);
  assert.equal(refreshed.hasTenantSkillRuntimeColumns(), true);
  assert.equal(typeof refreshed.resumeTenantSkill, "function");
});
