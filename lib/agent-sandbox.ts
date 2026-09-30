import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { ModelGateway, type ModelGatewayRoute } from "./model-gateway";
import { samePath } from "./paths";
import { resolveSkillExecutionTimeoutMs, resolveSkillLlmTimeoutSeconds, resolveSkillStageTimeoutSeconds } from "./skill-timeouts";

const DEFAULT_IMAGE = "node:22-bookworm-slim";
const DEFAULT_TIMEOUT_MS = 120_000;
// Biography Writer/Polisher invoke the model repeatedly and can legitimately
// run for 40 minutes. Keep room for the bridge to flush checkpoints and
// reports before the host-side execution deadline.
const MAX_TIMEOUT_MS = 2_400_000;
const MAX_CAPTURE_BYTES = 1024 * 1024;
const MAX_PROCESS_INPUT_BYTES = 8 * 1024 * 1024;
const CONTAINER_PATH = "/opt/pi-python/bin:/opt/pi-node/node_modules/.bin:/opt/pi-node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const DEFAULT_RUNTIME_MEMORY = "4g";
const DEFAULT_RUNTIME_CPUS = "2";

export interface AgentSandboxIdentity {
  tenantId: string;
  agentId: string;
  workspacePath: string;
  skillPaths?: string[];
  /**
   * Local image name or tag. The image must already be present on the Docker
   * host; sandbox startup never provisions images.
   */
  image?: string;
  /**
   * Optional immutable image digest (image id or repository manifest digest).
   * When supplied, startup verifies that the local image resolves to it.
   */
  imageDigest?: string;
  /** Immutable identity of the Skill release mounted into this sandbox. */
  releaseDigest?: string;
  /** Runtime profile used to build/provision the Skill image. */
  runtimeProfile?: string;
  /** Security policy version used to configure this sandbox. */
  policyVersion?: string;
  /** Optional digest for a policy document when a version is not sufficient. */
  policyDigest?: string;
  /** Host-owned model route served through the Unix-socket gateway. */
  modelRoute?: ModelGatewayRoute;
}

export interface SandboxRunOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  onOutput?: (chunk: Buffer) => void;
}

/** Options for invoking a fixed program without passing through a shell. */
export interface SandboxProcessOptions extends SandboxRunOptions {
  input?: string | Buffer;
  modelRoute?: ModelGatewayRoute;
}

export interface SandboxRunResult {
  exitCode: number | null;
  output: string;
  truncated: boolean;
  cancelled: boolean;
  timedOut: boolean;
}

export interface SandboxProcessResult extends SandboxRunResult {
  /** Captured stdout from a no-shell worker invocation. */
  stdout: string;
  /** Captured stderr from a no-shell worker invocation. */
  stderr: string;
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

function optionalIdentity(value: string | undefined, name: string): string {
  const result = value?.trim() ?? "";
  if (result.includes("\0")) throw new Error(`${name} contains an invalid character`);
  return result;
}

function imageDigest(value: string | undefined): string {
  const result = optionalIdentity(value, "imageDigest");
  if (!result) return "";
  if (!/^sha256:[0-9a-f]{64}$/i.test(result)) {
    throw new Error("imageDigest must be a sha256 digest");
  }
  return result.toLowerCase();
}

function imageName(value: string | undefined): string {
  const result = required(value ?? DEFAULT_IMAGE, "image");
  // Docker receives this as one argv item, but reject control characters so a
  // malformed configuration can never become ambiguous in diagnostics or
  // logs. Docker performs the authoritative image-reference validation.
  if ([...result].some((character) => character.charCodeAt(0) < 0x20 || character === "\u007f")) {
    throw new Error("image contains an invalid character");
  }
  return result;
}

function processArg(value: string, name: string): string {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new Error(`${name} contains an invalid character`);
  }
  return value;
}

