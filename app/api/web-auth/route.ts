import { NextRequest, NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import {
  acceptTenantInvitation,
  canManageHostConfiguration,
  createTenantOrganization,
  getTenantLoginOptions,
  loginTenantUser,
  logoutTenantSession,
  resolveTenantSession,
  setupTenantOwner,
  switchTenantOrganization,
  TENANT_SESSION_COOKIE,
  TENANT_SESSION_MAX_AGE,
  TenantAuthenticationError,
  TenantSelectionRequiredError,
  tenantSetupRequired,
} from "@/lib/tenant-auth";

export const dynamic = "force-dynamic";

function isSecureRequest(request: Request): boolean {
  return new URL(request.url).protocol === "https:"
    || request.headers.get("x-forwarded-proto")?.split(",", 1)[0]?.trim() === "https";
}

function publicSession(session: NonNullable<ReturnType<typeof resolveTenantSession>>) {
  return {
    user: {
      id: session.user.id,
      email: session.user.primaryEmail,
      displayName: session.user.displayName,
      avatarUrl: session.user.avatarUrl,
    },
    tenant: {
      id: session.tenant.id,
      name: session.tenant.name,
      slug: session.tenant.slug,
      planCode: session.tenant.planCode,
    },
    membership: { id: session.membership.id, role: session.membership.role },
    hostAccess: canManageHostConfiguration(session),
  };
}

function setSessionCookie(response: NextResponse, request: Request, token: string): void {
  response.cookies.set({
    name: TENANT_SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: "strict",
    secure: isSecureRequest(request),
    path: "/",
    maxAge: TENANT_SESSION_MAX_AGE,
  });
}

function clearSessionCookie(response: NextResponse, request: Request): void {
  response.cookies.set({
    name: TENANT_SESSION_COOKIE,
    value: "",
    httpOnly: true,
    sameSite: "strict",
    secure: isSecureRequest(request),
    path: "/",
    maxAge: 0,
  });
}

export async function GET(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const session = resolveTenantSession(request.cookies.get(TENANT_SESSION_COOKIE)?.value);
  return NextResponse.json({
    enabled: true,
    setupRequired: tenantSetupRequired(),
    authenticated: Boolean(session),
    account: session ? publicSession(session) : null,
  }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(request)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  try {
    const body = await request.json() as Record<string, unknown>;
    const current = resolveTenantSession(request.cookies.get(TENANT_SESSION_COOKIE)?.value);
    let result;
    if (body.action === "accept-invitation") {
      result = await acceptTenantInvitation({
        token: String(body.token ?? ""),
        displayName: String(body.displayName ?? ""),
        password: String(body.password ?? ""),
      });
    } else if (body.action === "create-organization") {
      if (!current) throw new TenantAuthenticationError("Authentication required", 401);
      result = createTenantOrganization(current, {
        name: String(body.tenantName ?? ""),
        slug: String(body.tenantSlug ?? ""),
      });
    } else if (body.action === "switch-organization") {
      if (!current) throw new TenantAuthenticationError("Authentication required", 401);
      result = switchTenantOrganization(current, String(body.tenantId ?? ""));
    } else if (body.action === "login-options") {
      const organizations = await getTenantLoginOptions({
        email: String(body.email ?? ""),
        password: String(body.password ?? ""),
      });
      return NextResponse.json({
        ok: true,
        organizations: organizations.map(({ tenantId, tenantName, tenantSlug, role }) => ({ tenantId, tenantName, tenantSlug, role })),
      }, { headers: { "Cache-Control": "no-store" } });
    } else {
      const setup = body.action === "setup" || tenantSetupRequired();
      result = setup ? await setupTenantOwner({
          tenantName: String(body.tenantName ?? ""),
          tenantSlug: String(body.tenantSlug ?? ""),
          displayName: String(body.displayName ?? ""),
          email: String(body.email ?? ""),
          password: String(body.password ?? ""),
        }) : await loginTenantUser({
          email: String(body.email ?? ""),
          password: String(body.password ?? ""),
          tenantId: typeof body.tenantId === "string" ? body.tenantId : undefined,
        });
    }
    const response = NextResponse.json({ ok: true, account: publicSession(result.session) });
    setSessionCookie(response, request, result.token);
    if (current && (body.action === "create-organization" || body.action === "switch-organization")) {
      logoutTenantSession(request.cookies.get(TENANT_SESSION_COOKIE)?.value);
    }
    return response;
  } catch (error) {
    const status = error instanceof TenantAuthenticationError ? error.status : 500;
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Authentication failed",
      organizations: error instanceof TenantSelectionRequiredError ? error.organizations : undefined,
    }, { status });
  }
}

export async function DELETE(request: NextRequest) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  logoutTenantSession(request.cookies.get(TENANT_SESSION_COOKIE)?.value);
  const response = NextResponse.json({ ok: true });
  clearSessionCookie(response, request);
  return response;
}
