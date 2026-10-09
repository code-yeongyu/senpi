export function normalizePatchText(patchText: string): string {
	return patchText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function stripHeredoc(input: string): string {
	const heredocMatch = input.match(/^(?:cat\s+)?<<['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\s*$/);
	if (heredocMatch) {
		return heredocMatch[2] ?? input;
	}
	return input;
}

const FILE_HEADER_MARKERS = [
	["add", "*** Add File: "],
	["delete", "*** Delete File: "],
	["update", "*** Update File: "],
] as const;
const MOVE_TO_MARKER = "*** Move to: ";

export type FileHeader = { readonly kind: (typeof FILE_HEADER_MARKERS)[number][0]; readonly path: string };

// The parser and extractPatchedPaths both read headers through these two functions, so they share one
// whitespace definition (String.prototype.trim): every path the parser writes is a path the permission
// system's per-file approval sees, spelled the same way.
export function parseFileHeader(line: string): FileHeader | undefined {
	const trimmed = line.trim();
	for (const [kind, marker] of FILE_HEADER_MARKERS) {
		if (trimmed.startsWith(marker)) return { kind, path: trimmed.slice(marker.length) };
	}
	return undefined;
}

export function parseMoveTo(line: string): string | undefined {
	const trimmed = line.trimEnd();
	return trimmed.startsWith(MOVE_TO_MARKER) ? trimmed.slice(MOVE_TO_MARKER.length) : undefined;
}

export function extractPatchedPaths(patchText: string): string[] {
	const lines = stripHeredoc(normalizePatchText(patchText)).split("\n");
	return lines.flatMap((line) => {
		const path = parseFileHeader(line)?.path ?? parseMoveTo(line.trimStart());
		return path === undefined ? [] : [path];
	});
}
