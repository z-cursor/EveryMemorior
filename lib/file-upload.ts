import fs from "fs";
import path from "path";

export const UPLOAD_CONFLICT_STRATEGIES = ["error", "overwrite", "skip"] as const;
export type UploadConflictStrategy = typeof UPLOAD_CONFLICT_STRATEGIES[number];

const UPLOAD_CONFLICT_STRATEGY_SET = new Set<string>(UPLOAD_CONFLICT_STRATEGIES);

export interface UploadTargetInspection {
  conflicts: string[];
  nonReplaceable: string[];
}

export function parseUploadConflictStrategy(value: string | null): UploadConflictStrategy | null {
  const candidate = value ?? "error";
  return UPLOAD_CONFLICT_STRATEGY_SET.has(candidate)
    ? candidate as UploadConflictStrategy
    : null;
}

/**
 * Return the canonical relative path carried by a browser directory upload.
 * Upload paths are relative to the selected workspace directory; absolute
 * paths, traversal segments, and empty segments are never accepted.
 */
export function normalizeUploadFilePath(filePath: string): string | null {
  if (!filePath || filePath.startsWith("/") || filePath.includes("\\") || /^[a-zA-Z]:/.test(filePath)) {
    return null;
  }
  const parts = filePath.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || part.includes("\0") || part.includes(":"))) return null;
  return parts.join("/");
}

export function validateUploadFileNames(fileNames: string[]): string | null {
  if (fileNames.length === 0) return "No files selected";

  const seen = new Set<string>();
  for (const fileName of fileNames) {
    const normalized = normalizeUploadFilePath(fileName);
    if (!normalized) {
      return `Invalid file name: ${fileName || "(empty)"}`;
    }
    if (seen.has(normalized)) return `Duplicate file name in upload: ${fileName}`;
    seen.add(normalized);
  }

  return null;
}

export function inspectUploadTargets(directory: string, fileNames: string[]): UploadTargetInspection {
  const conflicts: string[] = [];
  const nonReplaceable: string[] = [];

  for (const fileName of fileNames) {
    const destination = path.join(directory, ...fileName.split("/"));
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(destination);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      throw error;
    }

    conflicts.push(fileName);
    if (!stat.isFile() || stat.isSymbolicLink()) nonReplaceable.push(fileName);
  }

  return { conflicts, nonReplaceable };
}
