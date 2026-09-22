export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { configureHttpDispatcher } = await import("@/lib/http-dispatcher");
  configureHttpDispatcher();
  const [{ getTenantStore }, { scheduleCompanionRetentionSweep }, { scheduleCompanionContinuityWorker }] = await Promise.all([
    import("@/lib/tenant-store"),
    import("@/lib/companion-retention"),
    import("@/lib/companion-continuity"),
  ]);
  const store = getTenantStore();
  scheduleCompanionRetentionSweep(store);
  for (const target of store.listCompanionRetentionTargets()) {
    try {
      store.getCompanionConsent(target);
      scheduleCompanionContinuityWorker(store, target, `companion-${process.pid}`, undefined, 0, ["fragment_summary"]);
    } catch { /* Suspended relationships retain data but do not run personalization jobs. */ }
  }
}
