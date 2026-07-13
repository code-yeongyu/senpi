// allow: SIZE_OK — one eval render pipeline avoids the runtime/render TDZ that motivated this module boundary.
import {
	type AgentToolResult,
	highlightCode,
	sanitizeTerminalLabel,
	type Theme,
	type ThemeColor,
	type ToolDefinition,
	type ToolRenderResultOptions,
	truncateToVisualLines,
} from "@code-yeongyu/senpi";
import { formatTruncationWarning, stripOutputNotice, type TruncationMeta } from "../output/output-meta.ts";
import {
	JSON_TREE_MAX_DEPTH_COLLAPSED,
	JSON_TREE_MAX_DEPTH_EXPANDED,
	JSON_TREE_MAX_LINES_COLLAPSED,
	JSON_TREE_MAX_LINES_EXPANDED,
	JSON_TREE_SCALAR_LEN_COLLAPSED,
	JSON_TREE_SCALAR_LEN_EXPANDED,
	renderJsonTreeLines,
} from "./json-tree.ts";
import type {
	EvalCellResult,
	EvalInputSchema,
	EvalLanguage,
	EvalStatusEvent,
	EvalToolDetails,
	EvalToolInput,
} from "./types.ts";

type EvalToolDefinition = ToolDefinition<EvalInputSchema, EvalToolDetails>;
type RenderContext = Parameters<NonNullable<EvalToolDefinition["renderCall"]>>[2];
type ResultRenderContext = Parameters<NonNullable<EvalToolDefinition["renderResult"]>>[3];
type CollapsibleKind = "code" | "output";

export interface EvalRenderComponent {
	render(width: number): string[];
	invalidate(): void;
}
type ToolCallRow = {
	readonly summary: string;
	readonly error?: string;
	readonly color: "success" | "error";
};
type RenderBlock =
	| { readonly kind: "blank" }
	| {
			readonly kind: "text";
			readonly text: string;
			readonly maxVisualLines?: number;
			readonly collapseKind?: CollapsibleKind;
			readonly theme?: Theme;
	  }
	| {
			readonly kind: "toolCalls";
			readonly calls: readonly ToolCallRow[];
			readonly expanded: boolean;
			readonly theme?: Theme;
	  }
	| { readonly kind: "dynamic"; readonly render: (width: number) => readonly string[] };

const CODE_PREVIEW_LINES = 4;
const OUTPUT_PREVIEW_LINES = 8;
const STATUS_PREVIEW_COUNT = 3;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const TOOL_CALL_PREVIEW_COUNT = 5;
const TOOL_CALL_COLLAPSED_VISUAL_LINES = 4;
const TOOL_CALL_COLLAPSED_ERROR_CODE_POINTS = 512;
const TOOL_ERROR_OMISSION_MARKER = "[tool error omitted]";

class PlainTextComponent implements EvalRenderComponent {
	#blocks: readonly RenderBlock[] = [];

	setBlocks(blocks: readonly RenderBlock[]): void {
		this.#blocks = blocks;
	}

	render(width: number): string[] {
		const lines: string[] = [];
		for (const block of this.#blocks) {
			switch (block.kind) {
				case "blank":
					lines.push("");
					break;
				case "toolCalls":
					appendLines(lines, renderToolCallBlock(block, width));
					break;
				case "text":
					appendLines(lines, renderTextBlock(block, width));
					break;
				case "dynamic":
					appendLines(lines, block.render(width));
					break;
				default:
					assertNever(block);
			}
		}
		return lines;
	}

	invalidate(): void {}
}

function componentFor(context: RenderContext | ResultRenderContext): PlainTextComponent {
	const existing = context.lastComponent;
	if (existing instanceof PlainTextComponent) return existing;
	return new PlainTextComponent();
}

function style(theme: Theme | undefined, color: ThemeColor, text: string): string {
	return theme ? theme.fg(color, text) : text;
}

function appendLines(target: string[], source: readonly string[]): void {
	for (const line of source) target.push(line);
}

