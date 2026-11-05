import {
	type Agent,
	type AgentTool,
	type AgentToolResult,
	type AgentToolUpdateCallback,
	BatchStoreMissingError,
	createPreparedToolHost,
	type PreparedAgentToolCall,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { carryPreflightFacts } from "./execution/preflight-carry.ts";

type HostAgent = Pick<Agent, "batchStoreFactory" | "executionScope" | "getExecutionScope" | "onExecutionPipeline">;

export interface ExecuteToolHookResult {
	readonly content?: AgentToolResult<unknown>["content"];
	readonly details?: unknown;
}

export interface ExecuteToolHostSession {
	readonly agent: HostAgent;
	afterHooks(
		prepared: PreparedAgentToolCall,
		result: AgentToolResult<unknown>,
		isError: boolean,
	): Promise<ExecuteToolHookResult | undefined>;
}

export interface ExecuteToolHostOptions {
	readonly signal?: AbortSignal;
	readonly onUpdate?: AgentToolUpdateCallback<unknown>;
}

export interface ExecuteToolHostOutcome {
	readonly result: AgentToolResult<unknown>;
	readonly hook: ExecuteToolHookResult | undefined;
}

type Failure = { readonly error: unknown };

function issuingMessage(prepared: PreparedAgentToolCall): AssistantMessage {
	return {
		role: "assistant",
		content: [prepared.toolCall],
		api: "execute-tool",
		provider: "senpi",
		model: "execute-tool",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function thrownResult(error: unknown): AgentToolResult<unknown> {
	return {
		content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
		details: { isError: true },
	};
}

/**
 * Runs a call `executeTool()` already prepared and preflighted on the in-process prepared ToolHost (S19a). The host
 * freezes the preflighted arguments; the caller's own signal and `onUpdate` reach the body, since `executeTool()` never
 * raced an abort.
 */
export async function runExecuteToolOnHost(
	session: ExecuteToolHostSession,
	prepared: PreparedAgentToolCall,
	options: ExecuteToolHostOptions,
): Promise<ExecuteToolHostOutcome> {
	const openStore = session.agent.batchStoreFactory;
	if (openStore === undefined) throw new BatchStoreMissingError();
	const tool = prepared.tool;
	let failure: Failure | undefined;
	let settled: ExecuteToolHostOutcome | undefined;
	let threw = false;
	const body: AgentTool = Object.create(tool, {
		prepareArguments: { value: undefined },
		execute: {
			value: async (toolCallId: string, args: unknown): Promise<AgentToolResult<unknown>> => {
				try {
					return await tool.execute(toolCallId, args, options.signal, options.onUpdate);
				} catch (error) {
					threw = true;
					return thrownResult(error);
				}
			},
		},
	});
	const host = createPreparedToolHost(
		{
			afterToolFreeze: carryPreflightFacts,
			beforeToolCall: async ({ args }) => {
				carryPreflightFacts(prepared.args, args);
				return undefined;
			},
			afterToolCall: async ({ result, isError }) => {
				try {
					settled = { result, hook: await session.afterHooks(prepared, result, isError || threw) };
				} catch (error) {
					failure = { error };
				}
				return undefined;
			},
			removedToolHints: {},
		},
		openStore,
	);
	const agent = session.agent;
	await host.execute(
		{
			scope: agent.getExecutionScope?.() ?? agent.executionScope,
			calls: [{ ...prepared.toolCall, arguments: prepared.args as typeof prepared.toolCall.arguments }],
			mode: "sequential",
		},
		{
			emit: () => undefined,
			...(agent.onExecutionPipeline === undefined ? {} : { recordWitness: agent.onExecutionPipeline }),
			local: {
				context: { systemPrompt: "", messages: [], tools: [body] },
				assistantMessage: issuingMessage(prepared),
			},
		},
	);
	if (failure !== undefined) throw failure.error;
	if (settled === undefined) {
		throw new Error(`executeTool: the prepared host settled no result for ${prepared.toolCall.name}`);
	}
	return settled;
}
