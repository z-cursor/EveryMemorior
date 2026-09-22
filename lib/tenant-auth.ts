import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { getTenantStore, type AuthenticatedTenantSession, type UserTenantMembership } from "./tenant-store";

export const TENANT_SESSION_COOKIE = "pi_web_tenant_session";
export const TENANT_SESSION_MAX_AGE = 60 * 60 * 24 * 30;
const PASSWORD_ALGORITHM = "scrypt-v1";

export class TenantAuthenticationError extends Error {
  constructor(message: string, readonly status: 400 | 401 | 403 | 409 = 401) {
    super(message);
    this.name = "TenantAuthenticationError";
  }
}

export class TenantSelectionRequiredError extends TenantAuthenticationError {
  constructor(readonly organizations: UserTenantMembership[]) {
    super("Choose an organization", 409);
    this.name = "TenantSelectionRequiredError";
  }
}

function scryptKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 32, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(key as Buffer);
    });
  });
}

async function hashPassword(password: string): Promise<string> {
  if (password.length < 8) throw new TenantAuthenticationError("Password must be at least 8 characters", 400);
  const salt = randomBytes(16);
  const key = await scryptKey(password, salt);
  return `${salt.toString("hex")}:${key.toString("hex")}`;
}

async function passwordMatches(password: string, stored: string): Promise<boolean> {
  const [saltHex, keyHex, extra] = stored.split(":");
  if (extra !== undefined || !/^[a-f0-9]{32}$/.test(saltHex) || !/^[a-f0-9]{64}$/.test(keyHex)) return false;
  const actual = await scryptKey(password, Buffer.from(saltHex, "hex"));
  return timingSafeEqual(actual, Buffer.from(keyHex, "hex"));
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function newSession(userId: string, tenantId: string, membershipId: string): {
  token: string;
  expiresAt: string;
} {
  const store = getTenantStore();
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + TENANT_SESSION_MAX_AGE * 1000).toISOString();
  store.createAuthenticationSession({
    tokenHash: tokenHash(token),
    userId,
    tenantId,
    membershipId,
    expiresAt,
  });
  return { token, expiresAt };
}

export function tenantSetupRequired(): boolean {
  return !getTenantStore().isInitialized();
}

export async function setupTenantOwner(input: {
  tenantName: string;
  tenantSlug: string;
  displayName: string;
  email: string;
  password: string;
}): Promise<{ token: string; session: AuthenticatedTenantSession }> {
  const store = getTenantStore();
  if (store.isInitialized()) throw new TenantAuthenticationError("Pi Web is already configured", 409);
  const credentialHash = await hashPassword(input.password);
  const created = store.createTenantWithOwner({
    tenant: { name: input.tenantName, slug: input.tenantSlug },
    owner: { email: input.email, displayName: input.displayName },
    credential: { hash: credentialHash, algorithm: PASSWORD_ALGORITHM },
    claimInstallation: true,
  });
  const auth = newSession(created.owner.id, created.tenant.id, created.membership.id);
  const session = resolveTenantSession(auth.token);
  if (!session) throw new Error("Created authentication session could not be resolved");
  return { token: auth.token, session };
}

export async function loginTenantUser(input: {
  email: string;
  password: string;
  tenantId?: string;
}): Promise<{ token: string; session: AuthenticatedTenantSession }> {
  const store = getTenantStore();
  const credential = store.findPasswordCredential(input.email);
  const valid = credential?.algorithm === PASSWORD_ALGORITHM
    && await passwordMatches(input.password, credential.hash);
  if (!credential || !valid) throw new TenantAuthenticationError("Invalid email or password", 401);
  const organizations = store.listUserTenants(credential.userId).filter((item) => item.status === "active");
  if (!input.tenantId && organizations.length > 1) throw new TenantSelectionRequiredError(organizations);
  const membership = store.listUserMemberships(credential.userId).find((item) =>
    item.status === "active" && (!input.tenantId || item.tenantId === input.tenantId));
  if (!membership) throw new TenantAuthenticationError("No active tenant membership", 403);
  const auth = newSession(credential.userId, membership.tenantId, membership.id);
  const session = resolveTenantSession(auth.token);
  if (!session) throw new Error("Created authentication session could not be resolved");
  return { token: auth.token, session };
}

