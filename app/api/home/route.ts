import { NextResponse } from "next/server";
import { homedir } from "os";
import { canManageHostConfiguration, requireTenantSession } from "@/lib/tenant-auth";
import { VIRTUAL_WORKSPACE_ROOT } from "@/lib/tenant-workspace";

export async function GET(request: Request) {
  const session = requireTenantSession(request);
  return NextResponse.json({ home: canManageHostConfiguration(session) ? homedir() : VIRTUAL_WORKSPACE_ROOT });
}
