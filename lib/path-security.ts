import { realpathSync } from "fs";
import path from "path";
import { isWindowsAbsolutePath } from "./paths";

/**
 * Lexical containment check. Accepts either canonical form on both sides: it
 * re-resolves through path.win32/path.posix and case-folds on Windows, so
 * separator style and drive-letter case never decide the answer.
 */
export function isPathWithinRoots(target: string, roots: Set<string>): boolean {
  for (const root of roots) {
    const useWindowsRules = isWindowsAbsolutePath(target) || isWindowsAbsolutePath(root);
    const resolver = useWindowsRules ? path.win32 : path;
    const sep = useWindowsRules ? "\\" : path.sep;
    const normalized = resolver.resolve(target);
    const normalizedRoot = resolver.resolve(root);
    const comparable = useWindowsRules ? normalized.toLowerCase() : normalized;
    const comparableRoot = useWindowsRules ? normalizedRoot.toLowerCase() : normalizedRoot;
    const rootWithSep = comparableRoot.endsWith(sep) ? comparableRoot : comparableRoot + sep;
    if (comparable === comparableRoot || comparable.startsWith(rootWithSep)) return true;
  }
  return false;
}

export function isExistingPathWithinRoots(target: string, roots: Set<string>): boolean {
  let realTarget: string;
  try {
    realTarget = realpathSync(target);
  } catch {
    return false;
  }

  const realRoots = new Set<string>();
  for (const root of roots) {
    try {
      realRoots.add(realpathSync(root));
    } catch {
      // Ignore stale roots derived from removed sessions or worktrees.
    }
  }
  return isPathWithinRoots(realTarget, realRoots);
}

/** Resolve a future destination through its nearest existing parent. */
export function resolvePathWithExistingAncestor(target: string): string | null {
  let ancestor = path.resolve(target);
  const suffix: string[] = [];
  while (true) {
    try { return path.join(realpathSync(ancestor), ...suffix); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) return null;
      suffix.unshift(path.basename(ancestor)); ancestor = parent;
    }
  }
}

/** A mutation belongs to one Workspace, including canonical aliases and nested roots. */
export function isWorkspaceMutationPathAllowed(target: string, root: string, otherRoots: string[], includesChildren = false): boolean {
  if (!isPathWithinRoots(target, new Set([root]))) return false;
  const realTarget = resolvePathWithExistingAncestor(target);
  const realRoot = resolvePathWithExistingAncestor(root);
  if (!realTarget || !realRoot || !isPathWithinRoots(realTarget, new Set([realRoot]))) return false;
  for (const other of otherRoots) {
    const realOther = resolvePathWithExistingAncestor(other);
    // A selected nested Workspace owns its narrower scope, even when a parent
    // Workspace is registered. Siblings, descendants and aliases remain excluded.
    const lexicalParent = isPathWithinRoots(root, new Set([other])) && !isPathWithinRoots(other, new Set([root]));
    const canonicalParent = realOther && isPathWithinRoots(realRoot, new Set([realOther])) && !isPathWithinRoots(realOther, new Set([realRoot]));
    if (lexicalParent || canonicalParent) continue;
    if (isPathWithinRoots(target, new Set([other])) || (realOther && isPathWithinRoots(realTarget, new Set([realOther])))) return false;
    if (includesChildren && (isPathWithinRoots(other, new Set([target])) || (realOther && isPathWithinRoots(realOther, new Set([realTarget]))))) return false;
  }
  return true;
}
