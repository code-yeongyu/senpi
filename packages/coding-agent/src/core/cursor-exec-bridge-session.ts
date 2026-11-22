import {
	type Agent,
	type AgentEvent,
	type AgentTool,
	type AgentToolCall,
	type AgentToolResult,
	BatchStoreMissingError,
	type BeforeToolCallResult,
} from "@earendil-works/pi-agent-core";
import { createCursorExecBridge } from "./cursor-exec-bridge.ts";

type CursorBridgeAgent = Pick<
	Agent,
	"emitExternalEvent" | "signal" | "batchStoreFactory" | "executionScope" | "getExecutionScope" | "onExecutionPipeline"
>;

export interface CursorExecBridgeSession {
	getRegisteredTool(name: string): AgentTool | undefined;
	/** `execBridge` marks the call as issued by the model through the exec channel until it is released. */
	preflightToolCall(
		toolCall: AgentToolCall,
		args: unknown,
		options?: { execBridge?: boolean },
	): Promise<BeforeToolCallResult | undefined>;
	/** The exec-frame call ended on any path; its preflight marked it model-issued with `execBridge`. */
	releaseExecBridgeToolCall(toolCallId: string): void;
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
					// event.input is the validated form of the bridge's JSON exec-frame args; the extension
					// ToolCallEvent API types it Record<string, unknown>.
					arguments: event.input as AgentToolCall["arguments"],
				},
				event.input,
				{ execBridge: true },
			),
		emitEvent: async (event: AgentEvent, runSignal: AbortSignal) =>
			await getAgent().emitExternalEvent(event, runSignal),
		settleToolCall: (toolCallId) => sessionRef.current?.releaseExecBridgeToolCall(toolCallId),
		emitToolResult: async ({ toolName, toolCallId, args, result, isError }) => {
			await sessionRef.current?.emitExecBridgeToolResult(toolName, toolCallId, args, result, isError);
		},
		getAbortSignal: () => {
			if (runSignal === undefined || runSignal.aborted) return undefined;
			return runSignal === getAgent().signal ? runSignal : undefined;
		},
		openBatchStore: () => {
			const open = getAgent().batchStoreFactory;
			if (open === undefined) throw new BatchStoreMissingError();
			return open();
		},
		getExecutionScope: () => {
			const agent = getAgent();
			return agent.getExecutionScope?.() ?? agent.executionScope;
		},
		recordWitness: (witness) => getAgent().onExecutionPipeline?.(witness),
	});
}
