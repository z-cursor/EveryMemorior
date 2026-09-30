import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { basename, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_SKILL_RUNTIME_IMAGE,
  resolveSkillRuntime,
  type SkillRuntimeDescriptor,
} from "./skill-runtime";

const MAX_DEPENDENCY_CONTEXT_BYTES = 2 * 1024 * 1024;
const MAX_BUILD_LOG_BYTES = 2 * 1024 * 1024;
const BUILD_TIMEOUT_MS = 15 * 60 * 1000;

function configuredBaseImage(): string {
  const value = process.env.PI_WEB_SKILL_RUNTIME_BASE_IMAGE?.trim() || DEFAULT_SKILL_RUNTIME_IMAGE;
  if (![...value].every((character) => /[A-Za-z0-9._/@:-]/u.test(character))) {
    throw new Error("Configured Skill runtime base image is invalid");
  }
  return value;
}

export type SkillRuntimeBuildInput = {
  storagePath: string;
  releaseDigest: string;
  lockfileDigest: string;
  runtimeProfile: string;
};

export type SkillRuntimeBuildResult = {
  image: string;
  imageDigest: string;
  descriptor: SkillRuntimeDescriptor;
};

const inflight = new Map<string, Promise<SkillRuntimeBuildResult>>();

function imageTag(input: SkillRuntimeBuildInput): string {
  // Include every input that can change the installed dependency set. This
  // prevents a retry with a new lockfile/profile from reusing an old tag.
  const key = createHash("sha256")
    .update(`${input.lockfileDigest}\0${input.runtimeProfile}\0${configuredBaseImage()}`)
    .digest("hex");
  return `pi-web-skill-runtime:${key.slice(0, 56)}`;
}

function runDocker(args: string[], cwd?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdoutBytes < MAX_BUILD_LOG_BYTES) {
        stdout.push(chunk.subarray(0, MAX_BUILD_LOG_BYTES - stdoutBytes));
        stdoutBytes += Math.min(chunk.byteLength, MAX_BUILD_LOG_BYTES - stdoutBytes);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes < MAX_BUILD_LOG_BYTES) {
        stderr.push(chunk.subarray(0, MAX_BUILD_LOG_BYTES - stderrBytes));
        stderrBytes += Math.min(chunk.byteLength, MAX_BUILD_LOG_BYTES - stderrBytes);
      }
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, BUILD_TIMEOUT_MS);
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
  });
}

async function inspectImage(image: string): Promise<string | null> {
  try {
    const result = await runDocker(["image", "inspect", "--format", "{{.Id}}", image]);
    if (result.code !== 0) return null;
    const digest = result.stdout.trim().toLowerCase();
    return /^sha256:[0-9a-f]{64}$/.test(digest) ? digest : null;
  } catch {
    return null;
  }
}

