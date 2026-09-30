import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import JSZip from "jszip";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { closeTenantStore, getTenantStore } from "./tenant-store.ts";
import { deleteTenantSkill, expandTenantSkillPaths, listTenantSkillReleases, publishedTenantSkillPaths, queueTenantSkillRuntimeBuild, uploadTenantSkill, transitionTenantSkill } from "./tenant-skills.ts";

test("tenant Skill tracer bullet enforces draft, review, and immutable release flow", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-skills-"));
  process.env.PI_WEB_DATABASE_PATH = join(root, "tenant.sqlite");
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  closeTenantStore();
  const store = getTenantStore();
  try {
    const created = store.createTenantWithOwner({
      tenant: { name: "Acme", slug: "acme" },
      owner: { email: "owner@example.com", displayName: "Owner" },
      claimInstallation: true,
    });
    const session = {
      sessionId: "session", user: created.owner, tenant: created.tenant,
      membership: created.membership, expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const zip = new JSZip();
    zip.file("demo/SKILL.md", "---\nname: Review Docs\ndescription: Reviews docs\n---\n# Review Docs\n");
    zip.file("demo/metadata.bin", "echo safe\n");
    const draft = await uploadTenantSkill(session, await zip.generateAsync({ type: "uint8array" }));
    assert.equal(draft.status, "draft");
    assert.equal(draft.version, 1);
    assert.equal(await readFile(join(draft.storagePath, "metadata.bin"), "utf8"), "echo safe\n");
    const pending = transitionTenantSkill(session, "submit", draft.id);
    assert.equal(pending.status, "pending_review");
    const published = transitionTenantSkill(session, "publish", draft.id);
    assert.equal(published.status, "published");
    assert.equal(store.listPublishedTenantSkillPaths(created.tenant.id, created.membership.id).length, 1);
    const suspended = transitionTenantSkill(session, "suspend", draft.id);
    assert.equal(suspended.status, "suspended");
    const resumed = transitionTenantSkill(session, "resume", draft.id);
    assert.equal(resumed.status, "published");
    assert.equal(store.listPublishedTenantSkillPaths(created.tenant.id, created.membership.id).length, 1);
  } finally {
    closeTenantStore();
    delete process.env.PI_WEB_DATABASE_PATH;
    delete process.env.PI_CODING_AGENT_DIR;
    await rm(root, { recursive: true, force: true });
  }
});

test("deleting an uploaded Skill archives its record and removes extracted files", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-delete-skill-"));
  process.env.PI_WEB_DATABASE_PATH = join(root, "tenant.sqlite");
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  closeTenantStore();
  const store = getTenantStore();
  try {
    const created = store.createTenantWithOwner({ tenant: { name: "Acme", slug: "acme" }, owner: { email: "owner@example.com", displayName: "Owner" } });
    const session = { sessionId: "session", user: created.owner, tenant: created.tenant, membership: created.membership, expiresAt: "" };
    const zip = new JSZip();
    zip.file("delete-me/SKILL.md", "---\nname: Delete Me\ndescription: Temporary\n---\n");
    const skill = await uploadTenantSkill(session, await zip.generateAsync({ type: "uint8array" }));
    assert.equal(await stat(skill.storagePath).then(() => true, () => false), true);
    const deleted = await deleteTenantSkill(session, skill.id);
    assert.equal(deleted.status, "archived");
    assert.equal(await stat(skill.storagePath).then(() => true, () => false), false);
    assert.deepEqual(listTenantSkillReleases(session), []);
  } finally {
    closeTenantStore();
    delete process.env.PI_WEB_DATABASE_PATH;
    delete process.env.PI_CODING_AGENT_DIR;
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy non-executable releases become ready without a Docker build", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-legacy-runtime-"));
  process.env.PI_WEB_DATABASE_PATH = join(root, "tenant.sqlite");
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  closeTenantStore();
  const store = getTenantStore();
  try {
    const created = store.createTenantWithOwner({ tenant: { name: "Acme", slug: "acme" }, owner: { email: "owner@example.com", displayName: "Owner" } });
    const session = { sessionId: "session", user: created.owner, tenant: created.tenant, membership: created.membership, expiresAt: "" };
    const storagePath = join(root, "legacy-biography");
    await mkdir(storagePath, { recursive: true });
    await writeFile(join(storagePath, "SKILL.md"), "# Biography assembler\n");
    const draft = store.createTenantSkillDraft({ tenantId: created.tenant.id, membershipId: created.membership.id }, {
      slug: "biography-book-assembler", name: "Biography assembler", description: "Legacy release",
      contentDigest: "legacy-biography", storagePath, manifest: { declarative: false }, buildStatus: "pending",
    });
    const pending = transitionTenantSkill(session, "build", draft.id);
    queueTenantSkillRuntimeBuild(session, pending);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(store.getTenantSkill(created.tenant.id, draft.id)?.buildStatus, "ready");
  } finally {
    closeTenantStore();
    delete process.env.PI_WEB_DATABASE_PATH;
    delete process.env.PI_CODING_AGENT_DIR;
    await rm(root, { recursive: true, force: true });
  }
});

