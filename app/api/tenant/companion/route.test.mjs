import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";
import { NextRequest } from "next/server.js";

const root = mkdtempSync(join(tmpdir(), "pi-web-companion-governance-route-"));
const originalDatabasePath = process.env.PI_WEB_DATABASE_PATH;
process.env.PI_WEB_DATABASE_PATH = join(root, "tenant.sqlite");
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const { GET, POST } = await jiti.import("./route.ts");
const { PATCH: reviewConsent } = await jiti.import("../../../companion/understanding/route.ts");
const { acceptTenantInvitation, setupTenantOwner, TENANT_SESSION_COOKIE } = await jiti.import("../../../../lib/tenant-auth.ts");
const { closeTenantStore, getTenantStore } = await jiti.import("../../../../lib/tenant-store.ts");

const owner = await setupTenantOwner({ tenantName: "Quality", tenantSlug: "quality", displayName: "Owner", email: "owner@quality.test", password: "correct horse battery staple" });
const store = getTenantStore();
const ownerContext = { tenantId: owner.session.tenant.id, membershipId: owner.session.membership.id };
const inviteToken = "member-quality-token";
store.createInvitation(ownerContext, { email: "member@quality.test", role: "member", tokenHash: createHash("sha256").update(inviteToken).digest("hex"), expiresAt: new Date(Date.now() + 60_000).toISOString() });
const member = await acceptTenantInvitation({ token: inviteToken, displayName: "Member", password: "correct horse battery staple" });

function request(method, token, body) {
  return new NextRequest("http://localhost/api/tenant/companion", {
    method, headers: { Cookie: `${TENANT_SESSION_COOKIE}=${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}

after(() => {
  closeTenantStore();
  if (originalDatabasePath === undefined) delete process.env.PI_WEB_DATABASE_PATH;
  else process.env.PI_WEB_DATABASE_PATH = originalDatabasePath;
  rmSync(root, { recursive: true, force: true });
});

test("governance API denies members while consent remains a member-owned independent choice", async () => {
  assert.equal((await GET(request("GET", member.token))).status, 403);
  const consent = await reviewConsent(request("PATCH", member.token, { action: "set_review_consent", enabled: true, tenantId: "ignored" }));
  assert.equal(consent.status, 200);
  assert.equal((await consent.json()).reviewConsent.enabled, true);

  const config = store.ensureCompanionConfig(ownerContext);
  const sampled = await POST(request("POST", owner.token, {
    action: "sample", tenantId: "ignored", membershipId: member.session.membership.id, configVersionId: config.id,
    messages: [{ entryId: "entry-1", role: "user", text: "今天想说说散步。" }],
  }));
  assert.equal(sampled.status, 400, "administrators cannot forge review evidence through the public route");
  store.createCompanionQualitySample(ownerContext, {
    membershipId: member.session.membership.id,
    configVersionId: config.id,
    messages: [{ entryId: "entry-1", role: "user", text: "今天想说说散步。" }],
  });
  assert.equal((await GET(request("GET", owner.token))).status, 200);
});
