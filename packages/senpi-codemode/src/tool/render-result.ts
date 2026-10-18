import {
	type AgentToolResult,
	sanitizeTerminalLabel,
	type Theme,
	type ToolRenderResultOptions,
} from "@code-yeongyu/senpi";
import { renderAgentProgressEvents } from "./render-agent.ts";
import {
	componentFor,
	type EvalRenderComponent,
	OUTPUT_PREVIEW_LINES,
	type RenderBlock,
	type RenderEnvironment,
	type ResultRenderContext,
	renderNow,
	style,
} from "./render-blocks.ts";
import { summaryBlock } from "./render-cell.ts";
import { nestedToolCallBlock, renderDetailedLines, renderJsonOutputs, toolCallRows } from "./render-detail.ts";
import { hasLiveCell } from "./render-live.ts";
import { formatThroughputBadge, renderStatusEvents } from "./render-status.ts";
import { formatRuntimeBadge } from "./runtime-label.ts";
import { formatDuration } from "./tool-widgets.ts";
import type { EvalResultDetails, EvalStatusEvent, EvalToolDetails } from "./types.ts";

function textOutput(result: AgentToolResult<EvalResultDetails>, showImageFallback: boolean): string {
	const lines: string[] = [];
	for (const part of result.content) {
		if (part.type === "text" && part.audience !== "model") lines.push(part.text);
		else if (showImageFallback && part.type === "image") {
			lines.push(`[image: ${sanitizeTerminalLabel(part.mimeType)}]`);
		}
	}
	return lines.join("\n");
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
	let color: "warning" | "success" | "error";
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
	const runtimeBadge =
		details?.runtime === undefined ? "" : ` (${formatRuntimeBadge(details.language, details.runtime)})`;
	return style(theme, color, `eval ${details?.language ?? "?"}${runtimeBadge} ${status}`);
}

function resultMetadata(
	details: EvalToolDetails | undefined,
	options: ToolRenderResultOptions,
	theme: Theme | undefined,
	status: "running" | "done" | "error",
): RenderBlock[] {
	const metadata: string[] = [];
	if (details?.phase) metadata.push(`phase ${details.phase}`);
	const elapsedMs = details?.wallDurationMs ?? details?.durationMs;
	if (!options.isPartial && typeof elapsedMs === "number") metadata.push(`took ${formatDuration(elapsedMs)}`);
	if (status === "done" && typeof details?.toolCallCount === "number") {
		const badge = formatThroughputBadge({ calls: details.toolCallCount, wallDurationMs: details.wallDurationMs });
		if (badge !== undefined) metadata.push(badge);
	}
	if (metadata.length === 0) return [];
	return [{ kind: "text", text: style(theme, "muted", metadata.join(" | ")) }];
}

export function renderEvalResult(
	result: AgentToolResult<EvalResultDetails>,
	options: ToolRenderResultOptions,
	theme: Theme | undefined,
	context: ResultRenderContext,
): EvalRenderComponent {
	const component = componentFor(context);
	const details = result.details;
	if (details && "action" in details) {
		component.syncLiveTicker(false, context.invalidate);
		component.setBlocks([
			{ kind: "text", text: style(theme, "toolTitle", "eval list") },
			{ kind: "text", text: style(theme, "toolOutput", textOutput(result, false)) },
		]);
		return component;
	}
	const expanded = options.expanded || context.expanded;
	const imageProtocol = context.imageProtocol ?? null;
	component.syncLiveTicker(hasLiveCell(details), context.invalidate);
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
							now: renderNow(context),
							repaint: context.invalidate,
						},
						args: context.args,
						showImageFallback: context.showImages && imageProtocol === null,
						isFinal: !options.isPartial,
					}),
			},
		];
		const calls = toolCallRows(details);
		const nestedCalls = nestedToolCallBlock(details, theme, context.cwd, expanded);
		if (calls.length > 0)
			blocks.push({ kind: "blank" }, nestedCalls ?? { kind: "toolCalls", calls, expanded, theme });
		component.setBlocks(blocks);
		return component;
	}
	const status = resultStatus(details, options, context.isError);
	const blocks: RenderBlock[] = [
		{ kind: "text", text: resultHeader(details, status, theme) },
		...(details?.summary === undefined ? [] : [summaryBlock(details.summary, theme, expanded)]),
		...resultMetadata(details, options, theme, status),
		{ kind: "blank" },
	];
	const rawOutput = textOutput(result, context.showImages && imageProtocol === null);
	const output = rawOutput.trimEnd();
	const hasRenderedImage =
		context.showImages &&
		imageProtocol !== null &&
		result.content.some((part: { type: string }) => part.type === "image");
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
	const nonAgentEvents = statusEvents.filter((event: EvalStatusEvent) => event.op !== "agent");
	const agentEvents = statusEvents.filter((event: EvalStatusEvent) => event.op === "agent");
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
						now: renderNow(context),
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
						now: renderNow(context),
					}),
			},
		);
	}
	const calls = toolCallRows(details);
	const nestedCalls = nestedToolCallBlock(details, theme, context.cwd, expanded);
	if (calls.length > 0) blocks.push({ kind: "blank" }, nestedCalls ?? { kind: "toolCalls", calls, expanded, theme });
	component.setBlocks(blocks);
	return component;
}