export async function acceptTenantInvitation(input: {
  token: string;
  displayName?: string;
  password?: string;
}): Promise<{ token: string; session: AuthenticatedTenantSession }> {
  const store = getTenantStore();
  const digest = tokenHash(input.token);
  const email = store.getPendingInvitationEmail(digest);
  if (!email) throw new TenantAuthenticationError("Invitation is invalid or expired", 400);
  const existingCredential = store.findPasswordCredential(email);
  if (existingCredential) {
    const valid = input.password && existingCredential.algorithm === PASSWORD_ALGORITHM
      && await passwordMatches(input.password, existingCredential.hash);
    if (!valid) throw new TenantAuthenticationError("Invalid email or password", 401);
  }
  const credential = existingCredential ? undefined : {
    hash: await hashPassword(input.password ?? ""),
    algorithm: PASSWORD_ALGORITHM,
  };
  let accepted: ReturnType<typeof store.acceptInvitation>;
  try {
    accepted = store.acceptInvitation({
      tokenHash: digest,
      displayName: input.displayName,
      credential,
    });
  } catch (error) {
    throw new TenantAuthenticationError(error instanceof Error ? error.message : "Unable to accept invitation", 400);
  }
  const auth = newSession(accepted.user.id, accepted.tenant.id, accepted.membership.id);
  const session = resolveTenantSession(auth.token);
  if (!session) throw new Error("Created authentication session could not be resolved");
  return { token: auth.token, session };
}

export function createTenantOrganization(
  session: AuthenticatedTenantSession,
  input: { name: string; slug: string },
): { token: string; session: AuthenticatedTenantSession } {
  let created;
  try {
    created = getTenantStore().createTenantWithOwner({
      tenant: input,
      owner: { email: session.user.primaryEmail, displayName: session.user.displayName, locale: session.user.locale },
    });
  } catch (error) {
    throw new TenantAuthenticationError(error instanceof Error ? error.message : "Unable to create organization", 400);
  }
  const auth = newSession(created.owner.id, created.tenant.id, created.membership.id);
  const next = resolveTenantSession(auth.token);
  if (!next) throw new Error("Created authentication session could not be resolved");
  return { token: auth.token, session: next };
}

export function switchTenantOrganization(
  session: AuthenticatedTenantSession,
  tenantId: string,
): { token: string; session: AuthenticatedTenantSession } {
  const membership = getTenantStore().listUserMemberships(session.user.id)
    .find((item) => item.tenantId === tenantId && item.status === "active");
  if (!membership) throw new TenantAuthenticationError("No active membership for that organization", 403);
  const auth = newSession(session.user.id, membership.tenantId, membership.id);
  const next = resolveTenantSession(auth.token);
  if (!next) throw new Error("Created authentication session could not be resolved");
  return { token: auth.token, session: next };
}

export function resolveTenantSession(token: string | undefined): AuthenticatedTenantSession | null {
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return getTenantStore().resolveAuthenticationSession(tokenHash(token));
}

export function requireTenantSession(request: Request): AuthenticatedTenantSession {
  const cookie = tenantSessionTokenFromRequest(request);
  const session = resolveTenantSession(cookie);
  if (!session) throw new TenantAuthenticationError("Authentication required", 401);
  return session;
}

export function tenantSessionTokenFromRequest(request: Request): string | undefined {
  const value = request.headers.get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${TENANT_SESSION_COOKIE}=`))
    ?.slice(TENANT_SESSION_COOKIE.length + 1);
  return value ? decodeURIComponent(value) : undefined;
}

export function canManageHostConfiguration(session: AuthenticatedTenantSession): boolean {
  const store = getTenantStore();
  return store.getPrimaryTenantId() === session.tenant.id
    && store.getInstallationOwnerMembershipId() === session.membership.id
    && session.membership.role === "owner";
}

export function logoutTenantSession(token: string | undefined): void {
  if (token) getTenantStore().revokeAuthenticationSession(tokenHash(token));
}