function codePointPrefix(text: string, maxCodePoints: number): string {
	let end = 0;
	for (let count = 0; count < maxCodePoints && end < text.length; count += 1) {
		const firstCodeUnit = text.charCodeAt(end);
		const secondCodeUnit = text.charCodeAt(end + 1);
		const isSurrogatePair =
			firstCodeUnit >= 0xd800 && firstCodeUnit <= 0xdbff && secondCodeUnit >= 0xdc00 && secondCodeUnit <= 0xdfff;
		end += isSurrogatePair ? 2 : 1;
	}
	return text.slice(0, end);
}

function renderAllVisualLines(text: string, width: number): string[] {
	return truncateToVisualLines(text, Number.POSITIVE_INFINITY, width).visualLines.map((line) => line.trimEnd());
}

function renderTextBlock(block: Extract<RenderBlock, { kind: "text" }>, width: number): string[] {
	if (block.maxVisualLines === undefined) return renderAllVisualLines(block.text, width);
	const result = truncateToVisualLines(block.text, block.maxVisualLines, width);
	const visualLines = result.visualLines.map((line) => line.trimEnd());
	if (result.skippedCount === 0 || block.collapseKind === undefined) return visualLines;
	return [
		...renderAllVisualLines(
			style(block.theme, "muted", `${result.skippedCount} earlier ${block.collapseKind} lines`),
			width,
		),
		...visualLines,
	];
}

function renderToolCall(
	call: ToolCallRow,
	block: Extract<RenderBlock, { kind: "toolCalls" }>,
	width: number,
): string[] {
	if (call.error === undefined) return renderAllVisualLines(style(block.theme, call.color, call.summary), width);
	if (block.expanded)
		return renderAllVisualLines(style(block.theme, call.color, `${call.summary} (${call.error})`), width);

	const guardedError = codePointPrefix(call.error, TOOL_CALL_COLLAPSED_ERROR_CODE_POINTS);
	const guardedLines = renderAllVisualLines(
		style(block.theme, call.color, `${call.summary} (${guardedError})`),
		width,
	);
	if (guardedError.length === call.error.length && guardedLines.length <= TOOL_CALL_COLLAPSED_VISUAL_LINES)
		return guardedLines;

	const summaryLines = renderAllVisualLines(style(block.theme, call.color, call.summary), width);
	const errorLines = renderAllVisualLines(style(block.theme, call.color, `  (${guardedError})`), width);
	const markerLines = renderAllVisualLines(style(block.theme, "muted", TOOL_ERROR_OMISSION_MARKER), width);
	const lines: string[] = [];
	const summaryBudget = Math.max(1, TOOL_CALL_COLLAPSED_VISUAL_LINES - markerLines.length);
	appendLines(lines, summaryLines.slice(0, summaryBudget));
	const errorBudget = Math.max(0, TOOL_CALL_COLLAPSED_VISUAL_LINES - lines.length - markerLines.length);
	appendLines(lines, errorLines.slice(0, errorBudget));
	appendLines(lines, markerLines.slice(0, TOOL_CALL_COLLAPSED_VISUAL_LINES - lines.length));
	return lines;
}

function renderToolCallBlock(block: Extract<RenderBlock, { kind: "toolCalls" }>, width: number): string[] {
	const retainedCalls = block.expanded ? block.calls : block.calls.slice(-TOOL_CALL_PREVIEW_COUNT);
	const skippedCount = block.calls.length - retainedCalls.length;
	const toolCallNoun = skippedCount === 1 ? "call" : "calls";
	const lines =
		block.expanded || skippedCount === 0
			? []
			: renderAllVisualLines(style(block.theme, "muted", `${skippedCount} earlier tool ${toolCallNoun}`), width);
	for (const call of retainedCalls) {
		appendLines(lines, renderToolCall(call, block, width));
	}
	return lines;
}

type CellStatus = EvalCellResult["status"];
type AgentStatus = "pending" | "running" | "completed" | "failed" | "aborted";
type StatusPresentation = { readonly label: string; readonly icon: string; readonly color: ThemeColor };
type RenderEnvironment = {
	readonly expanded: boolean;
	readonly theme: Theme | undefined;
	readonly spinnerFrame: number | undefined;
	readonly width: number;
	readonly meta: TruncationMeta | undefined;
};
type CellBadges = { readonly reset: boolean; readonly timeout: number | undefined };
type PrefixStyle = { readonly prefix: string; readonly continuation: string; readonly color: ThemeColor };
type DetailedRenderContext = {
	readonly environment: RenderEnvironment;
	readonly args: EvalToolInput;
	readonly showImageFallback: boolean;
};

