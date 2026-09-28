const DEFAULT_MODEL_MAX_ACTIVE = 8;
const MAX_MODEL_MAX_ACTIVE = 64;
const MAX_MODEL_QUEUE = 128;

type Release = () => void;
type Waiter = { resolve: (release: Release) => void; reject: (error: unknown) => void };

type ModelAdmissionState = {
  active: number;
  limit: number;
  queue: Waiter[];
};

const GLOBAL_STATE_KEY = "__piWebModelAdmission";

function configuredLimit(): number {
  const value = Number.parseInt(process.env.PI_MODEL_MAX_ACTIVE ?? "", 10);
  if (!Number.isInteger(value) || value < 1) return DEFAULT_MODEL_MAX_ACTIVE;
  return Math.min(value, MAX_MODEL_MAX_ACTIVE);
}

function state(): ModelAdmissionState {
  const root = globalThis as typeof globalThis & { [GLOBAL_STATE_KEY]?: ModelAdmissionState };
  const existing = root[GLOBAL_STATE_KEY];
  if (existing) {
    existing.limit = configuredLimit();
    return existing;
  }
  const created: ModelAdmissionState = { active: 0, limit: configuredLimit(), queue: [] };
  root[GLOBAL_STATE_KEY] = created;
  return created;
}

function releaseSlot(admission: ModelAdmissionState): Release {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    admission.active = Math.max(0, admission.active - 1);
    pump(admission);
  };
}

function pump(admission: ModelAdmissionState): void {
  while (admission.active < admission.limit && admission.queue.length > 0) {
    const waiter = admission.queue.shift()!;
    admission.active += 1;
    waiter.resolve(releaseSlot(admission));
  }
}

/**
 * Limits model turns across all sessions in this Node process.
 * The state lives on globalThis so Next.js hot reload cannot create a second
 * gate and accidentally double the configured model concurrency.
 */
export function acquireModelAdmission(): Promise<Release> {
  const admission = state();
  if (admission.active < admission.limit && admission.queue.length === 0) {
    admission.active += 1;
    return Promise.resolve(releaseSlot(admission));
  }
  if (admission.queue.length >= MAX_MODEL_QUEUE) {
    return Promise.reject(new Error("Model request queue is full"));
  }
  return new Promise<Release>((resolve, reject) => {
    admission.queue.push({ resolve, reject });
    pump(admission);
  });
}

export function getModelAdmissionStats(): { active: number; queued: number; limit: number } {
  const admission = state();
  return { active: admission.active, queued: admission.queue.length, limit: admission.limit };
}

export const MODEL_ADMISSION_DEFAULT_LIMIT = DEFAULT_MODEL_MAX_ACTIVE;