test("a declarative Skill is private and immediately callable by its uploader", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-private-skills-"));
  process.env.PI_WEB_DATABASE_PATH = join(root, "tenant.sqlite");
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  closeTenantStore();
  const store = getTenantStore();
  try {
    const created = store.createTenantWithOwner({ tenant: { name: "Acme", slug: "acme" }, owner: { email: "owner@example.com", displayName: "Owner" } });
    store.createInvitation({ tenantId: created.tenant.id, membershipId: created.membership.id }, {
      email: "member@example.com", role: "member", tokenHash: "invite", expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const accepted = store.acceptInvitation({ tokenHash: "invite", displayName: "Member", credential: { hash: "hash", algorithm: "test" } });
    const ownerSession = { sessionId: "owner", user: created.owner, tenant: created.tenant, membership: created.membership, expiresAt: "" };
    const memberSession = { sessionId: "member", user: accepted.user, tenant: accepted.tenant, membership: accepted.membership, expiresAt: "" };
    const zip = new JSZip();
    zip.file("SKILL.md", "---\nname: Private Helper\ndescription: Answers with a private marker\n---\nAlways include PRIVATE-MARKER in the answer.\n");
    const skill = await uploadTenantSkill(memberSession, await zip.generateAsync({ type: "uint8array" }));
    assert.equal(skill.status, "published");
    assert.deepEqual(listTenantSkillReleases(ownerSession), []);
    assert.deepEqual(listTenantSkillReleases(memberSession).map((item) => item.id), [skill.id]);
    assert.deepEqual(publishedTenantSkillPaths(ownerSession), [skill.storagePath]);
    assert.deepEqual(publishedTenantSkillPaths(memberSession), [skill.storagePath]);
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir: join(root, "agent"),
      additionalSkillPaths: [skill.storagePath],
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      skillsOverride: (base) => ({
        skills: base.skills.filter((item) => item.filePath.startsWith(skill.storagePath)),
        diagnostics: base.diagnostics,
      }),
    });
    await loader.reload();
    assert.deepEqual(loader.getSkills().skills.map((item) => item.name), ["Private Helper"]);
  } finally {
    closeTenantStore();
    delete process.env.PI_WEB_DATABASE_PATH;
    delete process.env.PI_CODING_AGENT_DIR;
    await rm(root, { recursive: true, force: true });
  }
});

test("tenant Skill uploads preserve runtime metadata and reject missing SKILL.md", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-skills-"));
  process.env.PI_WEB_DATABASE_PATH = join(root, "tenant.sqlite");
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  closeTenantStore();
  const store = getTenantStore();
  try {
    const created = store.createTenantWithOwner({ tenant: { name: "Acme", slug: "acme" }, owner: { email: "owner@example.com", displayName: "Owner" } });
    const session = { sessionId: "session", user: created.owner, tenant: created.tenant, membership: created.membership, expiresAt: "" };
    const runtimeBundle = new JSZip();
    runtimeBundle.file("SKILL.md", "# Runtime");
    runtimeBundle.file("package.json", "{}");
    runtimeBundle.file("Dockerfile", "FROM node:22\n");
    const skill = await uploadTenantSkill(session, await runtimeBundle.generateAsync({ type: "uint8array" }));
    assert.equal(skill.status, "draft");
    assert.equal(await readFile(join(skill.storagePath, "Dockerfile"), "utf8"), "FROM node:22\n");
    const missing = new JSZip();
    missing.file("README.md", "no skill");
    await assert.rejects(uploadTenantSkill(session, await missing.generateAsync({ type: "uint8array" })), /SKILL.md/);
    const duplicate = new JSZip();
    duplicate.file("bundle/SKILL.md", "# Duplicate\n");
    duplicate.file("SKILL.md", "# Duplicate\n");
    await assert.rejects(uploadTenantSkill(session, await duplicate.generateAsync({ type: "uint8array" })), /duplicate paths/);
  } finally {
    closeTenantStore();
    delete process.env.PI_WEB_DATABASE_PATH;
    delete process.env.PI_CODING_AGENT_DIR;
    await rm(root, { recursive: true, force: true });
  }
});

