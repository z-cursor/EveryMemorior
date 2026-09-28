import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { normalizeTenantOverview, readTenantJsonResponse } = await jiti.import("./tenant-overview.ts");

test("normalizes a legacy tenant response before the settings page maps collections", () => {
  const overview = normalizeTenantOverview({
    tenant: { id: "tenant-1", name: "Acme", slug: "acme", planCode: "team", seatLimit: null },
    currentMembership: { id: "membership-1", role: "owner" },
    members: [],
  });

  assert.deepEqual(overview.organizations, [{
    membershipId: "membership-1",
    tenantId: "tenant-1",
    tenantName: "Acme",
    tenantSlug: "acme",
    role: "owner",
    status: "active",
  }]);
  assert.deepEqual(overview.invitations, []);
  assert.equal(overview.canManage, true);
  assert.doesNotThrow(() => overview.organizations.map((item) => item.tenantName));
});

test("reports an empty non-JSON tenant response by HTTP status", async () => {
  await assert.rejects(
    () => readTenantJsonResponse(new Response(null, { status: 405 })),
    /Tenant request failed \(HTTP 405\): empty or invalid JSON response/,
  );
});
