import { Text } from "@earendil-works/pi-tui";
import type { Theme, ThemeColor } from "../../../../modes/interactive/theme/theme.ts";
import type { ToolRenderResultOptions } from "../../types.ts";
import { formatGoalElapsedSeconds, formatTokensCompact, type GoalToolRenderDetails } from "./format.ts";
import { GOAL_STATUS_VALUES, type GoalStatus, type GoalToolSnapshot, isRecord } from "./types.ts";

const OBJECTIVE_PREVIEW_WIDTH = 120;
const COLLAPSED_OBJECTIVE_LINES = 2;
const CALL_OBJECTIVE_BUDGET = 80;
const CALL_REASON_BUDGET = 60;

interface ResultLike {
	content: ReadonlyArray<{ type: string; text?: string }>;
	details?: unknown;
}

export function renderGoalToolCall(toolName: string, args: unknown, theme: Theme): Text {
	const title = theme.fg("toolTitle", theme.bold(toolName));
	const params = isRecord(args) ? args : {};
	if (toolName === "create_goal" && typeof params.objective === "string") {
		const preview = objectiveCallPreview(params.objective);
		return new Text(preview === "" ? title : `${title} ${theme.fg("muted", preview)}`, 0, 0);
	}
	if (toolName === "update_goal" && typeof params.status === "string") {
		const statusColor: ThemeColor = params.status === "complete" ? "success" : "error";
		let line = `${title} ${theme.fg("muted", "→")} ${theme.fg(statusColor, params.status)}`;
		if (typeof params.reason === "string" && params.reason.trim().length > 0) {
			line += ` ${theme.fg("muted", `— ${shorten(params.reason.trim(), CALL_REASON_BUDGET)}`)}`;
		}
		return new Text(line, 0, 0);
	}
	return new Text(title, 0, 0);
}

export function renderGoalToolResult(result: ResultLike, options: ToolRenderResultOptions, theme: Theme): Text {
	const text = result.content.find((block) => block.type === "text")?.text ?? "";
	const details = resolveRenderDetails(result.details, text);
	if (details === undefined) return new Text(theme.fg("toolOutput", text), 0, 0);
	if (details.goal === null) {
		const lines = [theme.fg("dim", "No active goal is set.")];
		appendNotice(lines, details.notice, theme);
		return new Text(lines.join("\n"), 0, 0);
	}
	const lines = goalWidgetLines(details.goal, options.expanded, theme);
	appendNotice(lines, details.notice, theme);
	return new Text(lines.join("\n"), 0, 0);
}

function goalWidgetLines(goal: GoalToolSnapshot, expanded: boolean, theme: Theme): string[] {
	const status = theme.fg(statusColor(goal.status), theme.bold(`${statusGlyph(goal.status)} ${goal.status}`));
	const usage = ` • ${formatTokensCompact(goal.tokensUsed)} tokens • ${formatGoalElapsedSeconds(goal.timeUsedSeconds)}`;
	const lines = [`${status}${theme.fg("muted", usage)}`];

	const objectiveLines = goal.objective
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	if (expanded) {
		for (const line of objectiveLines) lines.push(theme.fg("toolOutput", `  ${line}`));
	} else {
		for (const line of objectiveLines.slice(0, COLLAPSED_OBJECTIVE_LINES)) {
			lines.push(theme.fg("toolOutput", `  ${shorten(line, OBJECTIVE_PREVIEW_WIDTH)}`));
		}
		const hidden = objectiveLines.length - COLLAPSED_OBJECTIVE_LINES;
		if (hidden > 0) lines.push(theme.fg("dim", `  … +${hidden} more lines`));
	}

	if (goal.blockedReason !== undefined && goal.blockedReason.length > 0) {
		lines.push(theme.fg("warning", `  ⚠ ${goal.blockedReason}`));
	}
	if (expanded) {
		const created = isoTimestamp(goal.createdAt);
		const updated = isoTimestamp(goal.updatedAt);
		lines.push(theme.fg("dim", `  created ${created} • updated ${updated}`));
	}
	return lines;
}

function appendNotice(lines: string[], notice: string | undefined, theme: Theme): void {
	if (notice !== undefined && notice.length > 0) lines.push(theme.fg("dim", `  ${notice}`));
}

function resolveRenderDetails(details: unknown, text: string): GoalToolRenderDetails | undefined {
	const direct = parseRenderDetails(details);
	if (direct !== undefined) return direct;
	const trimmed = text.trim();
	if (!trimmed.startsWith("{")) return undefined;
	try {
		return parseRenderDetails(JSON.parse(trimmed));
	} catch {
		return undefined;
	}
}

function parseRenderDetails(value: unknown): GoalToolRenderDetails | undefined {
	if (!isRecord(value) || !("goal" in value)) return undefined;
	const goal = value.goal;
	const notice = typeof value.notice === "string" ? value.notice : undefined;
	if (goal === null) return { goal: null, ...(notice === undefined ? {} : { notice }) };
	if (!isGoalSnapshotLike(goal)) return undefined;
	return { goal, ...(notice === undefined ? {} : { notice }) };
}

function isGoalSnapshotLike(value: unknown): value is GoalToolSnapshot {
	return (
		isRecord(value) &&
		typeof value.objective === "string" &&
		typeof value.status === "string" &&
		(GOAL_STATUS_VALUES as readonly string[]).includes(value.status) &&
		typeof value.tokensUsed === "number" &&
		typeof value.timeUsedSeconds === "number" &&
		typeof value.createdAt === "number" &&
		typeof value.updatedAt === "number"
	);
}

function statusGlyph(status: GoalStatus): string {
	switch (status) {
		case "active":
			return "●";
		case "paused":
			return "◌";
		case "blocked":
			return "■";
		case "complete":
			return "✓";
	}
}

function statusColor(status: GoalStatus): ThemeColor {
	switch (status) {
		case "active":
			return "accent";
		case "paused":
			return "muted";
		case "blocked":
			return "error";
		case "complete":
			return "success";
	}
}

function objectiveCallPreview(objective: string): string {
	const lines = objective
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	const first = lines[0] ?? "";
	if (first === "") return "";
	const truncated = shorten(first, CALL_OBJECTIVE_BUDGET);
	if (lines.length > 1 && truncated === first) return `${first}…`;
	return truncated;
}

function isoTimestamp(epochSeconds: number): string {
	return new Date(epochSeconds * 1000).toISOString();
}

function shorten(value: string, max: number): string {
	if (value.length <= max) return value;
	return `${value.slice(0, max - 1)}…`;
}
