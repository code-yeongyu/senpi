import {
	createBashToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	sanitizeTerminalLabel,
	type Theme,
	type ThemeColor,
	type ToolDefinition,
	truncateToVisualLines,
} from "@code-yeongyu/senpi";
import type { TSchema } from "typebox";
import { Check } from "typebox/value";
import type { EvalToolCallSummary } from "./types.ts";

export interface WidgetOptions {
	readonly cwd: string;
	readonly theme: Theme | undefined;
	readonly expanded: boolean;
	readonly width: number;
}

type AnyToolDef<TParams extends TSchema, TDetails, TState> = ToolDefinition<TParams, TDetails, TState>;
type RenderCallOf<TParams extends TSchema, TDetails, TState> = NonNullable<
	AnyToolDef<TParams, TDetails, TState>["renderCall"]
>;
type ToolRenderContext<TParams extends TSchema, TDetails, TState> = Parameters<
	RenderCallOf<TParams, TDetails, TState>
>[2];
type Component<TParams extends TSchema, TDetails, TState> = ReturnType<RenderCallOf<TParams, TDetails, TState>>;

type CoreWidgetName = "bash" | "read" | "write" | "grep" | "find" | "ls";
type CoreWidgetRenderer = (summary: EvalToolCallSummary, options: WidgetOptions) => string[] | undefined;
type CoreWidgets = Readonly<Record<CoreWidgetName, CoreWidgetRenderer>>;

const MIN_RENDERER_WIDTH = 20;
const MAX_RENDERER_LINES = 5;
const MAX_FALLBACK_ARGUMENT_CODE_POINTS = 120;
const MAX_COLLAPSED_ERROR_CODE_POINTS = 512;
const MAX_COLLAPSED_ERROR_LINES = 4;
const MAX_PREVIEW_LINES = 2;
const MAX_COLLAPSED_WIDGET_LINES = 8;
const TOOL_ERROR_OMISSION_MARKER = "[tool error omitted]";
const WIDGET_TRUNCATION_MARKER = "… (widget truncated)";
const TERMINAL_ESCAPE_PATTERN =
	/(?:\u001B\][\s\S]*?(?:\u0007|\u001B\\|\u009C))|[\u001B\u009B][[\]()#;?]*(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]/g;
const TERMINAL_CONTROL_PATTERN = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]+/g;
const coreWidgetsByCwd = new Map<string, CoreWidgets>();

