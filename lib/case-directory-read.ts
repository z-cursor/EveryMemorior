import fs from "node:fs";
import path from "node:path";

function isWithin(candidate: string, root: string): boolean {
	const value = candidate.toLowerCase();
	const boundary = root.toLowerCase();
	return value === boundary || value.startsWith(`${boundary}\\`);
}

/** Recover a real directory listing only inside the selected biography case. */
export function listSelectedCaseDirectory(requestedPath: string, caseRootWindows: string): string | undefined {
	if (!path.win32.isAbsolute(requestedPath) || !path.win32.isAbsolute(caseRootWindows)) return undefined;
	const caseRoot = path.win32.normalize(caseRootWindows);
	const casesRoot = path.win32.dirname(caseRoot);
	const target = path.win32.normalize(requestedPath);
	if (target.toLowerCase() !== casesRoot.toLowerCase() && !isWithin(target, caseRoot)) return undefined;
	try {
		const realCaseRoot = fs.realpathSync.native(caseRoot);
		const realCasesRoot = fs.realpathSync.native(casesRoot);
		const realTarget = fs.realpathSync.native(target);
		if (target.toLowerCase() === casesRoot.toLowerCase()) {
			if (realTarget.toLowerCase() !== realCasesRoot.toLowerCase()) return undefined;
		} else if (!isWithin(realTarget, realCaseRoot)) {
			return undefined;
		}
		if (!fs.statSync(realTarget).isDirectory()) return undefined;
		const entries = fs.readdirSync(realTarget, { withFileTypes: true });
		const shown = entries.slice(0, 100).map((entry) =>
			`${entry.isDirectory() ? "[目录]" : "[文件]"} ${JSON.stringify(entry.name)}`,
		);
		const suffix = entries.length > shown.length ? `\n另有 ${entries.length - shown.length} 项未显示。` : "";
		return `这是目录，已列出实际内容（未读取文件正文）：${target}\n${shown.join("\n") || "（空目录）"}${suffix}`;
	} catch {
		// Preserve the built-in read error if the path disappeared or is inaccessible.
		return undefined;
	}
}