function assertNever(value: never): never {
	throw new TypeError(`Unhandled eval render variant: ${String(value)}`);
}

function languageForHighlighter(language: EvalLanguage): "python" | "javascript" | "ruby" | "julia" {
	switch (language) {
		case "py":
			return "python";
		case "js":
			return "javascript";
		case "rb":
			return "ruby";
		case "jl":
			return "julia";
		default:
			return assertNever(language);
	}
}

function highlightedCode(code: string, language: EvalLanguage, theme: Theme | undefined): string {
	const normalizedCode = code.trim().length > 0 ? code : "...";
	const lines = highlightCode(normalizedCode, languageForHighlighter(language));
	return (theme === undefined ? lines.map((line) => line.replace(/\u001b\[[0-9;]*m/gu, "")) : lines).join("\n");
}

function formatDuration(milliseconds: number): string {
	const totalSeconds = Math.floor(Math.max(0, milliseconds) / 1_000);
	if (totalSeconds < 1) return "<1s";
	const seconds = totalSeconds % 60;
	const totalMinutes = Math.floor(totalSeconds / 60);
	if (totalMinutes < 1) return `${seconds}s`;
	const minutes = totalMinutes % 60;
	const hours = Math.floor(totalMinutes / 60);
	if (hours < 1) return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
	return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

function spinner(frame: number | undefined): string {
	return SPINNER_FRAMES.at((frame ?? 0) % SPINNER_FRAMES.length) ?? SPINNER_FRAMES[0];
}

function cellPresentation(status: CellStatus, spinnerFrame: number | undefined): StatusPresentation {
	switch (status) {
		case "pending":
			return { label: "pending", icon: "○", color: "muted" };
		case "running":
			return { label: "running", icon: spinner(spinnerFrame), color: "warning" };
		case "complete":
			return { label: "done", icon: "✓", color: "success" };
		case "error":
			return { label: "error", icon: "✗", color: "error" };
		default:
			return assertNever(status);
	}
}

function renderPrefixed(text: string, environment: RenderEnvironment, prefixStyle: PrefixStyle): string[] {
	const bodyLines = renderAllVisualLines(text, Math.max(1, environment.width - prefixStyle.prefix.length));
	if (bodyLines.length === 0) return [style(environment.theme, prefixStyle.color, prefixStyle.prefix.trimEnd())];
	return bodyLines.map(
		(line, index) =>
			`${style(environment.theme, prefixStyle.color, index === 0 ? prefixStyle.prefix : prefixStyle.continuation)}${line}`,
	);
}

function cellHeader(cell: EvalCellResult, environment: RenderEnvironment, badges: CellBadges): string {
	const presentation = cellPresentation(cell.status, environment.spinnerFrame);
	const title = cell.title === undefined ? "" : ` ${cell.title}`;
	let header = `eval ${cell.language}${title} ${presentation.label} ${presentation.icon}`;
	if (cell.durationMs !== undefined) header += ` · ${formatDuration(cell.durationMs)}`;
	if (badges.reset) header += " · reset";
	if (badges.timeout !== undefined) header += ` · timeout ${badges.timeout}s`;
	return style(environment.theme, presentation.color, header);
}

function previewText(
	text: string,
	maxLines: number,
	width: number,
): { readonly lines: string[]; readonly skipped: number } {
	const preview = truncateToVisualLines(text, maxLines, Math.max(1, width));
	return { lines: preview.visualLines.map((line) => line.trimEnd()), skipped: preview.skippedCount };
}

function eventString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function eventNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function plural(count: number, singular: string, pluralNoun: string): string {
	return `${count} ${count === 1 ? singular : pluralNoun}`;
}

function statusIcon(op: string): string {
	if (op.startsWith("git_")) return "⌁";
	switch (op) {
		case "read":
		case "write":
		case "cat":
		case "touch":
			return "▣";
		case "ls":
		case "cd":
		case "pwd":
		case "mkdir":
			return "▤";
		case "run":
		case "sh":
			return "▶";
		case "completion":
			return "◇";
		case "phase":
			return "◆";
		default:
			return "•";
	}
}

function formatStatusEvent(event: EvalStatusEvent, theme: Theme | undefined): string {
	const op = event.op;
	const icon = style(theme, "muted", statusIcon(op));
	const error = eventString(event["error"]);
	if (error !== undefined) return `${icon} ${style(theme, "warning", op)}: ${style(theme, "dim", error)}`;
	const parts: string[] = [];
	switch (op) {
		case "read": {
			parts.push(`${eventNumber(event["chars"] ?? event["bytes"])} chars`);
			const path = eventString(event["path"]);
			if (path !== undefined) parts.push(`from ${path}`);
			break;
		}
		case "write": {
			parts.push(`${eventNumber(event["chars"] ?? event["bytes"])} chars`);
			const path = eventString(event["path"]);
			if (path !== undefined) parts.push(`to ${path}`);
			break;
		}
		case "cat":
			parts.push(plural(eventNumber(event["files"]), "file", "files"));
			parts.push(`${eventNumber(event["chars"])} chars`);
			break;
		case "ls":
			parts.push(plural(eventNumber(event["count"]), "entry", "entries"));
			break;
		case "env": {
			const action = eventString(event["action"]);
			const key = eventString(event["key"]);
			const value = eventString(event["value"]) ?? "";
			if (action === "set" && key !== undefined) parts.push(`set ${key}=${value.slice(0, 30)}`);
			else if (action === "get" && key !== undefined) parts.push(`${key}=${value.slice(0, 30)}`);
			else parts.push(plural(eventNumber(event["count"]), "variable", "variables"));
			break;
		}
		case "git_status": {
			if (event["clean"] === true) parts.push("clean");
			else {
				const changes: string[] = [];
				for (const key of ["staged", "modified", "untracked"] as const) {
					const count = eventNumber(event[key]);
					if (count > 0) changes.push(`${count} ${key}`);
				}
				parts.push(changes.join(", ") || "unknown");
			}
			const branch = eventString(event["branch"]);
			if (branch !== undefined) parts.push(`on ${branch}`);
			break;
		}
		case "git_diff":
			parts.push(plural(eventNumber(event["lines"]), "line", "lines"));
			if (event["staged"] === true) parts.push("staged");
			break;
		case "git_log":
			parts.push(plural(eventNumber(event["commits"]), "commit", "commits"));
			break;
		case "run":
		case "sh": {
			const command = eventString(event["command"] ?? event["cmd"]);
			if (command !== undefined) parts.push(command);
			if (typeof event["exitCode"] === "number") parts.push(`exit ${event["exitCode"]}`);
			break;
		}
		case "completion": {
			const model = eventString(event["model"]);
			const tier = eventString(event["tier"]);
			if (model !== undefined) parts.push(model);
			if (tier !== undefined && tier !== model) parts.push(tier);
			parts.push(`${eventNumber(event["chars"])} chars`);
			break;
		}
		case "log":
			parts.push(eventString(event["message"]) ?? "");
			break;
		case "phase":
			parts.push(eventString(event["title"]) ?? "");
			break;
		default: {
			if (event["count"] !== undefined) parts.push(String(event["count"]));
			const path = eventString(event["path"]);
			if (path !== undefined) parts.push(path);
		}
	}
	const description = parts.filter((part) => part.length > 0).join(" · ");
	return `${icon} ${style(theme, "muted", op)}${description.length > 0 ? ` ${style(theme, "dim", description)}` : ""}`;
}

function renderStatusEvents(events: readonly EvalStatusEvent[], environment: RenderEnvironment): string[] {
	const retained = environment.expanded ? events : events.slice(-STATUS_PREVIEW_COUNT);
	const skipped = events.length - retained.length;
	const lines: string[] = [];
	if (skipped > 0) lines.push(style(environment.theme, "dim", `├ … ${skipped} earlier status events`));
	for (const [index, event] of retained.entries()) {
		const branch = index === retained.length - 1 ? "└" : "├";
		lines.push(`${style(environment.theme, "dim", branch)} ${formatStatusEvent(event, environment.theme)}`);
	}
	return lines;
}

function agentStatus(value: unknown): AgentStatus {
	switch (value) {
		case "pending":
		case "running":
		case "completed":
		case "failed":
		case "aborted":
			return value;
		default:
			return "running";
	}
}

function coalesceAgentEvents(events: readonly EvalStatusEvent[]): EvalStatusEvent[] {
	const rows: EvalStatusEvent[] = [];
	const indexes = new Map<string, number>();
	for (const event of events) {
		const id = eventString(event["id"]);
		if (id === undefined) {
			rows.push(event);
			continue;
		}
		const index = indexes.get(id);
		if (index === undefined) {
			indexes.set(id, rows.length);
			rows.push(event);
		} else rows[index] = event;
	}
	return rows;
}

function agentPresentation(status: AgentStatus, spinnerFrame: number | undefined): StatusPresentation {
	switch (status) {
		case "pending":
			return { label: "pending", icon: "○", color: "muted" };
		case "running":
			return { label: "running", icon: spinner(spinnerFrame), color: "warning" };
		case "completed":
			return { label: "done", icon: "✓", color: "success" };
		case "failed":
			return { label: "failed", icon: "✗", color: "error" };
		case "aborted":
			return { label: "aborted", icon: "×", color: "error" };
		default:
			return assertNever(status);
	}
}

function renderAgentProgressEvents(events: readonly EvalStatusEvent[], environment: RenderEnvironment): string[] {
	const rows = coalesceAgentEvents(events);
	const lines: string[] = [];
	// Senpi Theme has no tree-token API; fixed ├/└/│ glyphs intentionally mirror omp.
	for (const [index, event] of rows.entries()) {
		const isLast = index === rows.length - 1;
		const status = agentStatus(event["status"]);
		const presentation = agentPresentation(status, environment.spinnerFrame);
		const id = eventString(event["id"]) ?? "agent";
		const styledId = environment.theme === undefined ? id : environment.theme.bold(id);
		let body = `${style(environment.theme, presentation.color, presentation.icon)} ${styledId} ${presentation.label}`;
		if (status === "completed" || status === "failed" || status === "aborted") {
			const duration = eventNumber(event["durationMs"]);
			if (duration > 0) body += ` · ${style(environment.theme, "dim", formatDuration(duration))}`;
		}
		const branch = isLast ? "└ " : "├ ";
		const continuation = isLast ? "  " : "│ ";
		appendLines(
			lines,
			renderPrefixed(body, environment, { prefix: branch, continuation: continuation, color: "dim" }),
		);
		if (status !== "running") continue;
		const currentTool = eventString(event["currentTool"]);
		const lastIntent = eventString(event["lastIntent"]);
		if (currentTool === undefined && lastIntent === undefined) continue;
		const detail =
			currentTool === undefined
				? (lastIntent ?? "")
				: `${currentTool}${lastIntent === undefined ? "" : `: ${lastIntent}`}`;
		appendLines(
			lines,
			renderPrefixed(detail, environment, {
				prefix: `${continuation}└ `,
				continuation: `${continuation}  `,
				color: "dim",
			}),
		);
	}
	return lines;
}

function renderCell(cell: EvalCellResult, environment: RenderEnvironment, badges: CellBadges): string[] {
	const lines = renderPrefixed(cellHeader(cell, environment, badges), environment, {
		prefix: "╭─ ",
		continuation: "│  ",
		color: "borderAccent",
	});
	const innerWidth = Math.max(1, environment.width - 2);
	const codePreview = previewText(
		highlightedCode(cell.code, cell.language, environment.theme),
		environment.expanded ? Number.POSITIVE_INFINITY : CODE_PREVIEW_LINES,
		innerWidth,
	);
	if (codePreview.skipped > 0) {
		appendLines(
			lines,
			renderPrefixed(`${codePreview.skipped} earlier code lines`, environment, {
				prefix: "│ ",
				continuation: "│ ",
				color: "muted",
			}),
		);
	}
	for (const line of codePreview.lines) {
		appendLines(lines, renderPrefixed(line, environment, { prefix: "│ ", continuation: "│ ", color: "borderMuted" }));
	}
	const output = stripOutputNotice(cell.output, environment.meta).trimEnd();
	if (output.length > 0) {
		appendLines(lines, renderPrefixed("output", environment, { prefix: "├─ ", continuation: "│  ", color: "dim" }));
		const outputColor: ThemeColor = cell.status === "error" ? "error" : "toolOutput";
		const styledOutput = output
			.split("\n")
			.map((line) => style(environment.theme, outputColor, line))
			.join("\n");
		const outputPreview = previewText(
			styledOutput,
			environment.expanded ? Number.POSITIVE_INFINITY : OUTPUT_PREVIEW_LINES,
			innerWidth,
		);
		if (outputPreview.skipped > 0) {
			appendLines(
				lines,
				renderPrefixed(`${outputPreview.skipped} earlier output lines`, environment, {
					prefix: "│ ",
					continuation: "│ ",
					color: "muted",
				}),
			);
		}
		for (const line of outputPreview.lines) {
			appendLines(
				lines,
				renderPrefixed(line, environment, { prefix: "│ ", continuation: "│ ", color: "borderMuted" }),
			);
		}
	}
	const allEvents = cell.statusEvents ?? [];
	const statusEvents = allEvents.filter((event) => event.op !== "agent");
	if (statusEvents.length > 0) {
		appendLines(lines, renderPrefixed("status", environment, { prefix: "├─ ", continuation: "│  ", color: "dim" }));
		for (const line of renderStatusEvents(statusEvents, environment)) {
			appendLines(
				lines,
				renderPrefixed(line, environment, { prefix: "│ ", continuation: "│ ", color: "borderMuted" }),
			);
		}
	}
	lines.push(style(environment.theme, "borderMuted", "╰─"));
	const agentEvents = allEvents.filter((event) => event.op === "agent");
	if (agentEvents.length > 0) appendLines(lines, renderAgentProgressEvents(agentEvents, environment));
	return lines;
}

function renderJsonOutputs(values: readonly unknown[], environment: RenderEnvironment): string[] {
	const lines: string[] = [];
	const depth = environment.expanded ? JSON_TREE_MAX_DEPTH_EXPANDED : JSON_TREE_MAX_DEPTH_COLLAPSED;
	const lineCap = environment.expanded ? JSON_TREE_MAX_LINES_EXPANDED : JSON_TREE_MAX_LINES_COLLAPSED;
	const scalarLen = environment.expanded ? JSON_TREE_SCALAR_LEN_EXPANDED : JSON_TREE_SCALAR_LEN_COLLAPSED;
	for (const [index, value] of values.entries()) {
		appendLines(
			lines,
			renderAllVisualLines(style(environment.theme, "dim", `display[${index + 1}]`), environment.width),
		);
		const tree = renderJsonTreeLines(value, environment.theme, depth, lineCap, scalarLen);
		for (const line of tree.lines) appendLines(lines, renderAllVisualLines(line, environment.width));
		if (tree.truncated)
			appendLines(lines, renderAllVisualLines(style(environment.theme, "dim", "…"), environment.width));
	}
	return lines;
}

function renderDetailedLines(
	details: EvalToolDetails,
	result: AgentToolResult<EvalToolDetails>,
	context: DetailedRenderContext,
): string[] {
	const lines: string[] = [];
	const cells = details.cells ?? [];
	for (const [index, cell] of cells.entries()) {
		const badges = {
			reset: index === 0 && context.args.reset === true,
			timeout: index === 0 ? context.args.timeout : undefined,
		};
		appendLines(lines, renderCell(cell, context.environment, badges));
		if (index < cells.length - 1) lines.push("");
	}
	const jsonOutputs = details.jsonOutputs ?? [];
	if (jsonOutputs.length > 0) {
		if (lines.length > 0) lines.push("");
		appendLines(lines, renderJsonOutputs(jsonOutputs, context.environment));
	}
	if (context.showImageFallback) {
		for (const part of result.content) {
			if (part.type !== "image") continue;
			if (lines.length > 0) lines.push("");
			appendLines(
				lines,
				renderAllVisualLines(`[image: ${sanitizeTerminalLabel(part.mimeType)}]`, context.environment.width),
			);
		}
	}
	if (details.phase !== undefined)
		appendLines(
			lines,
			renderAllVisualLines(
				style(context.environment.theme, "muted", `phase ${details.phase}`),
				context.environment.width,
			),
		);
	if (details.notice !== undefined)
		appendLines(
			lines,
			renderAllVisualLines(style(context.environment.theme, "dim", details.notice), context.environment.width),
		);
	const warning = formatTruncationWarning(details.meta) ?? (details.truncated ? "[eval output truncated]" : null);
	if (warning !== null)
		appendLines(
			lines,
			renderAllVisualLines(style(context.environment.theme, "warning", warning), context.environment.width),
		);
	return lines;
}

function textOutput(result: AgentToolResult<EvalToolDetails>, showImageFallback: boolean): string {
	const lines: string[] = [];
	for (const part of result.content) {
		if (part.type === "text") lines.push(part.text);
		else if (showImageFallback && part.type === "image") {
			lines.push(`[image: ${sanitizeTerminalLabel(part.mimeType)}]`);
		}
	}
	return lines.join("\n");
}

function toolCallRows(details: EvalToolDetails | undefined): ToolCallRow[] {
	if (!details?.toolCalls || details.toolCalls.length === 0) return [];
	return details.toolCalls.map((call) => {
		const status = call.ok ? "ok" : "error";
		const row = { summary: `- tool.${call.name}: ${status}`, color: call.ok ? "success" : "error" } as const;
		return call.error === undefined ? row : { ...row, error: call.error };
	});
}

function resultStatus(
	details: EvalToolDetails | undefined,
	options: ToolRenderResultOptions,
	hostIsError: boolean,
): "running" | "done" | "error" {
	if (details?.isError || hostIsError) return "error";
	return options.isPartial ? "running" : "done";
}

function resultHeader(
	details: EvalToolDetails | undefined,
	status: "running" | "done" | "error",
	theme: Theme | undefined,
): string {
	const title = details?.title === undefined ? "" : ` ${details.title}`;
	let color: ThemeColor;
	switch (status) {
		case "running":
			color = "warning";
			break;
		case "done":
			color = "success";
			break;
		case "error":
			color = "error";
			break;
	}
	return style(theme, color, `eval ${details?.language ?? "?"}${title} ${status}`);
}

function resultMetadata(
	details: EvalToolDetails | undefined,
	options: ToolRenderResultOptions,
	theme: Theme | undefined,
): RenderBlock[] {
	const metadata: string[] = [];
	if (details?.phase) metadata.push(`phase ${details.phase}`);
	if (!options.isPartial && details) metadata.push(`took ${details.durationMs}ms`);
	if (metadata.length === 0) return [];
	return [{ kind: "text", text: style(theme, "muted", metadata.join(" | ")) }];
}

export function renderEvalCall(
	args: EvalToolInput,
	theme: Theme | undefined,
	context: RenderContext,
): EvalRenderComponent {
	const component = componentFor(context);
	if (theme === undefined && context.spinnerFrame === undefined) {
		const title = args.title === undefined ? "" : ` ${args.title}`;
		const reset = args.reset === true ? " reset" : "";
		const timeout = args.timeout === undefined ? "" : ` timeout ${args.timeout}s`;
		component.setBlocks([
			{ kind: "text", text: style(theme, "toolTitle", `eval ${args.language}${title}${reset}${timeout}`) },
			{
				kind: "text",
				text: style(theme, "mdCodeBlock", args.code.trim().length > 0 ? args.code : "..."),
				maxVisualLines: context.expanded ? undefined : CODE_PREVIEW_LINES,
				collapseKind: "code",
				theme,
			},
		]);
		return component;
	}
	component.setBlocks([
		{
			kind: "dynamic",
			render: (width) => {
				const environment: RenderEnvironment = {
					expanded: context.expanded,
					theme,
					spinnerFrame: context.spinnerFrame,
					width,
					meta: undefined,
				};
				const cell: EvalCellResult = {
					index: 0,
					...(args.title === undefined ? {} : { title: args.title }),
					code: args.code,
					language: args.language,
					output: "",
					status: context.spinnerFrame === undefined ? "pending" : "running",
				};
				return renderCell(cell, environment, { reset: args.reset === true, timeout: args.timeout });
			},
		},
	]);
	return component;
}

export function renderEvalResult(
	result: AgentToolResult<EvalToolDetails>,
	options: ToolRenderResultOptions,
	theme: Theme | undefined,
	context: ResultRenderContext,
): EvalRenderComponent {
	const component = componentFor(context);
	const details = result.details;
	const expanded = options.expanded || context.expanded;
	const imageProtocol = context.imageProtocol ?? null;
	if (details?.cells !== undefined && details.cells.length > 0) {
		const blocks: RenderBlock[] = [
			{
				kind: "dynamic",
				render: (width) =>
					renderDetailedLines(details, result, {
						environment: {
							expanded,
							theme,
							spinnerFrame: context.spinnerFrame,
							width,
							meta: details.meta,
						},
						args: context.args,
						showImageFallback: context.showImages && imageProtocol === null,
					}),
			},
		];
		const calls = toolCallRows(details);
		if (calls.length > 0) blocks.push({ kind: "blank" }, { kind: "toolCalls", calls, expanded, theme });
		component.setBlocks(blocks);
		return component;
	}
	const status = resultStatus(details, options, context.isError);
	const blocks: RenderBlock[] = [
		{ kind: "text", text: resultHeader(details, status, theme) },
		...resultMetadata(details, options, theme),
		{ kind: "blank" },
	];
	const rawOutput = textOutput(result, context.showImages && imageProtocol === null);
	const output = stripOutputNotice(rawOutput, details?.meta).trimEnd();
	const hasRenderedImage =
		context.showImages && imageProtocol !== null && result.content.some((part) => part.type === "image");
	if (output.length > 0) {
		blocks.push({
			kind: "text",
			text: style(theme, "toolOutput", output),
			maxVisualLines: expanded ? undefined : OUTPUT_PREVIEW_LINES,
			collapseKind: "output",
			theme,
		});
	} else if (!hasRenderedImage) blocks.push({ kind: "text", text: style(theme, "muted", "(no output)") });
	const statusEvents = details?.statusEvents ?? [];
	const nonAgentEvents = statusEvents.filter((event) => event.op !== "agent");
	const agentEvents = statusEvents.filter((event) => event.op === "agent");
	if (nonAgentEvents.length > 0 || agentEvents.length > 0) {
		blocks.push(
			{ kind: "blank" },
			{
				kind: "dynamic",
				render: (width) => {
					const environment: RenderEnvironment = {
						expanded,
						theme,
						spinnerFrame: context.spinnerFrame,
						width,
						meta: details?.meta,
					};
					return [
						...renderStatusEvents(nonAgentEvents, environment),
						...renderAgentProgressEvents(agentEvents, environment),
					];
				},
			},
		);
	}
	if ((details?.jsonOutputs?.length ?? 0) > 0) {
		blocks.push(
			{ kind: "blank" },
			{
				kind: "dynamic",
				render: (width) =>
					renderJsonOutputs(details?.jsonOutputs ?? [], {
						expanded,
						theme,
						spinnerFrame: context.spinnerFrame,
						width,
						meta: details?.meta,
					}),
			},
		);
	}
	const calls = toolCallRows(details);
	if (calls.length > 0) blocks.push({ kind: "blank" }, { kind: "toolCalls", calls, expanded, theme });
	if (details?.notice !== undefined)
		blocks.push({ kind: "blank" }, { kind: "text", text: style(theme, "dim", details.notice) });
	const warning = formatTruncationWarning(details?.meta) ?? (details?.truncated ? "[eval output truncated]" : null);
	if (warning !== null) blocks.push({ kind: "blank" }, { kind: "text", text: style(theme, "warning", warning) });
	component.setBlocks(blocks);
	return component;
}
