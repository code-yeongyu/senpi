import { type AgentToolResult, sanitizeTerminalLabel, type Theme } from "@code-yeongyu/senpi";
import {
	bufferPlaceholder,
	displayJsonSizeExceeds,
	formatByteLength,
	MAX_DISPLAY_JSON_BYTES,
	serializedBufferByteLength,
} from "./display-json-size.ts";
import {
	formatScalar,
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
		appendLines(lines, renderJsonEntryLines(value, environment, depth, lineCap, scalarLen));
	}
	return lines;
}
// The real legacy shape stores the screenshot as {buffer:{type:"Buffer",data},...metadata}; the buffer key
// collapses to a placeholder and the remaining keys render as one scalar summary line each.
function nestedSerializedBuffer(value: unknown): { readonly key: string } | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		if (serializedBufferByteLength(record[key]) !== undefined) return { key };
	}
	return undefined;
}

function renderJsonEntryLines(
	value: unknown,
	environment: RenderEnvironment,
	depth: number,
	lineCap: number,
	scalarLen: number,
): string[] {
	const fallback = (text: string): string[] =>
		renderAllVisualLines(style(environment.theme, "dim", text), environment.width);
	try {
		// Sessions from before the storage bound can hold byte-per-number Buffer dumps or oversized entries;
		// those collapse to a bounded placeholder or summary instead of walking the whole value.
		const bufferBytes = serializedBufferByteLength(value);
		if (bufferBytes !== undefined) return fallback(bufferPlaceholder(bufferBytes));
		const nested = nestedSerializedBuffer(value);
		if (nested !== undefined) {
			const record = value as Record<string, unknown>;
			const lines = fallback(
				`${nested.key}: ${bufferPlaceholder(serializedBufferByteLength(record[nested.key]) ?? 0)}`,
			);
			const keys = Object.keys(record).filter((key) => key !== nested.key);
			const shownKeys = keys.slice(0, Math.max(0, lineCap - 1));
			for (const key of shownKeys) {
				appendLines(
					lines,
					renderAllVisualLines(
						style(environment.theme, "dim", `  ${key}: ${formatScalar(record[key], scalarLen)}`),
						environment.width,
					),
				);
			}
			if (keys.length > shownKeys.length)
				appendLines(lines, fallback(`  … ${keys.length - shownKeys.length} more keys`));
			return lines;
		}
		if (displayJsonSizeExceeds(value, MAX_DISPLAY_JSON_BYTES)) {
			return fallback(
				`… oversized display value elided (${formatScalar(value, scalarLen)}, ~${formatByteLength(MAX_DISPLAY_JSON_BYTES)}+ stored)`,
			);
		}
		const tree = renderJsonTreeLines(value, environment.theme, depth, lineCap, scalarLen);
		const lines: string[] = [];
		for (const line of tree.lines) appendLines(lines, renderAllVisualLines(line, environment.width));
		if (tree.truncated)
			appendLines(lines, renderAllVisualLines(style(environment.theme, "dim", "…"), environment.width));
		return lines;
	} catch {
		return fallback("[display value could not be rendered]");
	}
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
