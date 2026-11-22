import type { AgentToolResult, EvalHandleHost } from "@code-yeongyu/senpi";
import { isReservedToolName, runReservedTool } from "../bridges/reserved-dispatch.ts";
import { defaultCodemodeSettings } from "../config/settings.ts";
import { marshalToolResult } from "../tool/image.ts";
import type { CellToolUpdateSink } from "../tool/nested-tool-output.ts";
import type { CreateCodemodeSessionManagerOptions } from "./session-manager-contract.ts";

export interface BridgeToolCallRequest {
	readonly toolName: string;
	readonly args: unknown;
	readonly callId: string;
	/** The calling run's secret; absent for a call made outside any run (a plain thread), which gets no kernel tools. */
	readonly cellToken?: string;
	readonly signal: AbortSignal;
}

// Subprocess kernels (py/rb/jl) reach the host only through this route, so every reply
// must match the in-process JS path in tool/cell-handler.ts: reserved helper names dispatch
// through runReservedTool (forwarding them made agent() fail with "Unknown tool __agent__"),
// and ordinary tool results are marshalled to { text, images, details, hasError } — the raw
// { content } shape left python cells unable to reach tool.read image blocks.
export async function routeBridgeToolCall(
	options: Pick<
		CreateCodemodeSessionManagerOptions,
		"executeTool" | "listTools" | "settings" | "handles" | "environments"
	>,
	request: BridgeToolCallRequest,
	evalHandleHost?: EvalHandleHost,
	toolUpdates?: CellToolUpdateSink,
): Promise<unknown> {
	if (!isReservedToolName(request.toolName)) {
		const live =
			toolUpdates === undefined
				? {}
				: {
						onUpdate: (partial: AgentToolResult<unknown>) =>
							toolUpdates.nestedToolUpdate(request.callId, partial),
					};
		try {
			return marshalToolResult(
				await options.executeTool(request.toolName, request.args, { signal: request.signal, ...live }),
			);
		} finally {
			toolUpdates?.nestedToolSettled(request.callId);
		}
	}
	const taskTools = options.settings.taskTools ?? defaultCodemodeSettings.taskTools;
	return await runReservedTool(request.toolName, {
		callId: request.callId,
		args: request.args,
		executeTool: options.executeTool,
		taskToolName: taskTools.task,
		taskOutputToolName: taskTools.output,
		listTools: options.listTools,
		signal: request.signal,
		emitStatus: () => {},
		marshalToolResult,
		...(options.handles === undefined ? {} : { handles: options.handles }),
		...(evalHandleHost === undefined ? {} : { evalHandleHost }),
		...(options.environments === undefined ? {} : { environments: options.environments }),
	});
}