function resourceLimit(value: string | undefined, name: string, pattern: RegExp, fallback: string): string {
  const result = value?.trim() || fallback;
  if (!pattern.test(result)) throw new Error(`${name} is invalid`);
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
  options: {
    captureOutput?: boolean;
    captureDiagnostic?: boolean;
    input?: string;
    onOutput?: (chunk: Buffer) => void;
    onStdout?: (chunk: Buffer) => void;
    onStderr?: (chunk: Buffer) => void;
  } = {},
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const diagnosticStdout: Buffer[] = [];
    const diagnosticStderr: Buffer[] = [];
    let diagnosticBytes = 0;
    const captureDiagnostic = (target: Buffer[], chunk: Buffer) => {
      if (!options.captureDiagnostic || diagnosticBytes >= 16 * 1024) return;
      const remaining = 16 * 1024 - diagnosticBytes;
      const part = chunk.subarray(0, remaining);
      target.push(part);
      diagnosticBytes += part.byteLength;
    };

    child.stdout!.on("data", (chunk: Buffer) => {
      if (options.captureOutput !== false) stdout.push(chunk);
      else captureDiagnostic(diagnosticStdout, chunk);
      options.onOutput?.(chunk);
      options.onStdout?.(chunk);
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      if (options.captureOutput !== false) stderr.push(chunk);
      else captureDiagnostic(diagnosticStderr, chunk);
      options.onOutput?.(chunk);
      options.onStderr?.(chunk);
    });
    child.once("error", (error) => reject(new AgentSandboxUnavailableError(
      "Docker is unavailable. Start Docker Desktop and try again.",
      { cause: error },
    )));
    child.once("close", (exitCode) => resolve({
      exitCode,
      stdout: Buffer.concat(options.captureOutput === false ? diagnosticStdout : stdout),
      stderr: Buffer.concat(options.captureOutput === false ? diagnosticStderr : stderr),
    }));
    if (options.input !== undefined) child.stdin!.end(options.input);
  });
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

function localImageMatchesDigest(result: ProcessResult, digest: string): boolean {
  if (result.exitCode !== 0) return false;
  const fields = result.stdout.toString("utf8").trim().split(/\s+/).filter(Boolean);
  if (fields[0]?.toLowerCase() === digest) return true;
  return fields.slice(1).some((field) => field.toLowerCase().endsWith(`@${digest}`));
}

