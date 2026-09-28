import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import JSZip from "jszip";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { closeTenantStore, getTenantStore } from "./tenant-store.ts";
import { listTenantSkillReleases, publishedTenantSkillPaths, uploadTenantSkill, transitionTenantSkill } from "./tenant-skills.ts";

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
    zip.file("demo/script.sh", "echo safe\n");
    const draft = await uploadTenantSkill(session, await zip.generateAsync({ type: "uint8array" }));
    assert.equal(draft.status, "draft");
    assert.equal(draft.version, 1);
    assert.equal(await readFile(join(draft.storagePath, "script.sh"), "utf8"), "echo safe\n");
    const pending = transitionTenantSkill(session, "submit", draft.id);
    assert.equal(pending.status, "pending_review");
    const published = transitionTenantSkill(session, "publish", draft.id);
    assert.equal(published.status, "published");
    assert.equal(store.listPublishedTenantSkillPaths(created.tenant.id, created.membership.id).length, 1);
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
  } finally {
    closeTenantStore();
    delete process.env.PI_WEB_DATABASE_PATH;
    delete process.env.PI_CODING_AGENT_DIR;
    await rm(root, { recursive: true, force: true });
  }
});
