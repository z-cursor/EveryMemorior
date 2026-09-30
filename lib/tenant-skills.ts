import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix, relative, resolve } from "node:path";
import JSZip from "jszip";
import * as yaml from "js-yaml";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { resolveSkillRuntime } from "./skill-runtime";
import { buildSkillRuntime } from "./skill-runtime-builder";
// @ts-expect-error Node's strip-types test runner resolves the extension explicitly.
import { getTenantStore, type AuthenticatedTenantSession, type TenantSkill } from "./tenant-store.ts";

const MAX_ARCHIVE_BYTES = 10 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 1_000;
const DECLARATIVE_EXTENSIONS = new Set([".md", ".txt", ".json", ".yaml", ".yml", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"]);
const RESOURCE_SCAN_IGNORED_DIRECTORIES = new Set(["node_modules", ".git", "__MACOSX", "__pycache__", ".pytest_cache"]);
const MAX_RESOURCE_SCAN_DIRECTORIES = 2_000;
const EXECUTABLE_SCRIPT_EXTENSIONS = new Set([
  ".bash", ".cjs", ".fish", ".js", ".jsx", ".ksh", ".lua", ".mjs", ".php", ".pl", ".py", ".py3", ".rb", ".r", ".sh", ".ts", ".tsx", ".zsh",
]);

function hasShebang(data: Uint8Array | undefined): boolean {
  return Boolean(data && data.byteLength >= 2 && data[0] === 0x23 && data[1] === 0x21);
}

function shouldMarkExecutable(relativePath: string, data: Uint8Array | undefined): boolean {
  const name = posix.basename(relativePath).toLocaleLowerCase("en-US");
  const extension = name.slice(name.lastIndexOf("."));
  return EXECUTABLE_SCRIPT_EXTENSIONS.has(extension) || hasShebang(data);
}

async function ensureExecutableModes(
  root: string,
  files: readonly { relative: string; data?: Uint8Array }[],
): Promise<void> {
  await Promise.all(files
    .filter(({ relative, data }) => shouldMarkExecutable(relative, data))
    .map(({ relative }) => chmod(join(root, ...relative.split("/")), 0o700)));
}

export class TenantSkillUploadError extends Error {}

function safePath(name: string): string {
  const normalized = name.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new TenantSkillUploadError("Skill archive contains an unsafe path");
  }
  return normalized;
}

function slugFromName(value: string): string {
  const slug = value.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 62);
  if (!slug) throw new TenantSkillUploadError("Skill name must contain letters or numbers");
  return slug;
}

/**
 * Verify a pre-existing deterministic release directory before reusing it.
 * This intentionally rejects symlinks, extra files, and content mismatches so
 * a stale or tampered path can never be treated as the uploaded archive.
 */
async function storageMatchesArchive(
  root: string,
  files: readonly { relative: string }[],
  buffers: readonly { data: Uint8Array }[],
): Promise<boolean> {
  const expected = new Map(files.map((file, index) => [file.relative, Buffer.from(buffers[index]?.data ?? new Uint8Array())]));
  const seen = new Set<string>();
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    let entries: Dirent<string>[];
    try {
      entries = await readdir(current, { withFileTypes: true, encoding: "utf8" }) as Dirent<string>[];
    } catch {
      return false;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) return false;
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (!entry.isFile()) return false;
      const relativePath = relative(root, path).replaceAll("\\", "/");
      const expectedBytes = expected.get(relativePath);
      if (!expectedBytes) return false;
      let actual: Buffer;
      try { actual = await readFile(path); } catch { return false; }
      if (!actual.equals(expectedBytes)) return false;
      seen.add(relativePath);
    }
  }
  return seen.size === expected.size;
}

function manifestFromSkill(content: string, fallbackName: string): { name: string; description: string; manifest: Record<string, unknown> } {
  const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  let frontmatter: Record<string, unknown> = {};
  if (match) {
    const parsed = yaml.load(match[1]);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new TenantSkillUploadError("SKILL.md frontmatter must be an object");
    frontmatter = parsed as Record<string, unknown>;
  }
  const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : (content.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? fallbackName);
  const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "Tenant skill";
  if (!name || name.length > 120 || description.length > 500) throw new TenantSkillUploadError("Skill name or description is invalid");
  return { name, description, manifest: { ...frontmatter, capabilities: { network: [], secrets: [], host: false } } };
}

