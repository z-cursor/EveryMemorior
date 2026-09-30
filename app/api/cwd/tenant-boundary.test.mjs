import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";
import { NextRequest } from "next/server.js";

const root = mkdtempSync(join(tmpdir(), "pi-web-tenant-boundary-"));
const previousDatabase = process.env.PI_WEB_DATABASE_PATH;
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_WEB_DATABASE_PATH = join(root, "tenant.sqlite");
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false,
});
const {
  setupTenantOwner, acceptTenantInvitation, createTenantOrganization, canManageHostConfiguration,
  requireTenantSession, TENANT_SESSION_COOKIE,
} = await jiti.import("../../../lib/tenant-auth.ts");
const { getTenantStore, closeTenantStore } = await jiti.import("../../../lib/tenant-store.ts");
const { POST: validateCwd } = await jiti.import("./validate/route.ts");
const { GET: browseCwd } = await jiti.import("./browse/route.ts");
const { POST: defaultCwd } = await jiti.import("../default-cwd/route.ts");
const { GET: getHome } = await jiti.import("../home/route.ts");
const { GET: listProjects, PATCH: renameProject } = await jiti.import("../projects/route.ts");
const { POST: createTerminal } = await jiti.import("../terminal/route.ts");
const { POST: createAgent } = await jiti.import("../agent/new/route.ts");
const { POST: commandAgent } = await jiti.import("../agent/[id]/route.ts");
const { GET: getBashOutput } = await jiti.import("../agent/[id]/bash-output/route.ts");
const { GET: fileIndex } = await jiti.import("../file-index/route.ts");
const { GET: gitStatus } = await jiti.import("../git/status/route.ts");
const { GET: getModels } = await jiti.import("../models/route.ts");
const { GET: searchSessions } = await jiti.import("../sessions/search/route.ts");
const { GET: listSessions } = await jiti.import("../sessions/route.ts");
const { GET: getSessionDetail } = await jiti.import("../sessions/[id]/route.ts");
const { GET: getFiles, POST: uploadFiles } = await jiti.import("../files/[...path]/route.ts");
const { canAccessWorkspacePath, tenantManagedWorkspaceRoot, workspacePathFromClient, workspacePathToClient } = await jiti.import("../../../lib/tenant-workspace.ts");
const { allowFileRoot } = await jiti.import("../../../lib/file-access.ts");
const { invalidateSessionListCache } = await jiti.import("../../../lib/session-reader.ts");
const owner = await setupTenantOwner({
  tenantName: "First", tenantSlug: "first", displayName: "Owner",
  email: "owner@first.test", password: "correct horse battery staple",
});
const rawToken = "invited-member-token";
getTenantStore().createInvitation({
  tenantId: owner.session.tenant.id, membershipId: owner.session.membership.id,
}, {
  email: "member@first.test", role: "member",
  tokenHash: createHash("sha256").update(rawToken).digest("hex"),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
});
const invited = await acceptTenantInvitation({
  token: rawToken, displayName: "Member", password: "correct horse battery staple",
});
const headers = { Cookie: `${TENANT_SESSION_COOKIE}=${invited.token}` };

after(() => {
  closeTenantStore();
  if (previousDatabase === undefined) delete process.env.PI_WEB_DATABASE_PATH;
  else process.env.PI_WEB_DATABASE_PATH = previousDatabase;
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(root, { recursive: true, force: true });
});

test("the installation owner cannot adopt another membership root before its workspace row exists", () => {
  const memberRoot = tenantManagedWorkspaceRoot(invited.session);
  assert.equal(canAccessWorkspacePath(owner.session, memberRoot), false);
});

test("invited members cannot validate an arbitrary host directory", async () => {
  const response = await validateCwd(new Request("http://localhost/api/cwd/validate", {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ cwd: root }),
  }));
  assert.equal(response.status, 403);
});

