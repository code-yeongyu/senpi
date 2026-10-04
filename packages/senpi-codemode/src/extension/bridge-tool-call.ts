import type { EvalHandleHost } from "@code-yeongyu/senpi";
import { isReservedToolName, runReservedTool } from "../bridges/reserved-dispatch.ts";
import { defaultCodemodeSettings } from "../config/settings.ts";
import { marshalToolResult } from "../tool/image.ts";
import type { CreateCodemodeSessionManagerOptions } from "./session-manager-contract.ts";

export interface BridgeToolCallRequest {
	readonly toolName: string;
	readonly args: unknown;
	readonly callId: string;
	readonly signal: AbortSignal;
}

// Subprocess kernels (py/rb/jl) reach the host only through this route, so every reply
// must match the in-process JS path in tool/cell-handler.ts: reserved helper names dispatch
// through runReservedTool (forwarding them made agent() fail with "Unknown tool __agent__"),
// and ordinary tool results are marshalled to { text, images, details, hasError } — the raw
// { content } shape left python cells unable to reach tool.read image blocks.
export async function routeBridgeToolCall(
	options: Pick<CreateCodemodeSessionManagerOptions, "executeTool" | "listTools" | "settings" | "handles">,
	request: BridgeToolCallRequest,
	evalHandleHost?: EvalHandleHost,
): Promise<unknown> {
	if (!isReservedToolName(request.toolName)) {
		return marshalToolResult(await options.executeTool(request.toolName, request.args, { signal: request.signal }));
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
	});
}
