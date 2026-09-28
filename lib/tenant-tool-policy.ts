/** Tool names allowed for tenant sessions. Keep this module client-safe. */
export const TENANT_WORK_TOOL_NAMES = ["read", "write", "edit", "grep", "find", "ls"] as const;
export const TENANT_READ_TOOL_NAMES = ["read", "grep", "find", "ls"] as const;

function normalizedToolNames(names: readonly string[]): string {
  return names.slice().sort().join(",");
}

export function isTenantWorkspaceToolSelection(names: readonly string[]): boolean {
  const normalized = normalizedToolNames(names);
  return normalized === normalizedToolNames(TENANT_READ_TOOL_NAMES)
    || normalized === normalizedToolNames(TENANT_WORK_TOOL_NAMES);
}
