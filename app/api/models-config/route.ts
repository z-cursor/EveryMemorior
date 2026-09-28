import { NextResponse } from "next/server";
import { readModelsConfig, writeModelsConfig } from "@/lib/models-config-store";
import { hasHostConfigurationAccess } from "@/lib/tenant-auth";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!hasHostConfigurationAccess(req)) return NextResponse.json({ error: "Model configuration is unavailable to this account" }, { status: 403 });
  return NextResponse.json(readModelsConfig());
}

export async function PUT(req: Request) {
  if (!hasHostConfigurationAccess(req)) return NextResponse.json({ error: "Model configuration is unavailable to this account" }, { status: 403 });
  try {
    const body = await req.json() as Record<string, unknown>;
    writeModelsConfig(body);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
