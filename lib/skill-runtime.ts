import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, readdirSync, readFileSync, readSync, type Dirent } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

/**
 * The runtime image is provisioned by the host/operator. It is deliberately
 * not pulled or built from a tenant archive while a command is running.
 */
export const DEFAULT_SKILL_RUNTIME_IMAGE = "pi-web-skill-runtime:2026-09-28";
export const SKILL_RUNTIME_POLICY_VERSION = "tenant-sandbox-v2";
const MAX_RUNTIME_MANIFEST_BYTES = 64 * 1024;
const MAX_DEPENDENCY_FILE_BYTES = 512 * 1024;
const MAX_SCAN_FILES = 4_000;
const MAX_SCAN_DIRECTORIES = 2_000;
/**
 * A Skill release may contain an executable script without dependency
 * metadata. Keep this list deliberately broad: the runtime image is a
 * fail-closed boundary, while missing an executable here would otherwise
 * allow the first Agent run to execute it on the host.
 */
const EXECUTABLE_SCRIPT_EXTENSIONS = new Set([
  ".bash", ".cjs", ".fish", ".js", ".jsx", ".ksh", ".lua", ".mjs", ".php", ".pl", ".py", ".py3", ".rb", ".r", ".sh", ".ts", ".tsx", ".zsh",
]);
const SHEBANG_BYTES = 256;

export class SkillRuntimeConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillRuntimeConfigurationError";
  }
}

export type SkillRuntimeDescriptor = {
  image?: string;
  imageDigest?: string;
  profile: string;
  releaseDigest: string;
  dependencyDigest: string;
  /** Digest of dependency/lock manifests used to build the runtime image. */
  lockfileDigest: string;
  /** Whether this release needs an isolated, prebuilt execution image. */
  requiresImage: boolean;
  hasPython: boolean;
  hasNode: boolean;
  dependencyFiles: string[];
};

export type SkillRuntimeRelease = {
  storagePath: string;
  image?: string | null;
  declarative?: boolean | null;
  releaseDigest?: string | null;
  lockfileDigest?: string | null;
  runtimeProfile?: string | null;
  imageDigest?: string | null;
  buildStatus?: "pending" | "building" | "ready" | "failed" | null;
};

type RuntimeManifest = {
  image?: unknown;
  imageDigest?: unknown;
  profile?: unknown;
};

function safeFile(path: string): boolean {
  try { return lstatSync(path).isFile(); } catch { return false; }
}

function safeDirectory(path: string): boolean {
  try { return lstatSync(path).isDirectory(); } catch { return false; }
}

function hasShebang(path: string): boolean {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    const buffer = Buffer.allocUnsafe(SHEBANG_BYTES);
    const bytes = readSync(descriptor, buffer, 0, buffer.byteLength, 0);
    return buffer.subarray(0, bytes).toString("utf8").startsWith("#!");
  } catch {
    return false;
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* best effort */ }
    }
  }
}

function isExecutableScript(path: string): boolean {
  const name = basename(path).toLowerCase();
  const extension = name.slice(name.lastIndexOf("."));
  if (EXECUTABLE_SCRIPT_EXTENSIONS.has(extension)) return true;
  try {
    // Zip extraction currently normalizes modes, but existing releases and
    // operator-provisioned roots can still carry an executable bit.
    if ((lstatSync(path).mode & 0o111) !== 0) return true;
  } catch {
    // Treat an unreadable file as non-executable here; the root validation
    // below still fails if the release itself is unavailable.
  }
  return hasShebang(path);
}

function validateImage(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim() || [...value].some((char) => char.charCodeAt(0) < 0x20 || char === "\u007f")) {
    throw new SkillRuntimeConfigurationError(`${field} is invalid`);
  }
  return value.trim();
}

function validateDigest(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/i.test(value.trim())) {
    throw new SkillRuntimeConfigurationError("runtime imageDigest must be a sha256 digest");
  }
  return value.trim().toLowerCase();
}

function readRuntimeManifest(root: string): RuntimeManifest | undefined {
  const path = join(root, ".pi-web-runtime.json");
  if (!safeFile(path)) return undefined;
  const stat = lstatSync(path);
  if (stat.size > MAX_RUNTIME_MANIFEST_BYTES) throw new SkillRuntimeConfigurationError("runtime manifest is too large");
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); } catch { throw new SkillRuntimeConfigurationError("runtime manifest is invalid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SkillRuntimeConfigurationError("runtime manifest must be an object");
  const manifest = value as RuntimeManifest;
  return {
    image: validateImage(manifest.image, "runtime image"),
    imageDigest: validateDigest(manifest.imageDigest),
    profile: typeof manifest.profile === "string" && manifest.profile.trim() ? manifest.profile.trim() : undefined,
  };
}

function collectFiles(root: string): string[] {
  const files: string[] = [];
  const pending = [root];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    visited += 1;
    if (visited > MAX_SCAN_DIRECTORIES) throw new SkillRuntimeConfigurationError("Skill release contains too many directories");
    let entries: Dirent<string>[];
    try { entries = readdirSync(current, { withFileTypes: true, encoding: "utf8" }) as Dirent<string>[]; } catch { continue; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (![".git", "node_modules", "__pycache__", ".pytest_cache"].includes(entry.name)) pending.push(path);
      } else if (entry.isFile()) {
        files.push(path);
        if (files.length > MAX_SCAN_FILES) throw new SkillRuntimeConfigurationError("Skill release contains too many files");
      }
    }
  }
  return files;
}

function dependencyFiles(root: string): string[] {
  const names = new Set(["requirements.txt", "requirements.lock", "pyproject.toml", "package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock"]);
  return collectFiles(root).filter((path) => {
    const name = basename(path).toLowerCase();
    return names.has(name) || /^requirements(?:[-_.][a-z0-9.-]+)?\.txt$/i.test(name);
  }).sort();
}

