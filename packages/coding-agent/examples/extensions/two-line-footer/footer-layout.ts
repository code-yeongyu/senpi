import { stripVTControlCharacters } from "node:util";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export interface FooterText {
	readonly colored: string;
	readonly plain: string;
}

export interface FooterLine {
	readonly left: FooterText;
	readonly right: FooterText;
	readonly width: number;
}

export interface FooterTextTools {
	readonly measure: (text: string) => number;
	readonly truncate: (text: string, width: number, ellipsis: string) => string;
	readonly colorTruncatedLeft: (text: string) => string;
}

export interface FooterUsageTotals {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly latestCacheHitRate: number | undefined;
	readonly cost: number;
}

export interface FooterUsageSegment {
	readonly color: "dim" | "success";
	readonly text: string;
}

export interface FooterTopLeftSegment {
	readonly color: "accent" | "muted" | "success" | "warning";
	readonly text: string;
}

export interface FooterTopLeftInput {
	readonly path: string;
	readonly branch: string;
	readonly sessionName: string;
	readonly omoNative: boolean;
}

export interface FooterStatusGroups {
	readonly left: readonly string[];
	readonly right: readonly string[];
}

export interface FooterBottomLine {
	readonly left: string;
	readonly right: string;
}

export const FOOTER_SEPARATOR = " • ";

function trimOneDecimal(value: number): string {
	const formatted = value.toFixed(1);
	return formatted.endsWith(".0") ? formatted.slice(0, -2) : formatted;
}

