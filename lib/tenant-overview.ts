export type TenantRole = "owner" | "admin" | "member";

export type TenantOverview = {
  tenant: { id: string; name: string; slug: string; planCode: string; seatLimit: number | null };
  currentMembership: { id: string; role: TenantRole };
  canManage: boolean;
  organizations: Array<{
    membershipId: string;
    tenantId: string;
    tenantName: string;
    tenantSlug: string;
    role: TenantRole;
    status: string;
  }>;
  invitations: Array<{ id: string; email: string; role: TenantRole; expiresAt: string }>;
  members: Array<{
    membershipId: string;
    email: string;
    displayName: string;
    role: TenantRole;
    status: string;
    joinedAt: string;
  }>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Accepts the phase-one response while stale clients/servers roll onto the expanded contract. */
export function normalizeTenantOverview(value: unknown): TenantOverview {
  if (!isRecord(value) || !isRecord(value.tenant) || !isRecord(value.currentMembership)) {
    throw new Error("Invalid tenant response");
  }
  const tenant = value.tenant as TenantOverview["tenant"];
  const currentMembership = value.currentMembership as TenantOverview["currentMembership"];
  const role = currentMembership.role;
  return {
    tenant,
    currentMembership,
    members: Array.isArray(value.members) ? value.members as TenantOverview["members"] : [],
    organizations: Array.isArray(value.organizations) ? value.organizations as TenantOverview["organizations"] : [{
      membershipId: currentMembership.id,
      tenantId: tenant.id,
      tenantName: tenant.name,
      tenantSlug: tenant.slug,
      role,
      status: "active",
    }],
    invitations: Array.isArray(value.invitations) ? value.invitations as TenantOverview["invitations"] : [],
    canManage: typeof value.canManage === "boolean"
      ? value.canManage
      : role === "owner" || role === "admin",
  };
}

export async function readTenantJsonResponse<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => {
    throw new Error(
      `Tenant request failed (HTTP ${response.status}): empty or invalid JSON response`,
    );
  });

  if (!body || typeof body !== "object") {
    throw new Error(
      `Tenant request failed (HTTP ${response.status}): empty or invalid JSON response`,
    );
  }

  if (!response.ok) {
    const error = (body as { error?: unknown }).error;
    throw new Error(
      typeof error === "string" && error ? error : `HTTP ${response.status}`,
    );
  }

  return body as T;
}