test("members can rename only their virtual project and see its path", async () => {
  const request = (projectRoot, name) => new Request("http://localhost/api/projects", {
    method: "PATCH", headers: { ...headers, Host: "localhost", Origin: "http://localhost", "Content-Type": "application/json" },
    body: JSON.stringify({ root: projectRoot, name }),
  });
  assert.equal((await renameProject(request(root, "Forbidden"))).status, 403);
  const renamed = await renameProject(request("/workspace", "Private notes"));
  assert.equal(renamed.status, 200);
  assert.deepEqual((await renamed.json()).project.root, "/workspace");
  const listed = await listProjects(new Request("http://localhost/api/projects", { headers: { ...headers, Host: "localhost" } }));
  assert.equal(listed.status, 200);
  assert.ok((await listed.json()).projects.some((project) => project.root === "/workspace" && project.name === "Private notes"));

  const ownerListed = await listProjects(new Request("http://localhost/api/projects", {
    headers: { Cookie: `${TENANT_SESSION_COOKIE}=${owner.token}`, Host: "localhost" },
  }));
  assert.equal(ownerListed.status, 200);
  assert.equal((await ownerListed.json()).projects.some((project) => project.root === "/workspace"), false);
});

test("invited members cannot browse the host directory tree", async () => {
  const response = await browseCwd(new NextRequest(`http://localhost/api/cwd/browse?path=${encodeURIComponent(root)}`, { headers }));
  assert.equal(response.status, 403);
});

test("global file roots do not grant invited members file-index or Git access", async () => {
  allowFileRoot(root);
  const query = `?cwd=${encodeURIComponent(root)}`;
  assert.equal((await fileIndex(new NextRequest(`http://localhost/api/file-index${query}`, { headers }))).status, 403);
  assert.equal((await gitStatus(new NextRequest(`http://localhost/api/git/status${query}`, { headers }))).status, 403);
  assert.equal((await getModels(new Request(`http://localhost/api/models${query}`, { headers }))).status, 403);
});

test("invited members cannot find the installation owner's session contents", async () => {
  const sessionId = "host-private-session";
  const sessionDirectory = join(root, "agent", "sessions", "host-project");
  mkdirSync(sessionDirectory, { recursive: true });
  writeFileSync(join(sessionDirectory, `2026-09-20T00-00-00-000Z_${sessionId}.jsonl`), [
    JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-09-20T00:00:00.000Z", cwd: root }),
    JSON.stringify({ type: "message", id: "private01", parentId: null, timestamp: "2026-09-20T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "HOST_PRIVATE_NEEDLE" }] } }),
  ].join("\n") + "\n");
  const context = { tenantId: owner.session.tenant.id, membershipId: owner.session.membership.id };
  const workspace = getTenantStore().ensureWorkspace(context, { name: "Host", rootPath: root });
  getTenantStore().bindAgentSession(context, workspace.id, sessionId);
  invalidateSessionListCache();

  const response = await searchSessions(new Request("http://localhost/api/sessions/search?q=HOST_PRIVATE_NEEDLE", { headers }));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).results, []);
});

