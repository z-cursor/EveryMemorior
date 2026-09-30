type InterviewToolArguments = {
	action?: string;
	chapter?: number;
};

type MessageContentPart = {
	type?: string;
	id?: string;
	text?: string;
	name?: string;
	arguments?: unknown;
};

type SessionEntryLike = {
	type?: string;
	message?: {
		role?: string;
		toolCallId?: string;
		toolName?: string;
		isError?: boolean;
		details?: unknown;
		content?: string | MessageContentPart[];
	};
};

export type InterviewUserMutation = "answer" | "skip" | "supplement" | "free_recall";

// These are transport/control messages from the chat UI, not biographical
// answers.  In particular, a user can press a visible “继续” control after a
// tool call was collapsed or failed to render.  Treating that word as an
// answer corrupts the current question and makes the next answer impossible
// to attach to it.
const CONTINUE_COMMAND_RE = /^(?:继续|继续吧|接着|接着说|接着问|往下|继续采访|继续进行采访)$/u;
const SKIP_COMMAND_RE = /^(?:跳过|先跳过|换一题|换个问题|下一题|不答了|不回答了|这题跳过)$/u;
const UNAVAILABLE_COMMAND_RE = /^(?:我)?(?:忘了|不记得|记不清|记不得|不知道|想不起来|不清楚|没有印象|(?:不想|不愿|不方便)(?:答|回答|说)(?:这个(?:问题|小问)?)?(?:了|吧)?)$/u;
const NEGATIVE_ANSWER_RE = /^(?:没有|没什么|没遇到(?:过)?|没有遇到(?:过)?|没有这回事|从来没有|不曾|没有发生过|没发生过|没碰到(?:过)?|没变化|没有变化)$/u;
const ALREADY_ANSWERED_CORRECTION_RE = /^(?:我的意思是)?(?:这(?:个问题|题)?)?(?:我)?(?:(?:已经|刚才|刚刚|前面|之前)(?:不是)?|不是(?:刚才|刚刚))(?:已经)?(?:回答|答|说)(?:过|了)(?:这个问题|这题|这一问)?(?:了|吗|啊|呀|呢|吧){0,2}$/u;

function normalizeText(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function normalizeCommandText(value: string): string {
	return normalizeText(value).replace(/[。！？!?，,；;、]+$/u, "").trim();
}

export function isInterviewContinueCommand(value: string | undefined): boolean {
	return typeof value === "string" && CONTINUE_COMMAND_RE.test(normalizeCommandText(value));
}

export function isInterviewSkipCommand(value: string | undefined): boolean {
	return typeof value === "string" && SKIP_COMMAND_RE.test(normalizeCommandText(value));
}

export function isInterviewUnavailableCommand(value: string | undefined): boolean {
	return typeof value === "string" && UNAVAILABLE_COMMAND_RE.test(normalizeCommandText(value));
}

export function isInterviewNegativeAnswer(value: string | undefined): boolean {
	return typeof value === "string" && NEGATIVE_ANSWER_RE.test(normalizeCommandText(value));
}

/** A short objection to a repeated question is a correction, not biography material. */
export function isInterviewAlreadyAnsweredCorrection(value: string | undefined): boolean {
	if (typeof value !== "string") return false;
	const normalized = normalizeCommandText(value).replace(/^[。！？!?，,；;、\s]+/u, "");
	return [...normalized].length <= 36 && ALREADY_ANSWERED_CORRECTION_RE.test(normalized);
}

function parseToolArguments(value: unknown): InterviewToolArguments | undefined {
	if (value && typeof value === "object") return value as InterviewToolArguments;
	if (typeof value !== "string") return undefined;
	try {
		const parsed = JSON.parse(value);
		return parsed && typeof parsed === "object" ? parsed as InterviewToolArguments : undefined;
	} catch {
		return undefined;
	}
}

function rawUserText(entry: SessionEntryLike): string | undefined {
	if (entry.type !== "message" || entry.message?.role !== "user") return undefined;
	const content = entry.message.content;
	if (typeof content === "string") return content.trim() || undefined;
	if (!Array.isArray(content)) return undefined;
	const text = content
		.filter((part) => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text as string)
		.join("\n");
	return text.trim() || undefined;
}

function userText(entry: SessionEntryLike): string | undefined {
	const raw = rawUserText(entry);
	return raw ? normalizeText(raw) : undefined;
}

function latestInterviewPromptIndex(entries: readonly SessionEntryLike[], chapter: number): number {
	const latestUserIndex = latestUserMessage(entries)?.index ?? -1;
	const toolResults = entries
		.filter((entry) => (entry.type === "message" || entry.type === "toolResult")
			&& entry.message?.role === "toolResult")
		.map((entry) => entry.message)
		.filter((message): message is NonNullable<SessionEntryLike["message"]> => !!message);
	const completedToolCallIds = new Set(toolResults
		.map((message) => message.toolCallId)
		.filter((id): id is string => typeof id === "string" && id.length > 0));
	const unissuedToolCallIds = new Set(toolResults
		.filter((message) => message.isError === true
			|| (message.details && typeof message.details === "object"
				&& (message.details as { interview_action?: unknown }).interview_action === "defer_ask"))
		.map((message) => message.toolCallId)
		.filter((id): id is string => typeof id === "string" && id.length > 0));
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
		const content = entry.message.content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if (part.type !== "toolCall" || part.name !== "biography_chapter_interviewer") continue;
			const toolCallId = part.id;
			if (toolCallId && (unissuedToolCallIds.has(toolCallId)
				|| (index > latestUserIndex && !completedToolCallIds.has(toolCallId)))) continue;
			const args = parseToolArguments(part.arguments);
			if (args?.chapter === chapter && (args.action === "ask" || args.action === "followup")) {
				return index;
			}
		}
	}
	return -1;
}

