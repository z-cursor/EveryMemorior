import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const root = mkdtempSync(join(tmpdir(), "pi-web-tenant-runtime-"));
const originalDatabasePath = process.env.PI_WEB_DATABASE_PATH;
process.env.PI_WEB_DATABASE_PATH = join(root, "tenant.sqlite");
const jiti = createJiti(import.meta.url, { moduleCache: false });
const { setupTenantOwner, TENANT_SESSION_COOKIE } = await jiti.import("./tenant-auth.ts");
const {
  authorizeAgentSessionRequest,
  bindNewAgentSessionToRequest,
  closeAgentSandbox,
  tenantWorkspaceRootsForRequest,
} = await jiti.import("./tenant-agent-runtime.ts");
const { createProjectCommandBashOperations } = await jiti.import("./project-command-env.ts");
const { closeTenantStore, getTenantStore } = await jiti.import("./tenant-store.ts");

const workspacePath = join(root, "workspace");
const ownerAuth = await setupTenantOwner({
  tenantName: "First", tenantSlug: "first", displayName: "Owner",
  email: "owner@first.test", password: "correct horse battery staple",
});
const ownerRequest = new Request("http://localhost", {
  headers: { Cookie: `${TENANT_SESSION_COOKIE}=${ownerAuth.token}` },
});

after(() => {
  closeTenantStore();
  if (originalDatabasePath === undefined) delete process.env.PI_WEB_DATABASE_PATH;
  else process.env.PI_WEB_DATABASE_PATH = originalDatabasePath;
  rmSync(root, { recursive: true, force: true });
});

test("new Agent sessions expose only their tenant workspace roots", () => {
  bindNewAgentSessionToRequest(ownerRequest, "agent-owned", workspacePath);
  assert.deepEqual(tenantWorkspaceRootsForRequest(ownerRequest), [workspacePath]);
  assert.doesNotThrow(() => authorizeAgentSessionRequest(ownerRequest, "agent-owned"));
});

test("a tenant cannot access another tenant's Agent binding", () => {
  const store = getTenantStore();
  const second = store.createTenantWithOwner({
    tenant: { name: "Second", slug: "second" },
    owner: { email: "owner@second.test", displayName: "Second Owner" },
  });
  const workspace = store.createWorkspace(
    { tenantId: second.tenant.id, membershipId: second.membership.id },
    { name: "Second", slug: "second", rootPath: join(root, "second-workspace") },
  );
  store.bindAgentSession(
    { tenantId: second.tenant.id, membershipId: second.membership.id },
    workspace.id,
    "agent-other-tenant",
  );

  assert.throws(
    () => authorizeAgentSessionRequest(ownerRequest, "agent-other-tenant"),
    /belongs to another tenant/,
  );
});

test("Work-mode Bash operations execute in the bound Agent container", { skip: process.env.PI_WEB_DOCKER_TEST !== "1" }, async () => {
  mkdirSync(workspacePath, { recursive: true });
  const agentSessionId = "agent-work-sandbox-proof";
  bindNewAgentSessionToRequest(ownerRequest, agentSessionId, workspacePath);
  let output = "";
  try {
    const result = await createProjectCommandBashOperations({ agentSessionId }).exec(
      "printf '%s|%s|' \"$PI_WEB_SANDBOX\" \"$PWD\"; test ! -e /var/run/docker.sock && printf socket-absent",
      workspacePath,
      { onData: (chunk) => { output += chunk.toString(); } },
    );
    assert.equal(result.exitCode, 0);
    assert.equal(output, "1|/workspace|socket-absent");
  } finally {
    await closeAgentSandbox(agentSessionId);
  }
});
