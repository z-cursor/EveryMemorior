import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";
import { NextRequest } from "next/server.js";

const root = mkdtempSync(join(tmpdir(), "pi-web-proxy-"));
const originalDatabasePath = process.env.PI_WEB_DATABASE_PATH;
process.env.PI_WEB_DATABASE_PATH = join(root, "tenant.sqlite");
const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false,
});
const { proxy } = await jiti.import("../proxy.ts");
const { createTenantOrganization, setupTenantOwner, TENANT_SESSION_COOKIE } = await jiti.import("./tenant-auth.ts");
const { closeTenantStore } = await jiti.import("./tenant-store.ts");
const setup = await setupTenantOwner({
  tenantName: "Proxy Test", tenantSlug: "proxy-test", displayName: "Owner",
  email: "owner@proxy.test", password: "correct horse battery staple",
});
const { token } = setup;
const secondary = createTenantOrganization(setup.session, { name: "Secondary", slug: "secondary" });

after(() => {
  closeTenantStore();
  if (originalDatabasePath === undefined) delete process.env.PI_WEB_DATABASE_PATH;
  else process.env.PI_WEB_DATABASE_PATH = originalDatabasePath;
  rmSync(root, { recursive: true, force: true });
});

function request(path, headers = {}) {
  return new NextRequest(`http://localhost${path}`, { headers: { Host: "localhost", ...headers } });
}

test("redirects page navigation to login and preserves the requested URL", () => {
  const response = proxy(request("/?session=abc"));
  assert.equal(response.status, 307);
  assert.equal(response.headers.get("location"), "http://localhost/login?next=%2F%3Fsession%3Dabc");
});

test("accepts a current tenant session for pages and APIs", () => {
  const headers = { Cookie: `${TENANT_SESSION_COOKIE}=${token}` };
  assert.equal(proxy(request("/", headers)).status, 200);
  assert.equal(proxy(request("/api/sessions", headers)).status, 200);
});

test("only the installation owner can access host resources", () => {
  assert.equal(proxy(request("/api/models-config", { Cookie: `${TENANT_SESSION_COOKIE}=${token}` })).status, 200);
  assert.equal(proxy(request("/api/models-config", { Cookie: `${TENANT_SESSION_COOKIE}=${secondary.token}` })).status, 403);
  assert.equal(proxy(request("/api/terminal", { Cookie: `${TENANT_SESSION_COOKIE}=${secondary.token}` })).status, 403);
  assert.equal(proxy(request("/api/worktrees", { Cookie: `${TENANT_SESSION_COOKIE}=${secondary.token}` })).status, 403);
});

test("rejects unauthenticated APIs", () => {
  assert.equal(proxy(request("/api/sessions")).status, 401);
});

test("leaves login and authentication endpoints reachable", () => {
  assert.equal(proxy(request("/login")).status, 200);
  assert.equal(proxy(request("/api/web-auth")).status, 200);
});
