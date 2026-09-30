import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const { AgentSandbox } = await createJiti(import.meta.url).import("./agent-sandbox.ts");
const dockerEnabled = process.env.PI_WEB_DOCKER_TEST === "1";

test("different Agents execute in isolated Docker containers", { skip: !dockerEnabled }, async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "pi-web-sandbox-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = join(workspace, "agent-home");
  mkdirSync(join(agentDir, "skills", "proof-skill"), { recursive: true });
  writeFileSync(join(agentDir, "skills", "proof-skill", "SKILL.md"), "# proof-skill\n");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let first;
  let second;
  t.after(async () => {
    await Promise.all([first?.close(), second?.close()]);
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(workspace, { recursive: true, force: true });
  });
  const skillPaths = [join(agentDir, "skills")];
  first = await AgentSandbox.open({ tenantId: "tenant-a", agentId: "agent-a", workspacePath: workspace, skillPaths });
  second = await AgentSandbox.open({ tenantId: "tenant-a", agentId: "agent-b", workspacePath: workspace, skillPaths });

  const firstHost = await first.run("hostname; printf agent-a > /tmp/identity");
  const secondHost = await second.run("hostname; printf agent-b > /tmp/identity");
  const firstIdentity = await first.run("cat /tmp/identity; printf shared > proof.txt");
  const secondIdentity = await second.run("cat /tmp/identity");

  assert.equal(firstHost.exitCode, 0);
  assert.equal(secondHost.exitCode, 0);
  assert.notEqual(firstHost.output.trim(), secondHost.output.trim());
  assert.equal(firstIdentity.output, "agent-a");
  assert.equal(secondIdentity.output, "agent-b");
  assert.equal(existsSync(join(workspace, "proof.txt")), true);
  assert.equal(readFileSync(join(workspace, "proof.txt"), "utf8"), "shared");

  const loadedSkill = await first.run("cat /opt/pi-agent/skills/0/proof-skill/SKILL.md");
  assert.equal(loadedSkill.output, "# proof-skill\n");

  const rpc = await first.runProcess(["/bin/sh", "-c", "cat"], {
    input: JSON.stringify({ action: "status", argument: "$(touch /workspace/should-not-exist)" }) + "\n",
  });
  assert.equal(rpc.exitCode, 0);
  assert.equal(rpc.stdout, '{"action":"status","argument":"$(touch /workspace/should-not-exist)"}\n');
  assert.equal(existsSync(join(workspace, "should-not-exist")), false);

  const proof = await first.run("printf '%s|%s|' \"$PI_WEB_SANDBOX\" \"$HOME\"; test ! -e /var/run/docker.sock && printf socket-absent; printf '|python='; command -v python3; printf '|node='; command -v node");
  assert.match(proof.output, /^1\|\/tmp\|socket-absent\|python=(?:|\/opt\/pi-python\/bin\/python3)\|node=\/usr\/local\/bin\/node\n$/);

  const network = await first.run("ls /sys/class/net");
  const readOnlyRoot = await first.run("touch /root/must-fail");
  assert.equal(network.output.trim(), "lo");
  assert.notEqual(readOnlyRoot.exitCode, 0);

  const timedOut = await first.run("sleep 5", { timeoutMs: 100 });
  assert.equal(timedOut.timedOut, true);
  assert.equal(timedOut.exitCode, null);
  assert.equal((await first.run("printf recreated")).output, "recreated");

  // Simulate a Docker daemon restart or an external `docker rm` while the
  // wrapper still has its ready flag. The next exec must recreate once rather
  // than returning the daemon's "No such container" error forever.
  const managedIds = execFileSync("docker", ["ps", "--filter", "label=pi-web.managed=true", "--format", "{{.ID}}"], { encoding: "utf8" })
    .trim().split(/\s+/).filter(Boolean);
  const ownedId = managedIds.find((id) => {
    try {
      const mounts = JSON.parse(execFileSync("docker", ["inspect", id], { encoding: "utf8" }))[0]?.Mounts ?? [];
      return mounts.some((mount) => mount.Source === workspace && mount.Destination === "/workspace");
    } catch {
      return false;
    }
  });
  assert.ok(ownedId, "expected to find the first sandbox container");
  execFileSync("docker", ["rm", "--force", ownedId]);
  assert.equal((await first.run("printf recovered-after-removal")).output, "recovered-after-removal");
});

test("skill command accepts an equivalent release path after host path resolution", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-sandbox-path-"));
  const release = join(root, "release");
  const alias = join(root, "release-alias");
  mkdirSync(join(release, "scripts"), { recursive: true });
  writeFileSync(join(release, "scripts", "pi_bridge.py"), "#!/usr/bin/env python3\n");
  symlinkSync(release, alias, process.platform === "win32" ? "junction" : "dir");
  try {
    const sandbox = Object.create(AgentSandbox.prototype);
    sandbox.skillPaths = [realpathSync(release)];
    sandbox.runProcess = async (argv) => ({ argv });
    const result = await sandbox.runSkillCommand(alias, "scripts/pi_bridge.py", ["active"]);
    assert.deepEqual(result.argv, ["python3", "/opt/pi-agent/skills/0/scripts/pi_bridge.py", "active"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