function latestUserMessage(entries: readonly SessionEntryLike[]): { index: number; text: string; rawText: string } | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const rawText = rawUserText(entries[index]);
		if (rawText) return { index, text: normalizeText(rawText), rawText };
	}
	return undefined;
}

/** Recover the exact user-authored span when a model changes only whitespace. */
function exactUserFragment(source: string, candidate: string): string | undefined {
	const requested = candidate.replace(/\s+/gu, "");
	if (!requested) return undefined;
	const offsets: number[] = [];
	let compact = "";
	for (let index = 0; index < source.length; index += 1) {
		if (/\s/u.test(source[index])) continue;
		offsets.push(index);
		compact += source[index];
	}
	const start = compact.indexOf(requested);
	if (start < 0) return undefined;
	return source.slice(offsets[start], offsets[start + requested.length - 1] + 1);
}

export function latestInterviewUserText(entries: readonly SessionEntryLike[]): string | undefined {
	return latestUserMessage(entries)?.text;
}

function latestUserAlreadyAnswered(entries: readonly SessionEntryLike[], userIndex: number, chapter: number): boolean {
	const calls = new Map<string, InterviewToolArguments>();
	for (let index = userIndex + 1; index < entries.length; index += 1) {
		const message = entries[index]?.message;
		if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const part of message.content) {
			if (part.type !== "toolCall" || part.name !== "biography_chapter_interviewer" || !part.id) continue;
			const args = parseToolArguments(part.arguments);
			if (args) calls.set(part.id, args);
		}
	}
	for (let index = userIndex + 1; index < entries.length; index += 1) {
		const message = entries[index]?.message;
		if (message?.role !== "toolResult" || message.isError === true || !message.toolCallId) continue;
		const call = calls.get(message.toolCallId);
		if (call?.chapter !== chapter) continue;
		const action = message.details && typeof message.details === "object"
			? (message.details as { interview_action?: unknown }).interview_action ?? call.action
			: call.action;
		if (action === "answer" || action === "skip" || action === "free_recall") return true;
	}
	return false;
}

export function assertInterviewUserMutation(options: {
	action: InterviewUserMutation;
	chapter: number;
	answer?: string;
	entries: readonly SessionEntryLike[];
}): string | undefined {
	const latestUser = latestUserMessage(options.entries);
	if (!latestUser) {
		throw new Error("采访记录被拒绝：当前会话没有可作为来源的用户消息。模型不得替用户回答、跳过或补充问题。");
	}

	const promptIndex = latestInterviewPromptIndex(options.entries, options.chapter);
	if (promptIndex >= 0 && latestUser.index <= promptIndex) {
		throw new Error(
			`采访记录被拒绝：第 ${options.chapter} 章当前问题发出后尚未收到新的用户消息。` +
			"模型不得根据自己的总结、推测或工具输出代替用户作答；请结束当前回复并等待用户回答。",
		);
	}
	if ((options.action === "answer" || options.action === "skip" || options.action === "free_recall")
		&& latestUserAlreadyAnswered(options.entries, latestUser.index, options.chapter)) {
		throw new Error("采访记录被拒绝：同一条用户消息已经登记，不能再次作为另一题的回答或跳过依据。");
	}

	if (options.action === "answer" || options.action === "supplement" || options.action === "free_recall") {
		const answer = normalizeText(options.answer ?? "");
		if (options.action === "answer" && (isInterviewContinueCommand(answer) || isInterviewSkipCommand(answer))) {
			throw new Error("采访记录被拒绝：继续或跳过是流程指令，不是传主回答；请按流程指令处理，不要写入问答。");
		}
		const quotedText = exactUserFragment(latestUser.rawText, answer);
		if (!quotedText) {
			throw new Error(
				"采访记录被拒绝：answer 的实际文字必须来自提问之后最新一条用户消息；允许换行等空白排版差异，不能补写、改写或推断。",
			);
		}
		return quotedText;
	}

	if (!isInterviewContinueCommand(latestUser.text)
		&& !isInterviewSkipCommand(latestUser.text)
		&& !isInterviewUnavailableCommand(latestUser.text)
		&& !/(跳过|换一题|下一题|忘了|不记得|记不清|不知道|不想答|不想回答|不愿回答|不方便说|不方便回答)/u.test(latestUser.text)) {
		throw new Error("采访跳过被拒绝：最新用户消息没有明确表达跳过、忘记或不愿回答。");
	}
}
