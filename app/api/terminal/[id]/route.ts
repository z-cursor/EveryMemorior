import { NextResponse } from "next/server";
import { getTerminalCwd, getTerminalTenantId, killTerminal, resizeTerminal, writeTerminal } from "@/lib/terminal-manager";
import { canManageHostConfiguration, requireTenantSession } from "@/lib/tenant-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function ownsTerminal(request: Request, id: string): boolean {
  const session = requireTenantSession(request);
  return canManageHostConfiguration(session) && getTerminalTenantId(id) === session.tenant.id;
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!ownsTerminal(req, id)) return NextResponse.json({ error: "Terminal not found" }, { status: 404 });
  const cwd = getTerminalCwd(id);
  return cwd
    ? NextResponse.json({ id, cwd })
    : NextResponse.json({ error: "Terminal expired or closed" }, { status: 404 });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    if (!ownsTerminal(req, id)) return NextResponse.json({ error: "Terminal not found" }, { status: 404 });
    const body = await req.json() as { type?: unknown; data?: unknown; cols?: unknown; rows?: unknown };
    if (body.type === "input" && typeof body.data === "string" && body.data.length <= 64 * 1024) {
      return writeTerminal(id, body.data)
        ? NextResponse.json({ success: true })
        : NextResponse.json({ error: "Terminal not found" }, { status: 404 });
    }
    if (body.type === "resize" && Number.isInteger(body.cols) && Number.isInteger(body.rows)
      && (body.cols as number) >= 2 && (body.cols as number) <= 1000
      && (body.rows as number) >= 2 && (body.rows as number) <= 1000) {
      return resizeTerminal(id, body.cols as number, body.rows as number)
        ? NextResponse.json({ success: true })
        : NextResponse.json({ error: "Terminal not found" }, { status: 404 });
    }
    return NextResponse.json({ error: "Invalid terminal command" }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!ownsTerminal(req, id)) return NextResponse.json({ error: "Terminal not found" }, { status: 404 });
  killTerminal(id);
  return NextResponse.json({ success: true });
}
