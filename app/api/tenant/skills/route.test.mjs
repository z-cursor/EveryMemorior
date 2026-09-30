import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import JSZip from "jszip";
import { createJiti } from "jiti";
import { NextRequest } from "next/server.js";

const root = await mkdtemp(join(tmpdir(), "pi-web-tenant-skills-route-"));
const originalDatabasePath = process.env.PI_WEB_DATABASE_PATH;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_WEB_DATABASE_PATH = join(root, "tenant.sqlite");
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const { DELETE, GET, POST } = await jiti.import("./route.ts");
const { setupTenantOwner, TENANT_SESSION_COOKIE } = await jiti.import("../../../../lib/tenant-auth.ts");
const { closeTenantStore } = await jiti.import("../../../../lib/tenant-store.ts");

const owner = await setupTenantOwner({
  tenantName: "Skills",
  tenantSlug: "skills",
  displayName: "Owner",
  email: "owner@skills.test",
  password: "correct horse battery staple",
});

function request(method, url, init = {}) {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: { Cookie: `${TENANT_SESSION_COOKIE}=${owner.token}`, ...(init.headers ?? {}) },
    ...init,
  });
}

after(async () => {
  closeTenantStore();
  if (originalDatabasePath === undefined) delete process.env.PI_WEB_DATABASE_PATH;
  else process.env.PI_WEB_DATABASE_PATH = originalDatabasePath;
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await rm(root, { recursive: true, force: true });
});

test("DELETE removes an uploaded Skill from the tenant catalog", async () => {
  const zip = new JSZip();
  zip.file("temporary/SKILL.md", "---\nname: Temporary\ndescription: Temporary skill\n---\n");
  const form = new FormData();
  form.set("file", new File([await zip.generateAsync({ type: "uint8array" })], "temporary.zip", { type: "application/zip" }));
  const uploaded = await POST(request("POST", "/api/tenant/skills", { body: form }));
  assert.equal(uploaded.status, 201);
  const skill = (await uploaded.json()).skill;

  const deleted = await DELETE(request("DELETE", `/api/tenant/skills?skillId=${encodeURIComponent(skill.id)}`));
  assert.equal(deleted.status, 200);
  assert.equal((await deleted.json()).skill.status, "archived");
  const listed = await GET(request("GET", "/api/tenant/skills"));
  assert.deepEqual((await listed.json()).skills, []);
});
