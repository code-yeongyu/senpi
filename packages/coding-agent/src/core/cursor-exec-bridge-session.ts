import type { Agent, AgentEvent, AgentTool, AgentToolCall, BeforeToolCallResult } from "@earendil-works/pi-agent-core";
import { createCursorExecBridge } from "./cursor-exec-bridge.ts";

type CursorBridgeAgent = Pick<Agent, "emitExternalEvent" | "signal">;

export interface CursorExecBridgeSession {
	getRegisteredTool(name: string): AgentTool | undefined;
	preflightToolCall(toolCall: AgentToolCall, args: unknown): Promise<BeforeToolCallResult | undefined>;
}

/**
 * Build the exec handlers for ONE Cursor run.
 *
 * `runSignal` is the signal of the request that owns this stream, captured
 * when the loop opens it. In production it is the loop's per-request
 * controller, always a different object than the agent's per-run controller,
 * so ownership cannot be decided by identity. It is a liveness property
 * instead: the loop mirrors the run's aborts into the request controller
 * (run aborted, idle timeout, or the run dying before a fallback restart),
 * so a frame is owned by its request and refused only when that request is
 * aborted or no run is active at all. A straggler frame from a stream whose
 * run already ended (a provider error or rate-limit fallback restarts the
 * run while its h2 stream still holds buffered exec frames) arrives on an
 * aborted request and is refused; one whose request is still live executes
 * under that request's signal, and its lifecycle events are dropped by
 * `Agent.emitExternalEvent`, which discards events whose signal is not the
 * active run's — they cannot leak into the replacement run's transcript.
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
		getAbortSignal: () => {
			if (runSignal === undefined) return getAgent().signal;
			if (runSignal.aborted || getAgent().signal === undefined) return undefined;
			return runSignal;
		},
	});
}
