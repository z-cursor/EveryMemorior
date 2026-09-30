import { NextResponse } from "next/server";
import { requireTenantSession, TenantAuthenticationError } from "@/lib/tenant-auth";
import { deleteTenantSkill, listTenantSkillReleases, queueTenantSkillRuntimeBuild, transitionTenantSkill, uploadTenantSkill, TenantSkillUploadError } from "@/lib/tenant-skills";
import { getRpcSessions } from "@/lib/rpc-manager";
import { getTenantStore } from "@/lib/tenant-store";

export const dynamic = "force-dynamic";

function errorResponse(error: unknown): NextResponse {
  const status = error instanceof TenantAuthenticationError ? error.status
    : error instanceof TenantSkillUploadError ? 400
      : error instanceof Error && /Skill release not found/i.test(error.message) ? 404
      : error instanceof Error && /runtime artifact (?:is not ready|is incompatible|metadata is incomplete)/i.test(error.message) ? 409
        : 500;
  return NextResponse.json({ error: error instanceof Error ? error.message : "Tenant Skill operation failed" }, { status });
}

function invalidateTenantSkillSessions(tenantId: string): void {
  const store = getTenantStore();
  for (const session of getRpcSessions()) {
    const binding = store.getAgentSessionExecution(session.sessionId);
    if (binding?.tenantId !== tenantId) continue;
    if (typeof session.markTenantSkillsStale === "function") session.markTenantSkillsStale();
    else if (!session.isRunning()) void session.shutdown();
  }
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
      const skill = await uploadTenantSkill(session, new Uint8Array(await file.arrayBuffer()));
      if (skill.status === "published") invalidateTenantSkillSessions(session.tenant.id);
      return NextResponse.json({ skill }, { status: 201 });
    }
    const body = await req.json() as { action?: unknown; skillId?: unknown };
    if (!(["submit", "publish", "suspend", "resume", "retry", "build"] as unknown[]).includes(body.action) || typeof body.skillId !== "string") {
      return NextResponse.json({ error: "action and skillId are required" }, { status: 400 });
    }
    const action = body.action as "submit" | "publish" | "suspend" | "resume" | "retry" | "build";
    const skill = transitionTenantSkill(session, action, body.skillId);
    // Start the reviewed runtime build as soon as a release enters review.
    // The request only records the transition; the Docker build continues in
    // the background and publication remains blocked until it is ready.
    if ((action === "submit" || action === "build" || action === "retry") && skill.buildStatus !== "ready") {
      queueTenantSkillRuntimeBuild(session, skill, () => invalidateTenantSkillSessions(session.tenant.id));
    }
    if (action === "publish" || action === "suspend" || action === "resume") invalidateTenantSkillSessions(session.tenant.id);
    return NextResponse.json({ skill });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(req: Request) {
  try {
    const session = requireTenantSession(req);
    const skillId = new URL(req.url).searchParams.get("skillId")?.trim();
    if (!skillId) return NextResponse.json({ error: "skillId is required" }, { status: 400 });
    const skill = await deleteTenantSkill(session, skillId);
    invalidateTenantSkillSessions(session.tenant.id);
    return NextResponse.json({ skill });
  } catch (error) {
    return errorResponse(error);
  }
}