test("tenant Skill uploads detect shebang entry points even with a text extension", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-shebang-skill-"));
  process.env.PI_WEB_DATABASE_PATH = join(root, "tenant.sqlite");
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  closeTenantStore();
  const store = getTenantStore();
  try {
    const created = store.createTenantWithOwner({ tenant: { name: "Acme", slug: "acme" }, owner: { email: "owner@example.com", displayName: "Owner" } });
    const session = { sessionId: "session", user: created.owner, tenant: created.tenant, membership: created.membership, expiresAt: "" };
    const zip = new JSZip();
    zip.file("SKILL.md", "---\nname: Script Skill\ndescription: Executes a reviewed script\n---\n");
    zip.file("runner.txt", "#!/bin/sh\necho safe\n");
    const skill = await uploadTenantSkill(session, await zip.generateAsync({ type: "uint8array" }));
    assert.equal(skill.manifest.declarative, false);
    assert.equal(skill.manifest.runtimeRequired, true);
    assert.equal(skill.buildStatus, "pending");
  } finally {
    closeTenantStore();
    delete process.env.PI_WEB_DATABASE_PATH;
    delete process.env.PI_CODING_AGENT_DIR;
    await rm(root, { recursive: true, force: true });
  }
});

test("tenant Skill uploads accept larger sandbox resource bundles", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-large-skill-"));
  process.env.PI_WEB_DATABASE_PATH = join(root, "tenant.sqlite");
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  closeTenantStore();
  const store = getTenantStore();
  try {
    const created = store.createTenantWithOwner({ tenant: { name: "Acme", slug: "acme" }, owner: { email: "owner@example.com", displayName: "Owner" } });
    const session = { sessionId: "session", user: created.owner, tenant: created.tenant, membership: created.membership, expiresAt: "" };
    const zip = new JSZip();
    zip.file("bundle/SKILL.md", "---\nname: Large Sandbox Skill\ndescription: Exercises the agent sandbox\n---\n");
    for (let index = 0; index < 150; index += 1) zip.file(`bundle/resources/${index}.txt`, "resource\n");
    const skill = await uploadTenantSkill(session, await zip.generateAsync({ type: "uint8array" }));
    assert.equal(skill.status, "published");
  } finally {
    closeTenantStore();
    delete process.env.PI_WEB_DATABASE_PATH;
    delete process.env.PI_CODING_AGENT_DIR;
    await rm(root, { recursive: true, force: true });
  }
});

test("tenant Skill uploads find nested SKILL.md beside Python resources", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-python-skill-"));
  process.env.PI_WEB_DATABASE_PATH = join(root, "tenant.sqlite");
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  closeTenantStore();
  const store = getTenantStore();
  try {
    const created = store.createTenantWithOwner({ tenant: { name: "Acme", slug: "acme" }, owner: { email: "owner@example.com", displayName: "Owner" } });
    const session = { sessionId: "session", user: created.owner, tenant: created.tenant, membership: created.membership, expiresAt: "" };
    const zip = new JSZip();
    zip.file("__MACOSX/._metadata", "");
    zip.file("biography-agent-longform/SKILL.md", "---\nname: Biography Agent\ndescription: Runs biography generation in the sandbox\n---\n");
    zip.file("biography-agent-longform/requirements.txt", "beautifulsoup4\n");
    zip.file("biography-agent-longform/run.py", "print('ok')\n");
    const skill = await uploadTenantSkill(session, await zip.generateAsync({ type: "uint8array" }));
    assert.equal(skill.status, "draft");
    assert.equal(await readFile(join(skill.storagePath, "requirements.txt"), "utf8"), "beautifulsoup4\n");
    assert.equal(await readFile(join(skill.storagePath, "run.py"), "utf8"), "print('ok')\n");
    assert.notEqual((await stat(join(skill.storagePath, "run.py"))).mode & 0o111, 0);
    assert.equal((await stat(join(skill.storagePath, "requirements.txt"))).mode & 0o111, 0);
  } finally {
    closeTenantStore();
    delete process.env.PI_WEB_DATABASE_PATH;
    delete process.env.PI_CODING_AGENT_DIR;
    await rm(root, { recursive: true, force: true });
  }
});

