# Agent sandbox — phase 1

`AgentSandbox` is the seam between Pi Agent orchestration and untrusted command execution. Callers
provide only a tenant id, Agent id, workspace path, and command; the module hides Docker naming,
image provisioning, mounts, security flags, limits, output capture, cancellation, and cleanup.

Each `(tenantId, agentId, workspacePath, releaseDigest, imageDigest, runtimeProfile, policyVersion)` gets a deterministic, dedicated container. Switching a published or deactivated release therefore cannot reuse an older Skill environment. The tenant-owned
workspace is mounted read/write and only the immutable tenant Skill release roots are mounted read-only. The host-wide Skill directory is never mounted. The root filesystem
is read-only, networking and Linux capabilities are disabled, and CPU, memory, process count, temporary
storage, output size, and command time are bounded. No host environment variables, model credentials,
Docker socket, or raw Docker options cross the seam.

If Docker removes a disposable container between calls (for example during a daemon restart or timeout),
the next `docker exec` reports the missing-container condition, clears the stale readiness flag, and
recreates the same digest-verified sandbox once. Other command failures are returned unchanged.

Pi orchestration and model calls remain in the server process. The built-in Bash tool and direct shell
commands execute through `runAgentSandboxCommand()`; PowerShell selections are normalized to this
Docker-backed Bash tool on Windows. Pi discovers Skill instructions in the orchestration process, while
reviewed release resources arrive through `/opt/pi-agent/skills` and the tenant workspace through
`/workspace`, so commands and supporting files run inside the Agent's container.

Server-owned Skill adapters invoke reviewed workers through `runAgentSandboxProcess()` or
`runAgentSandboxSkillCommand()`. These APIs pass an argv vector and optional bounded stdin to
`docker exec` without a shell, and return separately bounded stdout/stderr streams. A bridge may
write a large report or generated document under the mounted workspace; the model-facing adapter
returns only a short summary and a workspace artifact path. Tenant-provided extension modules are
never imported into the host process.

The biography bridge's deterministic stages run entirely in this container. Its Writer, Reviewer,
Polisher, and related LLM stages use a server-owned Unix-socket model gateway mounted only for the
session's container. The gateway validates the session's provider/model route and reads credentials
in the Pi Web process; the container receives neither credentials nor network access and keeps
`network=none`. A temporary, credential-free `models.json` containing only the selected provider
and model is mounted for the bridge's local preflight; its dummy endpoint cannot be used without
the gateway hook.

The preloaded runtime defaults to 4 GiB memory, 2 CPUs, and a 40-minute host-side execution cap;
operators can lower or raise the Docker memory/CPU values with `PI_WEB_SKILL_RUNTIME_MEMORY` and
`PI_WEB_SKILL_RUNTIME_CPUS`. `PI_WEB_SKILL_EXECUTION_TIMEOUT_SECONDS` changes that complete bridge
deadline (up to 40 minutes). The gateway's `PI_WEB_SKILL_LLM_TIMEOUT_SECONDS` controls only one
model request inside the worker and defaults to 600 seconds. `PI_WEB_SKILL_STAGE_TIMEOUT_SECONDS`
controls the minimum deadline for each named worker stage and also defaults to 600 seconds. These
variables are intentionally separate: changing either model/stage timeout cannot make the complete
chapter process exit at that number of seconds. Timeout values are part of the sandbox cache identity,
so changing them takes effect on the next tool call without reusing an old container.

The gateway also passes the complete execution budget to the container. For older bridge releases
that hard-code a 30-minute Writer subprocess deadline, the container-only hook extends that long
subprocess to the host budget minus a short cleanup margin; short helper commands and individual
model requests are unaffected.

Installed extensions are trusted server code and still execute in the Pi Web process. Tenant-uploaded
TypeScript extensions are never imported. Execution-based tenant Skills use a server-owned adapter
that invokes their reviewed Python bridge through `runAgentSandboxSkillCommand()`; only the bridge
process runs in the read-only Skill mount inside Docker. The adapter passes a fixed argv, never a
host path or shell fragment, and receives a bounded summary while command evidence is written to
the workspace artifact log.

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