test("invited members start inside their own tenant workspace", async () => {
  const home = await getHome(new Request("http://localhost/api/home", { headers }));
  const homePath = (await home.json()).home;
  assert.equal(homePath, "/workspace");
  const physicalRoot = join(root, "agent", "tenant-workspaces", invited.session.tenant.id, invited.session.membership.id);
  assert.equal(workspacePathFromClient(invited.session, homePath), physicalRoot);
  assert.equal(workspacePathToClient(invited.session, physicalRoot), homePath);
  assert.equal(workspacePathFromClient(invited.session, physicalRoot), null);
  assert.equal(workspacePathFromClient(invited.session, "/workspace/../agent"), null);
  assert.equal(workspacePathFromClient(invited.session, "/workspace\\..\\agent"), null);

  const created = await defaultCwd(new Request("http://localhost/api/default-cwd", {
    method: "POST", headers,
  }));
  assert.equal((await created.json()).cwd, homePath);

  const browsed = await browseCwd(new NextRequest("http://localhost/api/cwd/browse", { headers }));
  assert.equal(browsed.status, 200);
  assert.equal((await browsed.json()).path, homePath);

  const nested = join(physicalRoot, "project");
  mkdirSync(nested, { recursive: true });
  const validated = await validateCwd(new Request("http://localhost/api/cwd/validate", {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ cwd: "/workspace/project" }),
  }));
  assert.equal(validated.status, 200);
  const validatedBody = await validated.json();
  assert.equal(validatedBody.cwd, "/workspace/project");
  assert.equal(validatedBody.projectRoot, "/workspace");
  assert.ok(!validatedBody.projectKey.includes(physicalRoot));
  const browsedChildren = await browseCwd(new NextRequest("http://localhost/api/cwd/browse?path=%2Fworkspace", { headers }));
  assert.deepEqual((await browsedChildren.json()).directories, [{ name: "project", path: "/workspace/project" }]);
  const list = await getFiles(new NextRequest("http://localhost/api/files/workspace?type=list", { headers }), {
    params: Promise.resolve({ path: ["workspace"] }),
  });
  assert.equal(list.status, 200);
  assert.equal((await list.json()).path, "/workspace");
  const models = await getModels(new Request("http://localhost/api/models?cwd=%2Fworkspace", { headers }));
  assert.equal(models.status, 200);
  const rawPath = await getFiles(new NextRequest(`http://localhost/api/files/${encodeURIComponent(physicalRoot)}?type=list`, { headers }), {
    params: Promise.resolve({ path: [physicalRoot] }),
  });
  assert.equal(rawPath.status, 403);
  const traversal = await getFiles(new NextRequest("http://localhost/api/files/workspace/../agent?type=list", { headers }), {
    params: Promise.resolve({ path: ["workspace", "..", "agent"] }),
  });
  assert.equal(traversal.status, 403);

  const form = new FormData();
  form.append("files", new File(["tenant data"], "note.txt", { type: "text/plain" }));
  const uploaded = await uploadFiles(new NextRequest("http://localhost/api/files/workspace?type=upload", {
    method: "POST", headers: { ...headers, Host: "localhost" }, body: form,
  }), { params: Promise.resolve({ path: ["workspace"] }) });
  assert.equal(uploaded.status, 200);
  const read = await getFiles(new NextRequest("http://localhost/api/files/workspace/note.txt?type=read", { headers }), {
    params: Promise.resolve({ path: ["workspace", "note.txt"] }),
  });
  assert.equal(read.status, 200);
  assert.equal((await read.json()).content, "tenant data");
  const download = await getFiles(new NextRequest("http://localhost/api/files/workspace/note.txt?type=download", { headers }), {
    params: Promise.resolve({ path: ["workspace", "note.txt"] }),
  });
  assert.equal(download.status, 200);
  assert.equal(await download.text(), "tenant data");
  assert.match(download.headers.get("content-disposition") ?? "", /attachment; filename="note\.txt"/);
  assert.doesNotMatch(download.headers.get("content-disposition") ?? "", /tenant-workspaces|AppData|Users/);

});

test("workspace uploads preserve Skill directory paths", async () => {
  const skillForm = new FormData();
  skillForm.append("files", new File(["---\nname: sandbox-check\ndescription: verify execution\n---\n"], ".agents/skills/sandbox-check/SKILL.md", { type: "text/markdown" }));
  const skillUpload = await uploadFiles(new NextRequest("http://localhost/api/files/workspace?type=upload", {
    method: "POST", headers: { ...headers, Host: "localhost" }, body: skillForm,
  }), { params: Promise.resolve({ path: ["workspace"] }) });
  assert.equal(skillUpload.status, 200);
  const skillRead = await getFiles(new NextRequest("http://localhost/api/files/workspace/.agents/skills/sandbox-check/SKILL.md?type=read", { headers }), {
    params: Promise.resolve({ path: ["workspace", ".agents", "skills", "sandbox-check", "SKILL.md"] }),
  });
  assert.equal(skillRead.status, 200);
});

test("folder upload rejects a symlinked parent before writing outside the workspace", async (t) => {
  const physicalRoot = workspacePathFromClient(invited.session, "/workspace");
  const outside = join(root, "outside-upload");
  mkdirSync(outside);
  try {
    symlinkSync(outside, join(physicalRoot, "skill-link"), "junction");
  } catch (error) {
    if (error?.code === "EPERM") return t.skip("Creating symbolic links requires additional privileges");
    throw error;
  }
  const fileName = "skill-link/sandbox-check/SKILL.md";
  const check = await uploadFiles(new NextRequest("http://localhost/api/files/workspace?type=upload-check", {
    method: "POST", headers: { ...headers, Host: "localhost", "Content-Type": "application/json" },
    body: JSON.stringify({ fileNames: [fileName] }),
  }), { params: Promise.resolve({ path: ["workspace"] }) });
  assert.equal(check.status, 400);
  const form = new FormData();
  form.append("files", new File(["unsafe"], fileName));
  const upload = await uploadFiles(new NextRequest("http://localhost/api/files/workspace?type=upload", {
    method: "POST", headers: { ...headers, Host: "localhost" }, body: form,
  }), { params: Promise.resolve({ path: ["workspace"] }) });
  assert.equal(upload.status, 400);
  assert.equal(existsSync(join(outside, "sandbox-check")), false);
});

