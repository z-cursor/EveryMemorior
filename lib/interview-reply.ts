/** Deterministic user-facing reply guard for chapter interviews. */

import { isInterviewAlreadyAnsweredCorrection } from "./interview-turn-guard";

export type InterviewReplyPayload = {
	chapter?: unknown;
	completed_count?: unknown;
	pending_question_number?: unknown;
	reply_contract?: {
		final_user_reply?: unknown;
		next_question?: unknown;
	};
	pending_question?: unknown;
	pending_kind?: unknown;
	followup_target_question_number?: unknown;
	followup_target_question?: unknown;
	asked_question?: unknown;
	followup_question?: unknown;
};

/** Show interview position in the ordinary assistant reply, using saved state. */
export function formatInterviewProgressReply(
	payload: InterviewReplyPayload,
	_action: string,
	reply: string,
): string {
	const chapter = typeof payload.chapter === "number" && Number.isInteger(payload.chapter) && payload.chapter >= 1
		? `第${payload.chapter}章` : undefined;
	const completed = typeof payload.completed_count === "number" && Number.isInteger(payload.completed_count) && payload.completed_count >= 0
		? `已完整回答${payload.completed_count}组` : undefined;
	const hasPendingQuestion = typeof payload.pending_question === "string" && payload.pending_question.trim().length > 0;
	const number = payload.pending_question_number;
	const current = hasPendingQuestion && typeof number === "number" && Number.isInteger(number) && number >= 1
		&& (payload.pending_kind === "main" || payload.pending_kind === "followup")
		? `第${number}问（${payload.pending_kind === "followup" ? "追问" : "主问题"}）`
		: undefined;
	const heading = [chapter, current, completed].filter(Boolean).join("｜");
	return heading ? `${heading}\n\n${reply}` : reply;
}

const FOREIGN_SCRIPT_RE = /[A-Za-z\u3040-\u30ff\uac00-\ud7af\u0400-\u052f\u0600-\u06ff]/u;
const NUMBERED_LIST_RE = /(?:^|\n)\s*(?:\d{1,2}|[一二三四五六七八九十]+)[\s.、)）]/u;
const LEGACY_GENERIC_PRAISE_PREFIX_RE = /^谢谢您分享这些[，,。]\s*这段经历很有画面感[。！!]?\s*/u;
const LEGACY_FOLLOWUP_PREFIX_RE = /^谢谢您告诉我这些。为了把您的经历记录得更准确，我还想再确认一个小地方：\s*/u;
const STOCK_ACKNOWLEDGEMENT_RE = /谢谢您告诉我这些|谢谢您分享这些|这段经历很有画面感|为了把您的经历记录得更准确|还差几个小点|您漏答了|回答失败|工具|模型|审核/u;

function withoutGenericPraise(text: string | undefined): string | undefined {
	return text?.replace(LEGACY_GENERIC_PRAISE_PREFIX_RE, "").replace(LEGACY_FOLLOWUP_PREFIX_RE, "").trim() || undefined;
}

/** Keep a model-written lead-in separate from the exact saved question. */
export function safeInterviewAcknowledgement(
	value: unknown,
	question: string,
	recentAcknowledgements: readonly string[] = [],
	action = "followup",
): string | undefined {
	if (typeof value !== "string") return undefined;
	const text = value.replace(/\s+/gu, " ").trim();
	if (!text || [...text].length > 48 || FOREIGN_SCRIPT_RE.test(text)
		|| /[?？\r\n]/u.test(value) || NUMBERED_LIST_RE.test(value)
		|| STOCK_ACKNOWLEDGEMENT_RE.test(text) || text.includes(question)
		|| (action === "ask" && /还想再确认|再确认一下|再核实/u.test(text))) return undefined;
	const normalized = text.replace(/[，,:：；;。！!]+$/u, "") + "。";
	if (recentAcknowledgements.includes(normalized)) return undefined;
	return normalized;
}

