import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { resolveSessionPath } from "./session-reader";
import { getRpcSession, startRpcSession, type AgentEvent, type AgentSessionWrapper } from "./rpc-manager";
import {
  buildCompanionSystemPrompt,
  CompanionRuntime,
  type CompanionAuth,
  type CompanionModelRequest,
  type CompanionSearchResult,
  type CompanionTurnEvent,
} from "./companion-runtime";
import { getTenantStore } from "./tenant-store";
import { buildTenantCompanionContext, completeCompanionContinuity, prepareCompanionContinuity } from "./companion-runtime-continuity";
import { shouldSampleCompanionTurn } from "./companion-quality";

function companionCwd(auth: CompanionAuth): string {
  const path = join(getAgentDir(), "companion-sessions", auth.tenant.id, auth.membership.id);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function eventTextDelta(event: AgentEvent): string | null {
  if (event.type !== "message_update" || !isObject(event.assistantMessageEvent)) return null;
  const assistantEvent = event.assistantMessageEvent;
  return assistantEvent.type === "text_delta" && typeof assistantEvent.delta === "string" ? assistantEvent.delta : null;
}

function createPiGenerator(session: AgentSessionWrapper) {
  return async (request: CompanionModelRequest, onDelta: (text: string) => Promise<void>, signal?: AbortSignal): Promise<string> => {
    session.setExactContextMessages([
      ...request.context.map((message) => ({
        role: message.role,
        content: message.text,
        timestamp: Date.now(),
      })),
      { role: "user", content: request.input, timestamp: Date.now() },
    ] as never);
    let reply = "";
    let deltaChain = Promise.resolve();
    let settled = false;
    const result = new Promise<string>((resolve, reject) => {
      const unsubscribe = session.onEvent((event) => {
        const delta = eventTextDelta(event);
        if (delta) {
          reply += delta;
          deltaChain = deltaChain.then(() => onDelta(delta));
        }
        if (event.type === "prompt_error") {
          settled = true;
          unsubscribe();
          reject(new Error(typeof event.errorMessage === "string" ? event.errorMessage : "Companion model failed"));
        } else if (event.type === "prompt_done" || event.type === "agent_end") {
          if (settled) return;
          settled = true;
          void deltaChain.then(() => { unsubscribe(); resolve(reply); }, reject);
        }
      });
      const abort = () => {
        void session.send({ type: "abort" }).catch(() => undefined);
      };
      signal?.addEventListener("abort", abort, { once: true });
      void session.send({ type: "prompt", message: request.input }).catch((error) => {
        if (settled) return;
        settled = true;
        unsubscribe();
        reject(error);
      });
    });
    return result;
  };
}

function reviewCandidate(request: CompanionModelRequest, candidate: string): { approved: boolean; replacement?: string } {
  const lower = candidate.toLocaleLowerCase();
  if (/(我是人类|我是真人|我已经报警|我已经联系|我可以定位|我会去救您)/u.test(lower)) {
    if (request.input.match(/自杀|想死|不想活|结束生命/u)) {
      return { approved: false, replacement: "如果您现在有危险，请立即拨打当地急救电话，或走到可信任的人身边求助。凡小忆是 AI，不能联系、定位、报警或救援。" };
    }
    return { approved: false };
  }
  return { approved: true };
}

declare global {
  var __piCompanionSessionLocks: Map<string, Promise<AgentSessionWrapper>> | undefined;
  var __piCompanionAbortControllers: Map<string, AbortController> | undefined;
  var __piCompanionTurnLocks: Map<string, Promise<unknown>> | undefined;
}

function sessionLocks(): Map<string, Promise<AgentSessionWrapper>> {
  return globalThis.__piCompanionSessionLocks ??= new Map();
}

function abortControllers(): Map<string, AbortController> {
  return globalThis.__piCompanionAbortControllers ??= new Map();
}

function turnLocks(): Map<string, Promise<unknown>> {
  return globalThis.__piCompanionTurnLocks ??= new Map();
}

export function abortTenantCompanionTurn(auth: CompanionAuth): void {
  abortControllers().get(`${auth.tenant.id}:${auth.membership.id}`)?.abort();
}

export async function getCompanionSession(auth: CompanionAuth): Promise<AgentSessionWrapper> {
  const key = `${auth.tenant.id}:${auth.membership.id}`;
  const existingLock = sessionLocks().get(key);
  if (existingLock) return existingLock;
  const work = (async () => {
    const store = getTenantStore();
    const context = { tenantId: auth.tenant.id, membershipId: auth.membership.id };
    const existingAssignment = store.getCompanionAssignment(context);
    const config = existingAssignment
      ? store.getCompanionConfigVersion(auth.tenant.id, existingAssignment.configVersionId)
      : store.ensureCompanionConfig(context);
    if (!config) throw new Error("Published companion config not found");
    const exactSystemPrompt = () => buildCompanionSystemPrompt(config, new Date().toISOString());
    if (existingAssignment) {
      const live = getRpcSession(existingAssignment.sessionId);
      if (live?.isAlive()) return live;
      const file = await resolveSessionPath(existingAssignment.sessionId);
      const started = await startRpcSession(existingAssignment.sessionId, file ?? "", companionCwd(auth), {
        toolNames: [], tenantIsolated: true, initialModel: { provider: config.modelProvider, modelId: config.modelId },
        thinkingLevel: config.thinkingLevel as never, exactSystemPrompt,
      });
      return started.session;
    }
    const started = await startRpcSession("", "", companionCwd(auth), {
      toolNames: [], tenantIsolated: true, initialModel: { provider: config.modelProvider, modelId: config.modelId },
      thinkingLevel: config.thinkingLevel as never, exactSystemPrompt,
    });
    store.ensureCompanionAssignment(context, started.realSessionId);
    return started.session;
  })();
  sessionLocks().set(key, work);
  try {
    return await work;
  } finally {
    if (sessionLocks().get(key) === work) sessionLocks().delete(key);
  }
}

async function runTenantCompanionTurnOnce(input: {
  auth: CompanionAuth;
  clientMessageId: string;
  text: string;
  signal?: AbortSignal;
}, emit: (event: CompanionTurnEvent) => void | Promise<void>): Promise<Awaited<ReturnType<CompanionRuntime["runCompanionTurn"]>>> {
  const session = await getCompanionSession(input.auth);
  const store = getTenantStore();
  const context = { tenantId: input.auth.tenant.id, membershipId: input.auth.membership.id };
  const assignment = store.getCompanionAssignment(context);
  if (!assignment) throw new Error("Companion assignment not found");
  const key = `${input.auth.tenant.id}:${input.auth.membership.id}`;
  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  input.signal?.addEventListener("abort", forwardAbort, { once: true });
  abortControllers().set(key, controller);
  const runtime = new CompanionRuntime({
    persistence: {
      getAssignment: (context) => store.getCompanionAssignment(context),
      getConfig: (tenantId, configVersionId) => store.getCompanionConfigVersion(tenantId, configVersionId),
      findTurn: (context, clientMessageId) => store.findCompanionTurn(context, clientMessageId),
      beginTurn: (context, turn) => store.beginCompanionTurn(context, turn),
      completeTurn: (context, turnId, update) => store.completeCompanionTurn(context, turnId, update),
    },
    context: (auth, currentAssignment, currentText) => buildTenantCompanionContext(store, auth, currentAssignment.sessionId, currentText),
    beforeContext: (turn, eventSink) => prepareCompanionContinuity(store, context, turn, eventSink),
    afterCompleted: async (turn, result, eventSink) => {
      await completeCompanionContinuity(store, context, turn, eventSink);
      if (result.replyText && shouldSampleCompanionTurn(result.id)) store.sampleCompletedCompanionTurn(context, { turnId: result.id, userText: input.text, assistantText: result.replyText });
    },
    generate: createPiGenerator(session),
    review: async (request, candidate) => reviewCandidate(request, candidate),
    async search(query): Promise<CompanionSearchResult | null> {
      void query;
      return null;
    },
  });
  try {
    return await runtime.runCompanionTurn({ ...input, sessionId: assignment.sessionId, signal: controller.signal }, emit);
  } finally {
    input.signal?.removeEventListener("abort", forwardAbort);
    if (abortControllers().get(key) === controller) abortControllers().delete(key);
  }
}

export async function runTenantCompanionTurn(input: {
  auth: CompanionAuth;
  clientMessageId: string;
  text: string;
  signal?: AbortSignal;
}, emit: (event: CompanionTurnEvent) => void | Promise<void>): Promise<Awaited<ReturnType<typeof runTenantCompanionTurnOnce>>> {
  const key = `${input.auth.tenant.id}:${input.auth.membership.id}:${input.clientMessageId.trim()}`;
  const existing = turnLocks().get(key) as Promise<Awaited<ReturnType<typeof runTenantCompanionTurnOnce>>> | undefined;
  if (existing) return existing;
  const work = runTenantCompanionTurnOnce(input, emit);
  turnLocks().set(key, work);
  try {
    return await work;
  } finally {
    if (turnLocks().get(key) === work) turnLocks().delete(key);
  }
}
