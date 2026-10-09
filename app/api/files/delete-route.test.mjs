import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
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

function targetUpload(target, paths, strategy = "error", cwd = workspace) {
  const body = new FormData();
  paths.forEach((name) => body.append("files", new File([`new:${name}`], name.split("/").pop())));
  body.append("filePaths", JSON.stringify(paths));
  return uploadFiles(new NextRequest(`http://localhost/api/files/upload?type=upload&conflict=${strategy}&cwd=${encodeURIComponent(cwd)}`, {
    method: "POST", headers: { Cookie: `${TENANT_SESSION_COOKIE}=${auth.token}`, Host: "localhost" }, body,
  }), { params: Promise.resolve({ path: [target] }) });
}

test("uploading a colliding folder keeps its structure in one renamed top-level directory", async () => {
  const target = join(workspace, "group-target"); mkdirSync(join(target, "trip"), { recursive: true });
  writeFileSync(join(target, "trip", "original.txt"), "original");
  const response = await targetUpload(target, ["trip/a.txt", "trip/sub/b.txt"], "rename");
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).uploaded, ["trip (1)/a.txt", "trip (1)/sub/b.txt"]);
  assert.equal(readFileSync(join(target, "trip", "original.txt"), "utf8"), "original");
  assert.equal(existsSync(join(target, "trip", "a.txt")), false);
  assert.equal(readFileSync(join(target, "trip (1)", "sub", "b.txt"), "utf8"), "new:trip/sub/b.txt");
});

test("upload target cannot escape its current Workspace into another owned Workspace", async () => {
  const other = join(root, "other-workspace"); mkdirSync(other); allowFileRoot(other);
  getTenantStore().ensureWorkspace({ tenantId: auth.session.tenant.id, membershipId: auth.session.membership.id }, { name: "Other", rootPath: other });
  const response = await targetUpload(other, ["escape.txt"]);
  assert.equal(response.status, 403);
  assert.equal(existsSync(join(other, "escape.txt")), false);
});

test("folder upload detects top-level collision even when leaf names differ and never merges", async () => {
  const target = join(workspace, "no-merge"); mkdirSync(join(target, "trip"), { recursive: true });
  writeFileSync(join(target, "trip", "old.txt"), "old");
  const response = await targetUpload(target, ["trip/new.txt"]);
  assert.equal(response.status, 409);
  assert.deepEqual((await response.json()).conflicts, ["trip"]);
  const skip = await targetUpload(target, ["trip/new.txt", "other.txt"], "skip");
  assert.deepEqual((await skip.json()).skipped, ["trip/new.txt"]);
  const replace = await targetUpload(target, ["trip/new.txt"], "overwrite");
  assert.equal(replace.status, 207);
  assert.equal(existsSync(join(target, "trip", "new.txt")), false);
  assert.equal(readFileSync(join(target, "trip", "old.txt"), "utf8"), "old");
});

test("ordinary uploads rename before extension and allow explicitly selected replacement", async () => {
  const target = join(workspace, "file-conflicts"); mkdirSync(target);
  writeFileSync(join(target, "photo.jpg"), "old");
  writeFileSync(join(target, "photo (1).jpg"), "reserved");
  const renamed = await targetUpload(target, ["photo.jpg"], "rename");
  assert.deepEqual((await renamed.json()).uploaded, ["photo (2).jpg"]);
  assert.equal(readFileSync(join(target, "photo.jpg"), "utf8"), "old");
  const replaced = await targetUpload(target, ["photo.jpg"], "overwrite");
  assert.equal(replaced.status, 200);
  assert.equal(readFileSync(join(target, "photo.jpg"), "utf8"), "new:photo.jpg");
});

test("upload cannot introduce protected directories", async () => {
  const target = join(workspace, "protected-upload"); mkdirSync(target);
  const response = await targetUpload(target, [".git/config"]);
  assert.equal(response.status, 400);
  assert.equal(existsSync(join(target, ".git")), false);
});
