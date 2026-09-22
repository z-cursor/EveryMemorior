import { buildSessionContext, getSessionEntries, resolveSessionPath } from "./session-reader";
import type { CompanionAuth, CompanionContextMessage, CompanionTurnEvent } from "./companion-runtime";
import type { TenantContext, TenantStore } from "./tenant-store";
import {
  applyExplicitCompanionPreference,
  buildCompanionLayeredContext,
  queueCompanionContinuityWork,
  queueCompanionSummaryWork,
  scheduleCompanionContinuityWorker,
} from "./companion-continuity";
import { containsSensitiveCompanionInformation, ordinaryCompanionTopics } from "./companion-memory-policy";

function textFromMessage(message: { role: string; content?: unknown }): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.flatMap((block) => {
    if (typeof block === "string") return [block];
    if (block && typeof block === "object" && "type" in block && block.type === "text" && "text" in block && typeof block.text === "string") return [block.text];
    return [];
  }).join("");
}

export async function buildTenantCompanionContext(
  store: TenantStore,
  auth: CompanionAuth,
  sessionId: string,
  currentText: string,
): Promise<CompanionContextMessage[]> {
  const path = await resolveSessionPath(sessionId);
  if (!path) return [];
  const tenantContext = { tenantId: auth.tenant.id, membershipId: auth.membership.id };
  const excluded = store.listCompanionTurns(tenantContext).filter((turn) => turn.status === "incomplete" || turn.status === "rejected");
  const entries = getSessionEntries(path);
  const timestamps = new Map(entries.map((entry) => [entry.id, entry.timestamp]));
  const sessionContext = buildSessionContext(entries, null, { tail: 80 });
  const recent = sessionContext.messages.flatMap((message, index) => {
    if (message.role !== "user" && message.role !== "assistant") return [];
    const text = textFromMessage(message);
    if (!text) return [];
    const failed = excluded.some((turn) => turn.replyText && (text === turn.replyText || text.includes(turn.replyText)));
    const entryId = sessionContext.entryIds[index] ?? "";
    return [{
      role: message.role, text, status: failed ? "incomplete" as const : "complete" as const,
      entryId, timestamp: timestamps.get(entryId) ?? new Date(0).toISOString(),
    }];
  });
  return buildCompanionLayeredContext(store, tenantContext, { currentText, recent });
}

export async function prepareCompanionContinuity(
  store: TenantStore,
  context: TenantContext,
  input: { clientMessageId: string; text: string },
  emit: (event: CompanionTurnEvent) => void | Promise<void>,
): Promise<void> {
  if (!store.getCompanionConsent(context).memoryEnabled) return;
  const profile = applyExplicitCompanionPreference(store, context, { text: input.text });
  if (profile) await emit({ type: "profile_updated", profile, clientMessageId: input.clientMessageId });
}

export async function completeCompanionContinuity(
  store: TenantStore,
  context: TenantContext,
  input: { sessionId: string; clientMessageId: string; text: string },
  emit: (event: CompanionTurnEvent) => void | Promise<void>,
): Promise<void> {
  const path = await resolveSessionPath(input.sessionId);
  const source = path ? getSessionEntries(path).findLast((entry) => (
    entry.type === "message" && entry.message.role === "user" && textFromMessage(entry.message) === input.text
  )) : undefined;
  if (!source || !path) return;
  queueCompanionContinuityWork(store, context, {
    sourceEntryId: source.id, text: input.text, sessionId: input.sessionId, clientMessageId: input.clientMessageId,
  });
  if (store.getCompanionConsent(context).memoryEnabled) {
    const existingSources = new Set(store.listCompanionFragments(context, 20).flatMap((fragment) => fragment.sourceEntryIds));
    const sessionEntries = getSessionEntries(path);
    const completedReplies = new Set(store.listCompanionTurns(context)
      .filter((turn) => turn.status === "completed" && turn.replyText)
      .map((turn) => turn.replyText!));
    const completedExchanges = sessionEntries.flatMap((entry) => {
      if (entry.type !== "message" || entry.message.role !== "user" || existingSources.has(entry.id)) return [];
      const topics = ordinaryCompanionTopics(textFromMessage(entry.message));
      if (topics.length === 0 || containsSensitiveCompanionInformation(textFromMessage(entry.message))) return [];
      const reply = sessionEntries.find((candidate) => candidate.type === "message"
        && candidate.parentId === entry.id && candidate.message.role === "assistant");
      if (!reply || reply.type !== "message" || existingSources.has(reply.id)) return [];
      const replyText = textFromMessage(reply.message);
      if (!replyText || containsSensitiveCompanionInformation(replyText) || !completedReplies.has(replyText)) return [];
      return [{ sourceEntryIds: [entry.id, reply.id], topics }];
    });
    const summaryExchanges = completedExchanges.slice(0, Math.max(0, completedExchanges.length - 6)).slice(0, 2);
    if (summaryExchanges.length === 2) {
      queueCompanionSummaryWork(store, context, {
        sessionId: input.sessionId,
        sourceEntryIds: summaryExchanges.flatMap((exchange) => exchange.sourceEntryIds),
        summary: `较早聊过与${[...new Set(summaryExchanges.flatMap((exchange) => exchange.topics))].join("、")}相关的日常兴趣。`,
      });
    }
  }
  scheduleCompanionContinuityWorker(store, context, `companion-${process.pid}`, async (event, clientMessageId) => {
    if (clientMessageId) await emit({ ...event, clientMessageId });
  });
}
