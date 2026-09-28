import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createTenantReadTools, isTenantWorkspaceToolSelection } = await jiti.import("./tenant-read-tools.ts");

test("tenant tool policy allows Chat, read-only, and virtual-workspace Work selections only", () => {
  assert.equal(isTenantWorkspaceToolSelection(["read", "grep", "find", "ls"]), true);
  assert.equal(isTenantWorkspaceToolSelection(["read", "write", "edit", "grep", "find", "ls"]), true);
  assert.equal(isTenantWorkspaceToolSelection(["bash"]), false);
  assert.equal(isTenantWorkspaceToolSelection(["read", "bash"]), false);
});

test("tenant read tool errors use the virtual workspace path", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-tenant-read-"));
  await mkdir(join(root, "nested"));
  try {
    const read = createTenantReadTools(root).find((tool) => tool.name === "read");
    assert.ok(read);
    await assert.rejects(
      read.execute("read-missing", { path: "nested/index.html" }, undefined, undefined, { cwd: root }),
      (error) => {
        assert.match(error.message, /\/workspace[\\/]nested[\\/]index\.html/);
        assert.doesNotMatch(error.message, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tenant work tools write inside the virtual workspace and reject outside paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-tenant-write-"));
  try {
    const tools = createTenantReadTools(root);
    const write = tools.find((tool) => tool.name === "write");
    assert.ok(write);

    await write.execute("write-index", { path: "index.html", content: "<h1>ok</h1>" }, undefined, undefined, { cwd: root });
    assert.equal(await readFile(join(root, "index.html"), "utf8"), "<h1>ok</h1>");

    const edit = tools.find((tool) => tool.name === "edit");
    assert.ok(edit);
    await edit.execute("edit-index", {
      path: "index.html",
      edits: [{ oldText: "ok", newText: "done" }],
    }, undefined, undefined, { cwd: root });
    assert.equal(await readFile(join(root, "index.html"), "utf8"), "<h1>done</h1>");

    await assert.rejects(
      write.execute("write-outside", { path: join(root, "..", "outside.html"), content: "nope" }, undefined, undefined, { cwd: root }),
      /outside your personal workspace/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
