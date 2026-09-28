import { access, lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
export { TENANT_READ_TOOL_NAMES, TENANT_WORK_TOOL_NAMES, isTenantWorkspaceToolSelection } from "./tenant-tool-policy";

function within(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}

function globRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*").replace(/\?/g, "[^/]")}$`);
}

function redactToolError(error: unknown, root: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  const virtualized = message
    .replaceAll(root, "/workspace")
    .replaceAll(root.replaceAll("\\", "/"), "/workspace")
    .replaceAll("\\", "/");
  // SDK helpers sometimes construct an absolute path after the operation
  // callback returns. Keep those failures useful without returning host paths.
  if (/[A-Za-z]:[\\/]/.test(virtualized) || /(?:^|[\s'\"])(?:\\\\|\/(?:Users|home|tmp|var|opt|mnt))[^\s'\"]*/i.test(virtualized)) {
    return new Error("Workspace file operation failed");
  }
  return new Error(virtualized);
}

function redactToolErrors(tools: ToolDefinition[], root: string): ToolDefinition[] {
  return tools.map((tool) => {
    const execute = tool.execute;
    return {
      ...tool,
      execute: async (...args: Parameters<typeof execute>) => {
        try {
          return await execute(...args);
        } catch (error) {
          throw redactToolError(error, root);
        }
      },
    };
  });
}

/** SDK tools constrained to one physical tenant workspace. */
export function createTenantReadTools(workspaceRoot: string): ToolDefinition[] {
  const root = resolve(workspaceRoot);
  const checked = async (input: string) => {
    const candidate = resolve(input);
    if (!within(root, candidate)) throw new Error("Path is outside your personal workspace");
    const actual = await realpath(candidate);
    if (!within(root, actual)) throw new Error("Path resolves outside your personal workspace");
    return actual;
  };
  const checkedWritePath = async (input: string) => {
    const candidate = resolve(input);
    if (!within(root, candidate)) throw new Error("Path is outside your personal workspace");

    // Existing targets are resolved so a symlink cannot redirect a write.
    try {
      const actual = await realpath(candidate);
      if (!within(root, actual)) throw new Error("Path resolves outside your personal workspace");
      if ((await lstat(candidate)).isSymbolicLink()) throw new Error("Symbolic links are not writable");
      return actual;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
    }

    // New files may have missing parent directories. Resolve the nearest
    // existing parent before allowing the SDK to create anything below it.
    let parent = dirname(candidate);
    while (within(root, parent)) {
      try {
        const actualParent = await realpath(parent);
        if (!within(root, actualParent)) throw new Error("Path resolves outside your personal workspace");
        return join(parent, ...relative(parent, candidate).split(sep));
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
        const next = dirname(parent);
        if (next === parent) break;
        parent = next;
      }
    }
    throw new Error("Path is outside your personal workspace");
  };
  const safeMkdir = async (dir: string) => {
    await checkedWritePath(join(dir, ".pi-web-directory-check"));
    await mkdir(dir, { recursive: true });
    const actual = await realpath(dir);
    if (!within(root, actual)) throw new Error("Path resolves outside your personal workspace");
  };
  const safeWriteFile = async (path: string, content: string) => {
    const target = await checkedWritePath(path);
    await writeFile(target, content, "utf8");
  };
  const exists = async (path: string) => {
    try { await checked(path); return true; } catch { return false; }
  };

  const tools = [
    createReadToolDefinition(root, { operations: {
      readFile: async (path) => readFile(await checked(path)),
      access: async (path) => { await access(await checked(path)); },
    } }),
    createWriteToolDefinition(root, { operations: {
      writeFile: safeWriteFile,
      mkdir: safeMkdir,
    } }),
    createEditToolDefinition(root, { operations: {
      readFile: async (path) => readFile(await checked(path)),
      writeFile: safeWriteFile,
      access: async (path) => { await access(await checkedWritePath(path), 2); },
    } }),
    createGrepToolDefinition(root, { operations: {
      isDirectory: async (path) => (await stat(await checked(path))).isDirectory(),
      readFile: async (path) => readFile(await checked(path), "utf8"),
    } }),
    createFindToolDefinition(root, { operations: {
      exists,
      glob: async (pattern, cwd, options) => {
        const base = await checked(cwd);
        const matcher = globRegex(pattern.replaceAll("\\", "/"));
        const results: string[] = [];
        const walk = async (dir: string): Promise<void> => {
          if (results.length >= options.limit) return;
          for (const entry of await readdir(dir, { withFileTypes: true })) {
            if (entry.isSymbolicLink() || entry.name === "node_modules" || entry.name === ".git") continue;
            const path = resolve(dir, entry.name);
            const rel = relative(base, path).split(sep).join("/");
            if (matcher.test(rel) && !options.ignore.some((ignore) => globRegex(ignore.replace(/^\*\*\//, "")).test(rel))) results.push(path);
            if (entry.isDirectory()) await walk(path);
            if (results.length >= options.limit) break;
          }
        };
        await walk(base);
        return results;
      },
    } }),
    createLsToolDefinition(root, { operations: {
      exists,
      stat: async (path) => stat(await checked(path)),
      readdir: async (path) => readdir(await checked(path)),
    } }),
  ];
  return redactToolErrors(tools as unknown as ToolDefinition[], root);
}
