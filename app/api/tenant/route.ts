import { NextResponse } from "next/server";
import { createHash, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { getTenantStore } from "@/lib/tenant-store";
import { requireTenantSession, TenantAuthenticationError } from "@/lib/tenant-auth";

export const dynamic = "force-dynamic";

function localIpv4(): string | undefined {
  const virtualInterface = /docker|wsl|vbox|virtual|vmware|hyper-v|default switch/i;
  const isPrivate = (address: string) => {
    const [a, b] = address.split(".").map(Number);
    return a === 10 || a === 192 && b === 168 || a === 172 && b >= 16 && b <= 31;
  };
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    if (virtualInterface.test(name)) continue;
    const address = addresses?.find((item) => item.family === "IPv4" && !item.internal && isPrivate(item.address));
    if (address) return address.address;
  }
  return undefined;
}

function invitationUrl(request: Request, token: string): string {
  const incoming = new URL(request.url);
  const host = request.headers.get("host") ?? incoming.host;
  const protocol = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const url = new URL(`${protocol === "https" ? "https" : incoming.protocol}//${host}`);
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || isIP(hostname) && (hostname === "127.0.0.1" || hostname === "::1")) {
    const address = localIpv4();
    if (address) url.hostname = address;
  }
  const invite = new URL("/login", url);
  invite.searchParams.set("invite", token);
  return invite.toString();
}

export async function GET(request: Request) {
  try {
    const session = requireTenantSession(request);
    const context = { tenantId: session.tenant.id, membershipId: session.membership.id };
    const canManage = session.membership.role === "owner" || session.membership.role === "admin";
    return NextResponse.json({
      tenant: {
        id: session.tenant.id,
        name: session.tenant.name,
        slug: session.tenant.slug,
        planCode: session.tenant.planCode,
        seatLimit: session.tenant.seatLimit,
      },
      currentMembership: {
        id: session.membership.id,
        role: session.membership.role,
      },
      members: canManage
        ? getTenantStore().listTenantMembers(session.tenant.id)
        : getTenantStore().listTenantMembers(session.tenant.id).filter((member) => member.membershipId === session.membership.id),
      organizations: canManage ? getTenantStore().listUserTenants(session.user.id) : [],
      invitations: canManage ? getTenantStore().listPendingInvitations(context) : [],
      canManage,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const status = error instanceof TenantAuthenticationError ? error.status : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load tenant" }, { status });
  }
}

export async function POST(request: Request) {
  try {
    const session = requireTenantSession(request);
    const body = await request.json() as { email?: unknown; role?: unknown };
    const token = randomBytes(32).toString("base64url");
    const invitation = getTenantStore().createInvitation(
      { tenantId: session.tenant.id, membershipId: session.membership.id },
      {
        email: String(body.email ?? ""),
        role: String(body.role ?? "member") as "owner" | "admin" | "member",
        tokenHash: createHash("sha256").update(token, "utf8").digest("hex"),
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      },
    );
    return NextResponse.json({ invitation, token, invitationUrl: invitationUrl(request, token) }, { status: 201 });
  } catch (error) {
    const status = error instanceof TenantAuthenticationError ? error.status : 400;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to create invitation" }, { status });
  }
}

export async function PATCH(request: Request) {
  try {
    const session = requireTenantSession(request);
    const body = await request.json() as { membershipId?: unknown; role?: unknown };
    const membership = getTenantStore().updateMembershipRole(
      { tenantId: session.tenant.id, membershipId: session.membership.id },
      String(body.membershipId ?? ""),
      String(body.role ?? "") as "owner" | "admin" | "member",
    );
    return NextResponse.json({ membership });
  } catch (error) {
    const status = error instanceof TenantAuthenticationError ? error.status : 400;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to update member" }, { status });
  }
}

export async function DELETE(request: Request) {
  try {
    const session = requireTenantSession(request);
    const invitationId = new URL(request.url).searchParams.get("invitationId") ?? "";
    getTenantStore().revokeInvitation(
      { tenantId: session.tenant.id, membershipId: session.membership.id },
      invitationId,
    );
    return NextResponse.json({ ok: true });
  } catch (error) {
    const status = error instanceof TenantAuthenticationError ? error.status : 400;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to revoke invitation" }, { status });
  }
}
