import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";
import { NextRequest } from "next/server.js";

const root = mkdtempSync(join(tmpdir(), "pi-web-file-delete-"));
const previousDatabase = process.env.PI_WEB_DATABASE_PATH;
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_WEB_DATABASE_PATH = join(root, "tenant.sqlite");
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const { setupTenantOwner, TENANT_SESSION_COOKIE } = await jiti.import("../../../lib/tenant-auth.ts");
const { getTenantStore, closeTenantStore } = await jiti.import("../../../lib/tenant-store.ts");
const { allowFileRoot } = await jiti.import("../../../lib/file-access.ts");
const { DELETE: deleteFile, POST: uploadFiles } = await jiti.import("./[...path]/route.ts");

const auth = await setupTenantOwner({
  tenantName: "Delete", tenantSlug: "delete", displayName: "Owner",
  email: "owner@delete.test", password: "correct horse battery staple",
});
const workspace = join(root, "workspace");
mkdirSync(workspace, { recursive: true });
allowFileRoot(workspace);
getTenantStore().ensureWorkspace(
  { tenantId: auth.session.tenant.id, membershipId: auth.session.membership.id },
  { name: "Workspace", rootPath: workspace },
);

after(() => {
  closeTenantStore();
  if (previousDatabase === undefined) delete process.env.PI_WEB_DATABASE_PATH;
  else process.env.PI_WEB_DATABASE_PATH = previousDatabase;
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(root, { recursive: true, force: true });
});

function request() {
  return new NextRequest("http://localhost/api/files/delete", {
    method: "DELETE",
    headers: { Cookie: `${TENANT_SESSION_COOKIE}=${auth.token}`, Host: "localhost" },
  });
}

function uploadRequest(body) {
  return new NextRequest("http://localhost/api/files/upload?type=upload&conflict=error", {
    method: "POST",
    headers: { Cookie: `${TENANT_SESSION_COOKIE}=${auth.token}`, Host: "localhost" },
    body,
  });
}

test("deletes files and directories while refusing to delete its workspace root", async () => {
  const note = join(workspace, "note.txt");
  writeFileSync(note, "delete me");
  const deleted = await deleteFile(request(), { params: Promise.resolve({ path: [note] }) });
  assert.equal(deleted.status, 200);
  assert.equal(existsSync(note), false);

  const folder = join(workspace, "folder");
  mkdirSync(folder);
  writeFileSync(join(folder, "nested.txt"), "delete me too");
  const deletedFolder = await deleteFile(request(), { params: Promise.resolve({ path: [folder] }) });
  assert.equal(deletedFolder.status, 200);
  assert.equal(existsSync(folder), false);

  const rootResponse = await deleteFile(request(), { params: Promise.resolve({ path: [workspace] }) });
  assert.equal(rootResponse.status, 400);
});

test("uploads a folder entry using its relative path metadata", async () => {
  const body = new FormData();
  body.append("files", new File(["skill"], "SKILL.md"), "SKILL.md");
  body.append("filePaths", JSON.stringify(["prototype/SKILL.md"]));
  const response = await uploadFiles(uploadRequest(body), { params: Promise.resolve({ path: [workspace] }) });
  assert.equal(response.status, 200);
  assert.equal(existsSync(join(workspace, "prototype", "SKILL.md")), true);
});
