import {
	type AgentToolResult,
	sanitizeTerminalLabel,
	type Theme,
	type ThemeColor,
	type ToolDefinition,
	type ToolRenderResultOptions,
	truncateToVisualLines,
} from "@code-yeongyu/senpi";
import type { createEvalInputSchema, EvalToolDetails, EvalToolInput } from "./types.ts";

type EvalToolDefinition = ToolDefinition<ReturnType<typeof createEvalInputSchema>, EvalToolDetails>;
type RenderContext = Parameters<NonNullable<EvalToolDefinition["renderCall"]>>[2];
type Component = ReturnType<NonNullable<EvalToolDefinition["renderCall"]>>;
type CollapsibleKind = "code" | "output";
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
	  };

const CODE_PREVIEW_LINES = 4;
const OUTPUT_PREVIEW_LINES = 8;
const TOOL_CALL_PREVIEW_COUNT = 5;
const TOOL_CALL_COLLAPSED_VISUAL_LINES = 4;
const TOOL_CALL_COLLAPSED_ERROR_CODE_POINTS = 512;
const TOOL_ERROR_OMISSION_MARKER = "[tool error omitted]";

class PlainTextComponent {
	#blocks: readonly RenderBlock[] = [];

	setBlocks(blocks: readonly RenderBlock[]): void {
		this.#blocks = blocks;
	}

	render(width: number): string[] {
		const lines: string[] = [];
		for (const block of this.#blocks) {
			if (block.kind === "blank") {
				lines.push("");
			} else if (block.kind === "toolCalls") {
				appendLines(lines, renderToolCallBlock(block, width));
			} else {
				appendLines(lines, renderTextBlock(block, width));
			}
		}
		return lines;
	}

	invalidate(): void {}
}

function componentFor(context: RenderContext): PlainTextComponent {
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

function callCode(code: string): string {
	return code.trim().length > 0 ? code : "...";
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
	const title = details?.title ? ` ${details.title}` : "";
	return style(
		theme,
		status === "running" ? "warning" : status === "done" ? "success" : "error",
		`eval ${details?.language ?? "?"}${title} ${status}`,
	);
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

export function renderEvalCall(args: EvalToolInput, theme: Theme | undefined, context: RenderContext): Component {
	const component = componentFor(context);
	const title = args.title ? ` ${args.title}` : "";
	const reset = args.reset ? " reset" : "";
	const timeout = args.timeout ? ` timeout ${args.timeout}s` : "";
	component.setBlocks([
		{ kind: "text", text: style(theme, "toolTitle", `eval ${args.language}${title}${reset}${timeout}`) },
		{
			kind: "text",
			text: style(theme, "mdCodeBlock", callCode(args.code)),
			maxVisualLines: context.expanded ? undefined : CODE_PREVIEW_LINES,
			collapseKind: "code",
			theme,
		},
	]);
	return component;
}

export function renderEvalResult(
	result: AgentToolResult<EvalToolDetails>,
	options: ToolRenderResultOptions,
	theme: Theme | undefined,
	context: Parameters<NonNullable<EvalToolDefinition["renderResult"]>>[3],
): Component {
	const component = componentFor(context);
	const details = result.details;
	const expanded = options.expanded || context.expanded;
	const imageProtocol = context.imageProtocol ?? null;
	const status = resultStatus(details, options, context.isError);
	const blocks: RenderBlock[] = [
		{ kind: "text", text: resultHeader(details, status, theme) },
		...resultMetadata(details, options, theme),
		{ kind: "blank" },
	];
	const output = textOutput(result, context.showImages && imageProtocol === null).trimEnd();
	const hasRenderedImage =
		context.showImages && imageProtocol !== null && result.content.some((part) => part.type === "image");
	if (output) {
		blocks.push({
			kind: "text",
			text: style(theme, "toolOutput", output),
			maxVisualLines: expanded ? undefined : OUTPUT_PREVIEW_LINES,
			collapseKind: "output",
			theme,
		});
	} else if (!hasRenderedImage) {
		blocks.push({ kind: "text", text: style(theme, "muted", "(no output)") });
	}
	const calls = toolCallRows(details);
	if (calls.length > 0) blocks.push({ kind: "blank" }, { kind: "toolCalls", calls, expanded, theme });
	if (details?.truncated)
		blocks.push({ kind: "blank" }, { kind: "text", text: style(theme, "warning", "[eval output truncated]") });
	component.setBlocks(blocks);
	return component;
}
