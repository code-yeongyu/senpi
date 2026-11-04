import {
	type Agent,
	type AgentToolCallOutcome,
	createToolResultMessage,
	emitToolResultMessage,
	shouldTerminateToolBatch,
	type ToolHost,
} from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { runPreparedBatch } from "./pipeline-prepared-batch.ts";

/** The pipelines a session can run its tool calls on; `legacy` is the agent loop's own scheduler. */
export type ExecutionPipeline = "legacy" | "prepared";

/**
 * The pipeline `SENPI_EXECUTION_PIPELINE` asks for, or `undefined` when it is unset (the default: legacy, no receipts).
 * An unknown value is refused rather than silently running the default.
 */
export function requestedExecutionPipeline(env: NodeJS.ProcessEnv = process.env): ExecutionPipeline | undefined {
	const value = env.SENPI_EXECUTION_PIPELINE;
	if (value === undefined || value === "") return undefined;
	if (value === "legacy" || value === "prepared") return value;
	throw new Error(`SENPI_EXECUTION_PIPELINE must be legacy or prepared, got ${JSON.stringify(value)}`);
}

/**
 * The prepared pipeline as the session's ToolHost (S18b): every model-issued batch runs through the batch coordinator
 * and the prepared executor in this process, with today's events, result messages and source order. A batch the loop
 * runs sequentially runs as consecutive one-call batches, so each call is prepared after the previous one finished.
 */
export function createPreparedToolHost(agent: Agent): ToolHost {
	return {
		async execute(call, options) {
			const { emit, signal, recordWitness, local } = options;
			if (local === undefined) throw new Error("the prepared pipeline runs only in the loop's own process");
			if (recordWitness) {
				for (const raw of call.calls) {
					const pending = recordWitness({ pipeline: "prepared", toolCallId: raw.id });
					if (pending) await pending;
				}
			}
			const batch = (calls: typeof call.calls) =>
				runPreparedBatch({
					agent,
					calls,
					scope: call.scope,
					context: local.context,
					assistantMessage: local.assistantMessage,
					emit,
					...(signal === undefined ? {} : { signal }),
				});
			const outcomes: AgentToolCallOutcome[] = [];
			const messages: ToolResultMessage[] = [];
			const report = async (finished: readonly AgentToolCallOutcome[]): Promise<void> => {
				for (const outcome of finished) {
					const message = createToolResultMessage(outcome);
					await emitToolResultMessage(message, emit);
					outcomes.push(outcome);
					messages.push(message);
				}
			};
			if (call.mode === "sequential") {
				for (const raw of call.calls) {
					await report(await batch([raw]));
					if (signal?.aborted) break;
				}
			} else await report(await batch(call.calls));
			return { messages, terminate: shouldTerminateToolBatch(outcomes) };
		},
	};
}
