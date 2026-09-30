/* eslint-disable @typescript-eslint/no-explicit-any */

import path from "node:path";

const CASE_ID_RE = /^case-\d{8}-\d{3}$/u;
const CASE_SELECTION_ACTIONS = new Set(["new", "switch"]);

export type SessionCaseSelection = {
	caseId: string;
	caseRootWindows?: string;
	caseRootWsl?: string;
};

function firstTextContent(content: unknown): string | undefined {
	if (!Array.isArray(content)) return undefined;
	for (const item of content) {
		if (item && typeof item === "object" && (item as any).type === "text" && typeof (item as any).text === "string") {
			return (item as any).text;
		}
	}
	return undefined;
}

/** Recover the last explicit case selection recorded in this Pi session. */
export function findSessionCaseSelection(entries: readonly unknown[]): SessionCaseSelection | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index] as any;
		const message = entry?.type === "message" ? entry.message : undefined;
		if (message?.role !== "toolResult" || message.toolName !== "biography_workflow" || message.isError) continue;
		if (message.details?.status !== "success" || !CASE_SELECTION_ACTIONS.has(message.details?.action)) continue;
		const text = firstTextContent(message.content);
		if (!text) continue;
		try {
			const payload = JSON.parse(text);
			const caseId = payload?.case_id;
			if (typeof caseId !== "string" || !CASE_ID_RE.test(caseId)) continue;
      const rawCaseRoot = typeof payload.case_root === "string" ? payload.case_root : undefined;
      const isWindowsCaseRoot = Boolean(rawCaseRoot
        && /^[A-Za-z]:[\\/]/u.test(rawCaseRoot)
        && rawCaseRoot.replace(/\//gu, "\\").toLowerCase().endsWith(`\\cases\\${caseId}`));
      const isPosixCaseRoot = Boolean(rawCaseRoot
        && path.posix.isAbsolute(rawCaseRoot)
        && rawCaseRoot.replace(/\\/gu, "/").toLowerCase().endsWith(`/cases/${caseId}`));
      // The native extension historically called this field
      // `caseRootWindows`. Docker-backed Pi Web sessions use the same value
      // for a validated POSIX workspace path; callers only need a safe path
      // to the selected case and the case id hint.
      const caseRootWindows = rawCaseRoot && (isWindowsCaseRoot || isPosixCaseRoot) ? rawCaseRoot : undefined;
      const expectedWsl = isWindowsCaseRoot && caseRootWindows
        ? `/mnt/${caseRootWindows[0].toLowerCase()}/${caseRootWindows.slice(3).replace(/\\/gu, "/")}`
        : undefined;
			const caseRootWsl = typeof payload.case_root_wsl === "string" &&
				payload.case_root_wsl === expectedWsl
				? payload.case_root_wsl : undefined;
			return { caseId, caseRootWindows, caseRootWsl };
		} catch {
			// Ignore malformed historical tool output and continue looking backward.
		}
	}
	return undefined;
}

export function findSessionCaseHint(entries: readonly unknown[]): string | undefined {
	return findSessionCaseSelection(entries)?.caseId;
}
