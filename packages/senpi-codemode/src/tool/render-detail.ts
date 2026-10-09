import { type AgentToolResult, sanitizeTerminalLabel, type Theme } from "@code-yeongyu/senpi";
import {
	JSON_TREE_MAX_DEPTH_COLLAPSED,
	JSON_TREE_MAX_DEPTH_EXPANDED,
	JSON_TREE_MAX_LINES_COLLAPSED,
	JSON_TREE_MAX_LINES_EXPANDED,
	JSON_TREE_SCALAR_LEN_COLLAPSED,
	JSON_TREE_SCALAR_LEN_EXPANDED,
	renderJsonTreeLines,
} from "./json-tree.ts";
import {
	appendLines,
	isEvalRunInput,
	type RenderBlock,
	type RenderEnvironment,
	renderAllVisualLines,
	renderToolCall,
	style,
	TOOL_CALL_PREVIEW_COUNT,
} from "./render-blocks.ts";
import { renderCell } from "./render-cell.ts";
import { renderToolCallWidget } from "./tool-widgets.ts";
import type { EvalResultDetails, EvalToolDetails, EvalToolRequest } from "./types.ts";

type ToolCallRow = {
	readonly summary: string;
	readonly error?: string;
	readonly color: "success" | "error";
};
type DetailedRenderContext = {
	readonly environment: RenderEnvironment;
	readonly args: EvalToolRequest;
	readonly showImageFallback: boolean;
	readonly isFinal: boolean;
};

export function renderJsonOutputs(values: readonly unknown[], environment: RenderEnvironment): string[] {
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

export function renderDetailedLines(
	details: EvalToolDetails,
	result: AgentToolResult<EvalResultDetails>,
	context: DetailedRenderContext,
): string[] {
	const lines: string[] = [];
	const cells = details.cells ?? [];
	for (const [index, cell] of cells.entries()) {
		const run = isEvalRunInput(context.args) ? context.args : undefined;
		const throughput =
			context.isFinal &&
			cells.length === 1 &&
			cell.status === "complete" &&
			typeof details.toolCallCount === "number"
				? { calls: details.toolCallCount, wallDurationMs: details.wallDurationMs }
				: undefined;
		const badges = {
			reset: index === 0 && run?.reset === true,
			timeout: index === 0 ? run?.timeout : undefined,
			throughput,
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
	return lines;
}

export function toolCallRows(details: EvalToolDetails | undefined): ToolCallRow[] {
	if (!details?.toolCalls || details.toolCalls.length === 0) return [];
	return details.toolCalls.map((call) => {
		const status = call.ok ? "ok" : "error";
		const row = { summary: `- tool.${call.name}: ${status}`, color: call.ok ? "success" : "error" } as const;
		return call.error === undefined ? row : { ...row, error: call.error };
	});
}

export function nestedToolCallBlock(
	details: EvalToolDetails | undefined,
	theme: Theme | undefined,
	cwd: string,
	expanded: boolean,
): RenderBlock | undefined {
	const toolCalls = details?.toolCalls;
	if (theme === undefined || toolCalls === undefined || !toolCalls.some((call) => call.args !== undefined)) {
		return undefined;
	}
	const legacyRows = toolCallRows(details);
	return {
		kind: "dynamic",
		render: (width) => {
			const retainedCalls = expanded ? toolCalls : toolCalls.slice(-TOOL_CALL_PREVIEW_COUNT);
			const retainedRows = expanded ? legacyRows : legacyRows.slice(-TOOL_CALL_PREVIEW_COUNT);
			const skippedCount = toolCalls.length - retainedCalls.length;
			const toolCallNoun = skippedCount === 1 ? "call" : "calls";
			const lines =
				expanded || skippedCount === 0
					? []
					: renderAllVisualLines(style(theme, "muted", `${skippedCount} earlier tool ${toolCallNoun}`), width);
			const legacyBlock: Extract<RenderBlock, { kind: "toolCalls" }> = {
				kind: "toolCalls",
				calls: retainedRows,
				expanded,
				theme,
			};
			for (const [index, call] of retainedCalls.entries()) {
				if (call.args !== undefined) {
					appendLines(lines, renderToolCallWidget(call, { cwd, theme, expanded, width }));
				} else {
					appendLines(lines, renderToolCall(retainedRows[index], legacyBlock, width));
				}
			}
			return lines;
		},
	};
}
