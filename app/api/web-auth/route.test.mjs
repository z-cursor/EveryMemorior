import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import test, { after } from "node:test";
import { createJiti } from "jiti";
import { NextRequest } from "next/server.js";

const root = mkdtempSync(join(tmpdir(), "pi-web-auth-route-"));
const originalDatabasePath = process.env.PI_WEB_DATABASE_PATH;
process.env.PI_WEB_DATABASE_PATH = join(root, "tenant.sqlite");
const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false,
});
const { GET, POST, DELETE } = await jiti.import("./route.ts");
const { closeTenantStore, getTenantStore } = await jiti.import("../../../lib/tenant-store.ts");

after(() => {
  closeTenantStore();
  if (originalDatabasePath === undefined) delete process.env.PI_WEB_DATABASE_PATH;
  else process.env.PI_WEB_DATABASE_PATH = originalDatabasePath;
  rmSync(root, { recursive: true, force: true });
});

function request(method, body, headers = {}) {
  return new NextRequest("http://localhost/api/web-auth", {
    method,
    headers: {
      Host: "localhost", Origin: "http://localhost", "Sec-Fetch-Site": "same-origin",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

let sessionCookie;

test("first use creates the tenant owner and signs in", async () => {
  const initial = await GET(request("GET"));
  assert.equal((await initial.json()).setupRequired, true);

  const response = await POST(request("POST", {
    action: "setup", tenantName: "Acme AI", tenantSlug: "acme-ai",
    displayName: "Owner", email: "owner@example.com",
    password: "correct horse battery staple",
  }));
  assert.equal(response.status, 200);
  sessionCookie = response.headers.get("set-cookie").split(";", 1)[0];
  assert.match(sessionCookie, /^pi_web_tenant_session=/);
  assert.match(response.headers.get("set-cookie"), /HttpOnly/i);
  assert.match(response.headers.get("set-cookie"), /SameSite=strict/i);

  const authenticated = await GET(request("GET", undefined, { Cookie: sessionCookie }));
  const body = await authenticated.json();
  assert.equal(body.authenticated, true);
  assert.equal(body.account.user.displayName, "Owner");
  assert.equal(body.account.tenant.slug, "acme-ai");
});

test("login verifies the stored password", async () => {
  assert.equal((await POST(request("POST", {
    action: "login", email: "owner@example.com", password: "wrong-password",
  }))).status, 401);
  assert.equal((await POST(request("POST", {
    action: "login", email: "owner@example.com", password: "correct horse battery staple",
  }))).status, 200);
});

test("users explicitly choose, create, and switch organizations", async () => {
  const created = await POST(request("POST", {
    action: "create-organization", tenantName: "Second Org", tenantSlug: "second-org",
  }, { Cookie: sessionCookie }));
  assert.equal(created.status, 200);
  const createdBody = await created.json();
  assert.equal(createdBody.account.tenant.slug, "second-org");
  const secondCookie = created.headers.get("set-cookie").split(";", 1)[0];

  const optionsResponse = await POST(request("POST", {
    action: "login-options", email: "owner@example.com", password: "correct horse battery staple",
  }));
  assert.equal(optionsResponse.status, 200);
  const optionsBody = await optionsResponse.json();
  assert.deepEqual(optionsBody.organizations.map((item) => item.tenantSlug).sort(), ["acme-ai", "second-org"]);

  const ambiguous = await POST(request("POST", {
    action: "login", email: "owner@example.com", password: "correct horse battery staple",
  }));
  assert.equal(ambiguous.status, 409);
  const choices = await ambiguous.json();
  assert.deepEqual(choices.organizations.map((item) => item.tenantSlug).sort(), ["acme-ai", "second-org"]);

  const originalTenantId = choices.organizations.find((item) => item.tenantSlug === "acme-ai").tenantId;
  const switched = await POST(request("POST", {
    action: "switch-organization", tenantId: originalTenantId,
  }, { Cookie: secondCookie }));
  assert.equal(switched.status, 200);
  assert.equal((await switched.json()).account.tenant.slug, "acme-ai");
});

test("an existing user must confirm their password when accepting an invitation", async () => {
  const store = getTenantStore();
  const third = store.createTenantWithOwner({
    tenant: { name: "Third Org", slug: "third-org" },
    owner: { email: "third-owner@example.com", displayName: "Third Owner" },
  });
  const rawToken = "invite-existing-user-token";
  store.createInvitation(
    { tenantId: third.tenant.id, membershipId: third.membership.id },
    {
      email: "owner@example.com", role: "admin",
      tokenHash: createHash("sha256").update(rawToken).digest("hex"),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  );
  assert.equal((await POST(request("POST", {
    action: "accept-invitation", token: rawToken, password: "wrong-password",
  }))).status, 401);
  const accepted = await POST(request("POST", {
    action: "accept-invitation", token: rawToken, password: "correct horse battery staple",
  }));
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).account.tenant.slug, "third-org");
});

test("logout revokes and clears the tenant session", async () => {
  const response = await DELETE(request("DELETE", undefined, { Cookie: sessionCookie }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie"), /pi_web_tenant_session=;/);
  assert.match(response.headers.get("set-cookie"), /Max-Age=0/i);
  const state = await GET(request("GET", undefined, { Cookie: sessionCookie }));
  assert.equal((await state.json()).authenticated, false);
});

test("rejects cross-origin login attempts", async () => {
  const response = await POST(request(
    "POST",
    { action: "login", email: "owner@example.com", password: "correct horse battery staple" },
    { Origin: "https://attacker.example", "Sec-Fetch-Site": "cross-site" },
  ));
  assert.equal(response.status, 403);
});