test("tenant session responses expose virtual cwd but not JSONL host paths", async () => {
  const sessionId = "tenant-virtual-session";
  const physicalRoot = workspacePathFromClient(invited.session, "/workspace");
  const sessionDirectory = join(root, "agent", "sessions", "tenant-project");
  mkdirSync(sessionDirectory, { recursive: true });
  const sessionFile = join(sessionDirectory, `2026-09-20T00-00-00-000Z_${sessionId}.jsonl`);
  writeFileSync(sessionFile, [
    JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-09-20T00:00:00.000Z", cwd: physicalRoot }),
    JSON.stringify({ type: "message", id: "tenant01", parentId: null, timestamp: "2026-09-20T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "hello" }] } }),
  ].join("\n") + "\n");
  const context = { tenantId: invited.session.tenant.id, membershipId: invited.session.membership.id };
  const workspace = getTenantStore().ensureWorkspace(context, { name: "Tenant", rootPath: physicalRoot });
  getTenantStore().bindAgentSession(context, workspace.id, sessionId);
  invalidateSessionListCache();

  const listed = await listSessions(new Request("http://localhost/api/sessions?force=1", { headers }));
  assert.equal(listed.status, 200);
  const listedInfo = (await listed.json()).sessions.find((item) => item.id === sessionId);
  assert.equal(listedInfo.cwd, "/workspace");
  assert.equal(listedInfo.projectRoot, "/workspace");
  assert.equal(listedInfo.path, "");

  const detail = await getSessionDetail(new Request(`http://localhost/api/sessions/${sessionId}`, { headers }), {
    params: Promise.resolve({ id: sessionId }),
  });
  assert.equal(detail.status, 200);
  const detailBody = await detail.json();
  assert.equal(detailBody.filePath, "");
  assert.equal(detailBody.info.cwd, "/workspace");
  assert.equal(detailBody.info.path, "");

  const search = await searchSessions(new Request("http://localhost/api/sessions/search?q=hello", { headers }));
  const searchResult = (await search.json()).results.find((item) => item.session.id === sessionId);
  assert.equal(searchResult.session.cwd, "/workspace");
  assert.equal(searchResult.session.path, "");
});

test("the installation owner cannot list a member's bound session", async () => {
  const sessionId = "member-private-session";
  const physicalRoot = workspacePathFromClient(invited.session, "/workspace");
  const sessionDirectory = join(root, "agent", "sessions", "member-private");
  mkdirSync(sessionDirectory, { recursive: true });
  writeFileSync(join(sessionDirectory, `2026-09-21T00-00-00-000Z_${sessionId}.jsonl`), [
    JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-09-21T00:00:00.000Z", cwd: physicalRoot }),
    JSON.stringify({ type: "message", id: "member01", parentId: null, timestamp: "2026-09-21T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "member-only" }] } }),
  ].join("\n") + "\n");
  const context = { tenantId: invited.session.tenant.id, membershipId: invited.session.membership.id };
  const workspace = getTenantStore().ensureWorkspace(context, { name: "Member private", rootPath: physicalRoot });
  getTenantStore().bindAgentSession(context, workspace.id, sessionId);
  invalidateSessionListCache();

  const ownerHeaders = { Cookie: `${TENANT_SESSION_COOKIE}=${owner.token}` };
  const response = await listSessions(new Request("http://localhost/api/sessions?force=1", { headers: ownerHeaders }));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).sessions.some((item) => item.id === sessionId), false);
});

test("archived session bindings stay hidden and cannot be adopted again", async () => {
  const sessionId = "archived-owner-session";
  const archivedRoot = join(root, "archived-project");
  mkdirSync(archivedRoot, { recursive: true });
  const sessionDirectory = join(root, "agent", "sessions", "archived-project");
  mkdirSync(sessionDirectory, { recursive: true });
  writeFileSync(join(sessionDirectory, `2026-09-22T00-00-00-000Z_${sessionId}.jsonl`), [
    JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "2026-09-22T00:00:00.000Z", cwd: archivedRoot }),
    JSON.stringify({ type: "message", id: "archived01", parentId: null, timestamp: "2026-09-22T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "archived-private" }] } }),
  ].join("\n") + "\n");
  const context = { tenantId: owner.session.tenant.id, membershipId: owner.session.membership.id };
  const store = getTenantStore();
  const workspace = store.ensureWorkspace(context, { name: "Archived", rootPath: archivedRoot });
  store.bindAgentSession(context, workspace.id, sessionId);
  store.archiveWorkspaceByRoot(context, archivedRoot);
  invalidateSessionListCache();

  const listed = await listSessions(new Request("http://localhost/api/sessions?force=1", {
    headers: { Cookie: `${TENANT_SESSION_COOKIE}=${owner.token}` },
  }));
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).sessions.some((item) => item.id === sessionId), false);
  assert.equal(store.listArchivedWorkspaces(owner.session.tenant.id).some((item) => item.rootPath === archivedRoot), true);

  const detail = await getSessionDetail(new Request(`http://localhost/api/sessions/${sessionId}`, {
    headers: { Cookie: `${TENANT_SESSION_COOKIE}=${owner.token}` },
  }), { params: Promise.resolve({ id: sessionId }) });
  assert.equal(detail.status, 403);
});