async function writeBuildContext(input: SkillRuntimeBuildInput, descriptor: SkillRuntimeDescriptor): Promise<string> {
  const parent = join(getAgentDir(), "tenant-skill-runtime-builds");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const context = await mkdtemp(join(parent, `${input.releaseDigest.slice(0, 16)}-`));
  try {
    let bytes = 0;
    const names = new Set<string>();
    for (const source of descriptor.dependencyFiles) {
      const name = basename(source);
      if (names.has(name)) throw new Error(`Skill dependency manifest basename is ambiguous: ${name}`);
      names.add(name);
      const data = await readFile(source);
      bytes += data.byteLength;
      if (bytes > MAX_DEPENDENCY_CONTEXT_BYTES) throw new Error("Skill dependency manifests are too large");
      await writeFile(join(context, name), data, { mode: 0o600 });
    }
    // The uploaded manifest never chooses the build base. Operators provision
    // one reviewed base image for the builder.
    const baseImage = configuredBaseImage();
    const python = descriptor.hasPython
      ? "RUN python3 -m venv /opt/pi-python && for f in /tmp/pi-skill-deps/requirements*.txt /tmp/pi-skill-deps/requirements.lock; do if [ -f \"$f\" ]; then /opt/pi-python/bin/pip install --no-cache-dir --disable-pip-version-check -r \"$f\"; fi; done && if [ -f /tmp/pi-skill-deps/pyproject.toml ]; then /opt/pi-python/bin/python -c \"import subprocess,tomllib; d=tomllib.load(open('/tmp/pi-skill-deps/pyproject.toml','rb')); x=list(d.get('project',{}).get('dependencies',[]) or []); x += [n+s for n,s in (d.get('tool',{}).get('poetry',{}).get('dependencies',{}) or {}).items() if n.lower() != 'python' and isinstance(s,str)]; subprocess.check_call(['/opt/pi-python/bin/pip','install','--no-cache-dir','--disable-pip-version-check',*x]) if x else None\"; fi\n"
      : "";
    const node = descriptor.hasNode
      ? "RUN mkdir -p /opt/pi-node && for f in /tmp/pi-skill-deps/package.json /tmp/pi-skill-deps/package-lock.json /tmp/pi-skill-deps/npm-shrinkwrap.json /tmp/pi-skill-deps/pnpm-lock.yaml /tmp/pi-skill-deps/yarn.lock; do if [ -f \"$f\" ]; then cp \"$f\" /opt/pi-node/; fi; done && if [ -f /opt/pi-node/pnpm-lock.yaml ]; then corepack pnpm install --frozen-lockfile --prod --ignore-scripts --dir /opt/pi-node; elif [ -f /opt/pi-node/yarn.lock ]; then corepack yarn install --immutable --mode=skip-builds --cwd /opt/pi-node; elif [ -f /opt/pi-node/package-lock.json ] || [ -f /opt/pi-node/npm-shrinkwrap.json ]; then npm ci --ignore-scripts --omit=dev --prefix /opt/pi-node; elif [ -f /opt/pi-node/package.json ]; then npm install --ignore-scripts --omit=dev --prefix /opt/pi-node; fi\n"
      : "";
    const dockerfile = [
      `FROM ${baseImage}`,
      "ENV HOME=/tmp TMPDIR=/tmp NODE_PATH=/opt/pi-node/node_modules PATH=/opt/pi-python/bin:/opt/pi-node/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
      "COPY . /tmp/pi-skill-deps/",
      python,
      node,
      // Dependency manifests are build inputs only. Remove them and package
      // manager caches from the resulting image layer before it is cached.
      "RUN rm -rf /tmp/pi-skill-deps /root/.cache /root/.npm /tmp/pip-*",
      "",
    ].join("\n");
    await writeFile(join(context, "Dockerfile"), dockerfile, { mode: 0o600 });
    return context;
  } catch (error) {
    await rm(context, { recursive: true, force: true });
    throw error;
  }
}

async function build(input: SkillRuntimeBuildInput): Promise<SkillRuntimeBuildResult> {
  const descriptor = resolveSkillRuntime([input.storagePath]);
  if (descriptor.profile !== input.runtimeProfile || descriptor.lockfileDigest !== input.lockfileDigest) {
    throw new Error("Skill runtime metadata no longer matches the release");
  }
  const image = imageTag(input);
  const cached = await inspectImage(image);
  if (cached) return { image, imageDigest: cached, descriptor };
  const context = await writeBuildContext(input, descriptor);
  try {
    const result = await runDocker(["build", "--pull=false", "--tag", image, context]);
    if (result.code !== 0) throw new Error(result.stderr.trim() || "runtime image build failed");
    const digest = await inspectImage(image);
    if (!digest) throw new Error("runtime image was built but has no immutable digest");
    return { image, imageDigest: digest, descriptor };
  } finally {
    await rm(context, { recursive: true, force: true });
  }
}

/** Build one immutable runtime at most once per release on this host. */
export function buildSkillRuntime(input: SkillRuntimeBuildInput): Promise<SkillRuntimeBuildResult> {
  let baseImage: string;
  try {
    baseImage = configuredBaseImage();
  } catch (error) {
    return Promise.reject(error);
  }
  const key = createHash("sha256")
    .update(`${input.lockfileDigest}\0${input.runtimeProfile}\0${baseImage}`)
    .digest("hex");
  const current = inflight.get(key);
  if (current) return current;
  const promise = build(input).finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

export function clearSkillRuntimeBuilds(): void {
  inflight.clear();
}
