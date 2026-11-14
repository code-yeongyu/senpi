import {
	type Agent,
	type AgentTool,
	type AgentToolResult,
	type AgentToolUpdateCallback,
	BatchStoreMissingError,
	createPreparedToolHost,
	noPreflightCarry,
	type PreparedAgentToolCall,
	toStoreValue,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";

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

/** Why the host cannot record these arguments as JSON (a BigInt, a cycle), or undefined when it can (senpi#5861). */
export function unrecordableArguments(args: unknown): string | undefined {
	try {
		toStoreValue(args);
		return undefined;
	} catch (error) {
		return `Tool arguments are not JSON: ${error instanceof Error ? error.message : String(error)}`;
	}
}

/**
 * Runs a call `executeTool()` already prepared and preflighted on the in-process prepared ToolHost (S19a). The host
 * records a JSON copy of the preflighted arguments, while the body runs on the preflighted object itself, as before
 * the host (senpi#5861): a hook's non-JSON value and the body's in-place edits reach the body and the `tool_result`
 * chain unchanged. The caller's own signal and `onUpdate` reach the body, since `executeTool()` never raced an abort.
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
		// The `tool_call` chain may rewrite the arguments, and its contract is that they are not validated again.
		parameters: { value: PREFLIGHTED_ARGUMENTS },
		execute: {
			value: async (toolCallId: string): Promise<AgentToolResult<unknown>> => {
				try {
					return await tool.execute(toolCallId, prepared.args, options.signal, options.onUpdate);
				} catch (error) {
					threw = true;
					return thrownResult(error);
				}
			},
		},
	});
	const host = createPreparedToolHost(
		{
			// The body never sees the host's copies, so no preflight fact needs carrying to them.
			afterToolFreeze: noPreflightCarry,
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