/** Accept only the first safe sentence of a model reply; the host supplies the question. */
export function interviewAcknowledgementFromModelText(
	value: unknown,
	question: string,
	recentAcknowledgements: readonly string[] = [],
	action = "followup",
): string | undefined {
	if (typeof value !== "string") return undefined;
	const beforeQuestion = value.includes(question) ? value.slice(0, value.indexOf(question)) : value;
	const withoutProgress = beforeQuestion
		.replace(/^第\d+章(?:｜第\d+问（(?:主问题|追问)）)?(?:｜已完整回答\d+组)?\s*/u, "")
		.trim();
	const firstLine = withoutProgress.split(/\r?\n/u).map((line) => line.trim()).find(Boolean);
	if (!firstLine) return undefined;
	const firstSentence = firstLine.match(/^[^。！!？?]{1,80}[。！!]/u)?.[0] ?? firstLine;
	return safeInterviewAcknowledgement(firstSentence, question, recentAcknowledgements, action);
}

/** Last-resort response grounded in the user's words, without inventing a summary. */
export function contextualInterviewAcknowledgement(
	answer: string | undefined,
	question: string,
	recentAcknowledgements: readonly string[] = [],
	action = "followup",
): string | undefined {
	if (!answer?.trim()) return undefined;
	const source = answer.replace(/\s+/gu, " ").trim();
	if (isInterviewAlreadyAnsweredCorrection(source)) {
		const apologies = [
			"抱歉，我刚才问重复了。您提醒得对，我们接着往下聊。",
			"是我又问了一遍，抱歉。谢谢您提醒，我们继续聊。",
		];
		for (const candidate of apologies) {
			const safe = safeInterviewAcknowledgement(candidate, question, recentAcknowledgements, action);
			if (safe) return safe;
		}
		return safeInterviewAcknowledgement(apologies[0], question, [], action);
	}
	const unavailable = /^(?:我)?(?:忘了|不记得|记不清|记不得|不知道|想不起来|不想答|不想回答|不愿回答|不方便说|不方便回答)/u.test(source);
	if (unavailable) {
		const gentle = ["没关系，这一处先放下，我们接着聊。", "记不清或不想说都没关系，我们换个细节聊。", "好的，不用勉强想这一处，我们继续往下聊。"];
		for (const candidate of gentle) {
			const safe = safeInterviewAcknowledgement(candidate, question, recentAcknowledgements, action);
			if (safe) return safe;
		}
		return safeInterviewAcknowledgement(gentle[0], question, [], action);
	}
	const firstThought = source.split(/[。！？!?；;\r\n]/u).map((part) => part.trim()).find(Boolean);
	if (!firstThought) return undefined;
	const firstClause = firstThought.split(/[，,]/u).map((part) => part.trim()).find((part) => [...part].length >= 5) ?? firstThought;
	let excerpt = [...firstClause].slice(0, 25).join("").replace(/[，,、：:；;。！!？?\s]+$/u, "");
	if (FOREIGN_SCRIPT_RE.test(excerpt)) {
		excerpt = (source.match(/[\p{Script=Han}0-9]{2,}/gu) ?? [])
			.find((part) => [...part].length >= 2)?.slice(0, 25) ?? "";
	}
	if ([...excerpt].length < 2) {
		return safeInterviewAcknowledgement("您刚才的回答，我认真记下了。", question, recentAcknowledgements, action)
			?? safeInterviewAcknowledgement("您刚才的回答，我认真记下了。", question, [], action);
	}
	const variants = [
		`您刚才提到“${excerpt}”，我记下了。`,
		`“${excerpt}”这个细节，我认真记下了。`,
		`您说到“${excerpt}”，我们就按您说的记录。`,
		`关于“${excerpt}”，我会照您的原话记。`,
		`您提起“${excerpt}”，我们慢慢接着聊。`,
		`您说“${excerpt}”，这部分我听明白了。`,
	];
	for (let offset = 0; offset < variants.length; offset += 1) {
		const candidate = variants[(recentAcknowledgements.length + offset) % variants.length];
		const safe = safeInterviewAcknowledgement(candidate, question, recentAcknowledgements, action);
		if (safe) return safe;
	}
	// Repeated short answers can exhaust the recent window. Reuse the oldest
	// safe variant before ever falling back to a bare, unanswered question.
	const oldest = variants
		.map((candidate) => ({ candidate, index: recentAcknowledgements.indexOf(candidate) }))
		.filter(({ index }) => index >= 0)
		.sort((a, b) => a.index - b.index)[0]?.candidate ?? variants[0];
	return safeInterviewAcknowledgement(oldest, question, [], action);
}

