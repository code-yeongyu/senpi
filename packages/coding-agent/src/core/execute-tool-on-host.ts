import {
	type Agent,
	type AgentLoopConfig,
	type AgentTool,
	type AgentToolCall,
	type AgentToolResult,
	type AgentToolUpdateCallback,
	BatchStoreMissingError,
	createPreparedToolHost,
	type PreparedAgentToolCall,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
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

const PREFLIGHTED_ARGUMENTS = Type.Unknown();

function issuingMessage(toolCall: AgentToolCall): AssistantMessage {
	return {
		role: "assistant",
		content: [toolCall],
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

/** `tool`, as the host runs it: `execute` runs the body, and the already-prepared arguments are not prepared again. */
function hostBody(
	tool: AgentTool,
	execute: (toolCallId: string, args: unknown) => Promise<AgentToolResult<unknown>>,
): AgentTool {
	return Object.create(tool, {
		prepareArguments: { value: undefined },
		// The `tool_call` chain may rewrite the arguments, and its contract is that they are not validated again.
		parameters: { value: PREFLIGHTED_ARGUMENTS },
		execute: { value: execute },
	});
}

/**
 * Runs one already-prepared, preflighted call as a one-call sequential batch on the in-process prepared ToolHost, with
 * the agent's batch store, execution scope and witness sink. The host's `beforeToolCall` only carries the preflight
 * facts from `args` to its copy of them.
 */
async function runOnHost(
	agent: HostAgent,
	toolCall: AgentToolCall,
	args: unknown,
	body: AgentTool,
	afterToolCall?: AgentLoopConfig["afterToolCall"],
): Promise<void> {
	const openStore = agent.batchStoreFactory;
	if (openStore === undefined) throw new BatchStoreMissingError();
	const host = createPreparedToolHost(
		{
			afterToolFreeze: carryPreflightFacts,
			beforeToolCall: async ({ args: hostArgs }) => {
				carryPreflightFacts(args, hostArgs);
				return undefined;
			},
			...(afterToolCall === undefined ? {} : { afterToolCall }),
			removedToolHints: {},
		},
		openStore,
	);
	await host.execute(
		{
			scope: agent.getExecutionScope?.() ?? agent.executionScope,
			calls: [{ ...toolCall, arguments: args as AgentToolCall["arguments"] }],
			mode: "sequential",
		},
		{
			emit: () => undefined,
			...(agent.onExecutionPipeline === undefined ? {} : { recordWitness: agent.onExecutionPipeline }),
			local: {
				context: { systemPrompt: "", messages: [], tools: [body] },
				assistantMessage: issuingMessage(toolCall),
			},
		},
	);
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
	const tool = prepared.tool;
	let failure: Failure | undefined;
	let settled: ExecuteToolHostOutcome | undefined;
	let threw = false;
	const body = hostBody(tool, async (toolCallId, args) => {
		try {
			return await tool.execute(toolCallId, args, options.signal, options.onUpdate);
		} catch (error) {
			threw = true;
			return thrownResult(error);
		}
	});
	await runOnHost(session.agent, prepared.toolCall, prepared.args, body, async ({ result, isError }) => {
		try {
			settled = { result, hook: await session.afterHooks(prepared, result, isError || threw) };
		} catch (error) {
			failure = { error };
		}
		return undefined;
	});
	if (failure !== undefined) throw failure.error;
	if (settled === undefined) {
		throw new Error(`executeTool: the prepared host settled no result for ${prepared.toolCall.name}`);
	}
	return settled;
}

/**
 * `tool` for a nested `ctx.executeTool()` call (S19a): its body runs on the in-process prepared ToolHost. `runToolCall`
 * still does everything around the body as before (preparation, validation, the `tool_call` preflight, the abort race,
 * update gating, error conversion and the `tool_result` hooks), and the body gets the signal and update callback
 * `runToolCall` passed. A thrown body is rethrown, so `runToolCall` converts it as before.
 */
export function nestedToolOnHost(agent: HostAgent, tool: AgentTool): AgentTool {
	const execute = async (
		toolCallId: string,
		args: unknown,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<unknown>,
	): Promise<AgentToolResult<unknown>> => {
		let failure: Failure | undefined;
		let settled: AgentToolResult<unknown> | undefined;
		const body = hostBody(tool, async (id, frozen) => {
			try {
				settled = await tool.execute(id, frozen, signal, onUpdate);
				return settled;
			} catch (error) {
				failure = { error };
				return thrownResult(error);
			}
		});
		const toolCall: AgentToolCall = {
			type: "toolCall",
			id: toolCallId,
			name: tool.name,
			arguments: args as AgentToolCall["arguments"],
		};
		await runOnHost(agent, toolCall, args, body);
		if (failure !== undefined) throw failure.error;
		if (settled === undefined) throw new Error(`the prepared host settled no result for ${tool.name}`);
		return settled;
	};
	return Object.create(tool, { execute: { value: execute } });
}
