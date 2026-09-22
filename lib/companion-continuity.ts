import type {
  CompanionMemory,
  CompanionProfileField,
  TenantContext,
  TenantStore,
} from "./tenant-store";
import { containsProhibitedCompanionProfileContent, containsSensitiveCompanionInformation, normalizedOrdinaryCompanionMemory, ordinaryCompanionTopics, sensitiveCompanionTerms } from "./companion-memory-policy";

export const COMPANION_RAW_RETENTION_DAYS = 90;

export type CompanionContinuityEvent =
  | { type: "memory_receipt"; memory: CompanionMemory }
  | { type: "memory_confirmation"; memory: CompanionMemory }
  | { type: "profile_updated"; profile: CompanionProfileField };

export type CompanionContinuitySource = {
  role: "user" | "assistant";
  text: string;
  status: "complete" | "incomplete" | "rejected";
  entryId: string;
  timestamp: string;
};

export type CompanionLayeredContextItem = {
  role: "user" | "assistant";
  text: string;
  status: "complete";
  source: "memory" | "profile" | "summary" | "recent";
};

type ContinuityPayload = { sourceEntryId: string; text: string; sessionId: string; clientMessageId?: string };
type SummaryPayload = { sessionId: string; sourceEntryIds: string[]; summary: string };

const TRANSIENT_STATE = /(?:今天|刚才|现在|此刻|最近|这阵子|这会儿|暂时|这次).{0,12}(?:难过|开心|生气|焦虑|累|不想说|想休息)/u;
const EMOTIONAL_STATE = /(难过|开心|生气|焦虑|孤独|寂寞|害怕|紧张|沮丧|烦躁|累|不想说|想休息)/u;
const TRANSIENT_INTENT = /(?:想要?|打算|准备|计划|决定|希望).{0,20}(?:去|做|买|学|试|换|开始|停止|旅行|旅游)/u;
const TEMPORARY_INSTRUCTION = /(?:今天|现在|这次|这回|暂时|先)/u;
const DURABLE_PREFERENCE_START = /(?:从现在开始|以后|今后|往后)/u;
const STABLE_MEMORY = /(?:喜欢|不喜欢|偏好|爱喝|爱听|爱看)|(?:每天|每周|平时|通常|习惯|总是).{0,20}(?:喝|吃|散步|运动|睡|起床|听|看|读|写|做|去|练|养)/u;
const PERSONAL_SENSITIVE_DISCLOSURE = /(?:(?:我|本人)(?:有|患有|得了|确诊|住在|服|的|每(?:天|晚|周|月|年)|一直|总是|正在|已经|曾经|被|经历|需要|接受|做过|工资|薪资|收入|银行卡|房贷|车贷|负债|欠款)|我们家|家里|住在|住址(?:是|为)|地址(?:是|为)|(?:我的?|本人)?(?:父亲|母亲|爸|妈|女儿|儿子|老伴|丈夫|妻子|家人|家庭).{0,12}(?:去世|离世|过世|不在了|扫墓|祭奠|丧亲|葬礼|不孝|矛盾|冲突|争吵|吵架|疏远|断绝|不和))/u;
const SENSITIVE_QUESTION = /[？?]|(?:什么|怎么|哪些|是否|为何|为什么|多少|吗|呢)/u;
const GENERIC_RELEVANCE_BIGRAMS = new Set(["我喜", "喜欢", "不喜", "习惯", "每天", "一直", "通常", "平时", "我有", "我的", "我住", "住在", "家里", "家庭", "收入", "工资"]);

function hasTemporaryInstructionScope(text: string): boolean {
  return TEMPORARY_INSTRUCTION.test(text) && !DURABLE_PREFERENCE_START.test(text);
}

export function queueCompanionContinuityWork(
  store: TenantStore,
  context: TenantContext,
  payload: ContinuityPayload,
): void {
  store.enqueueCompanionBackgroundJob(context, { type: "memory_profile", payload });
}

export function queueCompanionSummaryWork(
  store: TenantStore,
  context: TenantContext,
  payload: SummaryPayload,
): void {
  store.enqueueCompanionBackgroundJob(context, { type: "fragment_summary", payload });
}

