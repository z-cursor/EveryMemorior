# Agent sandbox — phase 1

`AgentSandbox` is the seam between Pi Agent orchestration and untrusted command execution. Callers
provide only a tenant id, Agent id, workspace path, and command; the module hides Docker naming,
image provisioning, mounts, security flags, limits, output capture, cancellation, and cleanup.

Each `(tenantId, agentId, workspacePath)` gets a deterministic, dedicated container. The tenant-owned
workspace is mounted read/write and the global Skill directory is mounted read-only. The root filesystem
is read-only, networking and Linux capabilities are disabled, and CPU, memory, process count, temporary
storage, output size, and command time are bounded. No host environment variables, model credentials,
Docker socket, or raw Docker options cross the seam.

Pi orchestration and model calls remain in the server process. The built-in Bash tool and direct shell
commands execute through `runAgentSandboxCommand()`; PowerShell selections are normalized to this
Docker-backed Bash tool on Windows. Pi discovers Skill instructions in the orchestration process, while
project Skill resources arrive through `/workspace` and global Skill resources through
`/opt/pi-agent/skills`, so commands and supporting files run inside the Agent's container.

Installed extensions are trusted server code and still execute in the Pi Web process. They are not a
security boundary in phase 1 and must not be installed from untrusted sources.

Run the opt-in Docker integration check with:

```powershell
$env:PI_WEB_DOCKER_TEST = "1"
node --experimental-strip-types --test lib/agent-sandbox.test.mjs
```

## Verifying Work-mode command execution from a Skill

The installation owner can select the `.agents` directory with the file
explorer's folder-upload button. Its contents must land at the workspace root
with this layout. Trust the project when prompted, then start or reload a
Work-mode session with Bash enabled:

```text
.agents/
└── skills/
    └── sandbox-check/
        └── SKILL.md
```

Use this `SKILL.md` content:

````md
---
name: sandbox-check
description: Verify where Pi Web Work-mode Bash commands execute when asked to check the Agent sandbox.
---

When asked to verify the Agent sandbox, execute this command with the Bash tool
and report the raw tool output:

```bash
printf 'PI_WEB_SANDBOX=%s\nHOME=%s\n' "$PI_WEB_SANDBOX" "$HOME"
test ! -e /var/run/docker.sock && echo 'docker-socket=absent'
printf 'hostname='; hostname
printf 'workspace='; pwd
```

Explain that this checks command execution. Pi orchestration, model requests,
and trusted extensions still run in the Pi Web server process.
````

The expected result is `PI_WEB_SANDBOX=1`, `HOME=/tmp`, an absent Docker socket,
and a workspace of `/workspace`. Check the raw Bash tool result in the current
session rather than relying on the model's summary. Invited members have only
read-only Work tools, so they cannot run this Bash check.

The marker is informational only. The actual boundary is enforced by the
container flags in `AgentSandbox`. The check demonstrates that this Bash command
used the container; it does not claim that the whole Agent session ran there.