test("an account cannot read another account's workspace files", async () => {
  const memberRoot = workspacePathFromClient(invited.session, "/workspace");
  const ownerHeaders = { Cookie: `${TENANT_SESSION_COOKIE}=${owner.token}` };
  const response = await getFiles(new NextRequest(`http://localhost/api/files/${encodeURIComponent(memberRoot)}?type=list`, {
    headers: ownerHeaders,
  }), { params: Promise.resolve({ path: [memberRoot] }) });
  assert.equal(response.status, 403);
});

test("the same virtual path resolves to separate organization storage", async () => {
  const second = createTenantOrganization(invited.session, { name: "Second", slug: "second" });
  const firstRoot = workspacePathFromClient(invited.session, "/workspace");
  const secondRoot = workspacePathFromClient(second.session, "/workspace");
  assert.notEqual(firstRoot, secondRoot);
  const secondHeaders = { Cookie: `${TENANT_SESSION_COOKIE}=${second.token}` };
  const secondList = await getFiles(new NextRequest("http://localhost/api/files/workspace?type=list", { headers: secondHeaders }), {
    params: Promise.resolve({ path: ["workspace"] }),
  });
  assert.equal(secondList.status, 200);
  assert.deepEqual((await secondList.json()).entries, []);
  assert.equal(workspacePathFromClient(second.session, firstRoot), null);
});

test("invited members cannot create a host terminal or Agent outside their workspace", async () => {
  const terminal = await createTerminal(new Request("http://localhost/api/terminal", {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ cwd: root }),
  }));
  assert.equal(terminal.status, 403);

  const agent = await createAgent(new Request("http://localhost/api/agent/new", {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ cwd: root, type: "ensure_session" }),
  }));
  assert.equal(agent.status, 403);
});

test("invited members cannot send direct Bash or enable Agent tools", async () => {
  for (const body of [{ type: "bash", command: "whoami" }, { type: "set_tools", toolNames: ["bash"] }]) {
    const response = await commandAgent(new Request("http://localhost/api/agent/unknown", {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }), { params: Promise.resolve({ id: "unknown" }) });
    assert.equal(response.status, 403);
  }
  const output = await getBashOutput(new Request("http://localhost/api/agent/unknown/bash-output?path=ignored", {
    headers,
  }), { params: Promise.resolve({ id: "unknown" }) });
  assert.equal(output.status, 403);
});

test("promoting an invited member does not grant installation host access", async () => {
  const request = new Request("http://localhost", { headers });
  const context = { tenantId: owner.session.tenant.id, membershipId: owner.session.membership.id };
  assert.equal(canManageHostConfiguration(owner.session), true);
  for (const role of ["admin", "owner"]) {
    getTenantStore().updateMembershipRole(context, invited.session.membership.id, role);
    assert.equal(canManageHostConfiguration(requireTenantSession(request)), false);
    const response = await validateCwd(new Request("http://localhost/api/cwd/validate", {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: root }),
    }));
    assert.equal(response.status, 403);
  }
});
