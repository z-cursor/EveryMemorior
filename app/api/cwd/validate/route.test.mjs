import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const databaseRoot = mkdtempSync(path.join(os.tmpdir(), "pi-web-cwd-auth-"));
const previousDatabase = process.env.PI_WEB_DATABASE_PATH;
process.env.PI_WEB_DATABASE_PATH = path.join(databaseRoot, "tenant.sqlite");
const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { POST } = await jiti.import("./route.ts");
const { projectIdentityKey } = await jiti.import("../../../../lib/project-identity.ts");
const { setupTenantOwner, TENANT_SESSION_COOKIE } = await jiti.import("../../../../lib/tenant-auth.ts");
const { closeTenantStore } = await jiti.import("../../../../lib/tenant-store.ts");
const owner = await setupTenantOwner({
  tenantName: "First", tenantSlug: "first", displayName: "Owner",
  email: "owner@first.test", password: "correct horse battery staple",
});
after(() => {
  closeTenantStore();
  if (previousDatabase === undefined) delete process.env.PI_WEB_DATABASE_PATH;
  else process.env.PI_WEB_DATABASE_PATH = previousDatabase;
  rmSync(databaseRoot, { recursive: true, force: true });
});

test("validated cwd responses include server-resolved project identity", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-web-cwd-validate-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));

  const response = await POST(new Request("http://localhost/api/cwd/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: `${TENANT_SESSION_COOKIE}=${owner.token}` },
    body: JSON.stringify({ cwd }),
  }));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    success: true,
    cwd,
    projectRoot: cwd,
    projectKey: projectIdentityKey(cwd),
  });
});
