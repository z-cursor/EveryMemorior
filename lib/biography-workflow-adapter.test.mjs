import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const {
  BIOGRAPHY_WORKFLOW_TOOL_NAMES,
  buildBiographyBridgeArgs,
  createBiographyWorkflowAdapterExtension,
  resolveBiographyToolTimeoutMs,
} = await jiti.import("./biography-workflow-adapter.ts");

test("long-form bridge timeout is independent from the per-request LLM timeout", () => {
  assert.equal(resolveBiographyToolTimeoutMs("biography_chapter_writer", {
    PI_WEB_SKILL_LLM_TIMEOUT_SECONDS: "60",
  }), 2_400_000);
  assert.equal(resolveBiographyToolTimeoutMs("biography_chapter_writer", {
    PI_WEB_SKILL_LLM_TIMEOUT_SECONDS: "600",
    PI_WEB_SKILL_EXECUTION_TIMEOUT_SECONDS: "1800",
  }), 1_800_000);
  assert.equal(resolveBiographyToolTimeoutMs("biography_chapter_user_approval", {
    PI_WEB_SKILL_EXECUTION_TIMEOUT_SECONDS: "1800",
  }), 300_000);
});

test("workflow actions are not passed through the interviewer-only flag", () => {
  const args = buildBiographyBridgeArgs("biography_workflow", {
    action: "sync",
  }, "session-id");
  assert.deepEqual(args.slice(0, 5), ["sync", "--workspace-root", "/workspace", "--session-id", "session-id"]);
  assert.equal(args.includes("--interview-action"), false);
});

test("tenant biography adapter exposes server-owned tools without loading package TypeScript", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-biography-adapter-"));
  try {
    await mkdir(join(root, "biography-agent-longform", "scripts"), { recursive: true });
    await writeFile(join(root, "biography-agent-longform", "scripts", "pi_bridge.py"), "#!/usr/bin/env python3\n");
    await writeFile(join(root, "biography-agent-longform", "extensions", "evil.ts"), "throw new Error('must not load');\n").catch(() => undefined);
    const names = [];
    const extension = createBiographyWorkflowAdapterExtension({ skillPaths: [root], workspaceRoot: root });
    extension.factory({ registerTool(tool) { names.push(tool.name); } });
    assert.deepEqual(names, [...BIOGRAPHY_WORKFLOW_TOOL_NAMES]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("adapter reports missing bridge as an unavailable runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-biography-adapter-missing-"));
  try {
    const tools = [];
    const extension = createBiographyWorkflowAdapterExtension({ skillPaths: [root], workspaceRoot: root });
    extension.factory({ registerTool(tool) { tools.push(tool); } });
    const workflow = tools.find((tool) => tool.name === "biography_workflow");
    await assert.rejects(
      workflow.execute("call", { action: "active" }, undefined, undefined, { sessionManager: { getSessionId: () => "session" } }),
      /runtime artifact not ready/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source paths cannot escape the mounted workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-biography-adapter-path-"));
  try {
    await mkdir(join(root, "scripts"), { recursive: true });
    await writeFile(join(root, "scripts", "pi_bridge.py"), "#!/usr/bin/env python3\n");
    const tools = [];
    createBiographyWorkflowAdapterExtension({ skillPaths: [root], workspaceRoot: root }).factory({
      registerTool(tool) { tools.push(tool); },
    });
    const source = tools.find((tool) => tool.name === "biography_chapter_source");
    await assert.rejects(
      source.execute("call", { chapter: 1, source_path: "/workspace/../../etc/passwd" }, undefined, undefined, { sessionManager: { getSessionId: () => "session" } }),
      /remain inside|inside the tenant workspace/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
