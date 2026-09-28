import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const DEFAULT_IMAGE = "node:22-bookworm-slim";
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_CAPTURE_BYTES = 1024 * 1024;

export interface AgentSandboxIdentity {
  tenantId: string;
  agentId: string;
  workspacePath: string;
  skillPaths?: string[];
  includeGlobalSkills?: boolean;
}

export interface SandboxRunOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  onOutput?: (chunk: Buffer) => void;
}

export interface SandboxRunResult {
  exitCode: number | null;
  output: string;
  truncated: boolean;
  cancelled: boolean;
  timedOut: boolean;
}

type ProcessResult = {
  exitCode: number | null;
  stdout: Buffer;
  stderr: Buffer;
};

export class AgentSandboxUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentSandboxUnavailableError";
  }
}

function required(value: string, name: string): string {
  const result = value.trim();
  if (!result) throw new Error(`${name} is required`);
  return result;
}

function capture(chunks: Buffer[], chunk: Buffer, state: { bytes: number; truncated: boolean }): void {
  if (state.bytes >= MAX_CAPTURE_BYTES) {
    state.truncated = true;
    return;
  }
  const remaining = MAX_CAPTURE_BYTES - state.bytes;
  chunks.push(chunk.subarray(0, remaining));
  state.bytes += Math.min(chunk.length, remaining);
  if (chunk.length > remaining) state.truncated = true;
}

function runDocker(
  args: string[],
  options: { captureOutput?: boolean; input?: string; onOutput?: (chunk: Buffer) => void } = {},
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout!.on("data", (chunk: Buffer) => {
      if (options.captureOutput !== false) stdout.push(chunk);
      options.onOutput?.(chunk);
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      if (options.captureOutput !== false) stderr.push(chunk);
      options.onOutput?.(chunk);
    });
    child.once("error", (error) => reject(new AgentSandboxUnavailableError(
      "Docker is unavailable. Start Docker Desktop and try again.",
      { cause: error },
    )));
    child.once("close", (exitCode) => resolve({
      exitCode,
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr),
    }));
    if (options.input !== undefined) child.stdin!.end(options.input);
  });
}

async function requireDockerSuccess(args: string[], action: string): Promise<ProcessResult> {
  const result = await runDocker(args);
  if (result.exitCode !== 0) {
    throw new AgentSandboxUnavailableError(
      `${action}: ${result.stderr.toString("utf8").trim() || `docker exited with ${result.exitCode}`}`,
    );
  }
  return result;
}

function inspectContainer(result: ProcessResult, scopeHash: string): {
  exists: boolean;
  owned: boolean;
  running: boolean;
} {
  if (result.exitCode !== 0) return { exists: false, owned: false, running: false };
  const [running, scope] = result.stdout.toString("utf8").trim().split(" ", 2);
  return { exists: true, owned: scope === scopeHash, running: running === "true" };
}

/**
 * Owns one disposable Docker execution environment for one tenant's Agent.
 * Docker details are intentionally not part of the module interface.
 */
export class AgentSandbox {
  private ready = false;
  private closed = false;
  private running = false;

  private constructor(
    private readonly workspacePath: string,
    private readonly containerName: string,
    private readonly scopeHash: string,
    private readonly image: string,
    private readonly skillPaths: string[],
  ) {}

  static async open(identity: AgentSandboxIdentity): Promise<AgentSandbox> {
    const tenantId = required(identity.tenantId, "tenantId");
    const agentId = required(identity.agentId, "agentId");
    const workspacePath = await realpath(required(identity.workspacePath, "workspacePath"));
    if (!(await stat(workspacePath)).isDirectory()) throw new Error("workspacePath must be a directory");

    const image = process.env.PI_WEB_SANDBOX_IMAGE?.trim() || DEFAULT_IMAGE;
    const configuredPaths = identity.includeGlobalSkills
      ? [...(identity.skillPaths ?? []), join(getAgentDir(), "skills")]
      : (identity.skillPaths ?? []);
    const skillPaths = (await Promise.all(configuredPaths.map((path) => realpath(path).catch(() => null)))).filter((path): path is string => Boolean(path));
    const scopeHash = createHash("sha256")
      .update(`${tenantId}\0${agentId}\0${workspacePath}\0${image}\0${skillPaths.join("\0")}`)
      .digest("hex")
      .slice(0, 24);
    const sandbox = new AgentSandbox(
      workspacePath,
      `pi-web-agent-${scopeHash}`,
      scopeHash,
      image,
      skillPaths,
    );
    await sandbox.ensureContainer();
    return sandbox;
  }

