import { NextResponse } from "next/server";
import { requireTenantSession, TenantAuthenticationError } from "@/lib/tenant-auth";
import { getTenantStore } from "@/lib/tenant-store";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const auth = requireTenantSession(request);
    const latest = getTenantStore().listCompanionTurns({ tenantId: auth.tenant.id, membershipId: auth.membership.id }, 1)[0];
    return NextResponse.json({ hasConversation: Boolean(latest), modified: latest?.createdAt ?? null }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof TenantAuthenticationError ? error.message : "Unable to load conversation" }, {
      status: error instanceof TenantAuthenticationError ? error.status : 500,
    });
  }
}