export function codePointPrefix(text: string, maxCodePoints: number): string {
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

export function formatDuration(milliseconds: number): string {
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

function style(theme: Theme | undefined, color: ThemeColor, text: string): string {
	return theme === undefined ? text : theme.fg(color, text);
}

function renderAllVisualLines(text: string, width: number): string[] {
	return truncateToVisualLines(text, Number.POSITIVE_INFINITY, width).visualLines.map((line) => line.trimEnd());
}

function renderFirstVisualLines(text: string, maxLines: number, width: number): string[] {
	const truncated = truncateToVisualLines(text, maxLines, width);
	if (truncated.skippedCount === 0) return truncated.visualLines.map((line) => line.trimEnd());
	return renderAllVisualLines(text, width).slice(0, maxLines);
}

function indent(lines: readonly string[]): string[] {
	return lines.map((line) => `  ${line}`);
}

function renderWith<TParams extends TSchema, TDetails, TState>(
	definition: ToolDefinition<TParams, TDetails, TState>,
	summary: EvalToolCallSummary,
	options: WidgetOptions,
	initialState: TState,
): string[] | undefined {
	let preparedArgs: unknown = summary.args;
	try {
		if (definition.prepareArguments !== undefined) preparedArgs = definition.prepareArguments(preparedArgs);
		if (!Check(definition.parameters, preparedArgs)) return undefined;
	} catch {
		return undefined;
	}

	const theme = options.theme;
	const innerWidth = options.width - 2;
	const renderCall = definition.renderCall;
	if (theme === undefined || innerWidth < MIN_RENDERER_WIDTH || renderCall === undefined) return undefined;

	const context: ToolRenderContext<TParams, TDetails, TState> = {
		args: preparedArgs,
		toolCallId: summary.callId ?? summary.name,
		invalidate: () => {},
		lastComponent: undefined,
		state: initialState,
		cwd: options.cwd,
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: options.expanded,
		showImages: false,
		isError: !summary.ok,
		hasResult: false,
	};

	try {
		const component: Component<TParams, TDetails, TState> = renderCall(preparedArgs, theme, context);
		const renderedLines = component.render(innerWidth).map((line) => line.trimEnd());
		const retainedLines = renderedLines.slice(0, MAX_RENDERER_LINES);
		if (renderedLines.length > retainedLines.length) {
			retainedLines.push(style(theme, "muted", WIDGET_TRUNCATION_MARKER));
		}
		return indent(retainedLines);
	} catch {
		return undefined;
	}
}

function grepDetailsSummary(summary: EvalToolCallSummary): string | undefined {
	const details = summary.details;
	if (details === undefined || details === null || typeof details !== "object") return undefined;
	const record = details as { matchCount?: unknown; fileCount?: unknown; engine?: unknown };
	if (typeof record.fileCount !== "number" || typeof record.engine !== "string") return undefined;
	if (record.matchCount !== null && typeof record.matchCount !== "number") return undefined;
	return `matches=${record.matchCount ?? "n/a"} files=${record.fileCount} (${record.engine})`;
}

function createCoreWidgets(cwd: string): CoreWidgets {
	const bashDefinition = createBashToolDefinition(cwd);
	const readDefinition = createReadToolDefinition(cwd);
	const writeDefinition = createWriteToolDefinition(cwd);
	const grepDefinition = createGrepToolDefinition(cwd);
	const findDefinition = createFindToolDefinition(cwd);
	const lsDefinition = createLsToolDefinition(cwd);
	const widgets: CoreWidgets = {
		bash: (summary, options) =>
			renderWith(bashDefinition, summary, options, {
				startedAt: undefined,
				endedAt: undefined,
				interval: undefined,
			}),
		read: (summary, options) => renderWith(readDefinition, summary, options, {}),
		write: (summary, options) => renderWith(writeDefinition, summary, options, {}),
		grep: (summary, options) => {
			const lines = renderWith(grepDefinition, summary, options, {});
			if (lines === undefined) return undefined;
			const extra = grepDetailsSummary(summary);
			if (extra !== undefined) lines.push(`  ${style(options.theme, "muted", extra)}`);
			return lines;
		},
		find: (summary, options) => renderWith(findDefinition, summary, options, {}),
		ls: (summary, options) => renderWith(lsDefinition, summary, options, {}),
	};
	return widgets;
}

function coreWidgetsFor(cwd: string): CoreWidgets {
	const cached = coreWidgetsByCwd.get(cwd);
	if (cached !== undefined) return cached;
	const widgets = createCoreWidgets(cwd);
	coreWidgetsByCwd.set(cwd, widgets);
	return widgets;
}

function isCoreWidgetName(name: string): name is CoreWidgetName {
	switch (name) {
		case "bash":
		case "read":
		case "write":
		case "grep":
		case "find":
		case "ls":
			return true;
		default:
			return false;
	}
}

function compactArguments(args: unknown): string {
	if (args === undefined) return "";
	try {
		const serialized = JSON.stringify(args);
		if (serialized === undefined) return "";
		return codePointPrefix(sanitizeTerminalLabel(serialized), MAX_FALLBACK_ARGUMENT_CODE_POINTS);
	} catch {
		return "[unserializable args]";
	}
}

function renderFallback(summary: EvalToolCallSummary, width: number): string[] {
	const name = sanitizeTerminalLabel(summary.name);
	const fallback = `tool.${name}(${compactArguments(summary.args)})`;
	return indent(renderAllVisualLines(fallback, width));
}

function renderStatus(summary: EvalToolCallSummary, options: WidgetOptions, width: number): string[] {
	const icon = style(options.theme, summary.ok ? "success" : "error", summary.ok ? "✓" : "✗");
	const parts = [icon];
	if (summary.durationMs !== undefined) parts.push(formatDuration(summary.durationMs));
	if (summary.argsTruncated) parts.push("(args truncated)");
	return indent(renderFirstVisualLines(parts.join(" "), 1, width));
}

function sanitizeTerminalControl(text: string): string {
	return text.replace(TERMINAL_ESCAPE_PATTERN, "").replace(TERMINAL_CONTROL_PATTERN, " ");
}

function renderPreview(preview: string, options: WidgetOptions, width: number): string[] {
	const sanitized = sanitizeTerminalControl(preview);
	if (sanitized.length === 0) return [];
	return indent(renderFirstVisualLines(style(options.theme, "muted", sanitized), MAX_PREVIEW_LINES, width));
}

function renderCollapsedError(error: string, options: WidgetOptions, width: number): string[] {
	const guardedError = codePointPrefix(error, MAX_COLLAPSED_ERROR_CODE_POINTS);
	const guardedLines = renderAllVisualLines(style(options.theme, "error", guardedError), width);
	if (guardedError.length === error.length && guardedLines.length <= MAX_COLLAPSED_ERROR_LINES) {
		return indent(guardedLines);
	}

	const markerLines = renderAllVisualLines(style(options.theme, "muted", TOOL_ERROR_OMISSION_MARKER), width);
	const errorBudget = Math.max(0, MAX_COLLAPSED_ERROR_LINES - markerLines.length);
	const lines = guardedLines.slice(0, errorBudget);
	lines.push(...markerLines.slice(0, MAX_COLLAPSED_ERROR_LINES - lines.length));
	return indent(lines);
}

function renderError(error: string, options: WidgetOptions, width: number): string[] {
	const sanitized = sanitizeTerminalControl(error);
	if (options.expanded) return indent(renderAllVisualLines(style(options.theme, "error", sanitized), width));
	return renderCollapsedError(sanitized, options, width);
}

/**
 * The theme-less fallback is QA-only. Production's gate lives in render.ts:
 * nestedToolCallBlock routes theme-less renders to legacy rows before this function is called.
 */
export function renderToolCallWidget(summary: EvalToolCallSummary, options: WidgetOptions): string[] {
	const innerWidth = Math.max(1, options.width - 2);
	const coreLines = isCoreWidgetName(summary.name)
		? coreWidgetsFor(options.cwd)[summary.name](summary, options)
		: undefined;
	const lines = coreLines ?? renderFallback(summary, innerWidth);
	lines.push(...renderStatus(summary, options, innerWidth));
	if (summary.ok && summary.resultPreview !== undefined) {
		lines.push(...renderPreview(summary.resultPreview, options, innerWidth));
	} else if (!summary.ok && summary.error !== undefined) {
		lines.push(...renderError(summary.error, options, innerWidth));
	}
	return options.expanded ? lines : lines.slice(0, MAX_COLLAPSED_WIDGET_LINES);
}
