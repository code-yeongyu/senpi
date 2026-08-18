import type { Agent, AgentEvent, AgentTool, AgentToolCall, BeforeToolCallResult } from "@earendil-works/pi-agent-core";
import { createCursorExecBridge } from "./cursor-exec-bridge.ts";

type CursorBridgeAgent = Pick<Agent, "emitExternalEvent" | "signal">;

export interface CursorExecBridgeSession {
	getRegisteredTool(name: string): AgentTool | undefined;
	preflightToolCall(toolCall: AgentToolCall, args: unknown): Promise<BeforeToolCallResult | undefined>;
}

export function createSessionCursorExecBridge(
	sessionRef: { current?: CursorExecBridgeSession },
	getAgent: () => CursorBridgeAgent,
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
		emitEvent: (event: AgentEvent) => {
			void getAgent().emitExternalEvent(event);
		},
		getAbortSignal: () => getAgent().signal,
	});
}
