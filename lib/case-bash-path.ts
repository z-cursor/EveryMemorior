/** Convert only current-case paths that were written in Windows/Git-Bash form. */
export function normalizeCaseBashPaths(command: string, caseRootWindows: string, caseRootWsl: string): string {
	const windowsRoot = caseRootWindows.replace(/\\/gu, "/").replace(/\/+$/u, "");
	const match = /^([a-z]):\/(.+)$/iu.exec(windowsRoot);
	if (!match) return command;
	const drive = match[1].toLowerCase();
	const wslRoot = caseRootWsl.replace(/\/+$/u, "");
	if (wslRoot.toLowerCase() !== `/mnt/${drive}/${match[2]}`.toLowerCase()) return command;

	const legacyRoot = `/${drive}/${match[2]}`;
	const rewriteSegment = (segment: string): string => {
		// Output-only shell commands can contain path-looking prose; leave them intact.
		if (/^\s*(?:echo|printf)\b/iu.test(segment)) return segment;
		const candidate = /(^|[\s"'=<>])([a-z]:\/[^\s"'<>|;&()]*|\/[a-z]\/[^\s"'<>|;&()]*)/giu;
		return segment.replace(candidate, (whole, boundary: string, path: string, offset: number) => {
			const isWindowsPath = path.slice(0, windowsRoot.length).toLowerCase() === windowsRoot.toLowerCase();
			const isLegacyPath = path.slice(0, legacyRoot.length).toLowerCase() === legacyRoot.toLowerCase();
			const rootLength = isWindowsPath ? windowsRoot.length : isLegacyPath ? legacyRoot.length : 0;
			if (!rootLength || (path.length > rootLength && path[rootLength] !== "/")) return whole;

			const pathStart = offset + boundary.length;
			const pathEnd = pathStart + path.length;
			let quote: "'" | '"' | undefined;
			let quoteStart = -1;
			for (let i = 0; i < pathStart; i += 1) {
				const char = segment[i];
				if (char === "\\" && quote !== "'" && i + 1 < pathStart) {
					i += 1;
					continue;
				}
				if (quote) {
					if (char === quote) quote = undefined;
				} else if (char === "'" || char === '"') {
					quote = char;
					quoteStart = i;
				}
			}
			if (quote) {
				// A quoted argument must consist of this one path, not a sentence or script.
				if (quoteStart !== pathStart - 1 || segment[pathEnd] !== quote) return whole;
				if (quoteStart > 0 && !/[\s=<>(]/u.test(segment[quoteStart - 1])) return whole;
			}
			return `${boundary}${wslRoot}${path.slice(rootLength)}`;
		});
	};

	// Split at shell command operators outside quotes, so `echo ...; ls ...` only
	// suppresses rewriting in the echo segment.
	let result = "";
	let start = 0;
	let quote: "'" | '"' | undefined;
	for (let i = 0; i < command.length; i += 1) {
		const char = command[i];
		if (char === "\\" && quote !== "'" && i + 1 < command.length) {
			i += 1;
			continue;
		}
		if (quote) {
			if (char === quote) quote = undefined;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (char === ";" || char === "|" || char === "&" || char === "\n") {
			result += rewriteSegment(command.slice(start, i)) + char;
			start = i + 1;
		}
	}
	return result + rewriteSegment(command.slice(start));
}
