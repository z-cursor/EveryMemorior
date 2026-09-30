/* eslint-disable @typescript-eslint/no-explicit-any */
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	assertInterviewUserMutation,
	isInterviewAlreadyAnsweredCorrection,
	isInterviewContinueCommand,
	isInterviewNegativeAnswer,
	isInterviewSkipCommand,
	isInterviewUnavailableCommand,
	latestInterviewUserText,
} from "./interview-turn-guard";
import {
	buildInterviewUserReply,
	contextualInterviewAcknowledgement,
	formatInterviewProgressReply,
	interviewAcknowledgementFromModelText,
	interviewQuestionForAction,
	safeInterviewAcknowledgement,
	type InterviewReplyPayload,
} from "./interview-reply";
import { findSessionCaseHint, findSessionCaseSelection } from "./session-case-binding";
import { normalizeCaseBashPaths } from "./case-bash-path";
import { listSelectedCaseDirectory } from "./case-directory-read";

const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(EXTENSION_DIR, "..");
const PYTHON = process.env.BIOGRAPHY_PYTHON || "python";
const BRIDGE = path.join(PROJECT_ROOT, "scripts", "pi_bridge.py");
const TERMINATING_INTERVIEW_ACTIONS = new Set([
	"ask",
	"followup",
	"answer",
	"skip",
	"supplement",
]);
type InterviewChoice = "write" | "continue" | "free_recall" | "pause" | "confirm_write";

/**
 * Tool arguments are the controller's structured decision.  Keep them ahead
 * of natural-language inference from the latest user message: a confirmation
 * such as “继续写” is intentionally not a write-menu phrase, but the model
 * has already normalized it to choice=confirm_write before calling the tool.
 */
export function resolveInterviewChoice(
	requestedChoice: InterviewChoice | undefined,
	latestUserText: string | undefined,
	modelBackedWriteRequest = false,
): InterviewChoice | undefined {
	return requestedChoice
		?? interviewChoiceFromUserText(latestUserText)
		?? (modelBackedWriteRequest ? "write" : undefined);
}

function interviewChoiceFromUserText(value: string | undefined): InterviewChoice | undefined {
const text = value?.replace(/[。！？!?，,；;、\s]+/gu, "").trim() ?? "";
	if ([...text].length > 80) return undefined;
	if (/^(?:先别|不要|暂时不|不想|还不想)写/u.test(text)) return undefined;
	if (/^(?:1|一|第一个|第一种|选一|选1)(?:吧|就好)?$/u.test(text)
		|| /^(?:我想|我选|那就|可以|好)?(?:不用继续采访了?)?(?:直接|现在就?|马上)?(?:开始)?写(?:作|这一章)?(?:吧|了)?$/u.test(text)
		|| /^(?:可以|能|能不能|现在可以|是不是可以)(?:开始|直接)?写(?:作|这一章)?(?:了)?吗$/u.test(text)
		|| /^(?:直接|现在就?|马上)(?:开始)?写(?:作|这一章)?(?:吧|了)?(?:我累了|有点累了|不想聊了|别问了)?$/u.test(text)
		|| /^(?:别问了|不用再问了|不想聊了|我累了|有点累了|跳过这题|这题跳过)(?:就|直接|现在)?(?:开始)?写(?:作|这一章)?(?:吧|了)?$/u.test(text)
		|| /^(?:能写|可以写)(?:就)?(?:直接|现在)?(?:开始)?写(?:作|这一章)?(?:吧|了)?$/u.test(text)
		|| /^(?:结束采访|不采访了)(?:直接|现在)?(?:开始)?写(?:作)?(?:吧|了)?$/u.test(text)
		|| /^(?:我说)?(?:我)?(?:不想回答了|不想再回答了|不想继续回答了|不想再答了|别问了|不用再问了).{0,12}(?:开始|直接|现在|就)写(?:作|这一章)?(?:吧|了)?$/u.test(text)
		|| /^(?:(?:我说)?(?:我)?(?:想|要|请|就|那就|现在|直接|马上).{0,8})?(?:开始|直接|现在|就)写(?:作|这一章)?(?:吧|了)?$/u.test(text)
		|| /^(?:结束采访|不再采访|不想继续采访了|采访到这里结束|采访就到这里|不用再采访了)(?:吧|了)?$/u.test(text)) return "write";
	if (/^(?:今天先到这|先到这里|今天先结束采访|先休息|休息一下|先暂停|暂停采访|下次再说|明天再聊|我累了|有点累了|别问了|先别问了|先不采访了|先不回答了|(?:今天)?(?:我)?不想(?:再)?回答(?:了)?)(?:吧|了)?$/u.test(text)
		|| /^(?:今天先到这|先到这里|先休息)(?:下次|改天|明天)再(?:开始)?写(?:作)?(?:吧)?$/u.test(text)) return "pause";
	if (/^(?:2|二|第二个|第二种|选二|选2)(?:吧|就好)?$/u.test(text)
		|| /^(?:我想|我选|那就|请)?(?:继续采访|继续提问|继续按题采访|再问几题|你继续问)(?:吧)?$/u.test(text)) return "continue";
	if (/^(?:3|三|第三个|第三种|选三|选3)(?:吧|就好)?$/u.test(text)
		|| /^(?:我想|我选|那就)?(?:我自己说|我自己讲|自由讲|自由讲述|自由回忆|我想自己讲|我想讲一段回忆|我来说记忆中的事)(?:吧)?$/u.test(text)) return "free_recall";
	return undefined;
}

function isVerbalWriteRequest(value: string | undefined): boolean {
	if (interviewChoiceFromUserText(value) !== "write") return false;
	const text = value?.replace(/[。！？!?，,；;、\s]+/gu, "").trim() ?? "";
	return !/^(?:1|一|第一个|第一种|选一|选1)(?:吧|就好)?$/u.test(text);
}

function isModelBackedWriteRequest(value: string | undefined): boolean {
	const text = value?.replace(/[。！？!?，,；;、\s]+/gu, "").trim() ?? "";
	if (!text || [...text].length > 100
		|| /^(?:先别|不要|暂时不|不想|还不想)写/u.test(text)
		|| /(?:先别|不要|暂不|暂时不|不想|还不想).{0,2}(?:写|动笔|成稿|撰写|结束采访)/u.test(text)
		|| /^(?:今天先到这|先到这里|先休息)(?:下次|改天|明天)再写/u.test(text)) return false;
	if (/^(?:那年|那时|当时|小时候|我曾经|以前|后来)/u.test(text)
		&& !/(?:结束|停止|不再).{0,4}采访/u.test(text)) return false;
	return /(?:材料|素材).{0,8}(?:够了|足够).{0,12}(?:动笔|成稿|写作|撰写)/u.test(text)
		|| /(?:咱们|我们|你|请|现在|可以).{0,12}(?:动笔|成稿|撰写|写正文|写本章|写这一章)/u.test(text)
		|| /(?:结束|停止|不再|不用再).{0,4}采访/u.test(text)
		|| /(?:开始|直接|现在).{0,4}写(?:作|正文|本章|这一章)?(?:吧|了)?$/u.test(text);
}

function isEarlyWriteConfirmation(value: string | undefined): boolean {
	if (interviewChoiceFromUserText(value) === "write") return true;
	const text = value?.replace(/[。！？!?，,；;、\s]+/gu, "").trim() ?? "";
	return /^(?:确认|确定|确认写|确定写|确认现在写|确定现在写|就按现有素材写|就写吧|还是写吧|不补了直接写)(?:吧|了)?$/u.test(text);
}

function isExplicitEarlyWriteConfirmation(value: string | undefined): boolean {
	const text = value?.replace(/[。！？!?，,；;、\s]+/gu, "").trim() ?? "";
	return /^(?:确认现在写|确定现在写|确认按现有素材写|确定按现有素材写)(?:吧|了)?$/u.test(text);
}

function hadEarlyWriteWarningBeforeUser(entries: readonly any[], userIndex: number, chapter: number): boolean {
	for (let index = userIndex - 1; index >= 0; index -= 1) {
		const message = entries[index]?.message;
		if (message?.role !== "toolResult" || message.isError === true) continue;
		const payload = parseWorkflowPayload(String(message.details?.stdout ?? ""));
		if (payload?.chapter === chapter && payload.early_write_warning_pending === true
			&& payload?.recommended_next_action === "confirm_early_write") return true;
	}
	return false;
}

function wasInterviewPausedBeforeUser(entries: readonly any[], userIndex: number): boolean {
	for (let index = userIndex - 1; index >= 0; index -= 1) {
		const message = entries[index]?.message;
		if (message?.role !== "toolResult" || message.isError === true
			|| message.toolName !== "biography_chapter_interviewer") continue;
		const payload = parseWorkflowPayload(String(message.details?.stdout ?? ""));
		if (typeof payload?.selected_mode === "string") return payload.selected_mode === "pause";
	}
	return false;
}

function interviewChoiceMenu(payload: Record<string, unknown>): string {
	const count = typeof payload.completed_count === "number" ? payload.completed_count : 12;
	const menu = typeof payload.choice_menu === "string" && payload.choice_menu.trim()
		? payload.choice_menu.trim()
		: `这一章已经记录了 ${count} 组完整回答，接下来由您决定：\n1. 现在开始写作\n2. 继续由我提问，增加素材\n3. 您自由讲述想起的事，我按原话记录\n回复 1、2 或 3 即可。`;
	return formatInterviewProgressReply(payload, "choice", menu);
}

function interviewStructuredLimitReply(payload: Record<string, unknown>): string {
	return formatInterviewProgressReply(
		payload, "choice",
		"这一章的按题采访已到 20 组。您可以现在开始写作，也可以自由讲述想起的事来补充素材。您想选哪一种？",
	);
}

function isFreeRecallStopCommand(value: string | undefined): boolean {
	const text = value?.replace(/[。！？!?，,；;、\s]+/gu, "").trim() ?? "";
	return /^(?:今天先到这|先到这里|暂停|下次再说|明天再聊|不想继续|不想讲了|没有了|没什么可讲了|先不说了|结束采访)$/u.test(text);
}
type PendingAssistantReply = {
	text: string;
	chapter: number;
	action: string;
	kind: "interview" | "artifact";
	awaitingAnswer: boolean;
	interviewContext?: {
		payload: InterviewReplyPayload;
		question: string;
		baseReply: string;
		acknowledgement?: string;
		acknowledgementSource?: "tool" | "model" | "fallback" | "correction";
	};
};

type SessionTurnState = {
	pendingAssistantReplies: PendingAssistantReply[];
	resumedContinueText?: string;
	interviewStatusCallsSinceMutation: number;
	pendingNextQuestion?: { chapter: number; nextAction: "ask" | "followup" };
	freeRecallUserIndex?: number;
	choiceUserIndex?: number;
};

const sessionTurnStates = new WeakMap<object, SessionTurnState>();
const recentInterviewAcknowledgements = new WeakMap<object, string[]>();
const preToolInterviewText = new WeakMap<object, string>();
const currentTurnInterviewAnswer = new WeakMap<object, string>();
const interviewAdvanceAttempts = new WeakMap<object, { userIndex: number; count: number }>();
const earlyWriteWarningUserIndices = new WeakMap<object, number>();

function latestUserEntryIndex(entries: readonly any[]): number {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		if (entries[index]?.type === "message" && entries[index]?.message?.role === "user") return index;
	}
	return -1;
}

function turnStateFor(sessionManager: object): SessionTurnState {
	let state = sessionTurnStates.get(sessionManager);
	if (!state) {
		state = { pendingAssistantReplies: [], interviewStatusCallsSinceMutation: 0 };
		sessionTurnStates.set(sessionManager, state);
	}
	return state;
}

function queueAssistantReplyForAssistant(
	sessionManager: object,
	reply: string,
	chapter: number,
	action: string,
	kind: PendingAssistantReply["kind"] = "interview",
	awaitingAnswer = false,
	interviewContext?: PendingAssistantReply["interviewContext"],
): void {
	// One assistant continuation belongs to one visible interview reply. If a
	// host batches tool calls, keep the latest deterministic reply instead of
	// leaking an older question into a later turn.
	const pending = turnStateFor(sessionManager).pendingAssistantReplies;
	pending.length = 0;
	pending.push({ text: reply, chapter, action, kind, awaitingAnswer, interviewContext });
}

function clearPendingArtifactReply(sessionManager: object): void {
	const pending = turnStateFor(sessionManager).pendingAssistantReplies;
	for (let index = pending.length - 1; index >= 0; index -= 1) {
		if (pending[index]?.kind === "artifact") pending.splice(index, 1);
	}
}

function parseWorkflowPayload(output: string): Record<string, unknown> | undefined {
	try {
		const value = JSON.parse(output);
		return value && typeof value === "object" && !Array.isArray(value)
			? value as Record<string, unknown>
			: undefined;
	} catch {
		return undefined;
	}
}

function activeChapterProgress(entries: readonly unknown[]): { chapter: number; stage?: string } | undefined {
	const caseRoot = findSessionCaseSelection(entries)?.caseRootWindows;
	if (!caseRoot) return undefined;
	try {
		const state = JSON.parse(fs.readFileSync(path.join(caseRoot, "progressive-state.json"), "utf8"));
		const chapter = state?.current_chapter;
		return Number.isInteger(chapter) && chapter >= 1 && chapter <= 6
			? { chapter, stage: typeof state.stage === "string" ? state.stage : undefined }
			: undefined;
	} catch {
		// The bridge also checks the persisted chapter before writing. Keep its
		// error visible if the state file is missing or malformed.
		return undefined;
	}
}

function activeInterviewChapter(entries: readonly unknown[]): number | undefined {
	return activeChapterProgress(entries)?.chapter;
}

function resumeChapterInstruction(chapter: number): string {
	return `第${chapter}章问答已登记且内容未变。请调用 biography_chapter_writer，chapter=${chapter}，不要设置 force_rewrite；由原生工具校验现有稿件并返回实际 next_action，再按该结果继续。本次不要重复 register，也不要把请求下一章当作当前章的用户批准。`;
}

function resumeChapterResult(result: any, chapter: number) {
	const safe = {
		status: "resume_chapter_workflow",
		chapter,
		already_registered: true,
		recommended_next_action: "resume_chapter_workflow",
		instruction: resumeChapterInstruction(chapter),
	};
	return {
		...result,
		content: [{ type: "text" as const, text: JSON.stringify(safe) }],
		details: { ...result.details, ...safe, stdout: JSON.stringify(safe) },
	};
}

