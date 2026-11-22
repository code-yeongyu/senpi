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
	/** The registered tool's own row renderers, by tool name; a tool without them keeps the generic row. */
	readonly renderers?: (toolName: string) => NestedToolRenderers | undefined;
}

/** What a registered tool brings to draw its own nested row. */
export type NestedToolRenderers = {
	readonly renderCall?: ToolDefinition["renderCall"];
	readonly renderResult?: ToolDefinition["renderResult"];
};

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
const MAX_EXPANDED_RESULT_LINES = 40;
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
		return cappedLines(component, innerWidth, MAX_RENDERER_LINES, theme);
	} catch {
		return undefined;
	}
}

/** A renderer's lines, cut to `maxLines` with a marker, indented under the call. */
function cappedLines(
	component: { render(width: number): string[] },
	innerWidth: number,
	maxLines: number,
	theme: Theme,
): string[] {
	const renderedLines = component.render(innerWidth).map((line) => line.trimEnd());
	const retainedLines = renderedLines.slice(0, maxLines);
	if (renderedLines.length > retainedLines.length) {
		retainedLines.push(style(theme, "muted", WIDGET_TRUNCATION_MARKER));
	}
	return indent(retainedLines);
}

type OwnRenderContext = Parameters<NonNullable<ToolDefinition["renderCall"]>>[2];
type OwnComponent = ReturnType<NonNullable<ToolDefinition["renderCall"]>>;

/**
 * What a tool's own renderers keep between the frames that redraw one nested call: their `state` and the components
 * they returned, as the TUI keeps them for a direct row. Without it every frame handed a renderer fresh state, and one
 * that prefetches (the edit row's diff read) started that work again on every frame. Keyed by the summary object, so a
 * call's entry goes away with the eval result that holds it.
 */
type OwnRowMemory = { readonly state: Record<string, unknown>; call?: OwnComponent; result?: OwnComponent };
const ownRowMemory = new WeakMap<EvalToolCallSummary, OwnRowMemory>();

function ownRowMemoryOf(summary: EvalToolCallSummary): OwnRowMemory {
	let memory = ownRowMemory.get(summary);
	if (memory === undefined) {
		memory = { state: {} };
		ownRowMemory.set(summary, memory);
	}
	return memory;
}

function ownRenderContext(
	summary: EvalToolCallSummary,
	options: WidgetOptions,
	hasResult: boolean,
	memory: OwnRowMemory,
): OwnRenderContext {
	return {
		args: summary.args,
		toolCallId: summary.callId ?? summary.name,
		invalidate: () => {},
		lastComponent: hasResult ? memory.result : memory.call,
		state: memory.state,
		cwd: options.cwd,
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: options.expanded,
		showImages: false,
		isError: !summary.ok,
		hasResult,
	};
}

/**
 * The call line a registered tool draws for itself, as its direct row would. Its renderer already takes partial
 * arguments (the TUI calls it while they stream), so only truncated captures, a narrow width or a throwing renderer
 * fall back to the generic row.
 */
function renderOwnCall(
	own: NestedToolRenderers,
	summary: EvalToolCallSummary,
	options: WidgetOptions,
): string[] | undefined {
	const theme = options.theme;
	const innerWidth = options.width - 2;
	if (own.renderCall === undefined || theme === undefined || innerWidth < MIN_RENDERER_WIDTH || summary.argsTruncated)
		return undefined;
	try {
		const memory = ownRowMemoryOf(summary);
		memory.call = own.renderCall(summary.args, theme, ownRenderContext(summary, options, false, memory));
		return cappedLines(memory.call, innerWidth, MAX_RENDERER_LINES, theme);
	} catch {
		return undefined;
	}
}

/** The result a registered tool draws for itself from the details its nested call kept; undefined keeps the preview. */
function renderOwnResult(
	own: NestedToolRenderers,
	summary: EvalToolCallSummary,
	options: WidgetOptions,
): string[] | undefined {
	const theme = options.theme;
	const innerWidth = options.width - 2;
	if (
		own.renderResult === undefined ||
		summary.details === undefined ||
		theme === undefined ||
		innerWidth < MIN_RENDERER_WIDTH
	)
		return undefined;
	try {
		const memory = ownRowMemoryOf(summary);
		memory.result = own.renderResult(
			{ content: [{ type: "text", text: summary.resultPreview ?? summary.error ?? "" }], details: summary.details },
			{ expanded: options.expanded, isPartial: false },
			theme,
			ownRenderContext(summary, options, true, memory),
		);
		return cappedLines(
			memory.result,
			innerWidth,
			options.expanded ? MAX_EXPANDED_RESULT_LINES : MAX_RENDERER_LINES,
			theme,
		);
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

export function isCoreWidgetName(name: string): name is CoreWidgetName {
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
	const own = isCoreWidgetName(summary.name) ? undefined : options.renderers?.(summary.name);
	const callLines = isCoreWidgetName(summary.name)
		? coreWidgetsFor(options.cwd)[summary.name](summary, options)
		: own === undefined
			? undefined
			: renderOwnCall(own, summary, options);
	const lines = callLines ?? renderFallback(summary, innerWidth);
	lines.push(...renderStatus(summary, options, innerWidth));
	const resultLines = own === undefined ? undefined : renderOwnResult(own, summary, options);
	if (resultLines !== undefined) {
		lines.push(...resultLines);
	} else if (summary.ok && summary.resultPreview !== undefined) {
		lines.push(...renderPreview(summary.resultPreview, options, innerWidth));
	} else if (!summary.ok && summary.error !== undefined) {
		lines.push(...renderError(summary.error, options, innerWidth));
	}
	return options.expanded ? lines : lines.slice(0, MAX_COLLAPSED_WIDGET_LINES);
}
