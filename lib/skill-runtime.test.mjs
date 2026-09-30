import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const { resolveSkillRuntime, DEFAULT_SKILL_RUNTIME_IMAGE, SkillRuntimeConfigurationError } = await createJiti(import.meta.url).import("./skill-runtime.ts");

test("biography runtime selects the preloaded node and Python image", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-skill-runtime-"));
  try {
    await mkdir(join(root, "scripts"), { recursive: true });
    await writeFile(join(root, "requirements.txt"), "jsonschema>=4.23.0,<5\n");
    await writeFile(join(root, "package.json"), "{\"name\":\"fixture\"}\n");
    await writeFile(join(root, "scripts", "run.py"), "print('ok')\n");
    const runtime = resolveSkillRuntime([root]);
    assert.equal(runtime.image, DEFAULT_SKILL_RUNTIME_IMAGE);
    assert.equal(runtime.profile, "node22-python3");
    assert.equal(runtime.hasPython, true);
    assert.equal(runtime.hasNode, true);
    assert.equal(runtime.dependencyFiles.length, 2);
    assert.match(runtime.releaseDigest, /^[a-f0-9]{64}$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime manifests can select a reviewed image and reject unsafe values", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-skill-runtime-manifest-"));
  try {
    await writeFile(join(root, ".pi-web-runtime.json"), JSON.stringify({
      image: "registry.internal/pi-skill@sha256:" + "a".repeat(64),
      imageDigest: "sha256:" + "a".repeat(64),
      profile: "python311-jsonschema",
    }));
    const selected = resolveSkillRuntime([root]);
    assert.equal(selected.profile, "python311-jsonschema");
    assert.equal(selected.imageDigest, "sha256:" + "a".repeat(64));

    await writeFile(join(root, ".pi-web-runtime.json"), '{"image":"bad\\nimage"}');
    assert.throws(() => resolveSkillRuntime([root]), SkillRuntimeConfigurationError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("different reviewed runtime profiles cannot be mixed", async () => {
  const first = await mkdtemp(join(tmpdir(), "pi-web-skill-runtime-a-"));
  const second = await mkdtemp(join(tmpdir(), "pi-web-skill-runtime-b-"));
  try {
    await writeFile(join(first, ".pi-web-runtime.json"), JSON.stringify({ profile: "python311" }));
    await writeFile(join(second, ".pi-web-runtime.json"), JSON.stringify({ profile: "node22" }));
    assert.throws(() => resolveSkillRuntime([first, second]), /incompatible runtime profiles/);
  } finally {
    await Promise.all([
      rm(first, { recursive: true, force: true }),
      rm(second, { recursive: true, force: true }),
    ]);
  }
});

test("declarative packages may carry package metadata without requiring an execution image", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-skill-runtime-declarative-"));
  try {
    await writeFile(join(root, "SKILL.md"), "---\nname: Static\n---\n");
    await writeFile(join(root, "package.json"), "{}\n");
    const runtime = resolveSkillRuntime([{
      storagePath: root,
      declarative: true,
      buildStatus: "ready",
    }]);
    assert.equal(runtime.hasNode, true);
    assert.equal(runtime.image, undefined);
    assert.equal(runtime.requiresImage, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("execution scripts require a prebuilt image even without package metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-skill-runtime-script-"));
  try {
    await writeFile(join(root, "run.mjs"), "console.log('ok')\n");
    const runtime = resolveSkillRuntime([root]);
    assert.equal(runtime.requiresImage, true);
    assert.equal(runtime.image, DEFAULT_SKILL_RUNTIME_IMAGE);
    assert.equal(runtime.profile, "node22");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shell and shebang entry points require a prebuilt image", async () => {
  const shellRoot = await mkdtemp(join(tmpdir(), "pi-web-skill-runtime-shell-"));
  const shebangRoot = await mkdtemp(join(tmpdir(), "pi-web-skill-runtime-shebang-"));
  try {
    await writeFile(join(shellRoot, "run.sh"), "echo ok\n");
    await writeFile(join(shebangRoot, "run"), "#!/bin/sh\necho ok\n");
    const shellRuntime = resolveSkillRuntime([shellRoot]);
    const shebangRuntime = resolveSkillRuntime([shebangRoot]);
    assert.equal(shellRuntime.requiresImage, true);
    assert.equal(shellRuntime.profile, "shell");
    assert.equal(shebangRuntime.requiresImage, true);
    assert.equal(shebangRuntime.profile, "shell");
  } finally {
    await Promise.all([
      rm(shellRoot, { recursive: true, force: true }),
      rm(shebangRoot, { recursive: true, force: true }),
    ]);
  }
});
