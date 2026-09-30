import { NextResponse } from "next/server";
import { requireTenantSession } from "@/lib/tenant-auth";
import { VIRTUAL_WORKSPACE_ROOT } from "@/lib/tenant-workspace";

export async function GET(request: Request) {
  requireTenantSession(request);
  return NextResponse.json({ home: VIRTUAL_WORKSPACE_ROOT });
}
