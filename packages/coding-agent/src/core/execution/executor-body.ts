import type {
	AgentContext,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
	AgentToolUpdateCallback,
} from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { PreparationPipeline } from "./executor-types.ts";

/** What release needs from preparation; it lives in memory with the executor that prepared the call. */
export interface PreparedBody {
	readonly tool: AgentTool;
	readonly toolCall: AgentToolCall;
	readonly args: unknown;
	readonly assistantMessage: AssistantMessage;
	readonly context: AgentContext;
	/** The model's own name when it resolved to another tool; today's result carries a correction notice for it. */
	readonly requestedName?: string;
}

export interface BodyOutcome {
	readonly result: AgentToolResult<unknown>;
	readonly isError: boolean;
}

export function errorResult(message: string): AgentToolResult<unknown> {
	return { content: [{ type: "text", text: message }], details: {} };
}

export function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const ABORTED = Symbol("aborted");

// Today's body semantics (agent-loop `executePreparedToolCall`): an abort releases the wait even when the tool never
// settles, and updates stop at settlement.
export async function runBody(
	body: PreparedBody,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<unknown>,
): Promise<BodyOutcome> {
	const updates: Promise<void>[] = [];
	let accepting = true;
	try {
		const execution = body.tool.execute(body.toolCall.id, body.args, signal, (partial) => {
			if (accepting) updates.push(Promise.resolve(onUpdate(partial)));
		});
		const aborted =
			signal === undefined
				? undefined
				: new Promise<typeof ABORTED>((resolve) => {
						if (signal.aborted) resolve(ABORTED);
						else signal.addEventListener("abort", () => resolve(ABORTED), { once: true });
					});
		const settled = aborted ? await Promise.race([execution, aborted]) : await execution;
		accepting = false;
		await Promise.all(updates);
		if (settled === ABORTED) {
			void Promise.resolve(execution).catch(() => undefined);
			return { result: errorResult("Tool execution aborted"), isError: true };
		}
		return { result: settled, isError: settled.isError === true };
	} catch (error) {
		accepting = false;
		await Promise.all(updates);
		return { result: errorResult(messageOf(error)), isError: true };
	}
}

// Today's after-hook merge (agent-loop `finalizeExecutedToolCall`), field by field.
export async function finalizeBody(
	body: PreparedBody,
	executed: BodyOutcome,
	pipeline: PreparationPipeline,
	signal: AbortSignal | undefined,
): Promise<BodyOutcome> {
	const { result, isError } = executed;
	try {
		const after = await pipeline.afterToolCall(
			{
				assistantMessage: body.assistantMessage,
				toolCall: body.toolCall,
				args: body.args,
				result,
				isError,
				context: body.context,
			},
			signal,
		);
		if (!after) return executed;
		const structuredContent = after.structuredContent ?? (after.content ? undefined : result.structuredContent);
		const merged: AgentToolResult<unknown> = {
			...result,
			content: after.content ?? result.content,
			details: after.details ?? result.details,
			usage: after.usage ?? result.usage,
			terminate: after.terminate ?? result.terminate,
		};
		if (structuredContent === undefined) delete merged.structuredContent;
		else merged.structuredContent = structuredContent;
		return { result: merged, isError: after.isError ?? isError };
	} catch (error) {
		return { result: errorResult(messageOf(error)), isError: true };
	}
}
