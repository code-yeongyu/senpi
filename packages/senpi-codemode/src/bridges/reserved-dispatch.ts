import type { AgentToolResult, EvalHandleHost } from "@code-yeongyu/senpi";
import { RESERVED_AGENT_TOOL, RESERVED_OUTPUT_TOOL, RESERVED_SCHEMA_TOOL } from "../bridge/reserved.ts";
import type { HandleRegistry } from "../handles/handle-registry.ts";
import type { EvalStatusEvent, ExecuteTool } from "../tool/types.ts";
import { type AgentExecuteTool, runEvalAgent } from "./agent-bridge.ts";
import { isHandleToolName, runHandleTool } from "./handle-bridge.ts";
import { type MarshalledToolResult, type OutputExecuteTool, runEvalOutput } from "./output-bridge.ts";
import { type EvalSchemaToolInfo, runEvalSchema } from "./schema-bridge.ts";

export interface ReservedDispatchContext {
	readonly callId: string;
	readonly args: unknown;
	readonly executeTool: AgentExecuteTool & OutputExecuteTool & ExecuteTool;
	readonly taskToolName: string;
	readonly taskOutputToolName: string;
	readonly listTools: (() => readonly EvalSchemaToolInfo[]) | undefined;
	readonly signal: AbortSignal | undefined;
	readonly emitStatus: (event: EvalStatusEvent) => void;
	readonly marshalToolResult: (result: AgentToolResult<unknown>) => MarshalledToolResult;
	/** The session generation's handle registry; `wait()`/`handle()` fail with `eval_wait_unavailable` without one. */
	readonly handles?: HandleRegistry;
	/** `ctx.evalHandleHost` at dispatch time; agent/workpool refs need it, completion refs do not. */
	readonly evalHandleHost?: EvalHandleHost;
}

class SchemaUnavailableError extends Error {
	readonly name = "SchemaUnavailableError";

	constructor() {
		super("tool_schema() unavailable: this session does not expose a tool catalog");
	}
}

export function isReservedToolName(toolName: string): boolean {
	return (
		toolName === RESERVED_AGENT_TOOL ||
		toolName === RESERVED_OUTPUT_TOOL ||
		toolName === RESERVED_SCHEMA_TOOL ||
		isHandleToolName(toolName)
	);
}

export async function runReservedTool(toolName: string, context: ReservedDispatchContext): Promise<unknown> {
	if (isHandleToolName(toolName)) {
		return await runHandleTool(toolName, context.args, {
			registry: context.handles,
			host: context.evalHandleHost,
			signal: context.signal,
		});
	}
	if (toolName === RESERVED_AGENT_TOOL) {
		return await runEvalAgent(context.args, {
			callId: context.callId,
			taskToolName: context.taskToolName,
			executeTool: context.executeTool,
			...(context.listTools === undefined ? {} : { listTools: context.listTools }),
			...(context.signal === undefined ? {} : { signal: context.signal }),
			emitStatus: context.emitStatus,
		});
	}
	if (toolName === RESERVED_OUTPUT_TOOL) {
		return await runEvalOutput(context.args, {
			taskOutputToolName: context.taskOutputToolName,
			executeTool: context.executeTool,
			...(context.signal === undefined ? {} : { signal: context.signal }),
			marshalToolResult: context.marshalToolResult,
		});
	}
	if (toolName === RESERVED_SCHEMA_TOOL) {
		const listTools = context.listTools;
		if (listTools === undefined) throw new SchemaUnavailableError();
		return runEvalSchema(context.args, { listTools });
	}
	throw new Error(`runReservedTool received a non-reserved tool name: ${toolName}`);
}
