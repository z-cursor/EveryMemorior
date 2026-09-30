import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { resolveInterviewChoice } = await createJiti(import.meta.url, { moduleCache: false })
	.import("./biography-workflow-native.ts");

test("structured confirmation wins over natural-language choice inference", () => {
	assert.equal(resolveInterviewChoice("confirm_write", "继续写"), "confirm_write");
	assert.equal(resolveInterviewChoice("confirm_write", "结束本轮 开始写作"), "confirm_write");
});

test("natural-language choice remains the fallback when no structured choice is supplied", () => {
	assert.equal(resolveInterviewChoice(undefined, "1"), "write");
	assert.equal(resolveInterviewChoice(undefined, "继续采访"), "continue");
});

test("confirm_write reaches the bridge and registers after a persisted warning", async () => {
	const nativeExtension = await createJiti(import.meta.url, { moduleCache: false })
		.import("./biography-workflow-native.ts");
	const tools = [];
	const calls = [];
	const warning = {
		chapter: 1, completed_count: 12, pending_question: null, selected_mode: null,
		early_write_warning_pending: true, recommended_next_action: "confirm_early_write",
	};
	const selected = {
		...warning, selected_mode: "write", early_write_warning_pending: false,
		recommended_next_action: "register", registration_state: "missing",
	};
	const branch = [
		{ type: "message", message: { role: "user", content: "1" } },
		{ type: "message", message: { role: "toolResult", toolName: "biography_chapter_interviewer", details: { stdout: JSON.stringify(warning) } } },
		{ type: "message", message: { role: "user", content: "继续写" } },
	];
	const sessionManager = { getSessionId: () => "test-session", getBranch: () => branch };
	const pi = {
		on() {},
		registerTool(tool) { tools.push(tool); },
		async exec(_command, args) {
			calls.push(args);
			const valueAfter = (flag) => {
				const index = args.indexOf(flag);
				return index >= 0 ? args[index + 1] : undefined;
			};
			const action = valueAfter("--interview-action");
			const choice = valueAfter("--choice");
			const payload = action === "status" ? warning
				: action === "choice" && choice === "confirm_write" ? selected
				: selected;
			return { code: 0, killed: false, stdout: JSON.stringify(payload), stderr: "" };
		},
	};
	nativeExtension.default(pi);
	const interviewer = tools.find((tool) => tool.name === "biography_chapter_interviewer");
	const result = await interviewer.execute(
		"call", { action: "choice", chapter: 1, choice: "confirm_write" }, undefined, undefined,
		{ cwd: "/tmp", model: { provider: "test", id: "test" }, sessionManager },
	);
	assert.equal(JSON.parse(result.content[0].text).status, "registered_for_writing");
	assert.deepEqual(calls.map((args) => {
		const valueAfter = (flag) => {
			const index = args.indexOf(flag);
			return index >= 0 ? args[index + 1] : undefined;
		};
		return [valueAfter("--interview-action"), valueAfter("--choice")];
	}), [["status", undefined], ["choice", "confirm_write"], ["register", undefined]]);
});