export function applyExplicitCompanionPreference(
  store: TenantStore,
  context: TenantContext,
  payload: Pick<ContinuityPayload, "text">,
): CompanionProfileField | null {
  if (hasTemporaryInstructionScope(payload.text)) return null;
  const address = payload.text.match(/(?:请叫我|请称呼我|称呼我)([^，。！？\s]{1,12})/u)?.[1];
  if (address && !containsProhibitedCompanionProfileContent(address)) {
    return store.setCompanionProfileField(context, {
      field: "form_of_address", value: address, source: "explicit", confidence: 1,
    });
  }
  if (/请.{0,6}(?:说短|简短|少说)/u.test(payload.text)) {
    return store.setCompanionProfileField(context, {
      field: "reply_length", value: "short", source: "explicit", confidence: 1,
    });
  }
  return null;
}

function inferProfile(
  store: TenantStore,
  context: TenantContext,
  payload: ContinuityPayload,
): CompanionProfileField | null {
  if (hasTemporaryInstructionScope(payload.text) || TRANSIENT_STATE.test(payload.text) || TRANSIENT_INTENT.test(payload.text)) return null;
  if (/(?:喜欢简短|短一点.{0,8}(?:轻松|更好|好读)|简短.{0,6}回复)/u.test(payload.text)) {
    return store.recordCompanionProfileEvidence(context, {
      field: "reply_length", value: "short", sourceEntryId: payload.sourceEntryId, sourceText: payload.text,
    });
  }
  if (/(?:别总问|不喜欢被问|少问问题)/u.test(payload.text)) {
    return store.recordCompanionProfileEvidence(context, {
      field: "question_preference", value: "few", sourceEntryId: payload.sourceEntryId, sourceText: payload.text,
    });
  }
  return null;
}

function extractMemory(payload: ContinuityPayload): { content: string; sensitivity: "ordinary" | "sensitive" } | null {
  const text = payload.text.trim().replace(/[。！？]+$/u, "");
  if (!text || TRANSIENT_STATE.test(text) || EMOTIONAL_STATE.test(text) || TRANSIENT_INTENT.test(text)) return null;
  if (containsSensitiveCompanionInformation(text)) {
    return PERSONAL_SENSITIVE_DISCLOSURE.test(text) && !SENSITIVE_QUESTION.test(text)
      ? { content: text, sensitivity: "sensitive" }
      : null;
  }
  const normalized = normalizedOrdinaryCompanionMemory(text);
  return STABLE_MEMORY.test(text) && normalized
    ? { content: normalized, sensitivity: "ordinary" }
    : null;
}

export function runNextCompanionContinuityJob(
  store: TenantStore,
  context: TenantContext,
  workerId: string,
  jobTypes?: readonly ("memory_profile" | "fragment_summary")[],
): { events: CompanionContinuityEvent[]; clientMessageId: string | null } | null {
  const job = store.leaseCompanionBackgroundJob(context, workerId, 30_000, jobTypes);
  if (!job) return null;
  try {
    const events: CompanionContinuityEvent[] = [];
    const memoryEnabled = store.getCompanionConsent(context).memoryEnabled;
    if (job.type === "memory_profile" && memoryEnabled) {
      const payload = job.payload as ContinuityPayload;
      if (typeof payload.sourceEntryId !== "string" || typeof payload.text !== "string" || typeof payload.sessionId !== "string") {
        throw new Error("Invalid companion continuity payload");
      }
      const profile = inferProfile(store, context, payload);
      if (profile) events.push({ type: "profile_updated", profile });
      const extracted = extractMemory(payload);
      if (extracted && !profile) {
        const memory = store.saveCompanionMemory(context, { ...extracted, sourceEntryId: payload.sourceEntryId });
        events.push({ type: memory.status === "confirmed" ? "memory_receipt" : "memory_confirmation", memory });
      }
    } else if (job.type === "fragment_summary" && memoryEnabled) {
      const payload = job.payload as SummaryPayload;
      if (!Array.isArray(payload.sourceEntryIds) || payload.sourceEntryIds.length === 0 || typeof payload.sessionId !== "string" || typeof payload.summary !== "string") {
        throw new Error("Invalid companion summary payload");
      }
      const topics = ordinaryCompanionTopics(payload.summary);
      if (topics.length === 0 || containsSensitiveCompanionInformation(payload.summary)) throw new Error("Companion summary is not an ordinary topic summary");
      store.addCompanionFragment(context, {
        sessionId: payload.sessionId,
        startEntryId: payload.sourceEntryIds[0],
        endEntryId: payload.sourceEntryIds.at(-1)!,
        sourceEntryIds: payload.sourceEntryIds,
        summary: `较早聊过与${topics.join("、")}相关的日常兴趣。`,
      });
    }
    store.completeCompanionBackgroundJob(context, job.id);
    const clientMessageId = typeof job.payload.clientMessageId === "string" ? job.payload.clientMessageId : null;
    return { events, clientMessageId };
  } catch (error) {
    store.failCompanionBackgroundJob(context, job.id, error instanceof Error ? error.message : String(error), 1_000);
    throw error;
  }
}

