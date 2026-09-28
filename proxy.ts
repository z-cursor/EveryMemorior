import { NextResponse, type NextRequest } from "next/server";
import { isApiRequestAllowed, isApiRequestHostAllowed } from "@/lib/request-security";
import { canManageHostConfiguration, resolveTenantSession, TENANT_SESSION_COOKIE } from "@/lib/tenant-auth";

const HOST_CONFIGURATION_PREFIXES = [
  "/api/tools/settings",
  "/api/models-config",
  "/api/auth/",
  "/api/plugins",
  "/api/skills",
  "/api/subagents/settings",
  "/api/subagents/profiles",
  "/api/subagents/",
  "/api/project-trust",
  "/api/provider-usage/",
  "/api/worktrees",
  "/api/terminal",
];

function accessesHostConfiguration(request: NextRequest): boolean {
  return HOST_CONFIGURATION_PREFIXES.some((prefix) => request.nextUrl.pathname.startsWith(prefix));
}

export function proxy(request: NextRequest) {
  const isApiRequest = request.nextUrl.pathname === "/api"
    || request.nextUrl.pathname.startsWith("/api/");
  const trusted = isApiRequest ? isApiRequestAllowed(request) : isApiRequestHostAllowed(request);
  if (!trusted) {
    return isApiRequest
      ? NextResponse.json({ error: "Untrusted API request" }, { status: 403 })
      : new NextResponse("Untrusted request", { status: 403 });
  }

  const session = resolveTenantSession(request.cookies.get(TENANT_SESSION_COOKIE)?.value);
  const authenticated = Boolean(session);
  if (request.nextUrl.pathname === "/login") {
    return authenticated && !request.nextUrl.searchParams.has("invite")
      ? NextResponse.redirect(new URL("/", request.url))
      : NextResponse.next();
  }
  if (request.nextUrl.pathname === "/api/web-auth") return NextResponse.next();
  if (!authenticated) {
    if (!isApiRequest) {
      const loginUrl = new URL("/login", request.url);
      if (request.nextUrl.search) loginUrl.searchParams.set("next", `${request.nextUrl.pathname}${request.nextUrl.search}`);
      return NextResponse.redirect(loginUrl);
    }
    return NextResponse.json({ error: "Authentication required" }, {
      status: 401,
      headers: { "Cache-Control": "no-store" },
    });
  }
  if (session && accessesHostConfiguration(request) && !canManageHostConfiguration(session)) {
    return NextResponse.json({ error: "Only the installation owner can access host resources" }, { status: 403 });
  }
  return NextResponse.next();
}

export const config = { matcher: ["/", "/login", "/api/:path*"] };