  async run(command: string, options: SandboxRunOptions = {}): Promise<SandboxRunResult> {
    if (this.closed) throw new Error("Agent sandbox is closed");
    if (this.running) throw new Error("Agent sandbox already has a running command");
    const requestedTimeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(requestedTimeout) || requestedTimeout <= 0) {
      throw new Error("timeoutMs must be a positive number");
    }
    const timeoutMs = Math.min(requestedTimeout, MAX_TIMEOUT_MS);
    await this.ensureContainer();
    this.running = true;

    const output: Buffer[] = [];
    const outputState = { bytes: 0, truncated: false };
    let cancelled = options.signal?.aborted ?? false;
    let timedOut = false;
    let settled = false;

    const terminate = (reason: "cancelled" | "timeout") => {
      if (settled) return;
      cancelled ||= reason === "cancelled";
      timedOut ||= reason === "timeout";
      this.ready = false;
      void runDocker(["rm", "--force", this.containerName]).catch(() => undefined);
    };
    const onAbort = () => terminate("cancelled");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => terminate("timeout"), timeoutMs);

    try {
      if (cancelled) terminate("cancelled");
      const result = await runDocker(
        ["exec", "--interactive", this.containerName, "/bin/sh", "-lc", required(command, "command")],
        {
          captureOutput: false,
          onOutput: (chunk) => {
            capture(output, chunk, outputState);
            options.onOutput?.(chunk);
          },
        },
      );
      settled = true;
      return {
        exitCode: cancelled || timedOut ? null : result.exitCode,
        output: Buffer.concat(output).toString("utf8"),
        truncated: outputState.truncated,
        cancelled,
        timedOut,
      };
    } finally {
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      this.running = false;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.ready = false;
    await runDocker(["rm", "--force", this.containerName]);
  }

  private async ensureContainer(): Promise<void> {
    if (this.ready) return;
    const existing = await runDocker([
      "inspect", "--format", '{{.State.Running}} {{index .Config.Labels "pi-web.scope"}}', this.containerName,
    ]);
    const existingState = inspectContainer(existing, this.scopeHash);
    if (existingState.exists && !existingState.owned) {
      throw new AgentSandboxUnavailableError(`Docker container name is already in use: ${this.containerName}`);
    }
    if (existingState.running) {
      this.ready = true;
      return;
    }
    if (existingState.exists) await runDocker(["rm", "--force", this.containerName]);

    const imageExists = await runDocker(["image", "inspect", this.image]);
    if (imageExists.exitCode !== 0) await requireDockerSuccess(["pull", this.image], "Unable to pull sandbox image");

    const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
    const gid = typeof process.getgid === "function" ? process.getgid() : 1000;
    const skillMountArgs = this.skillPaths.flatMap((path, index) => [
      "--mount", `type=bind,source=${path},target=/opt/pi-agent/skills/${index},readonly`,
    ]);
    const created = await runDocker([
      "run",
      "--detach",
      "--rm",
      "--init",
      "--name", this.containerName,
      "--label", "pi-web.managed=true",
      "--label", `pi-web.scope=${this.scopeHash}`,
      "--network", "none",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--pids-limit", "256",
      "--memory", "1g",
      "--cpus", "1",
      "--read-only",
      "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m",
      "--user", `${uid}:${gid}`,
      "--env", "HOME=/tmp",
      "--env", "TMPDIR=/tmp",
      "--env", "LANG=C.UTF-8",
      "--env", "PI_CODING_AGENT_DIR=/opt/pi-agent",
      // Deliberate, container-only marker for Skills that need to prove where
      // a command ran. It is paired with the container restrictions below;
      // it is not used as an authorization decision.
      "--env", "PI_WEB_SANDBOX=1",
      "--mount", `type=bind,source=${this.workspacePath},target=/workspace`,
      ...skillMountArgs,
      "--workdir", "/workspace",
      this.image,
      "sleep", "infinity",
    ]);
    if (created.exitCode !== 0) {
      const raced = await runDocker([
        "inspect", "--format", '{{.State.Running}} {{index .Config.Labels "pi-web.scope"}}', this.containerName,
      ]);
      const racedState = inspectContainer(raced, this.scopeHash);
      if (!racedState.owned || !racedState.running) {
        throw new AgentSandboxUnavailableError(
          `Unable to create Agent sandbox: ${created.stderr.toString("utf8").trim()}`,
        );
      }
    }
    this.ready = true;
  }
}