type CompanionContinuityEventHandler = (event: CompanionContinuityEvent, clientMessageId: string | null) => void | Promise<void>;

const workerTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function scheduleCompanionContinuityWorker(
  store: TenantStore,
  context: TenantContext,
  workerId: string,
  onEvent?: CompanionContinuityEventHandler,
  delayMs = 0,
  jobTypes?: readonly ("memory_profile" | "fragment_summary")[],
): void {
  const scope = jobTypes?.length ? [...jobTypes].sort().join(",") : "all";
  const key = `${context.tenantId}:${context.membershipId}:${scope}`;
  if (workerTimers.has(key)) return;
  const timer = setTimeout(async () => {
    workerTimers.delete(key);
    try {
      let processed = runNextCompanionContinuityJob(store, context, workerId, jobTypes);
      while (processed) {
        for (const event of processed.events) await onEvent?.(event, processed.clientMessageId);
        processed = runNextCompanionContinuityJob(store, context, workerId, jobTypes);
      }
    } catch {
      scheduleCompanionContinuityWorker(store, context, workerId, onEvent, 1_100, jobTypes);
    }
  }, Math.max(0, delayMs));
  timer.unref?.();
  workerTimers.set(key, timer);
}

function bigrams(value: string): Set<string> {
  const normalized = value.toLocaleLowerCase().replace(/[\s，。！？、；：,.!?;:]/gu, "");
  const result = new Set<string>();
  for (let index = 0; index < normalized.length - 1; index += 1) result.add(normalized.slice(index, index + 2));
  return result;
}

function relevant(memory: CompanionMemory, currentText: string): boolean {
  if (memory.sensitivity === "sensitive") {
    const queryTerms = new Set(sensitiveCompanionTerms(currentText));
    return sensitiveCompanionTerms(memory.content).some((term) => (
      term.includes(":") ? queryTerms.has(term) : currentText.includes(term)
    ));
  }
  const memoryTopics = ordinaryCompanionTopics(memory.content);
  const queryTopics = new Set(ordinaryCompanionTopics(currentText));
  if (memoryTopics.some((topic) => queryTopics.has(topic))) return true;
  const query = [...bigrams(currentText)].filter((token) => !GENERIC_RELEVANCE_BIGRAMS.has(token));
  if (query.length === 0) return false;
  const candidate = bigrams(memory.content);
  const overlap = query.filter((token) => candidate.has(token)).length;
  return query.length === 1 ? overlap === 1 : overlap >= 2;
}

export function buildCompanionLayeredContext(
  store: TenantStore,
  context: TenantContext,
  input: { currentText: string; recent: readonly CompanionContinuitySource[]; now?: string },
): CompanionLayeredContextItem[] {
  const cutoff = new Date(new Date(input.now ?? new Date().toISOString()).getTime() - COMPANION_RAW_RETENTION_DAYS * 86_400_000).toISOString();
  const memoryEnabled = store.getCompanionConsent(context).memoryEnabled;
  const memories = memoryEnabled ? store.listUsableCompanionMemories(context)
    .filter((memory) => relevant(memory, input.currentText))
    .slice(0, 5)
    .map((memory): CompanionLayeredContextItem => ({
      role: "user", status: "complete", source: "memory",
      text: `我可能记得：${memory.content}。如果已经变化或不准确，请纠正我。`,
    })) : [];
  const profiles = memoryEnabled ? store.listCompanionProfileFields(context).map((field): CompanionLayeredContextItem => ({
    role: "user", status: "complete", source: "profile",
    text: `陪伴对象明确可纠正的表达偏好（${field.field}）：${field.value}${field.sourceLabel ? `；来源：${field.sourceLabel}` : ""}`,
  })) : [];
  const summaries = memoryEnabled ? store.listCompanionFragments(context, 4).map((fragment): CompanionLayeredContextItem => ({
    role: "assistant", status: "complete", source: "summary", text: `较早对话片段摘要：${fragment.summary}`,
  })) : [];
  const recent = input.recent
    .filter((message) => message.status === "complete" && message.timestamp >= cutoff && message.text.trim())
    .slice(-12)
    .map((message): CompanionLayeredContextItem => ({
      role: message.role, status: "complete", source: "recent", text: message.text,
    }));
  return [...profiles, ...memories, ...summaries, ...recent];
}