function wrongChapterWorkflowResult(
	activeChapter: number,
	requestedChapter: number,
	stage?: string,
	sourceCurrent = false,
	sourceReadyToRegister = false,
) {
	const stageInstruction: Record<string, string> = {
		awaiting_source: `第${activeChapter}章仍在素材采集阶段。先核对本章采访状态，并依用户选择继续当前章。`,
		chapter_writing: `第${activeChapter}章已进入写作阶段。调用 biography_chapter_writer，chapter=${activeChapter}，不要设置 force_rewrite；按工具返回的 next_action 续跑。`,
		chapter_polishing: `第${activeChapter}章需继续文风润色。调用 biography_chapter_polisher，chapter=${activeChapter}，按工具结果续跑。`,
		chapter_punctuation: `第${activeChapter}章需继续标点检查。调用 biography_chapter_punctuation，chapter=${activeChapter}，按工具结果续跑。`,
		chapter_proofreading: `第${activeChapter}章需继续文字校对。调用 biography_chapter_proofreader，chapter=${activeChapter}，按工具结果续跑。`,
		chapter_reviewing: `第${activeChapter}章需继续机器审核。调用 biography_chapter_reviewer，chapter=${activeChapter}，按工具结果续跑。`,
		chapter_revising: `第${activeChapter}章尚需处理审核或素材问题。先核对当前报告及缺口，再按本章修订流程继续；不要重新登记问答或跳章。`,
		awaiting_material: `第${activeChapter}章仍有素材问题。先核对当前缺口并等待或处理相应素材，再继续本章。`,
		structure_blocked: `第${activeChapter}章结构问题阻断了自动续跑。告知用户本章暂未完成，等待明确的修订安排；不要展示未通过的正文。`,
		awaiting_user_review: `先调用 biography_workflow action=sync 取得第${activeChapter}章当前稿件地址，读取并展示已审核的落盘正文，等待用户明确审阅和批准。`,
	};
	const stageNextAction: Record<string, string> = {
		chapter_writing: "biography_chapter_writer",
		chapter_polishing: "biography_chapter_polisher",
		chapter_punctuation: "biography_chapter_punctuation",
		chapter_proofreading: "biography_chapter_proofreader",
		chapter_reviewing: "biography_chapter_reviewer",
	};
	const safe = {
		status: "wrong_chapter_not_executed",
		requested_chapter: requestedChapter,
		active_chapter: activeChapter,
		current_stage: stage ?? "unknown",
		recommended_next_action: stage === "awaiting_source"
			? sourceCurrent ? "sync" : sourceReadyToRegister ? "register" : "status"
			: stageNextAction[stage ?? ""] ?? "sync",
		instruction: `第${requestedChapter}章操作未执行。当前仍在第${activeChapter}章。${sourceCurrent && stage === "awaiting_source"
			? `当前问答已与正式输入一致；先调用 biography_workflow action=sync 校正进度，再调用 biography_chapter_writer，chapter=${activeChapter}，不要设置 force_rewrite，由工具确定实际 next_action。`
			: sourceReadyToRegister && stage === "awaiting_source"
				? `第${activeChapter}章已满足登记条件，且此前已选择写作。可调用本章采访 action=register，然后以不设置 force_rewrite 的 biography_chapter_writer 核对并续跑。`
				: stageInstruction[stage ?? ""] ?? "先调用 biography_workflow action=sync 核对当前章进度。"}${sourceReadyToRegister && stage === "awaiting_source"
				? ""
				: "本次不要调用采访 action=register。"}不能把“先写下一章”视为对当前章的批准。`,
	};
	return {
		content: [{ type: "text" as const, text: JSON.stringify(safe) }],
		details: { ...safe, stdout: JSON.stringify(safe) },
	};
}

function explicitRevisionChapters(text: string | undefined): number[] {
	if (!text) return [];
	const chapters = new Set<number>();
	for (const match of text.matchAll(/第\s*([1-6一二三四五六])\s*章|(?:^|[^\d])([1-6])\s*[.．]\s*\d{1,2}(?!\d)/gu)) {
		const label = match[1] ?? match[2];
		const chapter = Number(label) || "一二三四五六".indexOf(label) + 1;
		if (chapter >= 1 && chapter <= 6) chapters.add(chapter);
	}
	return [...chapters];
}

function wrongRevisionChapterResult(requestedChapter: number, attemptedChapter: number) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify({
			status: "wrong_chapter_not_executed",
			requested_chapter: requestedChapter,
			attempted_chapter: attemptedChapter,
			instruction: `本次应处理第${requestedChapter}章，但修订参数或反馈内容不一致。请核对该章稿件及问答输入后按原话重试。`,
		}) }],
		details: { status: "wrong_chapter_not_executed", requested_chapter: requestedChapter },
	};
}

function workflowFileAddress(value: unknown, workspaceRoot: string): { raw: string; absolute: string; exists: boolean; link?: string } | undefined {
	if (typeof value !== "string" || !value.trim()) return undefined;
	const raw = value.trim();
	const absolute = path.win32.isAbsolute(raw) ? path.win32.normalize(raw) : path.win32.resolve(workspaceRoot, raw);
	const relative = path.win32.relative(workspaceRoot, absolute);
	// Pi Web opens relative Markdown links in its file viewer. A Windows drive
	// path (D:/...) is treated as a URL scheme and loses its href in Markdown.
	const withinWorkspace = relative !== "" && !path.win32.isAbsolute(relative)
		&& relative !== ".." && !relative.startsWith(`..${path.win32.sep}`);
	return {
		raw,
		absolute,
		exists: fs.existsSync(absolute),
		link: withinWorkspace ? `./${relative.split(path.win32.sep).map(encodeURIComponent).join("/")}` : undefined,
	};
}

function relinkWorkspaceFiles(text: string, workspaceRoot: string): string {
	return text.replace(
		/\[([^\]\r\n]+)\]\((?:<([A-Za-z]:[\\/][^>\r\n]+)>|([A-Za-z]:[\\/][^\s)\r\n]+))\)/gu,
		(original, label: string, angledPath: string | undefined, plainPath: string | undefined) => {
			const address = workflowFileAddress(angledPath ?? plainPath, workspaceRoot);
			return address?.exists && address.link ? `[${label}](<${address.link}>)` : original;
		},
	);
}

function formatWorkflowCompletionReply(
	action: string,
	payload: Record<string, unknown>,
	workspaceRoot: string,
	chapter?: number,
): string | undefined {
	const supported = new Set([
		"chapter-write",
		"chapter-revise",
		"chapter-polish",
		"chapter-punctuate",
		"chapter-proofread",
		"chapter-review",
		"section-title-manage",
		"assemble-book",
	]);
	if (!supported.has(action)) return undefined;
	const address = workflowFileAddress(payload.output_txt, workspaceRoot);
	if (!address) {
		if (action === "chapter-review") {
			const order = typeof payload.chapter_order === "number" ? payload.chapter_order : chapter;
			return `${order ? `第${order}章` : "本章"}尚未完成审核，工具没有返回可显示的候选稿地址。详细检查记录可在工具执行结果中查看。`;
		}
		return undefined;
	}
	const clickable = address.exists && address.link ? `[点击打开](<${address.link}>)` : address.raw;
	const availability = address.exists ? "已落盘" : "工具已返回，但当前未能确认文件仍存在";

	if (action === "assemble-book") {
		if (payload.status !== "success") return undefined;
		const bodyChars = typeof payload.chapter_body_character_count === "number"
			? `，正文约 ${payload.chapter_body_character_count} 字`
			: "";
		const chapterCount = typeof payload.chapter_count === "number"
			? `，共 ${payload.chapter_count} 章`
			: "";
		return `全书最终成稿${availability}。${chapterCount}${bodyChars}\n最终成稿：${clickable}\n文件地址：${address.raw}`;
	}

	const order = typeof payload.chapter_order === "number" ? payload.chapter_order : chapter;
	const chapterLabel = order ? `第${order}章` : "本章";
	if (action === "chapter-review") {
		// A freshly executed Reviewer includes review_status; a reused validated
		// report may only include status from the persisted review JSON.
		if (payload.status !== "pass" || !["awaiting_user_review", "user_approved"].includes(String(payload.candidate_status))) {
			const candidateLocation = address.exists
				? `候选稿位置：${clickable}\n文件地址：${address.raw}`
				: `候选稿文件暂无法确认，工具返回的地址：${address.raw}`;
			return `${chapterLabel}已生成候选稿，但尚未完成审核，暂不能作为成稿交您审阅。\n${candidateLocation}\n详细检查记录可在工具执行结果中查看。`;
		}
		let body = "";
		if (address.exists) {
			try {
				body = fs.readFileSync(address.absolute, "utf8").replace(/^\uFEFF/u, "").trim();
			} catch {
				// Do not request approval for a chapter the host could not display.
			}
		}
		if (!body) return `${chapterLabel}审阅稿暂时无法展示，已暂停处理。详细记录可在工具执行结果中查看。`;
		const heading = `${chapterLabel}当前审阅稿${availability}。请您审阅，确认满意后再批准本章。`;
		return `${heading}\n\n${body}\n\n章节地址：${clickable}\n文件地址：${address.raw}`;
	}
	if (payload.status === "failed" || payload.status === "partial" || payload.blocked === true) {
		return `${chapterLabel}尚未完成处理。详细记录可在工具执行结果中查看。`;
	}
	const stage = action === "chapter-write" || action === "chapter-revise"
		? "候选稿"
		: "当前章节文件";
	return `${chapterLabel}${stage}${availability}。\n章节地址：${clickable}\n文件地址：${address.raw}`;
}

function prepareStatusReply(statusResult: any, chapter: number, sessionManager: object, prefix = "好的，我们继续。") {
	const stdout = typeof statusResult.details?.stdout === "string" ? statusResult.details.stdout : "";
	let reply = "好的，我们接着往下聊。";
	let awaitingAnswer = false;
	try {
		const payload = JSON.parse(stdout) as Record<string, unknown>;
		if (payload.recommended_next_action === "resume_chapter_workflow") {
			return resumeChapterResult(statusResult, chapter);
		}
		if (payload.recommended_next_action === "wait_for_resume" || payload.selected_mode === "pause") {
			const message = typeof payload.pause_prompt === "string" && payload.pause_prompt.trim()
				? payload.pause_prompt.trim()
				: "今天先休息吧，已经说过的内容我会保存。等您愿意继续时，我们再从这里接着聊。";
			const reply = formatInterviewProgressReply({ ...payload, pending_question: null }, "pause", message);
			queueAssistantReplyForAssistant(sessionManager, reply, chapter, "pause", "interview", true);
			return {
				...statusResult, terminate: true,
				content: [{ type: "text" as const, text: JSON.stringify({
					status: "interview_paused", final_user_reply: reply,
					instruction: "采访已暂停。普通助手消息已准备，请结束本轮，等待用户主动继续。",
				}) }],
				details: { ...statusResult.details, interview_reply: reply, interview_action: "pause" },
			};
		}
		if (payload.recommended_next_action === "confirm_early_write"
			|| payload.early_write_warning_pending === true) {
			const message = typeof payload.early_write_warning_prompt === "string"
				&& payload.early_write_warning_prompt.trim()
				? payload.early_write_warning_prompt.trim()
				: "目前已有 12–14 组完整回答，写作素材可能偏少。您可以现在按现有素材写，也可以继续补充。若仍想现在写，请再告诉我一次。";
			const reply = formatInterviewProgressReply({ ...payload, pending_question: null }, "choice", message);
			queueAssistantReplyForAssistant(sessionManager, reply, chapter, "confirm_write", "interview", true);
			return {
				...statusResult, terminate: true,
				content: [{ type: "text" as const, text: JSON.stringify({
					status: "early_write_confirmation_required", final_user_reply: reply,
					instruction: "写作素材提醒已准备。请结束本轮，等待用户下一条消息决定；不得在同一用户回合确认写作。",
				}) }],
				details: { ...statusResult.details, interview_reply: reply, interview_action: "confirm_write" },
			};
		}
		if (payload.recommended_next_action === "stop_structured_interview") {
			const reply = interviewStructuredLimitReply(payload);
			queueAssistantReplyForAssistant(sessionManager, reply, chapter, "choice", "interview", true);
			return {
				...statusResult,
				content: [{ type: "text" as const, text: JSON.stringify({
					status: "structured_interview_limit", final_user_reply: reply,
					instruction: "按题采访已到上限。普通助手消息已准备，请等待用户选择写作或自由讲述。",
				}) }],
				details: { ...statusResult.details, interview_reply: reply, interview_action: "choice_menu" },
			};
		}
		if (payload.choice_required === true) {
			const menu = interviewChoiceMenu(payload);
			queueAssistantReplyForAssistant(sessionManager, menu, chapter, "choice", "interview", true);
			return {
				...statusResult,
				content: [{ type: "text" as const, text: JSON.stringify({
					status: "awaiting_user_choice", choice_menu: menu,
					instruction: "三项选择已作为普通助手消息准备。请结束本轮，等待用户选择。",
				}) }],
				details: { ...statusResult.details, interview_reply: menu, interview_action: "choice_menu" },
			};
		}
		const pending = typeof payload.pending_question === "string" ? payload.pending_question.trim() : "";
		if (!pending) {
			return {
				...statusResult,
				content: [{ type: "text" as const, text: JSON.stringify({
					...payload,
					status: "next_question_required",
					instruction: "当前没有待回答问题。请在本轮按 recommended_next_action 登记并展示下一道问题，不要只说接着聊。",
				}) }],
			};
		}
		if (pending) {
			reply = `${prefix}${pending}`;
			awaitingAnswer = true;
		}
		reply = formatInterviewProgressReply(payload, "status", reply);
	} catch {
		// Keep the short, user-facing continuation when an older bridge did not
		// return JSON. The underlying status result remains available in details.
	}
	queueAssistantReplyForAssistant(sessionManager, reply, chapter, "resume", "interview", awaitingAnswer);
	return {
		...statusResult,
		content: [{ type: "text" as const, text: `采访回复已准备。${awaitingAnswer ? "请结束本轮并等待用户回答，不再调用采访工具。" : ""}` }],
		details: { ...statusResult.details, interview_reply: reply, interview_action: "resume" },
	};
}
const LLM_ACTIONS = new Set([
	"chapter-write",
	"chapter-revise",
	"chapter-polish",
	"chapter-punctuate",
	"chapter-proofread",
	"chapter-review",
	"section-title-manage",
]);

type RunOptions = {
	title?: string;
	subjectName?: string;
	caseId?: string;
	label?: string;
	question?: string;
	materialGoal?: string;
	remainingSubquestions?: string[];
	unavailableSubquestions?: string[];
	resolvedSubquestions?: { question: string; evidence: string }[];
	textBase64?: string;
	feedbackBase64?: string;
	feedbackSource?: "user" | "reviewer";
	sourcePath?: string;
	chapter?: number;
	forceRewrite?: boolean;
	subjectType?: "self" | "direct_relative";
	relationshipToUser?: string;
	narrativePerson?: "first" | "third";
	subjectPronoun?: "我" | "他" | "她";
	targetReaders?: string;
	writingPurpose?: string;
	narrativeTone?: string;
	titleOperation?: "add_missing" | "regenerate";
	interviewAction?: "status" | "ask" | "followup" | "answer" | "skip" | "supplement" | "normalize" | "register" | "choice" | "free_recall";
	choice?: InterviewChoice;
	acknowledgement?: string;
	targetQuestionNumber?: number;
};

