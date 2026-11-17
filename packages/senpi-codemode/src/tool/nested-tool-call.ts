import { sanitizeTerminalLabel } from "@code-yeongyu/senpi";
import type { KernelToHostMessage } from "../bridge/protocol.ts";
import type { AgentExecuteTool } from "../bridges/agent-bridge.ts";
import { capCodePoints, toolCallResultPreview } from "./call-capture.ts";
import type { CellResultBuilder } from "./cell-runtime.ts";
import { marshalToolResult, toolResultIsError } from "./image.ts";

export type ResolvedToolReply = {
	readonly value: unknown;
	readonly toolCallOk: boolean;
	readonly resultPreview?: string;
	readonly errorText?: string;
};

/** Runs an ordinary host tool for a JS cell; its partial results stream into the cell's live update (#6167). */
export async function runNestedTool(
	executeTool: AgentExecuteTool,
	message: Extract<KernelToHostMessage, { type: "tool-call" }>,
	signal: AbortSignal,
	live: CellResultBuilder,
): Promise<ResolvedToolReply> {
	const result = await executeTool(message.toolName, message.args, {
		signal,
		onUpdate: (partial) => live.nestedToolUpdate(message.callId, partial),
	}).finally(() => live.dropNestedTool(message.callId));
	const toolCallOk = !toolResultIsError(result);
	if (toolCallOk) {
		const resultPreview = toolCallResultPreview(result);
		return {
			value: marshalToolResult(result),
			toolCallOk,
			...(resultPreview === undefined ? {} : { resultPreview }),
		};
	}
	let errorText: string | undefined;
	for (const part of result.content) {
		if (part.type !== "text") continue;
		errorText = capCodePoints(sanitizeTerminalLabel(part.text), 512);
		break;
	}
	return {
		value: marshalToolResult(result),
		toolCallOk,
		...(errorText === undefined ? {} : { errorText }),
	};
}
