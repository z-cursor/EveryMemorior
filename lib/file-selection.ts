/** A selected directory represents its entire subtree for movement and deletion. */
export function normalizeFileSelection(paths: string[]): string[] {
  const unique = [...new Set(paths)];
  return unique.filter(path => !unique.some(other => path !== other && path.startsWith(other + '/')));
}
