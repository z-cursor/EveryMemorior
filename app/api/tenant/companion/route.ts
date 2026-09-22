import { NextResponse } from "next/server";
import { requireTenantSession, TenantAuthenticationError } from "@/lib/tenant-auth";
import { getTenantStore } from "@/lib/tenant-store";

export const dynamic = "force-dynamic";

function admin(request: Request) {
  const auth = requireTenantSession(request);
  if (auth.membership.role === "member") throw new TenantAuthenticationError("Owner or admin access required", 403);
  return auth;
}
export async function GET(request: Request) {
  try {
    const auth = admin(request);
    const store = getTenantStore();
    return NextResponse.json({ configs: store.listCompanionConfigVersions({ tenantId: auth.tenant.id, membershipId: auth.membership.id }) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = error instanceof TenantAuthenticationError ? error.status : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load companion configuration" }, { status });
  }
}

export async function POST(request: Request) {
  try {
    const auth = admin(request);
    const store = getTenantStore();
    const context = { tenantId: auth.tenant.id, membershipId: auth.membership.id };
    const body = await request.json() as Record<string, unknown>;
    if (body.action === "draft") {
      return NextResponse.json({ config: store.createCompanionConfigDraft(context, {
        behaviorDocument: String(body.behaviorDocument ?? ""), modelProvider: String(body.modelProvider ?? "qwen"), modelId: String(body.modelId ?? "FY-Qwen3.8-27B-NVFP4"),
        thinkingLevel: String(body.thinkingLevel ?? "off"), temperature: Number(body.temperature ?? 0.2), maxOutputTokens: Number(body.maxOutputTokens ?? 600),
      }) }, { status: 201 });
    }
    if (body.action === "publish" && typeof body.configVersionId === "string") return NextResponse.json({ config: store.publishCompanionConfig(context, body.configVersionId) });
    if (body.action === "migrate" && typeof body.membershipId === "string" && typeof body.configVersionId === "string") return NextResponse.json({ assignment: store.migrateCompanionAssignment(context, body.membershipId, body.configVersionId) });
    return NextResponse.json({ error: "Unsupported companion configuration action" }, { status: 400 });
  } catch (error) {
    const status = error instanceof TenantAuthenticationError ? error.status : 400;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to change companion configuration" }, { status });
  }
}
