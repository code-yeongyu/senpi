import { type Theme, type ThemeColor, type ToolDefinition, truncateToVisualLines } from "@code-yeongyu/senpi";
import type { TruncationMeta } from "../output/output-meta.ts";
import { codePointPrefix } from "./tool-widgets.ts";
import type { EvalInputSchema, EvalResultDetails, EvalToolInput, EvalToolRequest } from "./types.ts";

type EvalToolDefinition = ToolDefinition<EvalInputSchema, EvalResultDetails>;
export type CallRenderContext = Parameters<NonNullable<EvalToolDefinition["renderCall"]>>[2];
export type ResultRenderContext = Parameters<NonNullable<EvalToolDefinition["renderResult"]>>[3];
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
export type RenderBlock =
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

export const CODE_PREVIEW_LINES = 4;
export const SUMMARY_PREVIEW_LINES = 3;
export const OUTPUT_PREVIEW_LINES = 8;
export const STATUS_PREVIEW_COUNT = 3;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
export const TOOL_CALL_PREVIEW_COUNT = 5;
const TOOL_CALL_COLLAPSED_VISUAL_LINES = 4;
const TOOL_CALL_COLLAPSED_ERROR_CODE_POINTS = 512;
const TOOL_ERROR_OMISSION_MARKER = "[tool error omitted]";
export const LIVE_RENDER_TICK_MS = 100;
// A live row repaints on every tick, so this many ticks without a render means the row is gone.
const LIVE_TICKER_MAX_IDLE_TICKS = 600;

export type StatusPresentation = { readonly label: string; readonly icon: string; readonly color: ThemeColor };
export type RenderEnvironment = {
	readonly expanded: boolean;
	readonly theme: Theme | undefined;
	readonly spinnerFrame: number | undefined;
	readonly width: number;
	readonly meta: TruncationMeta | undefined;
	/** Render-time clock, injected so elapsed time is deterministic under test. */
	readonly now: number;
	/** Repaints the row once a background-formatted code preview is ready; absent while args stream. */
	readonly repaint?: () => void;
};
export type PrefixStyle = { readonly prefix: string; readonly continuation: string; readonly color: ThemeColor };

class PlainTextComponent implements EvalRenderComponent {
	#blocks: readonly RenderBlock[] = [];
	#ticker: ReturnType<typeof setInterval> | undefined;
	#live = false;
	#invalidate: (() => void) | undefined;
	#idleTicks = 0;

	setBlocks(blocks: readonly RenderBlock[]): void {
		this.#blocks = blocks;
	}

	/**
	 * The host only animates tool rows for streaming args, `task`, and results carrying
	 * `details.progress`; an eval row matches none of them, so nothing repaints it between
	 * update events. While a cell is non-terminal this drives the repaint itself so the
	 * header's spinner and elapsed time advance, with no tool updates or RPC traffic. Detached
	 * and terminal cards never arm it, and a ticker whose row stopped rendering (transcript
	 * rebuild, session switch) stops itself after LIVE_TICKER_MAX_IDLE_TICKS and rearms on
	 * the next render, so dropped rows cannot accumulate intervals.
	 */
	syncLiveTicker(isLive: boolean, invalidate: () => void): void {
		this.#live = isLive;
		this.#invalidate = invalidate;
		if (!isLive) {
			this.stopLiveTicker();
			return;
		}
		this.#armTicker();
	}

	stopLiveTicker(): void {
		if (this.#ticker === undefined) return;
		clearInterval(this.#ticker);
		this.#ticker = undefined;
	}

	#armTicker(): void {
		if (this.#ticker !== undefined || this.#invalidate === undefined) return;
		this.#ticker = setInterval(() => this.#tick(), LIVE_RENDER_TICK_MS);
		this.#ticker.unref?.();
	}

	#tick(): void {
		this.#idleTicks += 1;
		if (this.#idleTicks >= LIVE_TICKER_MAX_IDLE_TICKS) {
			this.stopLiveTicker();
			return;
		}
		this.#invalidate?.();
	}

	render(width: number): string[] {
		this.#idleTicks = 0;
		if (this.#live) this.#armTicker();
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

export function componentFor(context: CallRenderContext | ResultRenderContext): PlainTextComponent {
	const existing = context.lastComponent;
	if (existing instanceof PlainTextComponent) return existing;
	return new PlainTextComponent();
}

/** Render-time clock; tests inject a fixed value so elapsed output never depends on wall time. */
export function renderNow(context: CallRenderContext | ResultRenderContext): number {
	const injected: unknown = Reflect.get(context, "now");
	return typeof injected === "number" && Number.isFinite(injected) ? injected : Date.now();
}

export function isEvalRunInput(args: EvalToolRequest | Partial<EvalToolInput>): args is EvalToolInput {
	return args.action === undefined || args.action === "run";
}

export function style(theme: Theme | undefined, color: ThemeColor, text: string): string {
	return theme ? theme.fg(color, text) : text;
}

export function appendLines(target: string[], source: readonly string[]): void {
	for (const line of source) target.push(line);
}

export function renderAllVisualLines(text: string, width: number): string[] {
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

export function renderToolCall(
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

export function assertNever(value: never): never {
	throw new TypeError(`Unhandled eval render variant: ${String(value)}`);
}

export function spinner(frame: number | undefined): string {
	return SPINNER_FRAMES.at((frame ?? 0) % SPINNER_FRAMES.length) ?? SPINNER_FRAMES[0];
}

export function renderPrefixed(text: string, environment: RenderEnvironment, prefixStyle: PrefixStyle): string[] {
	const bodyLines = renderAllVisualLines(text, Math.max(1, environment.width - prefixStyle.prefix.length));
	if (bodyLines.length === 0) return [style(environment.theme, prefixStyle.color, prefixStyle.prefix.trimEnd())];
	return bodyLines.map(
		(line, index) =>
			`${style(environment.theme, prefixStyle.color, index === 0 ? prefixStyle.prefix : prefixStyle.continuation)}${line}`,
	);
}

export function previewText(
	text: string,
	maxLines: number,
	width: number,
): { readonly lines: string[]; readonly skipped: number } {
	const preview = truncateToVisualLines(text, maxLines, Math.max(1, width));
	return { lines: preview.visualLines.map((line) => line.trimEnd()), skipped: preview.skippedCount };
}
