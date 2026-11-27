/**
 * `ctx.reportToolResult()` (senpi#7232): a tool reports work it already did outside the tool pipeline, and the
 * session's `tool_result` handlers run for it as they would for a real call's result. No tool runs and no
 * `tool_call` handler is asked, so nothing can be written twice, prompted twice or blocked.
 */

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ToolEventDispatchOptions } from "./two-sided-forwarding.ts";
import type { ToolResultEvent, ToolResultEventResult } from "./types.ts";

/** Work a running tool did outside the tool pipeline, reported as the result of a call that never ran. */
export interface ReportedToolResult {
	/** The tool the result stands for, for example `write`. */
	toolName: string;
	/** The arguments such a call would have carried; `tool_result` handlers read them as `event.input`. */
	input: Record<string, unknown>;
	content: (TextContent | ImageContent)[];
	details?: unknown;
	isError?: boolean;
}

/** One `tool_result` handler that did not complete for a reported result. */
export interface ReportedToolResultFailure {
	extensionPath: string;
	error: string;
}

export interface ReportedToolResultOutcome {
	/** The id the event carried: `<calling id>/reported-<n>`. */
	toolCallId: string;
	/** What the handlers changed, as a `tool_result` handler returns it; undefined when none changed anything. */
	result: ToolResultEventResult | undefined;
	/** Handlers that threw, timed out or were interrupted; the others still ran. */
	failures: ReportedToolResultFailure[];
}

type EmitToolResult = (
	event: ToolResultEvent,
	options: ToolEventDispatchOptions,
) => Promise<ToolResultEventResult | undefined>;

/** Runs the `tool_result` handlers for the `ordinal`-th result the call `callerId` reports. */
export async function emitReportedToolResult(
	emit: EmitToolResult,
	callerId: string,
	ordinal: number,
	report: ReportedToolResult,
): Promise<ReportedToolResultOutcome> {
	// `reported-<n>` never collides with the `<calling id>/<n>` ids of calls made through executeTool().
	const toolCallId = `${callerId}/reported-${ordinal}`;
	const failures: ReportedToolResultFailure[] = [];
	const result = await emit(
		{
			type: "tool_result",
			toolName: report.toolName,
			toolCallId,
			parentToolCallId: callerId,
			input: report.input,
			content: report.content,
			details: report.details,
			isError: report.isError ?? false,
		},
		{ onHandlerFailure: (failure) => failures.push({ ...failure }) },
	);
	return { toolCallId, result, failures };
}
