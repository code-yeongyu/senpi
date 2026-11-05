import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { openMemoryBatchStore } from "../../execution/prepared/memory-batch-store.ts";
import { createPreparedToolHost } from "../../execution/prepared/pipeline-prepared.ts";
import { type ExecutionPipelineWitness, noPreflightCarry } from "../../execution/tool-host.ts";
import type { AgentTool, AgentToolCall, AgentToolResult } from "../../types.ts";

export type WitnessSink = (witness: ExecutionPipelineWitness) => Promise<void> | void;

const CLEARED_ARGUMENTS = Type.Unknown();

function issuingMessage(toolCall: AgentToolCall): AssistantMessage {
	return {
		role: "assistant",
		content: [toolCall],
		api: "agent-harness",
		provider: "agent-harness",
		model: "agent-harness",
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

/**
 * Runs one cleared harness call's body on the in-process prepared ToolHost (S19c), as a one-call batch on its own
 * in-memory ledger. The harness already prepared, validated and hooked the call, so the host passes its arguments
 * through unchanged; `run` owns the harness's own signal, updates and error semantics.
 */
export async function runOnPreparedToolHost<T>(
	toolCall: AgentToolCall,
	scopeId: string,
	recordWitness: WitnessSink | undefined,
	run: (args: unknown) => Promise<{ readonly outcome: T; readonly result: AgentToolResult<unknown> }>,
): Promise<T> {
	let settled: { readonly outcome: T } | undefined;
	const body: AgentTool = {
		name: toolCall.name,
		label: toolCall.name,
		description: toolCall.name,
		parameters: CLEARED_ARGUMENTS,
		execute: async (_toolCallId, args) => {
			const { outcome, result } = await run(args);
			settled = { outcome };
			return result;
		},
	};
	await createPreparedToolHost(
		{ afterToolFreeze: noPreflightCarry, removedToolHints: {} },
		openMemoryBatchStore,
	).execute(
		{ scope: { id: scopeId, root: "" }, calls: [toolCall], mode: "sequential" },
		{
			emit: () => undefined,
			...(recordWitness === undefined ? {} : { recordWitness }),
			local: {
				context: { systemPrompt: "", messages: [], tools: [body] },
				assistantMessage: issuingMessage(toolCall),
			},
		},
	);
	if (settled === undefined) throw new Error(`agent harness: the prepared host ran no body for ${toolCall.name}`);
	return settled.outcome;
}
