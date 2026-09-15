/**
 * Presentation for the grep tool.
 *
 * Renderers live apart from the implementation so a process that only displays tool output does not
 * load the execution path or its typebox parameter schema. `grep.ts` spreads these into its
 * definition, so the tool's public shape is unchanged.
 */

import { Text } from "@earendil-works/pi-tui";
import { keyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../../extensions/types.ts";
import type { GrepEngineMatch } from "../grep/engine.ts";
import { displayPath } from "../grep/format.ts";
import type { GrepToolDetails } from "../grep.ts";
import { getTextOutput, invalidArgText, linkPath, renderToolPath, str } from "../render-utils.ts";
import { DEFAULT_MAX_BYTES, formatSize } from "../truncate.ts";

const COLLAPSED_LINE_BUDGET = 15;

type GrepCallArgs = {
	pattern?: unknown;
	path?: unknown;
	glob?: unknown;
	mode?: unknown;
	skip?: unknown;
};

function isV1Details(value: unknown): value is GrepToolDetails {
	if (!value || typeof value !== "object") return false;
	const details = value as GrepToolDetails;
	return details.version === 1 && Array.isArray(details.matches);
}

function formatCallPaths(path: unknown, theme: Theme, cwd: string): string {
	if (Array.isArray(path)) {
		if (path.length === 0 || path.some((entry) => typeof entry !== "string")) return invalidArgText(theme);
		return path.map((entry) => renderToolPath(entry, theme, cwd, { emptyFallback: "." })).join(", ");
	}
	return renderToolPath(str(path), theme, cwd, { emptyFallback: "." });
}

function formatCallGlobs(glob: unknown): string | undefined {
	if (glob === undefined) return undefined;
	const values = Array.isArray(glob) ? glob : [glob];
	const joined = values.filter((entry): entry is string => typeof entry === "string").join(",");
	return joined || undefined;
}

function formatGrepCall(args: GrepCallArgs | undefined, theme: Theme, cwd: string): string {
	const pattern = str(args?.pattern);
	const invalidArg = invalidArgText(theme);
	let text = `${theme.fg("toolTitle", theme.bold("grep"))} ${
		pattern === null ? invalidArg : theme.fg("accent", `/${pattern || ""}/`)
	}${theme.fg("toolOutput", " in ")}${formatCallPaths(args?.path, theme, cwd)}`;
	const glob = formatCallGlobs(args?.glob);
	if (glob) text += theme.fg("toolOutput", ` ${glob}`);
	if (typeof args?.mode === "string" && args.mode) text += theme.fg("toolOutput", ` ${args.mode}`);
	if (typeof args?.skip === "number") text += theme.fg("toolOutput", ` skip ${args.skip}`);
	return text;
}

function formatFileHeader(path: string, theme: Theme, cwd: string): string {
	return linkPath(theme.fg("accent", displayPath(path)), path, cwd);
}

function formatMatchRow(match: GrepEngineMatch, theme: Theme): string {
	const row = `${match.line}${match.isContext ? "-" : ":"} ${match.text}`;
	return match.isContext ? theme.fg("dim", row) : theme.fg("accent", row);
}

function truncationHeader(details: GrepToolDetails, theme: Theme): string | undefined {
	const warnings: string[] = [];
	if (details.totalLimitReached) warnings.push(`${details.matchCount} matches limit`);
	if (details.fileLimitReached) warnings.push("file page limit");
	if (details.perFileLimitReached) warnings.push("per-file limit");
	if (details.truncation?.truncated) {
		warnings.push(`${formatSize(details.truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
	}
	if (details.linesTruncated) warnings.push("some lines truncated");
	if (warnings.length === 0) return undefined;
	return theme.fg("warning", `truncated: ${warnings.join(", ")}`);
}

function footerLine(details: GrepToolDetails, theme: Theme): string {
	return theme.fg(
		"muted",
		`[grep: matches=${details.matchCount ?? "n/a"} files=${details.fileCount} nextSkip=${details.nextSkip ?? "none"}]`,
	);
}

function noMatchText(details: GrepToolDetails): string {
	if (details.status === "pageEnd") return `No more results (skip=${details.skip})`;
	if (details.status === "partial") return "No matches found in searched portion";
	return "No matches found";
}

function groupsFromDetails(details: GrepToolDetails): Array<{
	path: string;
	count: number | null;
	rows: GrepEngineMatch[];
}> {
	if (details.fileMatches.length > 0) {
		return details.fileMatches.map((file) => ({
			path: file.path,
			count: file.count,
			rows: details.matches.filter((match) => match.path === file.path),
		}));
	}
	const groups: Array<{ path: string; count: number | null; rows: GrepEngineMatch[] }> = [];
	for (const match of details.matches) {
		const last = groups[groups.length - 1];
		if (!last || last.path !== match.path) groups.push({ path: match.path, count: null, rows: [match] });
		else last.rows.push(match);
	}
	return groups;
}

function overflowHint(remaining: number, unit: string, theme: Theme): string {
	return `${theme.fg("muted", `... (${remaining} more ${unit},`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
}

function formatGroupedResult(
	details: GrepToolDetails,
	options: ToolRenderResultOptions,
	theme: Theme,
	cwd: string,
): string {
	const lines: string[] = [];
	const truncated = truncationHeader(details, theme);
	if (truncated) lines.push(truncated);

	const groups = groupsFromDetails(details);
	if (groups.length === 0) {
		lines.push(theme.fg("toolOutput", noMatchText(details)));
	} else {
		let hiddenGroups = 0;
		for (let index = 0; index < groups.length; index++) {
			const group = groups[index];
			const rows = options.expanded ? group.rows : group.rows.filter((row) => !row.isContext);
			const block: string[] = [];
			if (lines.length > 0) block.push("");
			if (rows.length === 0 && group.count !== null) {
				block.push(`${formatFileHeader(group.path, theme, cwd)}${theme.fg("toolOutput", `: ${group.count}`)}`);
			} else {
				block.push(formatFileHeader(group.path, theme, cwd));
				for (const row of rows) block.push(formatMatchRow(row, theme));
			}
			if (!options.expanded && lines.length > 0 && lines.length + block.length > COLLAPSED_LINE_BUDGET) {
				hiddenGroups = groups.length - index;
				break;
			}
			lines.push(...block);
		}
		if (hiddenGroups > 0) lines.push(overflowHint(hiddenGroups, hiddenGroups === 1 ? "file" : "files", theme));
	}

	lines.push(footerLine(details, theme));
	return `\n${lines.join("\n")}`;
}

function formatTextFallback(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	},
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
): string {
	const output = getTextOutput(result, showImages).trim();
	if (!output) return "";
	const lines = output.split("\n");
	const maxLines = options.expanded ? lines.length : COLLAPSED_LINE_BUDGET;
	const displayLines = lines.slice(0, maxLines);
	const remaining = lines.length - maxLines;
	let text = `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
	if (remaining > 0) {
		text += `\n${overflowHint(remaining, remaining === 1 ? "line" : "lines", theme)}`;
	}
	return text;
}

function formatGrepResult(
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: GrepToolDetails;
	},
	options: ToolRenderResultOptions,
	theme: Theme,
	showImages: boolean,
	cwd: string,
): string {
	if (isV1Details(result.details)) return formatGroupedResult(result.details, options, theme, cwd);
	return formatTextFallback(result, options, theme, showImages);
}

export const grepRenderers: Pick<ToolDefinition<any, any>, "renderCall" | "renderResult"> = {
	renderCall(args, theme, context) {
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		text.setText(formatGrepCall(args as GrepCallArgs, theme, context.cwd));
		return text;
	},
	renderResult(result, options, theme, context) {
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		text.setText(formatGrepResult(result as any, options, theme, context.showImages, context.cwd));
		return text;
	},
};
