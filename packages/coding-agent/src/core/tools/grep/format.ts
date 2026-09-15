import type { GrepToolDetails } from "./index.ts";

export function displayPath(path: string): string {
	return /[\x00-\x1f\x7f]/.test(path) ? JSON.stringify(path) : path;
}

/** now supplies the elapsed duration, allowing deterministic text in renderer tests. */
export function formatGrepText(
	result: GrepToolDetails,
	{ now = () => result.scan.elapsedMs }: { now?: () => number } = {},
): string {
	const blocks: string[] = [];
	if (result.matches.length) {
		for (const file of result.fileMatches) {
			const rows = result.matches.filter((match) => match.path === file.path);
			blocks.push(
				[displayPath(file.path), ...rows.map((row) => `${row.line}${row.isContext ? "-" : ":"} ${row.text}`)].join(
					"\n",
				),
			);
		}
	} else if (result.fileCount) {
		blocks.push(
			result.fileMatches
				.map((file) => (file.count === null ? displayPath(file.path) : `${displayPath(file.path)}: ${file.count}`))
				.join("\n"),
		);
	} else {
		blocks.push(
			result.status === "pageEnd"
				? `No more results (skip=${result.skip})`
				: result.status === "partial"
					? "No matches found in searched portion"
					: "No matches found",
		);
	}
	const notes: string[] = [];
	const scan = result.scan;
	if (scan.prefixSearched)
		notes.push(
			`Partial coverage: searched only the first 4 MiB of ${scan.prefixSearched} large file(s); later matches are omitted.`,
		);
	if (scan.skippedOversized) notes.push(`Skipped ${scan.skippedOversized} unreadable/unsearchable large file(s).`);
	if (scan.skippedBinary) notes.push(`Skipped ${scan.skippedBinary} binary file(s).`);
	if (scan.missingPaths.length)
		notes.push(`Skipped missing path(s): ${scan.missingPaths.map(displayPath).join(", ")}`);
	if (scan.timedOut)
		notes.push(
			scan.warnings.find((w) => w.code === "TIMED_OUT")?.message ??
				"Timed out after 30000 ms; showing the completed ordered prefix.",
		);
	if (scan.regexEngine === "pcre2")
		notes.push("Regex unsupported by the native engine; matched with ripgrep --pcre2.");
	if (scan.patternKind === "literal") notes.push(`Pattern searched literally: ${scan.effectivePattern}`);
	if (scan.patternKind === "sanitized") notes.push(`Pattern sanitized: ${scan.effectivePattern}`);
	notes.push(
		`[grep: matches=${result.matchCount ?? "n/a"} files=${result.fileCount} searched=${scan.filesSearched} elapsedMs=${Math.max(0, Math.round(now()))} engine=${result.engine} nextSkip=${result.nextSkip ?? "none"}]`,
	);
	return `${blocks.join("\n\n")}\n\n${notes.join("\n")}`;
}
