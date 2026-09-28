import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { TENANT_SCHEMA_VERSION, TenantStore } = await jiti.import("./tenant-store.ts");

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
  assert.equal(store.ensureWorkspace(context, { name: "Restored", rootPath: workspace.rootPath }).id, workspace.id);
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
  ), /FOREIGN KEY constraint failed/);

  assert.throws(() => store.createWorkspace(
    { tenantId: second.tenant.id, membershipId: second.membership.id },
    { name: "Same host path", slug: "same-path", rootPath: "D:/CODE/FIRST" },
  ), /UNIQUE constraint failed/);
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