export function sanitizeFooterLabel(value: string): string {
	return stripVTControlCharacters(value)
		.replace(/[\u0000-\u001f\u007f-\u009f]+/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
}

export function compactWorkingDirectory(cwd: string): string {
	const safeCwd = sanitizeFooterLabel(cwd);
	const parts = safeCwd.replaceAll("\\", "/").replace(/\/+$/, "").split("/").filter(Boolean);
	const pathSeparator = /^[A-Za-z]:[\\/]/.test(safeCwd) || safeCwd.includes("\\") ? "\\" : "/";
	const compactPath = parts.slice(-2).join(pathSeparator);

	return compactPath ? `[${compactPath}]` : "[]";
}

export function buildFooterTopLeftSegments(input: FooterTopLeftInput): readonly FooterTopLeftSegment[] {
	const segments: FooterTopLeftSegment[] = [];
	if (input.omoNative) {
		segments.push({ color: "success", text: "(🏴‍☠️ OmO Native)" });
	}
	segments.push({ color: "accent", text: input.path });
	if (input.branch) segments.push({ color: "warning", text: input.branch });
	if (input.sessionName) segments.push({ color: "muted", text: input.sessionName });
	return segments;
}

export function formatTokens(count: number): string {
	const rounded = Math.round(count);
	if (rounded < 1_000) return rounded.toString();
	if (rounded < 10_000) return `${trimOneDecimal(rounded / 1_000)}K`;
	if (rounded < 1_000_000) return `${Math.round(rounded / 1_000)}K`;
	if (rounded < 10_000_000) {
		return `${trimOneDecimal(rounded / 1_000_000)}M`;
	}
	if (rounded < 1_000_000_000) {
		return `${Math.round(rounded / 1_000_000)}M`;
	}
	if (rounded < 10_000_000_000) {
		return `${trimOneDecimal(rounded / 1_000_000_000)}B`;
	}
	return `${Math.round(rounded / 1_000_000_000)}B`;
}

export function buildFooterUsageSegments(
	usage: FooterUsageTotals,
	usingSubscription: boolean,
): readonly FooterUsageSegment[] {
	const segments: FooterUsageSegment[] = [];
	if (usage.input) {
		segments.push({ color: "dim", text: `↑${formatTokens(usage.input)}` });
	}
	if (usage.output) {
		segments.push({ color: "dim", text: `↓${formatTokens(usage.output)}` });
	}
	if (usage.cacheRead || usage.cacheWrite) {
		segments.push({
			color: "dim",
			text: `cache ${formatTokens(usage.cacheRead)}/${formatTokens(usage.cacheWrite)}`,
		});
	}
	if ((usage.cacheRead > 0 || usage.cacheWrite > 0) && usage.latestCacheHitRate !== undefined) {
		segments.push({
			color: "dim",
			text: `CH${usage.latestCacheHitRate.toFixed(1)}%`,
		});
	}
	if (usage.cost || usingSubscription) {
		segments.push({
			color: "success",
			text: `$${usage.cost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`,
		});
	}
	return segments;
}

export function fitFooterSegments(
	leadingSegments: readonly string[],
	statusSegments: readonly string[],
	maxWidth: number,
	measure: (text: string) => number = visibleWidth,
): string {
	const separator = FOOTER_SEPARATOR;
	const statusText = statusSegments.join(separator);
	if (!statusText) return leadingSegments.join(separator);

	const reservedWidth = measure(statusText);
	if (reservedWidth >= maxWidth) return statusText;

	const availableLeading = maxWidth - reservedWidth - measure(separator);
	const leadingText = leadingSegments.join(separator);
	if (!leadingText) return statusText;
	if (measure(leadingText) <= availableLeading) {
		return `${leadingText}${separator}${statusText}`;
	}

	const elided = `...${separator}${statusText}`;
	return measure(elided) <= maxWidth ? elided : statusText;
}

export function sortedFooterStatuses(statuses: ReadonlyMap<string, string>): FooterStatusGroups {
	const left: string[] = [];
	const right: string[] = [];
	for (const [key, text] of Array.from(statuses.entries()).sort(([leftKey], [rightKey]) =>
		leftKey.localeCompare(rightKey),
	)) {
		const target = key === "ext:nested-agents:status" ? left : right;
		target.push(sanitizeFooterLabel(text));
	}
	return { left, right };
}

export function planFooterBottomLine(
	usageSegments: readonly string[],
	contextText: string,
	statusSegments: readonly string[],
	maxRightWidth: number,
	measure: (text: string) => number = visibleWidth,
): FooterBottomLine {
	return {
		left: usageSegments.join(FOOTER_SEPARATOR),
		right: fitFooterSegments([contextText], statusSegments, maxRightWidth, measure),
	};
}

export function alignStyledFooterLine(line: FooterLine, tools: FooterTextTools): string {
	const rightWidth = tools.measure(line.right.plain);
	if (rightWidth >= line.width) {
		const renderedRight = tools.truncate(line.right.colored, line.width, "");
		const renderedWidth = tools.measure(renderedRight);
		return `${" ".repeat(Math.max(0, line.width - renderedWidth))}${renderedRight}`;
	}

	const minimumPadding = line.left.plain ? 2 : 0;
	const availableLeft = Math.max(0, line.width - rightWidth - minimumPadding);
	let renderedLeft = line.left.colored;
	let leftWidth = tools.measure(line.left.plain);

	if (leftWidth > availableLeft) {
		const truncatedLeft = tools.truncate(line.left.plain, availableLeft, "...");
		renderedLeft = tools.colorTruncatedLeft(truncatedLeft);
		leftWidth = tools.measure(truncatedLeft);
	}

	const padding = " ".repeat(Math.max(0, line.width - leftWidth - rightWidth));
	return `${renderedLeft}${padding}${line.right.colored}`;
}

export function alignFooterLine(left: string, right: string, width: number): string {
	return alignStyledFooterLine(
		{
			left: { colored: left, plain: left },
			right: { colored: right, plain: right },
			width,
		},
		{
			colorTruncatedLeft: (text) => text,
			measure: visibleWidth,
			truncate: (text, maxWidth, ellipsis) => truncateToWidth(text, maxWidth, ellipsis).replaceAll("\u001b[0m", ""),
		},
	);
}