function firstString(...values: unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value !== "string") continue;
		const text = value.replace(/\s+/gu, " ").trim();
		if (text) return text;
	}
	return undefined;
}

/** Follow-ups cover one missing detail at a time, after the user's answer. */
export function firstInterviewQuestion(...values: unknown[]): string | undefined {
	const text = firstString(...values);
	if (!text) return undefined;
	const match = text.match(/^[\s\S]*?[?？]/u);
	return (match?.[0] || text).trim();
}

/** A main question can contain several related prompts; never cut it at '?'. */
export function interviewQuestionForAction(action: string, ...values: unknown[]): string | undefined {
	return action === "ask" ? firstString(...values) : firstInterviewQuestion(...values);
}

export function isSafeInterviewReply(value: unknown, allowQuestionGroup = false): value is string {
	if (typeof value !== "string") return false;
	const text = value.replace(/\s+/gu, " ").trim();
	if (!text || FOREIGN_SCRIPT_RE.test(text) || (!allowQuestionGroup && NUMBERED_LIST_RE.test(value))) return false;
	const questionMarks = (text.match(/[?？]/gu) || []).length;
	return allowQuestionGroup || questionMarks <= 1;
}

function isFollowupReply(payload: InterviewReplyPayload, action: string): boolean {
	// The action is the source of truth for the wording.  In particular,
	// status serializes a missing target as null, and older bridge payloads can
	// carry a historical short-answer target while the current action is a new
	// main question.  Neither case should turn an ordinary ask into a follow-up.
	if (action === "ask") return false;
	if (action === "followup") return true;
	return action === "answer" && payload.pending_kind === "followup";
}

function fallbackReply(payload: InterviewReplyPayload, action: string): string {
	if (action === "skip" && !firstString(payload.pending_question)) {
		return "好的，这一题先放下，没关系。我们接着往下聊。";
	}
	const mainQuestion = action === "ask" || payload.pending_kind === "main";
	const nextQuestion = interviewQuestionForAction(
		mainQuestion ? "ask" : "followup",
		...(action === "ask" ? [payload.asked_question, payload.pending_question] : []),
		...(action === "ask" ? [] : [payload.pending_question]),
		payload.followup_question,
		payload.reply_contract?.next_question,
	);
	// Never hide a registered question behind a generic transition because a
	// stray foreign token made the model's candidate fail the language filter.
	// Only repair a question that is actually registered; the reply contract
	// alone is not authoritative enough to change its wording.
	const registeredQuestion = firstString(payload.asked_question, payload.pending_question);
	let question = withoutGenericPraise(nextQuestion)?.replace(/\s+/gu, " ").trim();
	if (registeredQuestion && question) {
		question = question
			.replace(/[A-Za-z\u3040-\u30ff\uac00-\ud7af\u0400-\u052f\u0600-\u06ff]+/gu, "什么")
			.replace(/([\p{Script=Han}])\s+什么/gu, "$1什么")
			.replace(/什么\s+([\p{Script=Han}])/gu, "什么$1");
	}
	const safeNextQuestion = question && isSafeInterviewReply(question, mainQuestion) ? question : undefined;
	if (safeNextQuestion) return safeNextQuestion;
	return "好的，我们接着慢慢聊。";
}

export function buildInterviewUserReply(payload: InterviewReplyPayload, action: string): string {
	// Old session/tool payloads may still contain the retired fixed compliment.
	// Keep specific, grounded acknowledgements; never replace it with another stock line.
	const candidate = withoutGenericPraise(firstString(payload.reply_contract?.final_user_reply));
	const mainQuestion = action === "ask" || payload.pending_kind === "main";
	if (!isSafeInterviewReply(candidate, mainQuestion)) return fallbackReply(payload, action);
	const completeQuestion = withoutGenericPraise(firstString(payload.asked_question, payload.pending_question));
	if (completeQuestion && !candidate.includes(completeQuestion)) {
		return fallbackReply(payload, action);
	}
	// Older bridge results used the follow-up prefix for every question. Keep
	// ordinary `ask` replies positive and concise even when such a result is
	// still present in a session replay.
	if (!isFollowupReply(payload, action) && /还想再确认|为了把您的经历记录得更准确/u.test(candidate)) {
		return fallbackReply(payload, action);
	}
	return candidate;
}