/** Deep module for the tenant Skill governance seam: archives become immutable, reviewable releases. */
export async function uploadTenantSkill(session: AuthenticatedTenantSession, archive: Uint8Array): Promise<TenantSkill> {
  if (archive.byteLength === 0 || archive.byteLength > MAX_ARCHIVE_BYTES) throw new TenantSkillUploadError("Skill archive must be between 1 byte and 10 MB");
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(archive, { checkCRC32: true });
  } catch (error) {
    throw new TenantSkillUploadError(`Invalid Skill ZIP: ${error instanceof Error ? error.message : "archive could not be read"}`);
  }
  const files = Object.values(zip.files).filter((entry) => !entry.dir);
  if (files.length === 0 || files.length > MAX_FILES) throw new TenantSkillUploadError("Skill archive must contain 1-1,000 files");
  const entries = files
    .map((entry) => ({ entry, name: safePath(entry.name) }))
    .filter(({ name }) => !name.toLocaleLowerCase("en-US").startsWith("__macosx/") && !posix.basename(name).startsWith("._") && posix.basename(name) !== ".DS_Store");
  const skillEntry = entries.find(({ name }) => posix.basename(name).toLocaleLowerCase("en-US") === "skill.md");
  if (!skillEntry) throw new TenantSkillUploadError("Skill archive must contain SKILL.md");
  const skillDirectory = skillEntry.name.includes("/")
    ? skillEntry.name.slice(0, skillEntry.name.lastIndexOf("/") + 1)
    : "";
  const normalizedPaths = new Set<string>();
  const normalized = entries.map(({ entry, name }) => {
    const relative = skillDirectory && name.startsWith(skillDirectory) ? name.slice(skillDirectory.length) : name;
    if (!relative || relative.startsWith("/") || relative.includes("/../")) throw new TenantSkillUploadError("Skill archive has an invalid root");
    if (normalizedPaths.has(relative)) throw new TenantSkillUploadError("Skill archive contains duplicate paths");
    normalizedPaths.add(relative);
    return { entry, relative };
  });
  const skillFile = normalized.find(({ relative }) => relative.toLocaleLowerCase("en-US") === "skill.md");
  if (!skillFile) throw new TenantSkillUploadError("Skill archive has an invalid SKILL.md path");
  const buffers = await Promise.all(normalized.map(async ({ entry }) => {
    const data = await entry.async("uint8array");
    return { relative: entry.name, data };
  }));
  const expanded = buffers.reduce((total, file) => total + file.data.byteLength, 0);
  if (expanded > MAX_EXPANDED_BYTES) throw new TenantSkillUploadError("Expanded Skill archive is too large");
  const skillContent = buffers.find((file) => file.relative === skillFile.entry.name)?.data;
  if (!skillContent) throw new TenantSkillUploadError("SKILL.md could not be read");
  const skillText = new TextDecoder().decode(skillContent);
  const fallback = posix.basename(skillFile.relative, ".md");
  const meta = manifestFromSkill(skillText, fallback);
  const archiveBytes = new Map(buffers.map((file) => [file.relative, file.data]));
  // A text extension alone does not make a release declarative. A shebang is
  // an executable entry point even when an uploader names it `.txt` or gives
  // it no conventional extension, so such releases must receive a runtime
  // image before they can be published.
  meta.manifest.declarative = normalized.every(({ entry, relative }) =>
    DECLARATIVE_EXTENSIONS.has(posix.extname(relative).toLocaleLowerCase("en-US"))
    && !hasShebang(archiveBytes.get(entry.name)));
  const digest = createHash("sha256").update(Buffer.from(archive)).digest("hex");
  const slug = slugFromName(meta.name);
  const storageRoot = join(getAgentDir(), "tenant-skills", session.tenant.id, session.membership.id);
  const storagePath = join(storageRoot, `${slug}-${digest.slice(0, 16)}`);
  await mkdir(storageRoot, { recursive: true, mode: 0o700 });
  // Build the immutable release in a private staging directory, then publish
  // it with one atomic rename.  This makes retries and concurrent uploads of
  // the same digest safe: an existing target is a completed release, rather
  // than an EEXIST failure half-way through extraction.
  const stagingPath = await mkdtemp(join(storageRoot, `.upload-${digest.slice(0, 16)}-`));
  let installedStorage = false;
  try {
    await Promise.all(normalized.map(async ({ entry, relative }) => {
      const data = await entry.async("uint8array");
      const target = join(stagingPath, ...relative.split("/"));
      await mkdir(join(target, ".."), { recursive: true, mode: 0o700 });
      await writeFile(target, data, { mode: shouldMarkExecutable(relative, data) ? 0o700 : 0o600 });
    }));
    try {
      await rename(stagingPath, storagePath);
      installedStorage = true;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
      if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
      if (!isDirectory(storagePath)) throw new TenantSkillUploadError("Skill release storage is unavailable");
      if (!(await storageMatchesArchive(storagePath, normalized, buffers))) {
        throw new TenantSkillUploadError("Skill release storage already exists with different contents");
      }
      // Another request won the atomic publish race.  Its directory is keyed
      // by this archive digest and can be safely reused after exact-content
      // verification.
    }
    // Older releases were extracted with mode 0600. Repair executable bits
    // after an idempotent reuse as well as after a fresh publish so direct
    // shebang and shell entry points work in the read-only sandbox mount.
    await ensureExecutableModes(storagePath, normalized.map(({ relative }, index) => ({
      relative,
      data: buffers[index]?.data,
    })));
    const context = { tenantId: session.tenant.id, membershipId: session.membership.id };
    const runtime = resolveSkillRuntime([{
      storagePath,
      declarative: meta.manifest.declarative === true,
    }]);
    meta.manifest.runtimeRequired = runtime.requiresImage;
    const store = getTenantStore();
    let draft: TenantSkill;
    try {
      draft = store.createTenantSkillDraft(context, {
        slug, name: meta.name, description: meta.description, contentDigest: digest, storagePath, manifest: meta.manifest,
        lockfileDigest: runtime.lockfileDigest,
        runtimeProfile: runtime.profile,
        buildStatus: meta.manifest.declarative === true || !runtime.requiresImage ? "ready" : "pending",
      });
    } catch (error) {
      // SQLite's uniqueness guard closes the small race where two requests
      // publish the same immutable archive at once.  Return the release that
      // won instead of surfacing a duplicate-upload error.
      const message = error instanceof Error ? error.message : String(error);
      if (!/unique constraint failed/i.test(message)) throw error;
      const existing = store.findTenantSkillByContentDigest(session.tenant.id, session.membership.id, digest);
      if (!existing) throw error;
      return existing;
    }
    return meta.manifest.declarative === true ? getTenantStore().activatePersonalDeclarativeSkill(context, draft.id) : draft;
  } finally {
    // `rename` consumes the staging directory.  The forceful cleanup is
    // harmless after a successful install and covers extraction failures.
    if (!installedStorage) await rm(stagingPath, { recursive: true, force: true });
  }
}

