import type {
	Agent,
	AgentEvent,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
	BeforeToolCallResult,
} from "@earendil-works/pi-agent-core";
import { createCursorExecBridge } from "./cursor-exec-bridge.ts";

type CursorBridgeAgent = Pick<Agent, "emitExternalEvent" | "signal">;

export interface CursorExecBridgeSession {
	getRegisteredTool(name: string): AgentTool | undefined;
	preflightToolCall(toolCall: AgentToolCall, args: unknown): Promise<BeforeToolCallResult | undefined>;
	emitExecBridgeToolResult(
		toolName: string,
		toolCallId: string,
		args: unknown,
		result: AgentToolResult<unknown>,
		isError: boolean,
	): Promise<void>;
}

/**
 * Build the exec handlers for ONE Cursor run.
 *
 * `runSignal` is the signal of the run that owns this stream, captured when
 * the loop opens it. Resolving ownership from the agent's live signal instead
 * would let a straggler frame from a stream whose run already ended (a
 * provider error or rate-limit fallback restarts the run while its h2 stream
 * still holds buffered exec frames) adopt the replacement run's signal, clear
 * the ownership guard in `Agent.emitExternalEvent`, and execute a dead run's
 * tool inside the new run.
 */
export function createSessionCursorExecBridge(
	sessionRef: { current?: CursorExecBridgeSession },
	getAgent: () => CursorBridgeAgent,
	runSignal?: AbortSignal,
) {
	return createCursorExecBridge({
		getTool: (name) => sessionRef.current?.getRegisteredTool(name),
		preflightToolCall: async (event) =>
			sessionRef.current?.preflightToolCall(
				{
					type: "toolCall",
					id: event.toolCallId,
					name: event.toolName,
					arguments: event.input,
				},
				event.input,
			),
		emitEvent: async (event: AgentEvent, runSignal: AbortSignal) =>
			await getAgent().emitExternalEvent(event, runSignal),
		emitToolResult: async ({ toolName, toolCallId, args, result, isError }) => {
			await sessionRef.current?.emitExecBridgeToolResult(toolName, toolCallId, args, result, isError);
		},
		getAbortSignal: () => {
			if (runSignal === undefined || runSignal.aborted) return undefined;
			return runSignal === getAgent().signal ? runSignal : undefined;
		},
	});
}
