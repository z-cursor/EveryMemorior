import { NextResponse } from "next/server";
import { requireTenantSession, TenantAuthenticationError } from "@/lib/tenant-auth";
import { listTenantSkillReleases, transitionTenantSkill, uploadTenantSkill, TenantSkillUploadError } from "@/lib/tenant-skills";

export const dynamic = "force-dynamic";

function errorResponse(error: unknown): NextResponse {
  const status = error instanceof TenantAuthenticationError ? error.status : error instanceof TenantSkillUploadError ? 400 : 500;
  return NextResponse.json({ error: error instanceof Error ? error.message : "Tenant Skill operation failed" }, { status });
}

export async function GET(req: Request) {
  try {
    const session = requireTenantSession(req);
    const governance = new URL(req.url).searchParams.get("view") === "governance";
    if (governance && session.membership.role === "member") {
      return NextResponse.json({ error: "Owner or admin access required" }, { status: 403 });
    }
    return NextResponse.json({ skills: listTenantSkillReleases(session, governance) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(req: Request) {
  try {
    const session = requireTenantSession(req);
    const contentType = req.headers.get("content-type") ?? "";
    if (contentType.startsWith("multipart/form-data")) {
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) return NextResponse.json({ error: "file is required" }, { status: 400 });
      return NextResponse.json({ skill: await uploadTenantSkill(session, new Uint8Array(await file.arrayBuffer())) }, { status: 201 });
    }
    const body = await req.json() as { action?: unknown; skillId?: unknown };
    if (!(["submit", "publish", "suspend"] as unknown[]).includes(body.action) || typeof body.skillId !== "string") {
      return NextResponse.json({ error: "action and skillId are required" }, { status: 400 });
    }
    return NextResponse.json({ skill: transitionTenantSkill(session, body.action as "submit" | "publish" | "suspend", body.skillId) });
  } catch (error) {
    return errorResponse(error);
  }
}
