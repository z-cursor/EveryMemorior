import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";
import { NextRequest } from "next/server.js";

const databaseRoot = mkdtempSync(path.join(os.tmpdir(), "pi-web-cwd-auth-"));
const previousDatabase = process.env.PI_WEB_DATABASE_PATH;
process.env.PI_WEB_DATABASE_PATH = path.join(databaseRoot, "tenant.sqlite");
const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { POST } = await jiti.import("./route.ts");
const { POST: defaultCwd } = await jiti.import("../../default-cwd/route.ts");
const { GET: getFiles } = await jiti.import("../../files/[...path]/route.ts");
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

test("validated host cwd can be browsed immediately", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-web-cwd-browse-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));

  const cookie = `${TENANT_SESSION_COOKIE}=${owner.token}`;
  const response = await POST(new Request("http://localhost/api/cwd/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ cwd }),
  }));
  assert.equal(response.status, 200);

  const listed = await getFiles(new NextRequest(`http://localhost/api/files${cwd}?type=list`, {
    headers: { Cookie: cookie },
  }), { params: Promise.resolve({ path: [cwd] }) });
  assert.equal(listed.status, 200);
});

test("default host cwd can be browsed immediately", async (t) => {
  const cookie = `${TENANT_SESSION_COOKIE}=${owner.token}`;
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const expectedCwd = path.join(os.homedir(), `pi-cwd-${date}`);
  const existedBefore = existsSync(expectedCwd);
  t.after(() => {
    if (!existedBefore) rmSync(expectedCwd, { recursive: true, force: true });
  });
  const response = await defaultCwd(new Request("http://localhost/api/default-cwd", {
    method: "POST",
    headers: { Cookie: cookie },
  }));
  assert.equal(response.status, 200);
  const { cwd } = await response.json();
  assert.equal(cwd, expectedCwd);

  const listed = await getFiles(new NextRequest(`http://localhost/api/files${cwd}?type=list`, {
    headers: { Cookie: cookie },
  }), { params: Promise.resolve({ path: [cwd] }) });
  assert.equal(listed.status, 200);
});
