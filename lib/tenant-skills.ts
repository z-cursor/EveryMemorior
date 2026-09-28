import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import JSZip from "jszip";
import * as yaml from "js-yaml";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
// @ts-expect-error Node's strip-types test runner resolves the extension explicitly.
import { getTenantStore, type AuthenticatedTenantSession, type TenantSkill } from "./tenant-store.ts";

const MAX_ARCHIVE_BYTES = 10 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 1_000;
const DECLARATIVE_EXTENSIONS = new Set([".md", ".txt", ".json", ".yaml", ".yml", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"]);

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
  const normalized = entries.map(({ entry, name }) => {
    const relative = skillDirectory && name.startsWith(skillDirectory) ? name.slice(skillDirectory.length) : name;
    if (!relative || relative.startsWith("/") || relative.includes("/../")) throw new TenantSkillUploadError("Skill archive has an invalid root");
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
  meta.manifest.declarative = normalized.every(({ relative }) => DECLARATIVE_EXTENSIONS.has(posix.extname(relative).toLocaleLowerCase("en-US")));
  const digest = createHash("sha256").update(Buffer.from(archive)).digest("hex");
  const slug = slugFromName(meta.name);
  const storageRoot = join(getAgentDir(), "tenant-skills", session.tenant.id, session.membership.id);
  const storagePath = join(storageRoot, `${slug}-${digest.slice(0, 16)}`);
  await mkdir(storageRoot, { recursive: true, mode: 0o700 });
  let createdStorage = false;
  try {
    await mkdir(storagePath, { mode: 0o700 });
    createdStorage = true;
    await Promise.all(normalized.map(async ({ entry, relative }) => {
      const data = await entry.async("uint8array");
      const target = join(storagePath, ...relative.split("/"));
      await mkdir(join(target, ".."), { recursive: true, mode: 0o700 });
      await writeFile(target, data, { flag: "wx", mode: 0o600 });
    }));
    const context = { tenantId: session.tenant.id, membershipId: session.membership.id };
    const draft = getTenantStore().createTenantSkillDraft(context, {
      slug, name: meta.name, description: meta.description, contentDigest: digest, storagePath, manifest: meta.manifest,
    });
    return meta.manifest.declarative === true ? getTenantStore().activatePersonalDeclarativeSkill(context, draft.id) : draft;
  } catch (error) {
    if (createdStorage) await rm(storagePath, { recursive: true, force: true });
    throw error;
  }
}

export function listTenantSkillReleases(session: AuthenticatedTenantSession, includeAll = false): TenantSkill[] {
  return getTenantStore().listTenantSkills({ tenantId: session.tenant.id, membershipId: session.membership.id }, includeAll);
}

export function transitionTenantSkill(session: AuthenticatedTenantSession, action: "submit" | "publish" | "suspend", skillId: string): TenantSkill {
  const context = { tenantId: session.tenant.id, membershipId: session.membership.id };
  const store = getTenantStore();
  if (action === "submit") return store.submitTenantSkillForReview(context, skillId);
  if (action === "publish") return store.publishTenantSkill(context, skillId);
  return store.suspendTenantSkill(context, skillId);
}

export function publishedTenantSkillPaths(session: AuthenticatedTenantSession): string[] {
  const store = getTenantStore();
  return session.membership.role === "member"
    ? store.listPublishedTenantSkillPaths(session.tenant.id, session.membership.id)
    : store.listPublishedTenantSkillPathsForTenant(session.tenant.id);
}
