import type { AgentToolResult } from "@code-yeongyu/senpi";
import { type AgentExecuteTool, type EvalAgentResult, runEvalAgent } from "../../src/bridges/agent-bridge.ts";
import type { EvalStatusEvent, ExecuteTool } from "../../src/tool/types.ts";

export function textResult(text: string, details: unknown = {}): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details };
}

export function withAvailability(
	executeTool: ExecuteTool,
	isToolAvailable: (name: string) => boolean,
): AgentExecuteTool {
	return Object.assign(executeTool, { isToolAvailable });
}

type AgentHarness = {
	readonly executeTool: AgentExecuteTool;
	readonly taskToolName?: string;
	readonly signal?: AbortSignal;
	readonly emitStatus?: (event: EvalStatusEvent) => void;
};

export function invokeAgent(args: unknown, harness: AgentHarness): Promise<EvalAgentResult> {
	return runEvalAgent(args, {
		callId: "agent-call-1",
		taskToolName: harness.taskToolName ?? "task",
		executeTool: harness.executeTool,
		...(harness.signal ? { signal: harness.signal } : {}),
		...(harness.emitStatus ? { emitStatus: harness.emitStatus } : {}),
	});
}
