import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  const proof = await first.run("printf '%s|%s|' \"$PI_WEB_SANDBOX\" \"$HOME\"; test ! -e /var/run/docker.sock && printf socket-absent");
  assert.equal(proof.output, "1|/tmp|socket-absent");

  const network = await first.run("ls /sys/class/net");
  const readOnlyRoot = await first.run("touch /root/must-fail");
  assert.equal(network.output.trim(), "lo");
  assert.notEqual(readOnlyRoot.exitCode, 0);

  const timedOut = await first.run("sleep 5", { timeoutMs: 100 });
  assert.equal(timedOut.timedOut, true);
  assert.equal(timedOut.exitCode, null);
  assert.equal((await first.run("printf recreated")).output, "recreated");
});