async function executeAction(
	pi: ExtensionAPI,
	action: string,
	options: RunOptions,
	signal: AbortSignal | undefined,
	onUpdate: ((result: any) => void) | undefined,
	ctx: ExtensionContext,
) {
	if (signal?.aborted) throw new Error("Biography workflow cancelled");
	// A later tool action supersedes a path queued by an earlier action in the
	// same model turn. Interview replies are kept because they are part of the
	// user-facing turn contract; stale artifact paths are never allowed to leak
	// into a later approval or status message.
	clearPendingArtifactReply(ctx.sessionManager);
	const sessionId = ctx.sessionManager.getSessionId();
	const args = ["-X", "utf8", BRIDGE, action, "--workspace-root", ctx.cwd, "--session-id", sessionId];
	const sessionCaseHint = findSessionCaseHint(ctx.sessionManager.getBranch());
	if (sessionCaseHint) args.push("--session-case-hint", sessionCaseHint);
	const modelRoute = LLM_ACTIONS.has(action) ? ctx.model : undefined;
	if (LLM_ACTIONS.has(action) && !modelRoute) {
		throw new Error(`传记工具 ${action} 无法取得 Pi 当前会话模型，已停止调用，未使用备用模型。`);
	}
	if (modelRoute) {
		args.push("--worker-provider", modelRoute.provider);
		args.push("--worker-model", modelRoute.id);
	}
	if (options.title) args.push("--title", options.title);
	if (options.subjectName) args.push("--subject-name", options.subjectName);
	if (options.caseId) args.push("--case-id", options.caseId);
	if (options.label) args.push("--label", options.label);
	if (options.question) args.push("--question", options.question);
	if (options.materialGoal) args.push("--material-goal", options.materialGoal);
	if (options.choice) args.push("--choice", options.choice);
	if (options.remainingSubquestions) {
		args.push("--remaining-subquestions-base64", Buffer.from(JSON.stringify(options.remainingSubquestions), "utf8").toString("base64"));
	}
	if (options.unavailableSubquestions) {
		args.push("--unavailable-subquestions-base64", Buffer.from(JSON.stringify(options.unavailableSubquestions), "utf8").toString("base64"));
	}
	if (options.resolvedSubquestions) {
		args.push("--resolved-subquestions-base64", Buffer.from(JSON.stringify(options.resolvedSubquestions), "utf8").toString("base64"));
	}
	if (options.textBase64) args.push("--answer-base64", options.textBase64);
	if (options.feedbackBase64) args.push("--feedback-base64", options.feedbackBase64);
	if (options.feedbackSource) args.push("--feedback-source", options.feedbackSource);
	if (options.sourcePath) args.push("--source-path", options.sourcePath);
	if (options.chapter) args.push("--chapter", String(options.chapter));
	if (options.forceRewrite) args.push("--force-rewrite");
	if (options.subjectType) args.push("--subject-type", options.subjectType);
	if (options.relationshipToUser) args.push("--relationship-to-user", options.relationshipToUser);
	if (options.narrativePerson) args.push("--narrative-person", options.narrativePerson);
	if (options.subjectPronoun) args.push("--subject-pronoun", options.subjectPronoun);
	if (options.targetReaders) args.push("--target-readers", options.targetReaders);
	if (options.writingPurpose) args.push("--writing-purpose", options.writingPurpose);
	if (options.narrativeTone) args.push("--narrative-tone", options.narrativeTone);
	if (options.titleOperation) args.push("--title-operation", options.titleOperation);
	if (options.interviewAction) args.push("--interview-action", options.interviewAction);
	if (options.targetQuestionNumber) args.push("--target-question-number", String(options.targetQuestionNumber));
	onUpdate?.({
		content: [{ type: "text", text: `正在执行传记工具：${action}` }],
		details: {
			action,
			status: "running",
			provider: modelRoute?.provider,
			model: modelRoute?.id,
		},
	});
	const slow = ["chapter-write", "chapter-revise", "chapter-polish", "chapter-punctuate", "chapter-proofread", "section-title-manage"].includes(action);
	const polish = action === "chapter-polish";
	const review = action === "chapter-review";
	const migration = action === "section-title-manage";
	const result = await pi.exec(PYTHON, args, { signal, timeout: migration || polish ? 1_800_000 : slow ? 900_000 : review ? 300_000 : 120_000 });
	if (signal?.aborted) {
		throw new Error(`传记工具 ${action} 已中断；本次不视为完成。`);
	}
	if (result.killed) {
		throw new Error(`传记工具 ${action} 已被终止；本次不视为完成，请检查运行日志后重试。`);
	}
	if (result.code !== 0) {
		throw new Error((result.stderr || result.stdout || `${action} failed`).trim());
	}
	const output = (result.stdout || "").trim();
	if (LLM_ACTIONS.has(action) && !output) {
		throw new Error(`传记工具 ${action} 已退出但没有返回结果；本次不视为完成，请检查运行日志后重试。`);
	}
	let outcomeStatus = "success";
	let nextAction: string | undefined;
	let resumable: boolean | undefined;
	if (polish) {
		const outcome = JSON.parse(output);
		if (!["pass", "partial", "failed"].includes(outcome.status)) {
			throw new Error("文风润色未返回明确的完成状态；请检查报告并从检查点恢复。");
		}
		outcomeStatus = outcome.status;
		nextAction = outcome.next_action;
		resumable = outcome.resumable === true;
	}
	let contentText = output || `${action} completed`;
	let interviewReply: string | undefined;
	let interviewReplyReady = false;
	let assistantReply: string | undefined;
	const workflowPayload = parseWorkflowPayload(output);
	const duplicateAskRejected = action === "chapter-interview" && options.interviewAction === "ask"
		&& workflowPayload?.ask_rejected_duplicate === true;
	if (action === "chapter-interview" && !workflowPayload) {
		throw new Error("采访工具未返回有效状态，无法确认问题是否已登记；请检查本次工具结果。");
	}
	if (action === "chapter-interview" && workflowPayload) {
		const state = turnStateFor(ctx.sessionManager);
		const pending = typeof workflowPayload.pending_question === "string" && workflowPayload.pending_question.trim().length > 0;
		const next = workflowPayload.recommended_next_action;
		state.pendingNextQuestion = !duplicateAskRejected && !pending && (next === "ask" || next === "followup")
			? { chapter: options.chapter ?? 0, nextAction: next }
			: undefined;
		if (pending) interviewAdvanceAttempts.delete(ctx.sessionManager);
		if (workflowPayload.choice_required === true && (
			options.interviewAction === "answer" || options.interviewAction === "skip"
			|| !interviewChoiceFromUserText(latestInterviewUserText(ctx.sessionManager.getBranch()))
		)) {
			const menu = interviewChoiceMenu(workflowPayload);
			let userReply = menu;
			if (options.interviewAction === "answer" && options.textBase64) {
				const recent = recentInterviewAcknowledgements.get(ctx.sessionManager) ?? [];
				const answer = Buffer.from(options.textBase64, "base64").toString("utf8");
				const acknowledgement = safeInterviewAcknowledgement(options.acknowledgement, menu, recent, "answer")
					?? contextualInterviewAcknowledgement(answer, menu, recent, "answer");
				if (acknowledgement) {
					userReply = `${acknowledgement}\n\n${menu}`;
					recentInterviewAcknowledgements.set(ctx.sessionManager, [...recent, acknowledgement].slice(-5));
				}
			}
			queueAssistantReplyForAssistant(ctx.sessionManager, userReply, options.chapter ?? 0, "choice", "interview", true);
			contentText = JSON.stringify({
				status: "awaiting_user_choice", choice_menu: menu, final_user_reply: userReply,
				instruction: "三项选择已作为普通助手消息准备。请结束本轮等待用户选择，不要继续提问。",
			});
		}
		if (workflowPayload.recommended_next_action === "stop_structured_interview"
			&& !interviewChoiceFromUserText(latestInterviewUserText(ctx.sessionManager.getBranch()))) {
			const reply = interviewStructuredLimitReply(workflowPayload);
			queueAssistantReplyForAssistant(ctx.sessionManager, reply, options.chapter ?? 0, "choice", "interview", true);
			contentText = JSON.stringify({
				status: "structured_interview_limit", final_user_reply: reply,
				instruction: "按题采访已到上限。普通助手消息已准备，请等待用户选择写作或自由讲述。",
			});
		}
	}
	if (workflowPayload) {
		if (action === "chapter-review") {
			const reportAddress = workflowFileAddress(workflowPayload.output_report ?? workflowPayload.output_json, ctx.cwd);
			if (reportAddress?.exists) {
				try {
					const report = fs.readFileSync(reportAddress.absolute, "utf8").replace(/^\uFEFF/u, "").trim();
					if (Array.isArray(JSON.parse(report)?.issues)) {
						// The detailed findings belong in the inspectable tool card,
						// while the ordinary assistant reply uses a controlled template.
						contentText = `${output}\n\n审核报告详情：\n${report}`;
					}
				} catch {
					// Preserve the bridge JSON when an older report is unavailable.
				}
			}
		}
		assistantReply = formatWorkflowCompletionReply(action, workflowPayload, ctx.cwd, options.chapter);
		if (assistantReply) {
			// The path must be visible in an ordinary assistant message. Keeping it
			// only in tool details makes the result effectively undiscoverable to a
			// user who cannot or does not open the tool card.
			queueAssistantReplyForAssistant(ctx.sessionManager, assistantReply, options.chapter ?? 0, action, "artifact");
		}
	}
	const interviewAction = options.interviewAction;
	if (action === "chapter-interview" && interviewAction && TERMINATING_INTERVIEW_ACTIONS.has(interviewAction)) {
		try {
			const payload = JSON.parse(output) as Record<string, unknown>;
			const pendingQuestion = typeof payload.pending_question === "string" ? payload.pending_question.trim() : "";
			interviewReplyReady = pendingQuestion.length > 0;
			const baseReply = buildInterviewUserReply(payload, interviewAction);
			let userReply = baseReply;
			let interviewContext: PendingAssistantReply["interviewContext"];
			if (interviewReplyReady && baseReply === pendingQuestion.replace(/\s+/gu, " ").trim()) {
				const recent = recentInterviewAcknowledgements.get(ctx.sessionManager) ?? [];
				const substantiveAnswer = interviewAction === "answer" || interviewAction === "supplement"
					? options.textBase64 ? Buffer.from(options.textBase64, "base64").toString("utf8") : undefined
					: currentTurnInterviewAnswer.get(ctx.sessionManager);
				const correctionAcknowledgement = isInterviewAlreadyAnsweredCorrection(substantiveAnswer)
					? contextualInterviewAcknowledgement(substantiveAnswer, pendingQuestion, recent, interviewAction)
					: undefined;
				const toolAcknowledgement = correctionAcknowledgement ? undefined
					: safeInterviewAcknowledgement(options.acknowledgement, pendingQuestion, recent, interviewAction);
				const modelAcknowledgement = correctionAcknowledgement || toolAcknowledgement ? undefined : interviewAcknowledgementFromModelText(
					preToolInterviewText.get(ctx.sessionManager), pendingQuestion, recent, interviewAction,
				);
				const fallbackAcknowledgement = correctionAcknowledgement || toolAcknowledgement || modelAcknowledgement ? undefined : contextualInterviewAcknowledgement(
					substantiveAnswer, pendingQuestion, recent, interviewAction,
				);
				const acknowledgement = correctionAcknowledgement ?? toolAcknowledgement ?? modelAcknowledgement ?? fallbackAcknowledgement;
				if (acknowledgement) {
					userReply = `${acknowledgement}\n${baseReply}`;
				}
				interviewContext = {
					payload, question: pendingQuestion, baseReply, acknowledgement,
					acknowledgementSource: correctionAcknowledgement ? "correction" : toolAcknowledgement ? "tool" : modelAcknowledgement ? "model" : fallbackAcknowledgement ? "fallback" : undefined,
				};
			}
			if (interviewReplyReady) preToolInterviewText.delete(ctx.sessionManager);
			interviewReply = formatInterviewProgressReply(
				payload, interviewAction, userReply,
			);
			// Capture a concrete next question for the ordinary assistant message
			// that follows this tool call. If an answer closes a group, the model
			// still needs to choose the next material goal and call action=ask (or
			// request chapter closure confirmation).
			if (interviewReplyReady) contentText = JSON.stringify({
				status: "awaiting_user_answer",
				pending_question: payload.pending_question,
				pending_kind: payload.pending_kind,
				final_user_reply: interviewReply,
				instruction: "采访回复已准备。该问题已经登记，请结束本轮等待用户回答，不再调用 followup、ask、answer 或 status。",
			});
			if (interviewReplyReady && interviewReply) {
				queueAssistantReplyForAssistant(ctx.sessionManager, interviewReply, options.chapter ?? 0, interviewAction, "interview", true, interviewContext);
			}
		} catch (error) {
			throw new Error(`采访回复未能确认待答问题：${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return {
		content: [{ type: "text" as const, text: contentText }],
		details: {
			action,
			status: outcomeStatus,
			next_action: nextAction,
			resumable,
			provider: modelRoute?.provider,
			model: modelRoute?.id,
			stdout: output,
			interview_action: duplicateAskRejected ? "defer_ask" : interviewAction,
			interview_reply: interviewReply,
			assistant_reply: assistantReply,
		},
	};
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "bash" || typeof event.input.command !== "string") return;
		const selection = findSessionCaseSelection(ctx.sessionManager.getBranch());
		if (!selection?.caseRootWindows || !selection.caseRootWsl) return;
		// Only normalize paths inside the case explicitly selected by this session.
		// Other shell text and paths are left for the normal bash tool to handle.
		event.input.command = normalizeCaseBashPaths(
			event.input.command, selection.caseRootWindows, selection.caseRootWsl,
		);
	});
	pi.on("tool_result", (event, ctx) => {
		if (event.toolName !== "read" || !event.isError || typeof event.input.path !== "string") return;
		const error = event.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
		if (!/\bEISDIR\b|illegal operation on a directory|is a directory/iu.test(error)) return;
		const selection = findSessionCaseSelection(ctx.sessionManager.getBranch());
		if (!selection?.caseRootWindows) return;
		const listing = listSelectedCaseDirectory(event.input.path, selection.caseRootWindows);
		if (!listing) return;
		// This is a real directory listing, not a blanket suppression of read errors.
		return { content: [{ type: "text" as const, text: listing }], isError: false };
	});
	pi.on("agent_end", (event, ctx) => {
		// If the continuation was aborted before message_end, do not let its
		// question replace an unrelated assistant message in a later turn.
		if (ctx?.sessionManager) {
			const sessionManager = ctx.sessionManager;
			const state = sessionTurnStates.get(sessionManager);
			const advance = state?.pendingNextQuestion;
			const lastAssistant = [...(event.messages ?? [])].reverse()
				.find((message) => message?.role === "assistant") as { stopReason?: string } | undefined;
			const interrupted = lastAssistant?.stopReason === "aborted" || lastAssistant?.stopReason === "error";
			if (advance && !interrupted && !state?.pendingAssistantReplies.some((reply) => reply.awaitingAnswer)) {
				const entries = sessionManager.getBranch();
				const latestUser = latestInterviewUserText(entries) ?? "";
				const shortPause = interviewChoiceFromUserText(latestUser) === "pause"
					|| isVerbalWriteRequest(latestUser) || ([...latestUser].length <= 40
					&& /^(?:今天先到这|先到这里|暂停|下次再说|明天再聊|不想继续|结束采访|开始写作|现在写吧)/u.test(latestUser.trim()));
				const userIndex = latestUserEntryIndex(entries);
				const prior = interviewAdvanceAttempts.get(sessionManager);
				const count = prior?.userIndex === userIndex ? prior.count + 1 : 1;
				if (!shortPause && count <= 3) {
					interviewAdvanceAttempts.set(sessionManager, { userIndex, count });
					pi.sendMessage({
						customType: "biography-interview-advance",
						content: `内部续行：第${advance.chapter}章刚才的回答或跳过已成功登记；这不是一条新的用户回答。立即调用 biography_chapter_interviewer action=status，再按 recommended_next_action=${advance.nextAction} 调用 action=${advance.nextAction}，登记并完整展示下一道采访问题。只有工具返回真实 pending_question 后才能结束本轮；不要只回复“记下了”或“接着聊”，也不要重复登记上一条用户消息。`,
						display: false,
					}, { deliverAs: "followUp" });
				}
			}
			sessionTurnStates.delete(ctx.sessionManager);
			preToolInterviewText.delete(ctx.sessionManager);
			currentTurnInterviewAnswer.delete(ctx.sessionManager);
		}
	});
	pi.on("agent_start", (_event, ctx) => {
		if (ctx?.sessionManager) {
			sessionTurnStates.delete(ctx.sessionManager);
			preToolInterviewText.delete(ctx.sessionManager);
			currentTurnInterviewAnswer.delete(ctx.sessionManager);
		}
	});

	pi.on("message_end" as never, ((event: any, ctx: any) => {
		if (event.message.role !== "assistant") return;
		const pendingAssistantReplies = turnStateFor(ctx.sessionManager).pendingAssistantReplies;
		const modelText = typeof event.message.content === "string"
			? event.message.content.trim()
			: Array.isArray(event.message.content)
				? event.message.content
					.filter((part: any) => part?.type === "text" && typeof part.text === "string")
					.map((part: any) => part.text.trim())
					.filter(Boolean)
					.join("\n")
				: "";
		if (pendingAssistantReplies.length === 0) {
			if (Array.isArray(event.message.content)
				&& event.message.content.some((part: any) => part?.type === "toolCall" && part?.name === "biography_chapter_interviewer")) {
				if (modelText) preToolInterviewText.set(ctx.sessionManager, modelText);
				// A transition announced before an ask succeeds is misleading when
				// the current answer is still pending. Keep a safe lead-in for the
				// eventual reply, but do not publish this speculative prose now.
				if (modelText) return {
					message: {
						...event.message,
						content: event.message.content.filter((part: any) => part?.type !== "text"),
					},
				};
			}
			if (typeof event.message.content === "string") {
				const corrected = relinkWorkspaceFiles(event.message.content, ctx.cwd);
				if (corrected !== event.message.content) return { message: { ...event.message, content: corrected } };
			} else if (Array.isArray(event.message.content)) {
				let changed = false;
				const content = event.message.content.map((part: any) => {
					if (part?.type !== "text" || typeof part.text !== "string") return part;
					const corrected = relinkWorkspaceFiles(part.text, ctx.cwd);
					if (corrected !== part.text) changed = true;
					return corrected === part.text ? part : { ...part, text: corrected };
				});
				if (changed) return { message: { ...event.message, content } };
			}
			return;
		}
		const awaitingAnswer = pendingAssistantReplies[0]?.awaitingAnswer === true;
		// Once a question exists, return it as a normal assistant message and
		// discard speculative next tool calls before the host executes them.
		// Completed answers and artifact workflows may still advance normally.
		if (Array.isArray(event.message.content)
			&& event.message.content.some((part: any) => part?.type === "toolCall") && !awaitingAnswer) {
			if (pendingAssistantReplies[0]?.kind !== "artifact") return;
			// Let the next workflow tool run, but discard model-authored status
			// prose attached to the same tool-call message.
			return {
				message: {
					...event.message,
					content: event.message.content.filter((part: any) => part?.type !== "text"),
				},
			};
		}
		const hasVisibleText = modelText.length > 0;
		if (!hasVisibleText && pendingAssistantReplies[0]?.kind !== "artifact" && !awaitingAnswer) return;
		const reply = pendingAssistantReplies.shift();
		if (!reply) return;
		const interviewContext = reply.interviewContext;
		if (interviewContext && modelText && interviewContext.acknowledgementSource !== "correction"
			&& interviewContext.acknowledgementSource !== "tool"
			&& interviewContext.acknowledgementSource !== "model") {
			const recent = recentInterviewAcknowledgements.get(ctx.sessionManager) ?? [];
			const modelAcknowledgement = interviewAcknowledgementFromModelText(
				modelText, interviewContext.question, recent, reply.action,
			);
			if (modelAcknowledgement) {
				interviewContext.acknowledgement = modelAcknowledgement;
				interviewContext.acknowledgementSource = "model";
				reply.text = formatInterviewProgressReply(
					interviewContext.payload, reply.action,
					`${modelAcknowledgement}\n${interviewContext.baseReply}`,
				);
			}
		}
		if (interviewContext?.acknowledgement) {
			const recent = recentInterviewAcknowledgements.get(ctx.sessionManager) ?? [];
			recentInterviewAcknowledgements.set(ctx.sessionManager, [...recent, interviewContext.acknowledgement].slice(-5));
		}
		// Interview questions and artifact updates both use controlled user-facing
		// text. Reviewer findings remain in tool details/report files; never append
		// a model-authored audit explanation to the ordinary assistant message.
		return {
			message: {
				...event.message,
				content: [{ type: "text" as const, text: reply.text }],
				stopReason: "stop" as const,
				errorMessage: undefined,
			},
		};
	}) as never);

	const workflowActions = [
		"doctor", "active", "list", "new", "configure", "set-subject", "switch", "snapshot", "archive",
		"archive-chapter", "sync", "ready", "confirm", "complete", "length-refresh",
	] as const;

	pi.registerTool(defineTool({
		name: "biography_workflow",
		label: "Biography Workflow",
		description: "Resolve biography cases and transition workflow state. Q&A can come from an upstream chapter file or from the built-in chapter interviewer.",
		promptSnippet: "Resolve the active biography case or transition its workflow state",
		promptGuidelines: [
			"案例选择按当前 Pi 会话隔离。新会话没有绑定案例时先使用 list 查看案例，再用 switch 绑定，或直接使用 new 创建；不得把其他会话的活动案例当作当前案例。",
			"需要核查写作进度或定位章节文件时，先调用 biography_workflow action=sync；它按现有产物返回真实状态，存在章节正文时会返回 output_txt 的 Windows 文件路径。Pi read 只读取这个明确的文件路径，不可把目录交给 read。不要用 bash/ls/find 查看状态或猜测案例路径；确需在 WSL bash 调试时，只使用 biography_workflow action=active 返回的 *_wsl 路径（/mnt/盘符/...），不要使用 D:/... 或 /d/...。",
			"创建新案例前先确认是为用户本人还是直系亲属写作；亲属案例还要确认关系和传主代词。使用 new 时一并保存 subject_name 与叙述配置，subject_name 只写传主真实姓名，不要把“传、传记、自传、回忆录”等标题后缀放入姓名；已有案例姓名错误时使用 set-subject 修正。",
			"新案例 narrative_config 未确认前不得调用 Writer；本人默认第一人称，直系亲属当前采用第三人称。",
			"中文硬规则：用户说“生成第一章/写第一章/重新生成某章/生成某人的某章”时，不要自己写正文，必须调用 biography_chapter_writer。",
			"中文硬规则：12 组完整问答是每一章各自的最低门槛，不是全书总共 12 题；每章采访、登记、写作都按章节独立判断。",
			"中文硬规则：问完并登记某一章后，立即进入同一章 biography_chapter_writer 写作链路；不要等六章全部采访完再统一写。",
			"登记结果 already_registered=true 表示问答未变且未重新登记。此时调用同章 biography_chapter_writer，保持 force_rewrite=false；由原生工具验证已有候选稿并返回实际 next_action，不得固定从 Writer 重跑，也不得再次 register。resume_chapter_workflow 是续跑指令，不是采访 action。",
			"中文硬规则：每章完成至少 12 组完整问答且无待回答题或必要追问时，向用户展示三项选择：直接写作、继续按题采访、自由讲述记忆。不足 12 组时用户想停就暂停，建议休息后再补充，不强迫继续回答；12–14 组时用户选择写作，提示一次素材可能偏少并等待下一条用户消息确认；达到 15 组后明确要求结束采访或写作则立即登记本章并进入同章 Writer。",
			"中文硬规则：Writer 返回成功只表示候选稿生成成功。固定链路为 Polisher → Punctuation → Proofreader；Proofreader 未改文字时直接进入 Reviewer，改了文字时必须再跑一次 Punctuation 后进入 Reviewer。Reviewer 前必须同时存在当前文风报告、当前标点报告与当前非标点正文绑定的文字校正报告。",
			"中文硬规则：同一底稿的 Writer 最多调用 1 次基于具体素材缺口的局部修正；同一章 Punctuation、Reviewer 各最多调用 2 次，Proofreader 最多调用 1 次；Reviewer 驱动的机器结构融合最多 1 次。Polisher 的时间片返回 partial 且 resumable=true 时继续同一工具恢复检查点，不占整章两次上限；每个片段的模型尝试预算跨调用累计。failed、partial 且 resumable=false 或重试预算耗尽时停止并报告；pass 继续下一阶段。",
			"中文硬规则：Writer 内部可对明显写成摘要的小节尝试一次非阻断的叙事展开，失败保留有效首稿；外层不得因字数偏离而重复调用 Writer、删减或拦截正文。后续局部修正须有具体内容依据，按固定流程审核后展示当前稿供用户审阅。",
			"中文硬规则：若 Reviewer 发现结构重复，不得展示该稿；先调用 Reviser 做 1 次“融合后去重”，再经过 Polisher、Punctuation、Proofreader、必要时第二次 Punctuation 与 Reviewer。复审确认内容和结构通过后展示融合稿供用户审阅，篇幅偏离不单独阻断；复审仍有结构 high 时进入 structure_blocked，只告知本章暂未完成，不展示正文或内部问题。",
			"中文硬规则：Writer 原生工具成功且主干、JSON、TXT 全部校验通过，只算候选稿生成成功。Reviewer 对同一正文版本返回 pass 只表示可交给用户审阅；只有用户明确批准并调用 biography_chapter_user_approval 后，章节才成为正式产物。",
			"中文硬规则：只生成 chapter-XX.txt 不算成功；必须同时有 chapter-XX.json，且 tool-runs.jsonl 里有 chapter-write returncode=0。",
			"中文硬规则：policies/chapter-lengths.json保存整书成书下限和技术上限，不保存素材倍率或固定章节配额。章节篇幅按事件、场景和叙事任务规划，各节软估计汇总为章节目标；回答字数只作统计，不限制写作。旧案例可用length-refresh只刷新篇幅元数据，保留正文及审核证据。",
			"中文硬规则：章节正文必须是中文；现有候选稿混入外文、拼音占位词或乱码片段时不得通过，必须交给 Reviser 定点修正。",
			"中文硬规则：机器审核首次 revise 且尚未使用自动结构融合时，保留旧稿并调用 biography_chapter_reviser 定点修改；已经融合过一次但复审仍 revise 时进入 structure_blocked，只告知本章暂未完成，不展示正文或内部问题。用户指出不满意之处时仍用 Reviser 局部修改。不要重新调用 Writer 整章重写。",
			"中文硬规则：问答回答中没有逐字来源时不得重建直接对白，统一使用间接转述。允许补入相容的普通天气、光线、环境声和场景相关日常物件；人物行为与即时心理须有素材支持或由已知事实直接推得，不得虚构重大人生事件或违背用户纠正。",
			"中文硬规则：全书同一事件、人物评价、感悟、教训或结论只能完整表达一次；Writer 与 Reviewer 必须读取只由用户批准章节生成的 narrative-ledger，换词复述、跨章或跨板块重复均为 high/structure。",
			"总控职责：只判断阶段和选择工具。写作、审核、重写、合稿都必须交给对应 biography native tool，不允许基础模型替代 skill 完成。",
			"回复规则：自动链路需要继续调用下一工具时，直接调用工具，不在工具调用前输出自然语言进度或审核说明；宿主会在最终普通回复中生成受控状态和文件地址。Reviewer pass 后由宿主读取并展示当前 chapter-XX.txt，让用户逐章审阅。",
			"回复规则：自动写作链路中，机器检查发现的问题、严重级别、段号、修订指令、重试过程与审核摘要只保留在工具结果、报告和日志中，普通助手消息不复述；自动修订直接继续。最终无法继续时只说明本章暂未完成和工具结果可查，不粘贴错误详情。用户主动询问具体原因时才解释。",
			"交付地址规则：凡工具结果包含 output_txt，宿主都会把章节地址或最终成稿地址放进普通助手消息，同时保留可点击地址和原始 Windows 路径；不要只依赖工具详情，也不要用一句‘已完成’覆盖地址。章节 output_txt 只能称为候选稿或当前审阅稿，assemble-book 的 output_txt 才能称为全书最终成稿。",
			"回复规则：如果用户明确要求查看正文，必须 read 当前 output_txt 文件后展示文件版本；禁止把模型草稿、记忆中的正文、或修订前聊天内容当作最终正文粘贴。",
			"状态规则：Writer、Polisher、Punctuation、Proofreader、Reviewer pass 都只代表候选阶段完成。Reviewer pass 后必须向用户展示当前落盘正文并等待逐章审阅；用户明确满意后调用 biography_chapter_user_approval，工具随后自动重建动态预算、叙事账本和口吻档案，才可称为该章完成。",
			"The user does not need to name tools. Infer the current chapter and choose the needed biography tool automatically.",
			"Use biography_workflow action=new to create a case before registering chapter Q&A files.",
			"可以使用 biography_chapter_interviewer 逐章采访并登记问答，也可以使用 biography_chapter_source 登记外部已整理好的单章问答文件。",
			"逐章流程顺序是：采访第 N 章并按完整回答组数处理用户写作选择（不足 12 暂停，12–14 提醒并待确认，15 组起直接进入写作）→ register 第 N 章问答 → biography_chapter_writer 写第 N 章 → Polisher → Punctuation → Proofreader → Reviewer → 展示给用户审阅；完成后再进入下一章采访。",
			"无论问答来自采访还是外部文件，Writer 都只能读取当前 case 的 input/chapter-XX-qa.md；不要把采访草稿或六章总文档直接交给 Writer。",
			"If a biography stage tool fails, keep the exact error in its tool result and follow that stage's retry rules. The ordinary user reply states only that this chapter has paused and details are available in the tool result, unless the user explicitly asks for the cause. A Writer content-validation failure ends automatic calls; do not repeat the same request to reload the same failed checkpoint. Do not repair case files with read/write/edit.",
			"Never create chapter TXT/JSON, review JSON, revision files, or final manuscript files with generic write/edit/shell operations. Only the registered biography native tools may create workflow artifacts.",
			"Any chapter prose produced outside biography_chapter_writer is invalid and must be discarded, even if it looks readable.",
			"A chapter TXT without a matching chapter JSON and a successful chapter-write tool run is incomplete; do not present it as success.",
			"TXT/JSON 一致性门禁：chapter-XX.txt 必须与 chapter-XX.json 重建出的正文一致；如果 TXT 被普通写入覆盖、缺少 JSON、或字数明显不符，该章无效，必须重新调用 biography_chapter_writer。",
		],
		parameters: Type.Object({
			action: StringEnum(workflowActions, { description: "Case or state action" }),
			title: Type.Optional(Type.String({ description: "Short case title for new" })),
			subject_name: Type.Optional(Type.String({ description: "Biography subject's actual name; keep separate from title, for example title=李建国传 and subject_name=李建国" })),
			case_id: Type.Optional(Type.String({ description: "Case id for switch or archive" })),
			label: Type.Optional(Type.String({ description: "Snapshot label" })),
			chapter: Type.Optional(Type.Integer({ minimum: 1, maximum: 6, description: "Chapter number for archive-chapter" })),
			subject_type: Type.Optional(StringEnum(["self", "direct_relative"] as const, { description: "Whether the subject is the user or a direct relative" })),
			relationship_to_user: Type.Optional(Type.String({ description: "self, father, mother, grandfather, grandmother, or another direct relationship" })),
			narrative_person: Type.Optional(StringEnum(["first", "third"] as const, { description: "Narrative person fixed for the whole book" })),
			subject_pronoun: Type.Optional(StringEnum(["我", "他", "她"] as const, { description: "Main prose pronoun for the subject" })),
			target_readers: Type.Optional(Type.String({ description: "Intended readers; defaults to family and descendants" })),
			writing_purpose: Type.Optional(Type.String({ description: "Purpose of the biography" })),
			narrative_tone: Type.Optional(Type.String({ description: "Stable tone for the whole book" })),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			return executeAction(pi, params.action, {
				title: params.title,
				subjectName: params.subject_name,
				caseId: params.case_id,
				label: params.label,
				chapter: params.chapter,
				subjectType: params.subject_type,
				relationshipToUser: params.relationship_to_user,
				narrativePerson: params.narrative_person,
				subjectPronoun: params.subject_pronoun,
				targetReaders: params.target_readers,
				writingPurpose: params.writing_purpose,
				narrativeTone: params.narrative_tone,
			}, signal, onUpdate, ctx);
		},
	}));

	for (const [name, label, description, action] of [
		[
			"biography_chapter_writer",
			"Biography Chapter Writer",
			"Generate exactly one autobiography chapter from that chapter's directly supplied Q&A file. 中文：用户要求生成/重写任意单章时必须用本工具；不要直接在聊天里写正文，不要用普通 write/edit 创建 chapter TXT。",
			"chapter-write",
		],
		[
			"biography_chapter_polisher",
			"Biography Chapter Polisher",
			"Polish one generated Chinese biography chapter for narrative style after Writer/Reviser and before punctuation, preserving nonfiction facts and chapter structure.",
			"chapter-polish",
		],
		[
			"biography_chapter_punctuation",
			"Biography Chapter Punctuation",
			"Screen and, only when necessary, repair Chinese punctuation for one native chapter. This mandatory gate runs after Polisher and before Reviewer without changing lexical content.",
			"chapter-punctuate",
		],
		[
			"biography_chapter_proofreader",
			"Biography Chapter Proofreader",
			"Correct only explicit typos, missing characters, and narrowly scoped sentence-completeness defects after punctuation screening. It never styles, expands, or changes facts and quotations.",
			"chapter-proofread",
		],
		[
			"biography_chapter_reviewer",
			"Biography Chapter Reviewer",
			"Review exactly one generated chapter against that chapter's Q&A source and the compact ledger of user-approved prior chapters, then return a structured report.",
			"chapter-review",
		],
	] as const) {
		const toolGuidelines = name === "biography_chapter_writer"
			? [
				"本工具只负责调用运行时配置的写作模型，按 biography-chapter-writer Skill 生成一章完整中文传记正文及匹配的 TXT/JSON。主控不得代写正文。",
				"Writer 内部已执行有界重试。工具返回内容或校验错误后停止自动调用，普通回复只说明本章暂未完成，具体错误留在工具结果；不得原样连调读取同一失败断点。仅当工具明确标记可恢复（如暂时性传输故障或 resumable=true）时可续跑一次；同一错误再次出现必须停止。用户再次明确要求继续时可重新调用原生工具；不得用普通 write/edit/shell/Python 生成替代章节。",
				"Writer 在保留底稿主体的前提下最多进行 1 次针对具体素材缺口的局部修正。若仅剩可融合的结构重复，须保留当前候选稿并继续调用 Polisher、Punctuation、Proofreader 和 Reviewer，不得重新生成整章。",
				"全部问答均已展开、结构可审核时，保留候选稿并继续调用 Polisher、Punctuation、Proofreader 和 Reviewer；不按素材字数倍率删减或拦截正文。",
				"工具成功只表示候选稿已落盘，下一步必须调用 biography_chapter_polisher，再依次调用 biography_chapter_punctuation 与 biography_chapter_proofreader；用户批准当前正文前不得称为章节写作成功。",
				"当前问答已经存在合法候选稿时，默认保护现稿并根据工具返回的 next_action 续跑标点、文字校正、审核或用户审阅；只有用户明确要求整章重写时才传 force_rewrite=true。",
				"工具从案例动态预算读取本轮计划贡献，并从已批准叙事账本和口吻档案读取跨章约束；不得把废稿或未批准候选稿当作案例记忆。",
			]
			: name === "biography_chapter_polisher"
				? [
					"本工具固定在 Writer/Reviser 之后、Punctuation 之前，以当前成稿为内容基线，只调整措辞、语序、句式和节奏；不得按采访回答重新取舍成稿，也不得补入时代背景。",
					"不得新增具体私人事件、具体对话、人物姓名、家庭遭遇或因果关系；不得把公共历史背景写成传主亲历的私人事实。",
					"润色先按连贯片段处理；内容校验失败且完整生成预算耗尽时，工具仅对该片段启用一次有界的逐句编辑恢复，未涉及句子由程序原样保留，有改动的候选仍须独立核对。已完成片段不重做。标题、顺序、拼接和断点由程序控制。",
					"status=partial 表示检查点已保存、文风阶段尚未完成；仅当 resumable=true 时依照 next_action 继续本工具，只续跑未完成片段，不重写 Writer、不进入标点，也不把保留原文解释为润色通过。status=failed 或 partial 且 resumable=false 时停止自动循环，普通回复只说明本章暂未完成，具体问题留在工具结果。",
					"只有 status=pass 且报告已完整提交才进入 biography_chapter_punctuation；修改正文后旧标点、校正、审核和用户审批报告失效。单片尝试预算跨工具调用累计，恢复检查点不能重置预算。",
					"本工具完整提交只表示文风阶段完成，章节仍须经过标点、文字校正、审核与用户批准。",
				]
			: name === "biography_chapter_punctuation"
				? [
					"本工具是 Polisher 后以及 Proofreader 改字后的标点关卡，只筛查和修复中文标点及断句。",
					"只能修改 Unicode 标点、受控空白与需替换的外文符号；任何汉字、字母、数字或其他正文字符增删替换都必须失败，不得补主语或借标点修复润色正文。",
					"第一次 pass 后必须调用 biography_chapter_proofreader；若已有与当前非标点正文绑定的 Proofreader 报告，则这是校正后的第二次标点，可进入 biography_chapter_reviewer。失败时不得绕过。",
					"本工具 pass 只表示候选稿标点通过，不表示章节写作成功。",
					"单次用户任务中同一章最多调用本工具 2 次，第 2 次仍失败必须停止并报告。",
				]
			: name === "biography_chapter_proofreader"
				? [
					"本工具固定在第一次 Punctuation 之后、Reviewer 之前，只校正明确错别字、漏字和最小范围的主谓宾残缺。",
					"不得润色、扩写、改事实、改数字、改引语形式、改标点或改段落边界；没有明确错误必须返回空操作。",
					"工具未改文字时下一步直接调用 biography_chapter_reviewer；工具改了文字时旧标点报告失效，必须再调用一次 biography_chapter_punctuation，然后直接进入 Reviewer，不得第二次调用 Proofreader。",
					"单次候选链只调用本工具 1 次；失败时最多由工具内部按配置重试，不得由主控循环调用。",
				]
			: [
					"本工具只审核当前章节，不生成、不修改章节正文。调用前必须同时通过当前文风报告、标点报告与文字校正报告门禁，主控不得自行宣布通过。",
					"本工具 pass 表示候选稿可以交给用户审阅；篇幅short/long仅作诊断，不单独阻断，也不得因此自动改写。",
					"Reviewer 首次发现结构 high 时先调用 Reviser 融合一次，不得展示融合前正文；融合后的复审pass才能展示。若仍返回 revise，进入 structure_blocked，只告知本章暂未完成，不展示正文或内部问题。",
					"审核请求发生技术失败时才按限额重试；已生成有效 revise 报告应按 next_action 进入局部修订，不得反复审核同一正文或修改审核 JSON 绕过。",
					"单次用户任务中同一章最多调用本工具 2 次，第 2 次仍失败或返回 revise 后必须停止；普通回复只说明本章暂未完成，具体原因留在工具结果。",
				];
		const toolParameters = name === "biography_chapter_writer"
			? Type.Object({
				chapter: Type.Integer({ minimum: 1, maximum: 6, description: "The single chapter number to process" }),
				force_rewrite: Type.Optional(Type.Boolean({ description: "Replace an existing valid candidate only when the user explicitly requests a whole-chapter rewrite" })),
			})
			: Type.Object({
				chapter: Type.Integer({ minimum: 1, maximum: 6, description: "The single chapter number to process" }),
			});
		pi.registerTool(defineTool({
			name,
			label,
			description,
			promptSnippet: `${label}: process one chapter only`,
			promptGuidelines: [
				...toolGuidelines,
				"already_complete=true 表示复用当前有效产物，必须按返回的 next_action 接着执行，不得按该工具首次完成时的固定顺序倒退。next_action=stop 或 blocked=true 时停止自动调用并报告原因。",
				"每次只处理一个章节号，只读取上游直接提供的该章 input/chapter-XX-qa.md；不得拆分、合并或读取其他章问答。",
				"章节 TXT 必须与 JSON 旁文件一致；所有阶段产物只能由对应原生传记工具生成。",
				"自动链路需要继续调用下一工具时直接调用，不先输出自然语言说明；宿主在最终普通回复中展示状态和路径。Reviewer pass 后由宿主读取并展示已落盘正文。审核问题、段号、级别和修订经过不写进普通助手消息；用户主动问原因时才具体解释。",
			],
			parameters: toolParameters,
			async execute(_id, params, signal, onUpdate, ctx) {
				return executeAction(pi, action, {
					chapter: params.chapter,
					forceRewrite: name === "biography_chapter_writer"
						&& "force_rewrite" in params
						&& params.force_rewrite === true,
				}, signal, onUpdate, ctx);
			},
		}));
	}

	pi.registerTool(defineTool({
		name: "biography_section_title_manager",
		label: "Biography Section Title Manager",
		description: "Atomically add or regenerate validated subsection titles for existing chapters without rewriting chapter prose.",
		promptSnippet: "Add or regenerate subsection titles without changing prose",
		promptGuidelines: [
			"用户要求给无标题小节补标题时使用 add_missing；用户要求重做、重命名或更换已有标题时使用 regenerate。",
			"chapter 省略时处理全部六章；用户只指定一章时传该章号。不得自行扩大用户指定范围。",
			"模型只负责提出2-8字标题；程序负责读取结构、校验、归档、原子写入和回滚。不得调用 Writer，也不得改写正文。",
			"工具会验证去除标题行后的正文逐字不变，并记录可审计的标题等价证据。正文审核和用户批准继续有效；既有合稿因展示标题变化而失效，需重新合稿。",
		],
		parameters: Type.Object({
			operation: StringEnum(["add_missing", "regenerate"] as const, { description: "Add absent titles or regenerate existing titles" }),
			chapter: Type.Optional(Type.Integer({ minimum: 1, maximum: 6, description: "Optional single chapter; omit for the whole book" })),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			return executeAction(pi, "section-title-manage", {
				chapter: params.chapter,
				titleOperation: params.operation,
			}, signal, onUpdate, ctx);
		},
	}));

	pi.registerTool(defineTool({
		name: "biography_chapter_reviser",
		label: "Biography Chapter Reviser",
		description: "Revise only the paragraphs implicated by machine review or explicit user feedback. It preserves untouched paragraphs and archives the prior version; it never rewrites the whole chapter.",
		promptSnippet: "Apply explicit feedback as localized edits to one chapter",
		promptGuidelines: [
			"用户指出章节中不满意或不真实的局部时必须使用本工具，不得重新调用 Writer 整章重写。",
			"用户明确要求重写某个编号小节（如 2.4）时，仍调用本工具；工具会重写该节正文并保持其他小节原样。不得把整节重写解释为只改几句，也不得扩大到整章。",
			"feedback 必须传用户原话或 Reviewer 的具体 high 问题，不得自行扩写用户意见；工具会以会话中最新用户原话为准。",
			"feedback_source 必须准确标记来源：用户亲自提出或补充素材时填 user；机器 Reviewer 的 high 修订指令填 reviewer。机器意见绝不能冒充用户反馈。",
			"工具成功后旧文风、标点、文字校正、机器审核和用户批准全部失效，必须重新调用 Polisher、Punctuation、Proofreader 与 Reviewer，再交用户审阅。",
			"问答是事实证据池；具体动作、环境、感官、心理、道具状态和对白必须有来源。用户本轮纠正优先于原问答。",
			"用户补充新经历时原样作为feedback传入并局部组合进现稿；不要因篇幅偏离而自动请求补字或重新调用Writer。",
			"结构重复修订必须由 Reviser 先调用 fusion_audit 生成并保存重复组登记表，再调用 fusion_write 按登记表融合；禁止一次调用直接判断并删除。每个被删段落的独有内容必须有融合段证据。",
			"feedback_source=reviewer 的自动结构融合每轮最多一次；融合后重新走 Polisher、Punctuation、Proofreader、必要时第二次 Punctuation 与 Reviewer，只有结构通过才交给用户。复审仍有结构 high 时进入 structure_blocked，不展示正文，也不得再次调用机器 Reviser。",
		],
		parameters: Type.Object({
			chapter: Type.Integer({ minimum: 1, maximum: 6, description: "Chapter number to revise" }),
			feedback: Type.String({ minLength: 1, description: "The user's exact revision request or concrete machine-review issue" }),
			feedback_source: StringEnum(["user", "reviewer"] as const, { description: "Whether feedback came explicitly from the user or from machine review" }),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			let chapter = params.chapter;
			let feedback = params.feedback;
			if (params.feedback_source === "user") {
				const entries = ctx.sessionManager.getBranch();
				const userText = latestInterviewUserText(entries)?.trim();
				const userChapters = explicitRevisionChapters(userText);
				const feedbackChapters = explicitRevisionChapters(params.feedback);
				const activeChapter = activeInterviewChapter(entries);
				if (userChapters.length === 1 && (params.chapter !== userChapters[0]
					|| feedbackChapters.some((value) => value !== userChapters[0]))) {
					const target = userChapters[0];
					const caseRoot = findSessionCaseSelection(entries)?.caseRootWindows;
					const hasTargetFiles = caseRoot
						&& fs.existsSync(path.join(caseRoot, "input", `chapter-${String(target).padStart(2, "0")}-qa.md`))
						&& fs.existsSync(path.join(caseRoot, "chapters", `chapter-${String(target).padStart(2, "0")}.txt`));
					if (params.chapter !== target && hasTargetFiles
						&& feedbackChapters.every((value) => value === target)) {
						chapter = target;
					} else {
						return wrongRevisionChapterResult(target, params.chapter);
					}
				} else if (userChapters.length === 0 && activeChapter !== undefined
					&& (params.chapter !== activeChapter || feedbackChapters.some((value) => value !== activeChapter))) {
					return wrongRevisionChapterResult(activeChapter, params.chapter);
				} else if (userChapters.length > 1 && !userChapters.includes(params.chapter)) {
					return wrongRevisionChapterResult(userChapters[0], params.chapter);
				}
				// Never present the model's inferred instructions as user feedback.
				if (userText) feedback = userText;
			}
			const feedbackBase64 = Buffer.from(feedback, "utf8").toString("base64");
			const result = await executeAction(pi, "chapter-revise", {
				chapter,
				feedbackBase64,
				feedbackSource: params.feedback_source,
			}, signal, onUpdate, ctx);
			return chapter === params.chapter ? result : {
				...result,
				details: { ...result.details, corrected_chapter_from: params.chapter, corrected_chapter_to: chapter },
			};
		},
	}));

	pi.registerTool(defineTool({
		name: "biography_chapter_user_approval",
		label: "Biography Chapter User Approval",
		description: "Record the user's explicit approval of the current machine-reviewed chapter version.",
		promptSnippet: "Record explicit user approval for the current chapter version",
		promptGuidelines: [
			"只有用户在看过当前落盘正文后明确表示满意、通过或无需修改时才能调用。",
			"不得根据沉默、机器 Reviewer pass 或主控自己的判断代替用户批准。",
			"用户提出修改意见时不要调用本工具；应调用 biography_chapter_reviser。",
			"批准成功后由原生工具自动重建 context/book-budget.json、narrative-ledger.json 和 voice-profile.json；不得手工编辑这些文件。",
		],
		parameters: Type.Object({
			chapter: Type.Integer({ minimum: 1, maximum: 6, description: "Chapter number explicitly approved by the user" }),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			return executeAction(pi, "chapter-user-approve", { chapter: params.chapter }, signal, onUpdate, ctx);
		},
	}));

	pi.registerTool(defineTool({
		name: "biography_book_assembler",
		label: "Biography Book Assembler",
		description: "Assemble six machine-reviewed and explicitly user-approved chapter TXT files into one final TXT autobiography with title, author, directory, and body.",
		promptSnippet: "Assemble six approved autobiography chapters into the final TXT",
		promptGuidelines: ["Do not use until all six current chapter versions pass machine review and have explicit user-approval records."],
		parameters: Type.Object({}),
		async execute(_id, _params, signal, onUpdate, ctx) {
			return executeAction(pi, "assemble-book", {}, signal, onUpdate, ctx);
		},
	}));

	pi.registerTool(defineTool({
		name: "biography_chapter_source",
		label: "Biography Chapter Source",
		description: "Register one upstream-prepared chapter Q&A file in the active case without splitting, merging, summarizing, or rewriting it.",
		promptSnippet: "Register one ready-to-use chapter Q&A file",
		promptGuidelines: [
			"When the user provides one chapter's Q&A file, infer this tool automatically; do not ask the user to name it.",
			"The input must contain exactly the requested chapter with 12-20 complete Q&A pairs. Twelve is the hard minimum; chapter-specific interview targets are 16-18, 16-18, 18-20, 18-20, 15-18, and 15-18 for chapters 1-6.",
			"Register the file unchanged. Never accept a six-chapter master document and split it inside the Agent.",
			"Replacing one chapter source must not change any other chapter source.",
		],
		parameters: Type.Object({
			chapter: Type.Integer({ minimum: 1, maximum: 6, description: "Chapter number for this Q&A file" }),
			source_path: Type.String({ minLength: 1, description: "Absolute Windows path to one chapter's UTF-8 .md or .txt Q&A file" }),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			return executeAction(pi, "chapter-source", { chapter: params.chapter, sourcePath: params.source_path }, signal, onUpdate, ctx);
		},
	}));

	pi.registerTool(defineTool({
		name: "biography_chapter_interviewer",
		label: "Biography Chapter Interviewer",
		description: "Interview one topic group at a time, present its related questions in full, then follow up only on missing details after the user answers. Save and register chapter Q&A after user confirmation.",
		promptSnippet: "Interview one biography chapter and register confirmed Q&A",
		promptGuidelines: [
			"本工具只采集和登记问答，不写章节正文、不审核、不合稿。",
			"每次询问一个主题的问题组，可以包含紧密相关的几个小问，首次必须完整告知用户，不得按问号提前截成多轮。用户回答后才逐项判断遗漏；有 pending 问题时先记录用户的新回答或明确跳过，不得重复创建追问。",
			"action=ask 时 question 必须包含准备发给用户的完整问题组；同时从 status.chapter_interview_contract.allowed_material_goals 选择一个 material_goal。工具成功后宿主显示完整问题并结束本轮等待用户回答。action=followup 创建新追问时也必须传 question；已有 pending 追问时直接展示，不再新建。",
			"每个新主问题必须服务于当前章 material_goal，并且实际问法必须符合该目标的 collect 和 question_angles。不得给婚礼问题贴上 work_entry 标签之类的错误标签来绕过章节边界。",
			"status 返回的 chapter_interview_contract 是当前章硬边界：只从 in_scope 和 allowed_material_goals 开新题，避开 out_of_scope。用户主动说到越界内容时保留原话，但不得顺着越界主题继续开题；只有它直接影响当前章主题时才能追问这种因果关系。",
			"开新题前核对 status.skipped_question_topics 和本章已问问题。用户跳过的是主题，不只是当时的原句；不能改写题目或更换 material_goal 再问。用户后来顺带提到相关事实，不等于同意重谈已跳过的主题。ask_rejected_duplicate 表示新题没有登记，不要把候选题展示给用户；改选独立主题，或在达到最低题量且用户要结束时尊重其意愿。",
			"如果下一句只是为了补足上一题的具体细节、例子、时间、地点、人物或动作，使用 action=followup，不要使用 action=ask；followup 不占 12-20 个主问题槽位。",
			"提问前必须考虑这个问题将来能为章节正文贡献哪一种传记素材；不要只问事实标签。优先采集时间阶段、地点空间、人物关系、具体动作、生活处境、冲突或变化、结果影响、感官画面。",
			"每个主问题最好至少拿到 3-5 个素材维度；用户回答只给事实标签时，追问应优先补缺失维度，例如谁在场、怎么做、路上经过哪里、后来怎样、留下什么画面。",
			"素材多少由回答的事件、过程与画面决定，不要凭问答组数保证章节丰满；达到 12 组后由用户选择是否继续补充。",
			"先看 pending_question：已经有待回答问题时，通常展示并等待用户，不重复调用 followup。用户明确要求结束并写作时，优先调用 action=choice、choice=write；即使有 pending 题也不要求先回答或说‘跳过’。原生工具按完整回答组数决定暂停、提醒或写作。仅在没有 pending 且 needs_followup=true 时，使用 action=followup 并传入具体 question，围绕 followup_target_question_number 回补。用户忘了、不记得或不愿回答当前小问时按不可回答状态关闭该小问，不要重复逼问；如果说今天不想再答，则暂停采访并保留当前题。",
			"用户在回答当前 pending 问题时突然补充以前的问题，先调用 action=supplement，把 answer 原文登记到 target_question_number 指向的旧问答；如果当前 pending 仍需要回答，再继续围绕当前问题让用户作答。",
			"旧采访记录中如果追问被误登记成主问题，先调用 action=normalize；工具会备份原采访文件，再把明显追问并回上一主问题。",
			"用户回答 pending 问题时调用 action=answer，answer 传用户原话，不要润色或摘要。",
			"用户单独说‘继续’、‘接着’或‘往下’是流程控制，不是回答、跳过或不愿回答；不要把这些词写入问答，也不要调用 answer/skip。宿主会重新显示当前 pending 小问，等待用户真正回答。用户明确说‘跳过这题/忘了/不记得/不想回答这道题/不方便说这个问题’才关闭当前问题；说‘今天不想再回答/我不想回答了’则暂停采访，保留待答题供下次继续。",
			"如果当前仍有 pending 小问，必须先用 answer 或明确的不可回答标记关闭它，再决定是否 ask 新主问题；不得在同一用户回答尚未登记时先调用 ask。用户明确选择写作时直接 choice=write，由工具按题数处理 pending；这不是要求用户先回答或跳过。",
			"用户刚回答时，先静默调用 action=answer，等工具确认已登记并返回是否仍有 pending，再决定追问或换题。不要在工具调用前说‘这组记下了’‘接下来聊……’之类尚未确认的转场话；工具入口会拒绝过早的新题并让你先登记答案。",
			"一个主问题含有多个紧密相关的小问时，逐项核对当前及已保存的用户原话。action=answer 仅把真正仍未回答的小问原文放进 remaining_subquestions；回答已有追问时，不得把既有待答小问改写、拆分后再次追加。用户说忘了、记不清或不想回答的小问放进 unavailable_subquestions。用户已经回答过的待答小问放进 resolved_subquestions，每项 question 必须是现有 pending 小问原文，evidence 必须逐字摘自当前或已保存的用户回答。不能从模型总结、推断或他人话语取证。",
			"answer、skip 和 supplement 只能处理当前问题发出后到达的新用户消息；同一助手回合里 ask/followup 之后必须停止并等待用户，禁止根据模型自己的总结、推测或工具输出继续 answer/skip/supplement。工具入口会校验用户消息来源。",
			"用户只要求跳过整组当前题时调用 action=skip；明确要求现在写作时不要误用 skip，应调用 action=choice、choice=write。用户说今天先休息、暂停或笼统地说不想再回答，应调用 action=choice、choice=pause；已经登记的回答和当前待答题都保留，之后可继续。单说‘跳过’只跳过当前题。如果只是其中一个小问忘了、记不清或不想回答，仍使用 action=answer 并把该小问放入 unavailable_subquestions。skip 只保留整组跳过记录，不计入 12-20 个有效主问答。",
			"用户回答‘没有’、‘没遇到’、‘没什么变化’等明确否定时，视为该小问已经回答，不得因为字数短而重复追问；先登记当前 pending，再进入下一步。",
			"用户说‘我已经回答过了’时，不要把这句纠错当传记素材，也不要再问同义题。调用 action=answer，answer 原样传本轮用户消息；明确纠正重复追问时可关闭当前小问而不新增事实。主动核销其他排队小问才须在 resolved_subquestions 中提供已有用户原话的逐字证据。下一句先自然道歉，不要称赞或复述纠错话语。",
			"聊天保持温和、有耐心。用户刚回答后，下一次提问必须先针对回答中的真实细节写一句简短、积极或鼓励性的承接，放入 acknowledgement 参数；不要省略，也不必每轮道谢或反复用同一说法。用户只确认身份、关系或设置时只确认该信息；讲述经历时回应真实细节，不补造情绪、不替用户总结意义。承接不要包含问题、编号或外语，只用于聊天显示，不写入采访记录。首次提问前没有用户回答、或只是重显待答问题时，不必承接。",
			"面向老年用户时使用客服式关怀表达：普通 action=ask 自然衔接一个主问题；只有 action=followup 或 answer 后仍有 pending 小问时，才可温和说明是在补充细节，不必固定说‘还想再确认’。不要直接说‘还差几个小点’‘您漏答了’或‘回答失败’；用户忘了、不想回答时告诉对方没有关系，不需要勉强，也不会因此影响继续采访。",
			"首次 ask 必须完整展示同一主题下的所有相关小问；只有用户回答后产生多个遗漏点时，才逐个追问。不要提前隐藏尚未告知用户的小问，也不要说‘再补几个小点’。",
			"工具结果里的 reply_contract 是硬性输出契约：最终回复用户时必须满足 must_include，避开 must_not。",
			"如果工具本轮已经返回 final_user_reply，宿主会把安全的承接放在已登记问题前，再作为普通助手消息显示；遗漏 acknowledgement 时会从本轮自然回应或用户原话补足承接。模型不能改写问题或追加第二个问题。严格遵守 language_rule，只使用简体中文。",
			"action=ask、followup，或 answer 后仍有 pending 小问时，宿主会把工具准备的回复替换为普通助手消息；不要根据工具结果追加、改写或列出第二个问题。answer/skip/supplement 如果没有 pending 小问，本轮按 recommended_next_action 继续：ask/followup 时立即登记并展示下一题；offer_interview_choices 时展示三选并等待；自由讲述时等待用户讲述。不要只说‘记下了’或‘接着聊’就停住，不要把内部状态 JSON 发给用户。",
			"回复计数时必须使用 completed_count 表示完整有效问答数，使用 partial_count 表示部分完成的问题组，使用 skipped_count 单独说明整组跳过数；不要把 recorded_main_question_count 当成 12 题进度。",
			"每章至少 12 组有效完整主问答，最多 20 组。跳过题和自由回忆不计入 completed_count；12 组有效主问答以前不得 register；达到 20 组有效主问答后不得继续 ask。",
			"每轮读取 chapter_interview_contract.recommended_question_range 和 writing_readiness_baseline 作为提问方向参考，不把建议题数当成用户选择写作的门槛。",
			"题数不能替代写作准备判断：第一、二章通常至少需要 3 段可展开场景或事件，第三、四章通常至少需要 4 段，第五章至少需要 3 段当下生活场景，第六章至少需要 4 项有具体经历和明确表达者支持的真实表达。",
			"12 组完整问答是每章各自的最低门槛，不是全书总题数；问完一章就处理一章，不要等六章全部采访完。",
			"达到 12 组且本题闭环后，使用工具返回的 choice_required/choice_menu 展示三选；用户选继续采访后可继续 ask，不因第 13、14 组反复弹菜单。选自由讲述后原样保存用户主动讲的内容，不追问成一串小题。",
			"完成至少 12 组完整问答且没有待回答题或必要追问时，立刻展示三项选择：1 现在写作；2 继续按题采访增加素材；3 用户自由讲述记忆增加素材。不得自动开第 13 题。12–14 组时仅在用户选择写作后说明素材可能偏少，等待其下一条消息确认；不要在菜单和选择后重复提醒。",
			"用户明确要求写作或结束采访时调用 action=choice、choice=write：不足 12 组时暂停并建议休息后补充；12–14 组时只提示一次素材可能偏少，等待用户下一条消息确认，收到明确确认后用 choice=confirm_write；满 15 组时立即登记并进入本章写作。提醒出现后绝不能在同一用户回合自动确认。用户明确说暂停时用 choice=pause；用户之后说继续时用 choice=continue，若有 pending 题则重显原题。already_registered=true 表示已登记且问答未变，不得宣告新登记或再次 register。resume_chapter_workflow 是转回写作链路的哨兵，不是采访 action。选 2 时 action=choice、choice=continue，然后继续当前采访；选 3 时 action=choice、choice=free_recall，之后对用户自由讲述的原话调用 action=free_recall、answer=原话；这类回忆不计入 12-20 问答组。",
			"采访草稿保存在 interviews/chapter-XX-interview.md；正式写作输入保存在 input/chapter-XX-qa.md。Writer 只读取正式输入。",
		],
		parameters: Type.Object({
			action: StringEnum(["status", "ask", "followup", "answer", "skip", "supplement", "normalize", "register", "choice", "free_recall"] as const, { description: "Interview action" }),
			chapter: Type.Integer({ minimum: 1, maximum: 6, description: "The chapter being interviewed" }),
			choice: Type.Optional(StringEnum(["write", "continue", "free_recall", "pause", "confirm_write"] as const, { description: "Write, continue, free recall, or pause; confirm_write requires an earlier warning and a fresh user confirmation" })),
			question: Type.Optional(Type.String({ minLength: 1, description: "Required for ask and for creating a new followup. For ask, pass the complete topic question group, including all related subquestions; do not cut it at the first question mark. For followup, ask only about a missing detail after the user has answered." })),
			material_goal: Type.Optional(Type.String({ minLength: 1, description: "Required for action=ask. One current-chapter goal id returned by status.chapter_interview_contract.allowed_material_goals" })),
			answer: Type.Optional(Type.String({ minLength: 1, description: "The user's exact words when action=answer or free_recall" })),
			acknowledgement: Type.Optional(Type.String({ description: "When the user has just answered, provide one short, specific, varied and encouraging Chinese acknowledgement grounded in that answer before the next question. Omit only for an initial question or a control-only message. Do not include a question, invent facts, or repeat a stock thank-you. Display only; never saved as Q&A." })),
			remaining_subquestions: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 3, description: "For a main-question answer, exact unanswered child questions to queue. While answering an existing follow-up, do not create reworded children; [] does not clear other queued children. Use resolved_subquestions with verbatim evidence to close a different queued child already answered." })),
			unavailable_subquestions: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 3, description: "For action=answer, exact child questions the user forgot or does not want to answer; these are terminal and are not asked again" })),
			resolved_subquestions: Type.Optional(Type.Array(Type.Object({
				question: Type.String({ minLength: 1, description: "The exact text of an existing pending child question that the user has already answered" }),
				evidence: Type.String({ minLength: 1, description: "Verbatim span from the current or already recorded user answer proving this child was answered; no paraphrase or inference" }),
			}), { maxItems: 20, description: "For action=answer only. Close stale pending child questions with exact question text and verbatim user-answer evidence; do not rewrite or split questions" })),
			target_question_number: Type.Optional(Type.Integer({ minimum: 1, description: "Existing question number for supplement, or explicit followup target" })),
		}),
		async execute(_id, params, signal, onUpdate, ctx) {
			const turnState = turnStateFor(ctx.sessionManager);
			const entries = ctx.sessionManager.getBranch();
			const latestUserText = latestInterviewUserText(entries);
			const latestUserIndex = latestUserEntryIndex(entries);
			const requestedChoice = params.action === "choice" ? params.choice : undefined;
			const modelBackedWriteRequest = params.action === "choice" && params.choice === "write"
				&& isModelBackedWriteRequest(latestUserText);
			const userChoice = resolveInterviewChoice(requestedChoice, latestUserText, modelBackedWriteRequest);
			const verbalWriteRequest = requestedChoice === "write"
				|| isVerbalWriteRequest(latestUserText) || modelBackedWriteRequest;
			// A model may batch ask/answer and followup in one message. The next
			// message_end guard cannot cancel calls already in that batch, so reuse
			// the question prepared by the first successful call without writing again.
			const waitingReply = turnState.pendingAssistantReplies.find((reply) => reply.kind === "interview" && reply.awaitingAnswer);
			if (waitingReply && !verbalWriteRequest && !isExplicitEarlyWriteConfirmation(latestUserText)
				&& userChoice !== "pause") {
				return {
					content: [{ type: "text" as const, text: JSON.stringify({
						status: "awaiting_user_answer", final_user_reply: waitingReply.text,
						instruction: "问题已经准备好，请结束本轮等待用户回答，不再调用工具。",
					}) }],
					details: { interview_reply: waitingReply.text, interview_action: "reuse", awaiting_user_answer: true },
				};
			}
			const writeCurrentChapter = async (chapter: number, confirmed = false) => {
				const selected = await executeAction(pi, "chapter-interview", {
					chapter, interviewAction: "choice", choice: confirmed ? "confirm_write" : "write",
				}, signal, onUpdate, ctx);
				turnState.choiceUserIndex = latestUserIndex;
				turnState.interviewStatusCallsSinceMutation = 0;
				turnState.pendingNextQuestion = undefined;
				turnState.pendingAssistantReplies.length = 0;
				const selection = parseWorkflowPayload(String(selected.details?.stdout ?? ""));
				if (selection?.selected_mode !== "write") {
					if (selection?.early_write_warning_pending === true) {
						earlyWriteWarningUserIndices.set(ctx.sessionManager, latestUserIndex);
					}
					return prepareStatusReply(selected, chapter, ctx.sessionManager);
				}
				const registered = await executeAction(pi, "chapter-interview", {
					chapter, interviewAction: "register",
				}, signal, onUpdate, ctx);
				turnState.pendingNextQuestion = undefined;
				turnState.pendingAssistantReplies.length = 0;
				const payload = parseWorkflowPayload(String(registered.details?.stdout ?? ""));
				if (payload?.already_registered === true) return resumeChapterResult(registered, chapter);
				return {
					...registered,
					content: [{ type: "text" as const, text: JSON.stringify({
						...payload,
						status: "registered_for_writing",
						instruction: `用户已选择直接写作，第${chapter}章采访素材已经登记。立即调用 biography_chapter_writer 写第${chapter}章，并继续后续链路；不要再采访或要求二次确认。`,
					}) }],
				};
			};
			const chooseWriteForStatus = async (chapter: number, payload: Record<string, unknown>) => {
				const warningPending = payload.early_write_warning_pending === true
					|| payload.recommended_next_action === "confirm_early_write";
				if (warningPending) {
					if (!isEarlyWriteConfirmation(latestUserText)
						|| earlyWriteWarningUserIndices.get(ctx.sessionManager) === latestUserIndex
						|| (!hadEarlyWriteWarningBeforeUser(entries, latestUserIndex, chapter)
							&& !isExplicitEarlyWriteConfirmation(latestUserText))) return undefined;
					return writeCurrentChapter(chapter, true);
				}
				return writeCurrentChapter(chapter);
			};
			const activeProgress = activeChapterProgress(ctx.sessionManager.getBranch());
			const activeChapter = activeProgress?.chapter;
			if (activeChapter !== undefined && params.chapter !== activeChapter) {
				// Model-provided chapter numbers are not authority to advance the
				// interview. Only an unfinished interview can have a live pending
				// question; later stages must follow the persisted chapter stage.
				let sourceCurrent = false;
				let sourceReadyToRegister = false;
				if (!activeProgress?.stage || activeProgress.stage === "awaiting_source") {
					const statusResult = await executeAction(pi, "chapter-interview", {
						chapter: activeChapter,
						interviewAction: "status",
					}, signal, onUpdate, ctx);
					const payload = parseWorkflowPayload(String(statusResult.details?.stdout ?? ""));
					if (payload && (userChoice === "write" || userChoice === "pause"
						|| isEarlyWriteConfirmation(latestUserText))) {
						if (userChoice === "write" || isEarlyWriteConfirmation(latestUserText)) {
							const routed = await chooseWriteForStatus(activeChapter, payload);
							if (routed) return routed;
						} else {
							const selected = await executeAction(pi, "chapter-interview", {
								chapter: activeChapter, interviewAction: "choice", choice: "pause",
							}, signal, onUpdate, ctx);
							return prepareStatusReply(selected, activeChapter, ctx.sessionManager);
						}
					}
					if (payload?.selected_mode === "pause"
						&& (userChoice === "continue" || isInterviewContinueCommand(latestUserText))) {
						const selected = await executeAction(pi, "chapter-interview", {
							chapter: activeChapter, interviewAction: "choice", choice: "continue",
						}, signal, onUpdate, ctx);
						return prepareStatusReply(selected, activeChapter, ctx.sessionManager);
					}
					if (typeof payload?.pending_question === "string" && payload.pending_question.trim()) {
						return prepareStatusReply(statusResult, activeChapter, ctx.sessionManager, "好的，我们接着聊：");
					}
					sourceCurrent = payload?.registration_state === "current";
					sourceReadyToRegister = payload?.registration_state === "missing"
						&& payload?.selected_mode === "write" && payload?.can_register === true;
				}
				return wrongChapterWorkflowResult(activeChapter, params.chapter, activeProgress?.stage,
					sourceCurrent, sourceReadyToRegister);
			}
			const choose = async (choice: InterviewChoice) => {
				if (choice === "write" || choice === "confirm_write") {
					return writeCurrentChapter(params.chapter, choice === "confirm_write");
				}
				const choiceResult = await executeAction(pi, "chapter-interview", {
					chapter: params.chapter, interviewAction: "choice", choice,
				}, signal, onUpdate, ctx);
				turnState.choiceUserIndex = latestUserIndex;
				turnState.interviewStatusCallsSinceMutation = 0;
				if (choice !== "continue") turnState.pendingNextQuestion = undefined;
				turnState.pendingAssistantReplies.length = 0;
				if (choice === "pause") {
					return prepareStatusReply(choiceResult, params.chapter, ctx.sessionManager);
				}
				if (choice === "free_recall") {
					const reply = `第${params.chapter}章｜自由讲述\n\n您想到哪段经历，就按自己的方式慢慢说。我会按原话记下；想开始写作时，告诉我一声就好。`;
					queueAssistantReplyForAssistant(ctx.sessionManager, reply, params.chapter, "free_recall", "interview", true);
					return {
						...choiceResult,
						content: [{ type: "text" as const, text: JSON.stringify({
							status: "awaiting_free_recall", final_user_reply: reply,
							instruction: "自由讲述邀请已作为普通助手消息准备。请结束本轮等待用户讲述，不要自行编写回忆。",
						}) }],
					};
				}
				const chosenPayload = parseWorkflowPayload(String(choiceResult.details?.stdout ?? ""));
				if (typeof chosenPayload?.pending_question === "string" && chosenPayload.pending_question.trim()) {
					return prepareStatusReply(choiceResult, params.chapter, ctx.sessionManager);
				}
				return {
					...choiceResult,
					content: [{ type: "text" as const, text: JSON.stringify({
						...parseWorkflowPayload(String(choiceResult.details?.stdout ?? "")),
						instruction: `用户选择继续采访。立即按本章 material_goal 调用 action=ask 登记并展示下一道主问题，不要等待用户再发“继续”。`,
					}) }],
				};
			};
			const saveFreeRecall = async () => {
				const source = assertInterviewUserMutation({
					action: "free_recall", chapter: params.chapter,
					answer: latestUserText,
					entries: ctx.sessionManager.getBranch(),
				});
				const saved = await executeAction(pi, "chapter-interview", {
					chapter: params.chapter, interviewAction: "free_recall",
					textBase64: Buffer.from(source ?? "", "utf8").toString("base64"),
				}, signal, onUpdate, ctx);
				turnState.freeRecallUserIndex = latestUserIndex;
				turnState.interviewStatusCallsSinceMutation = 0;
				const reply = `第${params.chapter}章｜自由讲述\n\n这段我按您的原话记下了。您可以接着讲，也可以告诉我现在开始写作。`;
				queueAssistantReplyForAssistant(ctx.sessionManager, reply, params.chapter, "free_recall", "interview", true);
				return {
					...saved,
					content: [{ type: "text" as const, text: JSON.stringify({
						status: "free_recall_saved", final_user_reply: reply,
						instruction: "自由回忆原话已保存。请结束本轮，等待用户继续讲述或选择写作。",
					}) }],
				};
			};
			const handleChoiceOrRecall = async (payload: Record<string, unknown> | undefined) => {
				const count = typeof payload?.completed_count === "number" ? payload.completed_count : 0;
				const pending = typeof payload?.pending_question === "string" && payload.pending_question.trim().length > 0;
				const warningPending = payload?.early_write_warning_pending === true
					|| payload?.recommended_next_action === "confirm_early_write";
				if (userChoice === "pause" && turnState.choiceUserIndex !== latestUserIndex) {
					return choose("pause");
				}
				if (warningPending) {
					if ((userChoice === "continue" || isInterviewContinueCommand(latestUserText))
						&& turnState.choiceUserIndex !== latestUserIndex) return choose("continue");
					const requestedEarlyWriteConfirmation = requestedChoice === "confirm_write";
					if ((requestedEarlyWriteConfirmation || isEarlyWriteConfirmation(latestUserText))
						&& earlyWriteWarningUserIndices.get(ctx.sessionManager) !== latestUserIndex
						&& (requestedEarlyWriteConfirmation
							|| hadEarlyWriteWarningBeforeUser(entries, latestUserIndex, params.chapter)
							|| isExplicitEarlyWriteConfirmation(latestUserText))
						&& turnState.choiceUserIndex !== latestUserIndex) return choose("confirm_write");
					return undefined;
				}
				if (isExplicitEarlyWriteConfirmation(latestUserText)
					&& payload?.selected_mode !== "write"
					&& turnState.choiceUserIndex !== latestUserIndex) return choose("write");
				if (userChoice === "write" && (!pending || verbalWriteRequest)
					&& turnState.choiceUserIndex !== latestUserIndex
					&& payload?.selected_mode !== "write") return choose("write");
				if (payload?.selected_mode === "pause"
					&& (userChoice === "continue" || isInterviewContinueCommand(latestUserText))
					&& turnState.choiceUserIndex !== latestUserIndex) return choose("continue");
				if (count < 12 || (pending && !verbalWriteRequest)) return undefined;
				if (userChoice && turnState.choiceUserIndex !== latestUserIndex
					&& (payload?.choice_required === true || payload?.selected_mode !== userChoice)) {
					return choose(userChoice);
				}
				if (payload?.selected_mode === "free_recall" && !userChoice && latestUserText
					&& !isInterviewContinueCommand(latestUserText) && !isInterviewSkipCommand(latestUserText)
					&& !isFreeRecallStopCommand(latestUserText) && !isInterviewUnavailableCommand(latestUserText)
					&& turnState.freeRecallUserIndex !== latestUserIndex) {
					return saveFreeRecall();
				}
				return undefined;
			};
			if (params.action !== "status" && params.action !== "choice" && params.action !== "free_recall"
				&& ((userChoice === "write" && verbalWriteRequest) || userChoice === "pause"
					|| isEarlyWriteConfirmation(latestUserText)
					|| (isInterviewContinueCommand(latestUserText)
						&& params.action !== "ask" && params.action !== "followup"))) {
				const statusResult = await executeAction(pi, "chapter-interview", {
					chapter: params.chapter, interviewAction: "status",
				}, signal, onUpdate, ctx);
				const statusPayload = parseWorkflowPayload(String(statusResult.details?.stdout ?? ""));
				const routed = await handleChoiceOrRecall(statusPayload);
				if (routed) return routed;
				if (statusPayload?.recommended_next_action === "wait_for_resume"
					|| statusPayload?.recommended_next_action === "confirm_early_write") {
					return prepareStatusReply(statusResult, params.chapter, ctx.sessionManager);
				}
			}
			if (params.action === "status") {
				const repeatedStatus = turnState.interviewStatusCallsSinceMutation > 0;
				turnState.interviewStatusCallsSinceMutation += 1;
				const statusResult = await executeAction(pi, "chapter-interview", {
					chapter: params.chapter,
					interviewAction: "status",
				}, signal, onUpdate, ctx);
				const payload = parseWorkflowPayload(String(statusResult.details?.stdout ?? ""));
				if (payload?.recommended_next_action === "resume_chapter_workflow") {
					return resumeChapterResult(statusResult, params.chapter);
				}
				const choiceOrRecall = await handleChoiceOrRecall(payload);
				if (choiceOrRecall) return choiceOrRecall;
				if (payload?.recommended_next_action === "wait_for_resume"
					|| payload?.recommended_next_action === "confirm_early_write") {
					return prepareStatusReply(statusResult, params.chapter, ctx.sessionManager);
				}
				if (isInterviewContinueCommand(latestUserText)) {
					const prepared = prepareStatusReply(statusResult, params.chapter, ctx.sessionManager, "好的，我们继续。您想到多少说多少：");
					return prepared;
				}
				const hasPending = typeof payload?.pending_question === "string" && payload.pending_question.trim().length > 0;
				return repeatedStatus && hasPending ? { ...statusResult, terminate: true } : statusResult;
			}
			if (params.action === "choice" || params.action === "free_recall" || userChoice) {
				const statusResult = await executeAction(pi, "chapter-interview", {
					chapter: params.chapter, interviewAction: "status",
				}, signal, onUpdate, ctx);
				const payload = parseWorkflowPayload(String(statusResult.details?.stdout ?? ""));
				if (payload?.recommended_next_action === "resume_chapter_workflow") {
					return resumeChapterResult(statusResult, params.chapter);
				}
				const routed = await handleChoiceOrRecall(payload);
				if (routed) return routed;
				if (payload?.recommended_next_action === "wait_for_resume"
					|| payload?.recommended_next_action === "confirm_early_write") {
					return prepareStatusReply(statusResult, params.chapter, ctx.sessionManager);
				}
				if (params.action === "free_recall" && payload?.selected_mode === "free_recall"
					&& !userChoice && latestUserText && !isFreeRecallStopCommand(latestUserText)
					&& turnState.freeRecallUserIndex !== latestUserIndex) {
					return saveFreeRecall();
				}
				if (payload?.choice_required === true) return prepareStatusReply(statusResult, params.chapter, ctx.sessionManager);
				if (params.action === "choice" || params.action === "free_recall") return statusResult;
			}
			if (params.action === "register") {
				const statusResult = await executeAction(pi, "chapter-interview", {
					chapter: params.chapter, interviewAction: "status",
				}, signal, onUpdate, ctx);
				const payload = parseWorkflowPayload(String(statusResult.details?.stdout ?? ""));
				if (payload?.recommended_next_action === "resume_chapter_workflow") {
					return resumeChapterResult(statusResult, params.chapter);
				}
				if (payload?.recommended_next_action === "wait_for_resume"
					|| payload?.recommended_next_action === "confirm_early_write") {
					return prepareStatusReply(statusResult, params.chapter, ctx.sessionManager);
				}
				if (payload?.selected_mode !== "write") {
					if (typeof payload?.pending_question === "string" && payload.pending_question.trim()) {
						return prepareStatusReply(statusResult, params.chapter, ctx.sessionManager);
					}
					if (payload?.choice_required === true) return prepareStatusReply(statusResult, params.chapter, ctx.sessionManager);
					if (payload?.recommended_next_action === "stop_structured_interview") {
						return prepareStatusReply(statusResult, params.chapter, ctx.sessionManager);
					}
					if (typeof payload?.completed_count === "number" && payload.completed_count >= 12) {
						const menu = interviewChoiceMenu(payload);
						queueAssistantReplyForAssistant(ctx.sessionManager, menu, params.chapter, "choice", "interview", true);
						return {
							...statusResult,
							content: [{ type: "text" as const, text: JSON.stringify({
								status: "write_choice_required", choice_menu: menu,
								instruction: "用户尚未选择现在写作，不能登记。三项选择已作为普通助手消息准备，请等待用户决定。",
							}) }],
						};
					}
				}
			}
			if ((params.action === "answer" || params.action === "skip") && !userChoice
				&& wasInterviewPausedBeforeUser(entries, latestUserIndex)
				&& !isInterviewContinueCommand(latestUserText)) {
				const statusResult = await executeAction(pi, "chapter-interview", {
					chapter: params.chapter, interviewAction: "status",
				}, signal, onUpdate, ctx);
				const statusPayload = parseWorkflowPayload(String(statusResult.details?.stdout ?? ""));
				if (statusPayload?.selected_mode === "pause"
					&& typeof statusPayload.pending_question === "string" && statusPayload.pending_question.trim()) {
					await executeAction(pi, "chapter-interview", {
						chapter: params.chapter, interviewAction: "choice", choice: "continue",
					}, signal, onUpdate, ctx);
					turnState.pendingAssistantReplies.length = 0;
					turnState.pendingNextQuestion = undefined;
				}
			}
			const correctionUser = isInterviewAlreadyAnsweredCorrection(latestUserText);
			const unavailableUser = isInterviewUnavailableCommand(latestUserText);
			const negativeUser = isInterviewNegativeAnswer(latestUserText);
			const unavailableAnswer = (params.action === "answer" || params.action === "skip") && unavailableUser;
			const negativeAnswer = (params.action === "answer" || params.action === "skip") && negativeUser;
			let pendingFollowupQuestion: string | undefined;
			if (unavailableAnswer || negativeAnswer) {
				// A refusal/unknown answer to a child question closes only that child.
				// The model often omits unavailable_subquestions, so resolve the
				// current pending kind at the host boundary before writing anything.
				const statusResult = await executeAction(pi, "chapter-interview", {
					chapter: params.chapter,
					interviewAction: "status",
				}, signal, onUpdate, ctx);
				const stdout = typeof statusResult.details?.stdout === "string" ? statusResult.details.stdout : "";
				try {
					const payload = JSON.parse(stdout) as Record<string, unknown>;
					if (payload.pending_kind === "followup" && typeof payload.pending_question === "string") {
						pendingFollowupQuestion = payload.pending_question.trim() || undefined;
					}
				} catch {
					// Let the normal action path report a useful bridge error if the
					// status payload cannot be read.
				}
			}
			// If the model tries to open a new main question while the user's
			// latest message is a clear negative answer, close the existing pending
			// question first. This prevents a failed ask from becoming the newest
			// prompt and then blocking the real answer in the turn guard.
			if ((params.action === "ask" || params.action === "followup")
				&& (isInterviewNegativeAnswer(latestUserText) || isInterviewUnavailableCommand(latestUserText))) {
				const statusResult = await executeAction(pi, "chapter-interview", {
					chapter: params.chapter,
					interviewAction: "status",
				}, signal, onUpdate, ctx);
				const stdout = typeof statusResult.details?.stdout === "string" ? statusResult.details.stdout : "";
				try {
					const payload = JSON.parse(stdout) as Record<string, unknown>;
					if (typeof payload.pending_question === "string" && payload.pending_question.trim()) {
						const answerBase64 = Buffer.from(latestUserText ?? "", "utf8").toString("base64");
						const answerResult = await executeAction(pi, "chapter-interview", {
							chapter: params.chapter,
							textBase64: answerBase64,
							remainingSubquestions: [],
							unavailableSubquestions: payload.pending_kind === "followup"
								? [payload.pending_question.trim()]
								: [],
							interviewAction: "answer",
						}, signal, onUpdate, ctx);
						turnState.interviewStatusCallsSinceMutation = 0;
						return answerResult;
					}
				} catch {
					// Fall through to the requested ask when status cannot be read.
				}
			}
			// “继续” is a UI/flow command.  It commonly arrives after a tool
			// result was collapsed or failed to render, so never record it as a
			// biography answer and never turn it into an implicit skip.  Re-read
			// status and let the pending question be shown as an ordinary reply.
			if (isInterviewContinueCommand(latestUserText) && !turnState.pendingNextQuestion
				&& turnState.resumedContinueText !== latestUserText) {
				turnState.resumedContinueText = latestUserText;
				const statusResult = await executeAction(pi, "chapter-interview", {
					chapter: params.chapter,
					interviewAction: "status",
				}, signal, onUpdate, ctx);
				const routed = await handleChoiceOrRecall(parseWorkflowPayload(String(statusResult.details?.stdout ?? "")));
				if (routed) return routed;
				return prepareStatusReply(statusResult, params.chapter, ctx.sessionManager, "好的，我们继续。您想到多少说多少：");
			}
			if (isInterviewContinueCommand(latestUserText) && !turnState.pendingNextQuestion && params.action === "ask") {
				const statusResult = await executeAction(pi, "chapter-interview", {
					chapter: params.chapter,
					interviewAction: "status",
				}, signal, onUpdate, ctx);
				const routed = await handleChoiceOrRecall(parseWorkflowPayload(String(statusResult.details?.stdout ?? "")));
				if (routed) return routed;
				return prepareStatusReply(statusResult, params.chapter, ctx.sessionManager, "好的，我们继续。您想到多少说多少：");
			}
			if (isInterviewContinueCommand(latestUserText) && !turnState.pendingNextQuestion
				&& turnState.resumedContinueText === latestUserText && (params.action as string) !== "status") {
				const statusResult = await executeAction(pi, "chapter-interview", {
					chapter: params.chapter,
					interviewAction: "status",
				}, signal, onUpdate, ctx);
				const routed = await handleChoiceOrRecall(parseWorkflowPayload(String(statusResult.details?.stdout ?? "")));
				if (routed) return routed;
				return prepareStatusReply(statusResult, params.chapter, ctx.sessionManager, "好的，我们继续。您想到多少说多少：");
			}

			if (params.action === "ask" || params.action === "followup") {
				// The controller sometimes tries to open a new topic before recording
				// the user's answer to the still-pending question. Resolve this as a
				// recoverable ordering issue, not a failed/red ask or a guessed answer.
				const statusResult = await executeAction(pi, "chapter-interview", {
					chapter: params.chapter,
					interviewAction: "status",
				}, signal, onUpdate, ctx);
				const stdout = typeof statusResult.details?.stdout === "string" ? statusResult.details.stdout : "";
				let statusPayload: Record<string, unknown> | undefined;
				try { statusPayload = JSON.parse(stdout) as Record<string, unknown>; } catch { /* Let the normal tool path report a malformed status. */ }
				const routed = await handleChoiceOrRecall(statusPayload);
				if (routed) return routed;
				if (statusPayload?.recommended_next_action === "resume_chapter_workflow") {
					return resumeChapterResult(statusResult, params.chapter);
				}
				if (statusPayload?.recommended_next_action === "wait_for_resume"
					|| statusPayload?.recommended_next_action === "confirm_early_write") {
					return prepareStatusReply(statusResult, params.chapter, ctx.sessionManager);
				}
				if (statusPayload?.choice_required === true) {
					return prepareStatusReply(statusResult, params.chapter, ctx.sessionManager);
				}
				if (statusPayload?.recommended_next_action === "stop_structured_interview") {
					return prepareStatusReply(statusResult, params.chapter, ctx.sessionManager);
				}
				if (statusPayload?.selected_mode === "free_recall" && !userChoice) {
					const reply = `第${params.chapter}章｜自由讲述\n\n您可以继续讲述想起的经历；如果想恢复按题采访，直接告诉我就好。`;
					queueAssistantReplyForAssistant(ctx.sessionManager, reply, params.chapter, "free_recall", "interview", true);
					return {
						...statusResult,
						content: [{ type: "text" as const, text: JSON.stringify({ status: "awaiting_free_recall", final_user_reply: reply }) }],
					};
				}
				const pendingQuestion = typeof statusPayload?.pending_question === "string"
					? statusPayload.pending_question.trim() : "";
				if (pendingQuestion) {
					preToolInterviewText.delete(ctx.sessionManager);
					if (isInterviewSkipCommand(latestUserText)) {
						return {
							...statusResult,
							content: [{ type: "text" as const, text: JSON.stringify({
								status: "prior_question_must_be_closed",
								pending_question: pendingQuestion,
								instruction: "用户要求跳过当前题。请先调用 action=skip 关闭它；本次新问题尚未登记。",
							}) }],
							details: { ...statusResult.details, interview_action: "defer_ask", deferred_question: params.question },
						};
					}
					let hasNewAnswer = false;
					try {
						assertInterviewUserMutation({
							action: "answer", chapter: params.chapter, answer: latestUserText,
							entries: ctx.sessionManager.getBranch(),
						});
						hasNewAnswer = true;
					} catch {
						// Without a new user answer, the existing pending question is
						// the only question that may be shown in this turn.
					}
					if (!hasNewAnswer) {
						return prepareStatusReply(statusResult, params.chapter, ctx.sessionManager);
					}
					return {
						...statusResult,
						content: [{ type: "text" as const, text: JSON.stringify({
							status: "answer_required_before_new_question",
							pending_question: pendingQuestion,
							pending_kind: statusPayload?.pending_kind,
							instruction: "刚收到的用户回答尚未登记。先调用 action=answer 并原样传入这条用户消息，核对原问题里仍未回答的小问；根据 answer 的结果再决定是否追问或开启新题。本次 ask/followup 未执行。",
						}) }],
						details: { ...statusResult.details, interview_action: "defer_ask", deferred_question: params.question },
					};
				}
			}

			// A literal skip/advance command is also handled as a flow operation,
			// rather than allowing the model to save the command as a short answer.
			// “忘了/不想回答” remains an answer: for a main question it records an
			// unavailable answer; for a child question the host supplies the exact
			// pending child so only that child is closed.
			const convertedTerminalSkip = params.action === "skip"
				&& (unavailableUser || negativeUser || correctionUser)
				&& !isInterviewSkipCommand(latestUserText);
			let terminalAnswer = correctionUser && (params.action === "answer" || params.action === "skip")
				? latestUserText
				: convertedTerminalSkip
				? latestUserText
				: params.answer || ((unavailableUser || negativeUser) ? latestUserText : undefined);
			const effectiveAction = convertedTerminalSkip
				? "answer"
				: params.action === "answer"
				&& isInterviewSkipCommand(terminalAnswer)
				? "skip"
				: params.action;
			const effectiveUnavailableSubquestions = pendingFollowupQuestion
				? Array.from(new Set([...(params.unavailable_subquestions ?? []), pendingFollowupQuestion]))
				: params.unavailable_subquestions;
			if (effectiveAction === "answer" || effectiveAction === "skip" || effectiveAction === "supplement") {
				const verifiedUserWords = assertInterviewUserMutation({
					action: effectiveAction,
					chapter: params.chapter,
					answer: terminalAnswer,
					entries: ctx.sessionManager.getBranch(),
				});
				if (verifiedUserWords !== undefined) terminalAnswer = verifiedUserWords;
			}
			const textBase64 = effectiveAction === "skip" ? undefined : terminalAnswer
				? Buffer.from(terminalAnswer, "utf8").toString("base64")
				: undefined;
			const focusedQuestion = interviewQuestionForAction(effectiveAction, params.question);
			const interviewResult = await executeAction(pi, "chapter-interview", {
				chapter: params.chapter,
				acknowledgement: params.acknowledgement,
				question: focusedQuestion,
				materialGoal: params.material_goal,
				remainingSubquestions: params.remaining_subquestions,
				unavailableSubquestions: effectiveUnavailableSubquestions,
				resolvedSubquestions: params.resolved_subquestions,
				textBase64,
				targetQuestionNumber: params.target_question_number,
				interviewAction: effectiveAction,
			}, signal, onUpdate, ctx);
			if (effectiveAction === "register"
				&& parseWorkflowPayload(String(interviewResult.details?.stdout ?? ""))?.already_registered === true) {
				return resumeChapterResult(interviewResult, params.chapter);
			}
			if ((effectiveAction === "answer" || effectiveAction === "supplement") && terminalAnswer) {
				currentTurnInterviewAnswer.set(ctx.sessionManager, terminalAnswer);
			}
			if (["ask", "followup", "answer", "skip", "supplement"].includes(effectiveAction)) {
				turnState.interviewStatusCallsSinceMutation = 0;
			}
			return interviewResult;
		},
	}));

}