export function listTenantSkillReleases(session: AuthenticatedTenantSession, includeAll = false): TenantSkill[] {
  return getTenantStore().listTenantSkills({ tenantId: session.tenant.id, membershipId: session.membership.id }, includeAll);
}

/** Archive a release and remove the extracted ZIP contents from host storage. */
export async function deleteTenantSkill(session: AuthenticatedTenantSession, skillId: string): Promise<TenantSkill> {
  const store = getTenantStore();
  const context = { tenantId: session.tenant.id, membershipId: session.membership.id };
  const skill = store.getTenantSkill(session.tenant.id, skillId);
  if (!skill || skill.status === "archived") throw new Error("Skill release not found");

  // The persisted path is only ever created below this membership-scoped
  // directory. Keep this check before changing the database so a corrupted
  // record can never turn deletion into an arbitrary filesystem operation.
  const storageRoot = resolve(join(getAgentDir(), "tenant-skills", session.tenant.id, skill.createdByMembershipId));
  const storagePath = resolve(skill.storagePath);
  if (storagePath === storageRoot || !isWithinRoot(storageRoot, storagePath)) {
    throw new Error("Skill release storage path is invalid");
  }

  const archived = store.archiveTenantSkill(context, skillId);
  await rm(storagePath, { recursive: true, force: true });
  return archived;
}