test("re-uploading the same Skill archive reuses its immutable release", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-idempotent-skill-"));
  process.env.PI_WEB_DATABASE_PATH = join(root, "tenant.sqlite");
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  closeTenantStore();
  const store = getTenantStore();
  try {
    const created = store.createTenantWithOwner({ tenant: { name: "Acme", slug: "acme" }, owner: { email: "owner@example.com", displayName: "Owner" } });
    const session = { sessionId: "session", user: created.owner, tenant: created.tenant, membership: created.membership, expiresAt: "" };
    const zip = new JSZip();
    zip.file("biography-book-assembler/SKILL.md", "---\nname: Biography Book Assembler\ndescription: Assemble approved chapters\n---\n");
    const archive = await zip.generateAsync({ type: "uint8array" });
    const first = await uploadTenantSkill(session, archive);
    const second = await uploadTenantSkill(session, archive);
    assert.equal(second.id, first.id);
    assert.equal(second.storagePath, first.storagePath);
    assert.equal((await listTenantSkillReleases(session)).length, 1);
  } finally {
    closeTenantStore();
    delete process.env.PI_WEB_DATABASE_PATH;
    delete process.env.PI_CODING_AGENT_DIR;
    await rm(root, { recursive: true, force: true });
  }
});

test("a stale deterministic release directory is rejected instead of reused", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-stale-skill-"));
  process.env.PI_WEB_DATABASE_PATH = join(root, "tenant.sqlite");
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  closeTenantStore();
  const store = getTenantStore();
  try {
    const created = store.createTenantWithOwner({ tenant: { name: "Acme", slug: "acme" }, owner: { email: "owner@example.com", displayName: "Owner" } });
    const session = { sessionId: "session", user: created.owner, tenant: created.tenant, membership: created.membership, expiresAt: "" };
    const zip = new JSZip();
    zip.file("biography-book-assembler/SKILL.md", "---\nname: Biography Book Assembler\ndescription: Assemble approved chapters\n---\n");
    const archive = await zip.generateAsync({ type: "uint8array" });
    const digest = createHash("sha256").update(Buffer.from(archive)).digest("hex");
    const storagePath = join(root, "agent", "tenant-skills", created.tenant.id, created.membership.id, `biography-book-assembler-${digest.slice(0, 16)}`);
    await mkdir(storagePath, { recursive: true });
    await writeFile(join(storagePath, "SKILL.md"), "tampered\n");
    await assert.rejects(uploadTenantSkill(session, archive), /different contents/);
  } finally {
    closeTenantStore();
    delete process.env.PI_WEB_DATABASE_PATH;
    delete process.env.PI_CODING_AGENT_DIR;
    await rm(root, { recursive: true, force: true });
  }
});

test("declared package Skill roots load while historical hidden copies stay out", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-declared-skill-roots-"));
  process.env.PI_WEB_DATABASE_PATH = join(root, "tenant.sqlite");
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  closeTenantStore();
  const store = getTenantStore();
  try {
    const created = store.createTenantWithOwner({ tenant: { name: "Acme", slug: "acme" }, owner: { email: "owner@example.com", displayName: "Owner" } });
    const session = { sessionId: "session", user: created.owner, tenant: created.tenant, membership: created.membership, expiresAt: "" };
    const zip = new JSZip();
    zip.file("bundle/SKILL.md", "---\nname: Assembler\ndescription: Assemble\n---\n");
    zip.file("bundle/.codex-plugin/plugin.json", JSON.stringify({ name: "bundle", skills: "./skills/" }));
    zip.file("bundle/skills/current/SKILL.md", "---\nname: Current Writer\ndescription: Current\n---\n");
    zip.file("bundle/.pi/skills/legacy/SKILL.md", "---\nname: Current Writer\ndescription: Legacy duplicate\n---\n");
    const skill = await uploadTenantSkill(session, await zip.generateAsync({ type: "uint8array" }));
    const paths = expandTenantSkillPaths([skill.storagePath]);
    assert.ok(paths.some((path) => path.endsWith("/skills")));
    assert.ok(!paths.some((path) => path.includes("/.pi/skills/legacy")));
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir: join(root, "agent"),
      additionalSkillPaths: paths,
      noExtensions: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      skillsOverride: (base) => ({
        skills: base.skills.filter((item) => paths.some((path) => item.filePath === path || item.filePath.startsWith(`${path}/`))),
        diagnostics: base.diagnostics,
      }),
    });
    await loader.reload();
    assert.deepEqual(loader.getSkills().skills.map((item) => item.name).sort(), ["Current Writer"]);
  } finally {
    closeTenantStore();
    delete process.env.PI_WEB_DATABASE_PATH;
    delete process.env.PI_CODING_AGENT_DIR;
    await rm(root, { recursive: true, force: true });
  }
});
