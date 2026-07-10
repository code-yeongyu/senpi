import {
	type AgentToolResult,
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
type RenderBlock =
	| { readonly kind: "blank" }
	| {
			readonly kind: "text";
			readonly text: string;
			readonly maxVisualLines?: number;
			readonly collapseKind?: CollapsibleKind;
	  }
	| {
			readonly kind: "toolCalls";
			readonly calls: readonly string[];
			readonly expanded: boolean;
	  };

const CODE_PREVIEW_LINES = 4;
const OUTPUT_PREVIEW_LINES = 8;
const TOOL_CALL_PREVIEW_COUNT = 5;
const UNBOUNDED_VISUAL_LINES = 1_000_000;

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
				lines.push(...renderToolCallBlock(block, width));
			} else {
				lines.push(...renderTextBlock(block, width));
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

function renderAllVisualLines(text: string, width: number): string[] {
	return truncateToVisualLines(text, UNBOUNDED_VISUAL_LINES, width).visualLines.map((line) => line.trimEnd());
}

function renderTextBlock(block: Extract<RenderBlock, { kind: "text" }>, width: number): string[] {
	if (block.maxVisualLines === undefined) return renderAllVisualLines(block.text, width);
	const result = truncateToVisualLines(block.text, block.maxVisualLines, width);
	const visualLines = result.visualLines.map((line) => line.trimEnd());
	if (result.skippedCount === 0 || block.collapseKind === undefined) return visualLines;
	return [
		...renderAllVisualLines(`${result.skippedCount} earlier ${block.collapseKind} lines`, width),
		...visualLines,
	];
}

function renderToolCallBlock(block: Extract<RenderBlock, { kind: "toolCalls" }>, width: number): string[] {
	const retainedCalls = block.expanded ? block.calls : block.calls.slice(-TOOL_CALL_PREVIEW_COUNT);
	const skippedCount = block.calls.length - retainedCalls.length;
	const toolCallNoun = skippedCount === 1 ? "call" : "calls";
	const lines =
		block.expanded || skippedCount === 0
			? []
			: renderAllVisualLines(`${skippedCount} earlier tool ${toolCallNoun}`, width);
	for (const call of retainedCalls) {
		lines.push(...renderAllVisualLines(call, width));
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
		else if (showImageFallback && part.type === "image") lines.push(`[image: ${part.mimeType}]`);
	}
	return lines.join("\n");
}

function toolCallLines(details: EvalToolDetails | undefined, theme: Theme | undefined): string[] {
	if (!details?.toolCalls || details.toolCalls.length === 0) return [];
	return details.toolCalls.map((call) => {
		const status = call.ok ? "ok" : "error";
		const text = `- tool.${call.name}: ${status}${call.error ? ` (${call.error})` : ""}`;
		return style(theme, call.ok ? "success" : "error", text);
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
	if (!options.isPartial && details && details.durationMs > 0) metadata.push(`took ${details.durationMs}ms`);
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
		});
	} else if (!hasRenderedImage) {
		blocks.push({ kind: "text", text: style(theme, "muted", "(no output)") });
	}
	const calls = toolCallLines(details, theme);
	if (calls.length > 0) blocks.push({ kind: "blank" }, { kind: "toolCalls", calls, expanded });
	if (details?.truncated)
		blocks.push({ kind: "blank" }, { kind: "text", text: style(theme, "warning", "[eval output truncated]") });
	component.setBlocks(blocks);
	return component;
}