export function transitionTenantSkill(session: AuthenticatedTenantSession, action: "submit" | "publish" | "suspend" | "resume" | "retry" | "build", skillId: string): TenantSkill {
  const context = { tenantId: session.tenant.id, membershipId: session.membership.id };
  const store = getTenantStore();
  if (action === "build") {
    if (session.membership.role === "member") throw new Error("Only a tenant administrator can build a Skill runtime");
    const skill = store.getTenantSkill(session.tenant.id, skillId);
    if (!skill) throw new Error(`Skill release is not buildable: release ${skillId} was not found`);
    // Building is safe before review as well: the resulting image is only
    // cached metadata and publication still requires the normal review gate.
    if (!["draft", "pending_review", "published", "suspended"].includes(skill.status)) {
      throw new Error(`Skill release is not buildable: current status is ${skill.status}`);
    }
    return store.updateTenantSkillBuild(context, skillId, {
      status: "pending", imageDigest: null, runtimeImage: null, error: null, completedAt: null,
    });
  }
  if (action === "retry") {
    if (session.membership.role === "member") throw new Error("Only a tenant administrator can build a Skill runtime");
    const skill = store.getTenantSkill(session.tenant.id, skillId);
    if (!skill || skill.buildStatus !== "failed" || !["draft", "pending_review", "published", "suspended"].includes(skill.status)) throw new Error("Skill runtime build is not retryable");
    return store.updateTenantSkillBuild(context, skillId, {
      status: "pending", imageDigest: null, runtimeImage: null, error: null,
      completedAt: null,
    });
  }
  if (action === "submit") return store.submitTenantSkillForReview(context, skillId);
  if (action === "publish") return store.publishTenantSkill(context, skillId);
  if (action === "resume") return store.resumeTenantSkill(context, skillId);
  return store.suspendTenantSkill(context, skillId);
}

/**
 * Start a release build without making the first Agent invocation perform an
 * install. The in-process dedupe in the builder keeps retries cheap; the
 * persisted status makes a restart fail closed until a successful artifact is
 * available.
 */
export function queueTenantSkillRuntimeBuild(
  session: AuthenticatedTenantSession,
  skill: TenantSkill,
  onReady?: () => void,
): void {
  if (skill.buildStatus === "ready") return;
  const context = { tenantId: session.tenant.id, membershipId: session.membership.id };
  const store = getTenantStore();
  let descriptor;
  try {
    descriptor = resolveSkillRuntime([skill.storagePath]);
  } catch (error) {
    try {
      store.updateTenantSkillBuild(context, skill.id, {
        status: "failed",
        error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
      });
    } catch {
      // The release may have been removed while the preflight was running.
    }
    return;
  }
  try {
    store.updateTenantSkillBuild(context, skill.id, { status: "building", error: null });
  } catch {
    return;
  }
  // Legacy releases can be marked non-declarative even when their archive
  // contains no executable files. The resolver is authoritative here: if no
  // image is required, complete the persisted state without invoking Docker.
  if (!descriptor.requiresImage) {
    try {
      store.updateTenantSkillBuild(context, skill.id, {
        status: "ready", imageDigest: null, runtimeImage: null,
        lockfileDigest: descriptor.lockfileDigest, runtimeProfile: descriptor.profile,
        error: null, completedAt: null,
      });
      onReady?.();
    } catch {
      // The release may have been removed while the preflight was running.
    }
    return;
  }
  void buildSkillRuntime({
    storagePath: skill.storagePath,
    releaseDigest: skill.releaseDigest,
    lockfileDigest: skill.lockfileDigest ?? descriptor.lockfileDigest,
    runtimeProfile: skill.runtimeProfile ?? descriptor.profile,
  }).then((result) => {
    store.updateTenantSkillBuild(context, skill.id, {
      status: "ready", imageDigest: result.imageDigest, runtimeImage: result.image,
      lockfileDigest: result.descriptor.lockfileDigest, runtimeProfile: result.descriptor.profile,
      error: null,
    });
    onReady?.();
  }).catch((error) => {
    try {
      store.updateTenantSkillBuild(context, skill.id, {
        status: "failed",
        error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
      });
    } catch {
      // The release may have been deleted while its background build failed.
    }
  });
}

export function publishedTenantSkillPaths(session: AuthenticatedTenantSession): string[] {
  return publishedTenantSkillReleases(session).map((skill) => skill.storagePath);
}