export function listSkillDependencyFiles(root: string): string[] {
  return dependencyFiles(resolve(root));
}

function digestFiles(paths: string[], roots: readonly string[]): string {
  const hash = createHash("sha256");
  for (const path of paths) {
    const stat = lstatSync(path);
    if (stat.size > MAX_DEPENDENCY_FILE_BYTES) throw new SkillRuntimeConfigurationError(`dependency file is too large: ${path}`);
    const rootIndex = roots.findIndex((root) => {
      const child = relative(root, path);
      return child === "" || (!child.startsWith("..") && !isAbsolute(child));
    });
    hash.update(`${rootIndex}:${rootIndex >= 0 ? relative(roots[rootIndex], path) : basename(path)}`);
    hash.update("\0");
    hash.update(readFileSync(path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** Resolve an immutable runtime descriptor for a set of mounted Skill roots. */
export function resolveSkillRuntime(storageRoots: readonly string[] | readonly SkillRuntimeRelease[]): SkillRuntimeDescriptor {
  const releases: readonly SkillRuntimeRelease[] = storageRoots.length > 0 && typeof storageRoots[0] !== "string"
    ? storageRoots as readonly SkillRuntimeRelease[]
    : (storageRoots as readonly string[]).map((storagePath) => ({ storagePath }));
  const candidateRoots = [...new Set(releases.map((release) => resolve(release.storagePath)))].sort();
  if (candidateRoots.some((root) => !safeDirectory(root))) {
    throw new SkillRuntimeConfigurationError("Skill release storage is unavailable");
  }
  const roots = candidateRoots;
  const manifests = roots.map(readRuntimeManifest).filter((manifest): manifest is RuntimeManifest => Boolean(manifest));
  const releaseImages = releases.map((release) => release.image).filter((value): value is string => Boolean(value));
  const images = [...new Set(releaseImages.length > 0
    ? releaseImages
    : manifests.map((manifest) => manifest.image).filter((value): value is string => Boolean(value)))];
  const releaseDigests = releases.map((release) => release.imageDigest).filter((value): value is string => Boolean(value));
  const digests = [...new Set((releaseDigests.length > 0
    ? releaseDigests
    : manifests.map((manifest) => manifest.imageDigest)).filter((value): value is string => Boolean(value)))];
  const profiles = [...new Set([
    ...manifests.map((manifest) => manifest.profile),
    ...releases.map((release) => release.runtimeProfile ?? undefined),
  ].filter((value): value is string => Boolean(value)))];
  if (images.length > 1 || digests.length > 1 || profiles.length > 1) {
    throw new SkillRuntimeConfigurationError("runtime artifact not ready: Skill releases require incompatible runtime profiles");
  }

  const files = roots.flatMap(dependencyFiles).sort();
  const allFiles = roots.flatMap(collectFiles);
  const executableRoots = new Set(allFiles.filter(isExecutableScript).map((path) => {
    for (const root of roots) {
      const child = relative(root, path);
      if (child === "" || (!child.startsWith("..") && !isAbsolute(child))) return root;
    }
    return "";
  }));
  const executableReleases = releases.filter((release) => {
    if (release.declarative === true) return false;
    const root = resolve(release.storagePath);
    return executableRoots.has(root) || dependencyFiles(root).length > 0;
  });
  const requiresImage = executableReleases.length > 0;
  if (executableReleases.some((release) => release.buildStatus && release.buildStatus !== "ready")) {
    throw new SkillRuntimeConfigurationError("runtime artifact not ready");
  }
  const hasPython = files.some((path) => basename(path).toLowerCase() === "requirements.lock"
    || /^(?:requirements(?:[-_.][a-z0-9.-]+)?\.txt|pyproject\.toml)$/i.test(basename(path)))
    || allFiles.some((path) => /\.py$/i.test(path));
  const hasNode = files.some((path) => /^(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock)$/i.test(basename(path)))
    || allFiles.some((path) => /\.(?:js|jsx|mjs|cjs|ts|tsx)$/i.test(path));
  if (requiresImage && executableReleases.some((release) => release.buildStatus === "ready"
    && (!release.image || !release.imageDigest || !release.runtimeProfile || !release.lockfileDigest))) {
    throw new SkillRuntimeConfigurationError("runtime artifact not ready");
  }
  const dependencyDigest = digestFiles(files, roots);
  const lockfileDigest = [...new Set(releases.map((release) => release.lockfileDigest).filter((value): value is string => Boolean(value)))].sort().join("\0") || `sha256:${dependencyDigest}`;
  const releaseDigest = [...new Set(releases.map((release) => release.releaseDigest).filter((value): value is string => Boolean(value)))].sort().join("\0")
    || roots.join("\0");

  const defaultImage = requiresImage
    ? process.env.PI_WEB_SKILL_RUNTIME_IMAGE?.trim() || DEFAULT_SKILL_RUNTIME_IMAGE
    : undefined;
  return {
    image: images[0] ?? defaultImage,
    imageDigest: digests[0] ?? (requiresImage
      ? process.env.PI_WEB_SKILL_RUNTIME_IMAGE_DIGEST?.trim()
      : process.env.PI_WEB_SANDBOX_IMAGE_DIGEST?.trim()),
    profile: profiles[0] ?? (hasPython && hasNode ? "node22-python3" : hasPython ? "python3" : hasNode ? "node22" : "shell"),
    releaseDigest: createHash("sha256").update(releaseDigest).update("\0").update(lockfileDigest).digest("hex"),
    dependencyDigest,
    lockfileDigest,
    requiresImage,
    hasPython,
    hasNode,
    dependencyFiles: files,
  };
}