function isMissingContainer(result: ProcessResult): boolean {
  if (result.exitCode === 0) return false;
  const diagnostic = `${result.stdout.toString("utf8")}\n${result.stderr.toString("utf8")}`.toLowerCase();
  return diagnostic.includes("no such container")
    || diagnostic.includes("container is not running")
    || diagnostic.includes("is not running");
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
    private readonly imageDigest: string,
    private readonly memoryLimit: string,
    private readonly cpuLimit: string,
    private readonly llmTimeoutSeconds: string,
    private readonly stageTimeoutSeconds: string,
    private readonly executionTimeoutSeconds: string,
    private readonly skillPaths: string[],
    private readonly modelGatewayRoute: ModelGatewayRoute | null,
    private readonly modelGateway: ModelGateway | null,
  ) {}

  static async open(identity: AgentSandboxIdentity): Promise<AgentSandbox> {
    const tenantId = required(identity.tenantId, "tenantId");
    const agentId = required(identity.agentId, "agentId");
    const workspacePath = await realpath(required(identity.workspacePath, "workspacePath"));
    if (!(await stat(workspacePath)).isDirectory()) throw new Error("workspacePath must be a directory");

    const image = imageName(identity.image ?? process.env.PI_WEB_SANDBOX_IMAGE);
    const imageDigestValue = imageDigest(identity.imageDigest ?? process.env.PI_WEB_SANDBOX_IMAGE_DIGEST);
    const memoryLimit = resourceLimit(
      process.env.PI_WEB_SKILL_RUNTIME_MEMORY,
      "PI_WEB_SKILL_RUNTIME_MEMORY",
      /^[1-9][0-9]*(?:[bBkKmMgGtTpP](?:[iI]?[bB])?)?$/u,
      DEFAULT_RUNTIME_MEMORY,
    );
    const cpuLimit = resourceLimit(
      process.env.PI_WEB_SKILL_RUNTIME_CPUS,
      "PI_WEB_SKILL_RUNTIME_CPUS",
      /^[1-9][0-9]*(?:\.[0-9]+)?$/u,
      DEFAULT_RUNTIME_CPUS,
    );
    // This value is only passed to the worker's per-request settings. The
    // host-side command deadline is supplied by the caller and is resolved
    // independently by the Skill adapter.
    const llmTimeoutSeconds = String(resolveSkillLlmTimeoutSeconds());
    const stageTimeoutSeconds = String(resolveSkillStageTimeoutSeconds());
    const executionTimeoutSeconds = String(resolveSkillExecutionTimeoutMs() / 1_000);
    const releaseDigest = optionalIdentity(identity.releaseDigest, "releaseDigest");
    const runtimeProfile = optionalIdentity(identity.runtimeProfile, "runtimeProfile");
    const policyVersion = optionalIdentity(identity.policyVersion, "policyVersion");
    const policyDigest = optionalIdentity(identity.policyDigest, "policyDigest");
    const modelRoute = identity.modelRoute
      ? { provider: required(identity.modelRoute.provider, "modelRoute.provider"), modelId: required(identity.modelRoute.modelId, "modelRoute.modelId") }
      : undefined;
    // Only immutable release roots supplied by the tenant runtime are mounted.
    // Host-wide Skill directories are intentionally outside this seam.
    const configuredPaths = identity.skillPaths ?? [];
    const skillPaths = (await Promise.all(configuredPaths.map((path) => realpath(path).catch(() => null)))).filter((path): path is string => Boolean(path));
    const scopeHash = createHash("sha256")
      .update([
        tenantId,
        agentId,
        workspacePath,
        image,
        imageDigestValue,
        memoryLimit,
        cpuLimit,
        llmTimeoutSeconds,
        stageTimeoutSeconds,
        executionTimeoutSeconds,
        releaseDigest,
        runtimeProfile,
        policyVersion,
        policyDigest,
        modelRoute?.provider ?? "",
        modelRoute?.modelId ?? "",
        ...skillPaths,
      ].join("\0"))
      .digest("hex")
      .slice(0, 24);
    const modelGateway = modelRoute ? await ModelGateway.open(modelRoute) : null;
    const sandbox = new AgentSandbox(
      workspacePath,
      `pi-web-agent-${scopeHash}`,
      scopeHash,
      image,
      imageDigestValue,
      memoryLimit,
      cpuLimit,
      llmTimeoutSeconds,
      stageTimeoutSeconds,
      executionTimeoutSeconds,
      skillPaths,
      modelRoute ?? null,
      modelGateway,
    );
    try {
      await sandbox.ensureContainer();
    } catch (error) {
      await modelGateway?.close().catch(() => undefined);
      throw error;
    }
    return sandbox;
  }

  async run(command: string, options: SandboxRunOptions = {}): Promise<SandboxRunResult> {
    return this.execute(["/bin/sh", "-c", required(command, "command")], options);
  }

  /**
   * Execute a reviewed executable that belongs to one mounted Skill release.
   * The caller supplies a host-side release root only for mount lookup; the
   * path that enters the container is always `/opt/pi-agent/skills/<index>`.
   */
  async runSkillCommand(
    skillPath: string,
    relativeExecutable: string,
    args: readonly string[] = [],
    options: SandboxProcessOptions = {},
  ): Promise<SandboxProcessResult> {
    const requestedRoot = resolve(required(skillPath, "skillPath"));
    // AgentSandbox.open stores realpath() values so Docker mounts cannot be
    // redirected through a later symlink change. Resolve the caller's path by
    // the same rule before selecting the corresponding read-only mount. The
    // fallback preserves the existing "not mounted" diagnostic for a path
    // that disappeared between session startup and invocation.
    const hostRoot = await realpath(requestedRoot).catch(() => requestedRoot);
    const executable = relative(hostRoot, resolve(hostRoot, required(relativeExecutable, "relativeExecutable")));
    if (!executable || executable === ".." || executable.startsWith(`..${sep}`) || isAbsolute(executable)) {
      throw new Error("relativeExecutable must remain inside the Skill release");
    }
    const index = this.skillPaths.findIndex((path) => samePath(path, hostRoot));
    if (index < 0) throw new Error("Skill release is not mounted in this sandbox");
    const containerExecutable = `/opt/pi-agent/skills/${index}/${executable.split(sep).join("/")}`;
    return this.runProcess(["python3", containerExecutable, ...args], options);
  }

  /**
   * Execute a fixed program and argument vector in the container.
   *
   * This is intentionally separate from `run()`; callers cannot accidentally
   * turn user-provided values into shell code. Server-owned Skill adapters use
   * this seam to invoke a bridge process over stdin/stdout.
   */
  async runProcess(argv: readonly string[], options: SandboxProcessOptions = {}): Promise<SandboxProcessResult> {
    if (argv.length === 0) throw new Error("argv is required");
    const args = argv.map((value, index) => processArg(value, `argv[${index}]`));
    if (!args[0].trim()) throw new Error("argv[0] is required");
    if (options.input !== undefined && Buffer.byteLength(options.input) > MAX_PROCESS_INPUT_BYTES) {
      throw new Error("sandbox process input is too large");
    }
    return this.execute(args, options);
  }

  private async execute(argv: readonly string[], options: SandboxProcessOptions): Promise<SandboxProcessResult> {
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
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const stdoutState = { bytes: 0, truncated: false };
    const stderrState = { bytes: 0, truncated: false };
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
      let result: ProcessResult;
      for (let attempt = 0; ; attempt += 1) {
        result = await runDocker(
          // Do not use a login shell: distro profile files can overwrite the
          // reviewed runtime PATH and hide the preloaded Python environment.
          ["exec", "--interactive", this.containerName, ...argv],
          {
            input: options.input === undefined
              ? undefined
            : Buffer.isBuffer(options.input) ? options.input.toString("utf8") : options.input,
            captureOutput: false,
            captureDiagnostic: true,
            onOutput: (chunk) => {
              capture(output, chunk, outputState);
              options.onOutput?.(chunk);
            },
            onStdout: (chunk) => capture(stdout, chunk, stdoutState),
            onStderr: (chunk) => capture(stderr, chunk, stderrState),
          },
        );
        // Docker can remove a disposable container after a timeout, daemon
        // restart, or external cleanup while this wrapper still has `ready`
        // cached. An exec failure that explicitly identifies that condition
        // happened before the requested process started, so rebuilding once
        // is safe and avoids replaying a partially executed command.
        if (attempt === 0 && !cancelled && !timedOut && isMissingContainer(result)) {
          this.ready = false;
          output.length = 0;
          stdout.length = 0;
          stderr.length = 0;
          stdoutState.bytes = 0;
          stdoutState.truncated = false;
          stderrState.bytes = 0;
          stderrState.truncated = false;
          outputState.bytes = 0;
          outputState.truncated = false;
          await this.ensureContainer();
          continue;
        }
        break;
      }
      settled = true;
      return {
        exitCode: cancelled || timedOut ? null : result.exitCode,
        output: Buffer.concat(output).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        truncated: outputState.truncated || stdoutState.truncated || stderrState.truncated,
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
    await this.modelGateway?.close().catch(() => undefined);
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
    if (existingState.running && !this.modelGateway) {
      this.ready = true;
      return;
    }
    if (existingState.running) await runDocker(["rm", "--force", this.containerName]);
    if (existingState.exists) await runDocker(["rm", "--force", this.containerName]);

    // Image provisioning belongs to the release/build pipeline. Pulling here
    // would bypass the host's offline policy and would make first execution
    // unexpectedly depend on registry availability.
    const imageExists = await runDocker([
      "image", "inspect", "--format", "{{.Id}} {{join .RepoDigests \" \"}}", this.image,
    ]);
    if (imageExists.exitCode !== 0) {
      throw new AgentSandboxUnavailableError(
        `runtime artifact not ready: sandbox image is not preloaded: ${this.image}`,
      );
    }
    if (this.imageDigest && !localImageMatchesDigest(imageExists, this.imageDigest)) {
      throw new AgentSandboxUnavailableError(
        `runtime artifact not ready: preloaded sandbox image does not match digest ${this.imageDigest}: ${this.image}`,
      );
    }

    const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
    const gid = typeof process.getgid === "function" ? process.getgid() : 1000;
    const skillMountArgs = this.skillPaths.flatMap((path, index) => [
      "--mount", `type=bind,source=${path},target=/opt/pi-agent/skills/${index},readonly`,
    ]);
    const gatewayMountArgs = this.modelGateway
      ? [
        "--mount", `type=bind,source=${this.modelGateway.directory},target=/run/pi-web,readonly`,
        "--mount", `type=bind,source=${join(this.modelGateway.directory, "models.json")},target=/opt/pi-agent/models.json,readonly`,
        "--env", "BIOGRAPHY_LLM_GATEWAY_SOCKET=/run/pi-web/model-gateway.sock",
        "--env", "PYTHONPATH=/run/pi-web",
        // The hook cannot read the host-side route object. Pass only the
        // non-secret provider/model identity so the gateway can reject route
        // confusion before forwarding; credentials remain host-side.
        "--env", `BIOGRAPHY_WORKER_PROVIDER=${this.modelGatewayRoute?.provider ?? ""}`,
        "--env", `BIOGRAPHY_WORKER_MODEL=${this.modelGatewayRoute?.modelId ?? ""}`,
        "--env", `BIOGRAPHY_LLM_TIMEOUT_SECONDS=${this.llmTimeoutSeconds}`,
        "--env", `BIOGRAPHY_STAGE_TIMEOUT_SECONDS=${this.stageTimeoutSeconds}`,
        "--env", `BIOGRAPHY_EXECUTION_TIMEOUT_SECONDS=${this.executionTimeoutSeconds}`,
      ]
      : [];
    const created = await runDocker([
      "run",
      "--detach",
      "--rm",
      "--init",
      "--name", this.containerName,
      "--label", "pi-web.managed=true",
      "--label", `pi-web.scope=${this.scopeHash}`,
      // Never allow Docker to resolve a missing tag through a registry. Image
      // availability and digest checks above are deliberately local-only.
      "--pull", "never",
      "--network", "none",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--pids-limit", "256",
      "--memory", this.memoryLimit,
      "--cpus", this.cpuLimit,
      "--read-only",
      "--tmpfs", "/tmp:rw,nosuid,nodev,size=256m",
      "--user", `${uid}:${gid}`,
      "--env", "HOME=/tmp",
      "--env", "TMPDIR=/tmp",
      "--env", "LANG=C.UTF-8",
      // /bin/sh -l may reset PATH from /etc/profile. Keep the reviewed
      // runtime's Python venv ahead of the system tools explicitly.
      "--env", `PATH=${CONTAINER_PATH}`,
      "--env", "PI_CODING_AGENT_DIR=/opt/pi-agent",
      // Deliberate, container-only marker for Skills that need to prove where
      // a command ran. It is paired with the container restrictions below;
      // it is not used as an authorization decision.
      "--env", "PI_WEB_SANDBOX=1",
      "--mount", `type=bind,source=${this.workspacePath},target=/workspace`,
      ...skillMountArgs,
      ...gatewayMountArgs,
      "--workdir", "/workspace",
      "--entrypoint", "/bin/sh",
      this.image,
      "-c", "exec sleep infinity",
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