/** Published, runtime-ready releases visible to this membership. */
export function publishedTenantSkillReleases(session: AuthenticatedTenantSession): TenantSkill[] {
  const store = getTenantStore();
  return store.listPublishedTenantSkills(
    session.tenant.id,
    session.membership.id,
    session.membership.role !== "member",
  );
}

export function publishedTenantSkillResourcePaths(session: AuthenticatedTenantSession): string[] {
  return expandTenantSkillPaths(publishedTenantSkillReleases(session).map((skill) => skill.storagePath));
}

type PluginManifest = { skills?: unknown };

function isDirectory(path: string): boolean {
  try { return lstatSync(path).isDirectory(); } catch { return false; }
}

function isRegularFile(path: string): boolean {
  try { return lstatSync(path).isFile(); } catch { return false; }
}

function isWithinRoot(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

/**
 * Find package manifests without following symlinks. Tenant archives are
 * immutable, but this boundary must still avoid a resource path escaping the
 * immutable release directory.
 */
function findPluginManifests(root: string): string[] {
  const found: string[] = [];
  const pending = [root];
  let visited = 0;
  while (pending.length > 0 && visited < MAX_RESOURCE_SCAN_DIRECTORIES) {
    const current = pending.pop()!;
    visited += 1;
    let entries: Dirent<string>[];
    try { entries = readdirSync(current, { withFileTypes: true, encoding: "utf8" }) as Dirent<string>[]; } catch { continue; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(current, entry.name);
      if (entry.isFile() && entry.name === "plugin.json") found.push(path);
      else if (entry.isDirectory() && !RESOURCE_SCAN_IGNORED_DIRECTORIES.has(entry.name)) pending.push(path);
    }
  }
  return found.sort();
}

function declaredSkillRoots(root: string): string[] {
  const roots: string[] = [];
  for (const manifestPath of findPluginManifests(root)) {
    let manifest: PluginManifest;
    try {
      const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      manifest = parsed as PluginManifest;
    } catch { continue; }
    const values = typeof manifest.skills === "string"
      ? [manifest.skills]
      : Array.isArray(manifest.skills) ? manifest.skills.filter((value): value is string => typeof value === "string") : [];
    const manifestDirectory = dirname(manifestPath);
    const packageDirectory = basename(manifestDirectory) === ".codex-plugin"
      ? dirname(manifestDirectory)
      : manifestDirectory;
    for (const value of values) {
      const candidate = resolve(packageDirectory, value);
      if (isDirectory(candidate) && isWithinRoot(root, candidate)) roots.push(candidate);
    }
  }
  return roots;
}

function skillDirectoriesUnder(root: string): string[] {
  const found: string[] = [];
  const pending = [root];
  let visited = 0;
  while (pending.length > 0 && visited < MAX_RESOURCE_SCAN_DIRECTORIES) {
    const current = pending.pop()!;
    visited += 1;
    let entries: Dirent<string>[];
    try { entries = readdirSync(current, { withFileTypes: true, encoding: "utf8" }) as Dirent<string>[]; } catch { continue; }
    let hasSkill = false;
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isFile() && entry.name.toLocaleLowerCase("en-US") === "skill.md") hasSkill = true;
      if (entry.isDirectory() && !RESOURCE_SCAN_IGNORED_DIRECTORIES.has(entry.name)) pending.push(join(current, entry.name));
    }
    if (hasSkill) found.push(current);
  }
  return found.sort();
}

/**
 * Expand immutable release roots into the Skill directories the SDK should
 * inspect. A package manifest is authoritative when present: this keeps
 * historical `.pi/skills` copies from shadowing the package's declared
 * `skills/` tree. Archives without a manifest use a bounded safe fallback.
 */
export function expandTenantSkillPaths(storageRoots: readonly string[]): string[] {
  const expanded: string[] = [];
  for (const storageRoot of storageRoots) {
    const root = resolve(storageRoot);
    if (!isDirectory(root)) continue;
    const declared = declaredSkillRoots(root);
    // A package manifest is authoritative. The upload root may be the first
    // SKILL.md found in a legacy `.pi/skills` tree; adding it before the
    // declared `skills/` root would let that older duplicate win by name.
    const nested = declared.length > 0
      ? declared
      : [
          ...(isRegularFile(join(root, "SKILL.md")) ? [root] : []),
          ...skillDirectoriesUnder(root),
        ];
    expanded.push(...nested);
  }
  return [...new Set(expanded.map((path) => resolve(path)))];
}
