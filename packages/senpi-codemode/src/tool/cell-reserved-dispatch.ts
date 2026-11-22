import type { ExtensionContext } from "@code-yeongyu/senpi";
import type { KernelToHostMessage } from "../bridge/protocol.ts";
import type { ReservedDispatchContext } from "../bridges/reserved-dispatch.ts";
import type { CompletionRequest, CompletionResult } from "../completion/handler.ts";
import type { CompletionToolCallOptions } from "../completion/tool-bridge.ts";
import type { CellBridgeRuntime } from "./cell-handler.ts";
import { marshalToolResult } from "./image.ts";
import type { EvalKernel, EvalStatusEvent } from "./types.ts";

type ToolCallMessage = Extract<KernelToHostMessage, { type: "tool-call" }>;

/** The in-process (JS kernel) dispatch context for a reserved helper call; mirrors the bridge route for py/rb/jl. */
export function reservedDispatchContext(
	message: ToolCallMessage,
	runtime: CellBridgeRuntime,
	signal: AbortSignal,
	emitStatus: (event: EvalStatusEvent) => void,
): ReservedDispatchContext {
	const host = runtime.ctx.evalHandleHost;
	return {
		callId: message.callId,
		args: message.args,
		executeTool: runtime.executeTool,
		taskToolName: runtime.settings.taskTools.task,
		taskOutputToolName: runtime.settings.taskTools.output,
		listTools: runtime.listTools,
		signal,
		emitStatus,
		marshalToolResult,
		...(runtime.handles === undefined ? {} : { handles: runtime.handles }),
		...(host === undefined ? {} : { evalHandleHost: host }),
		...(runtime.environments === undefined ? {} : { environments: runtime.environments }),
	};
}

export function completionCallOptions(
	message: ToolCallMessage,
	kernel: EvalKernel,
	runtime: CellBridgeRuntime,
	complete: (request: CompletionRequest, ctx: ExtensionContext) => Promise<CompletionResult>,
	isActive: () => boolean,
): CompletionToolCallOptions {
	return {
		message,
		kernel,
		complete,
		ctx: runtime.ctx,
		isActive,
		...(runtime.handles === undefined ? {} : { handles: runtime.handles }),
		...(runtime.hardDeadlineMs === undefined ? {} : { hardDeadlineMs: runtime.hardDeadlineMs }),
	};
}
