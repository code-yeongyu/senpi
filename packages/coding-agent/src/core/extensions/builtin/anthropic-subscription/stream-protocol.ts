import { type Api, type AssistantMessage, calculateCost, type Model } from "@earendil-works/pi-ai";
import { BUILTIN_SDK_TOOLS, mapSdkToolNameToPi, mapToolArgs, TOOL_EXECUTION_DENIED_MESSAGE } from "./tools.ts";

/** @deprecated Resolve the active Context.tools allowlist through resolveSdkTools(). */
export const sdkTools = [...BUILTIN_SDK_TOOLS];
/** @deprecated Use TOOL_EXECUTION_DENIED_MESSAGE from tools.ts. */
export const toolExecutionDeniedMessage = TOOL_EXECUTION_DENIED_MESSAGE;

export type TextBlock = { type: "text"; text: string; index?: number };
export type ThinkingBlock = { type: "thinking"; thinking: string; thinkingSignature: string; index?: number };
export type ToolBlock = {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	partialJson?: string;
	index?: number;
};
export type StreamBlock = TextBlock | ThinkingBlock | ToolBlock;

type SdkUsage = {
	input_tokens?: number | null;
	output_tokens?: number | null;
	cache_read_input_tokens?: number | null;
	cache_creation_input_tokens?: number | null;
};

export function mapStopReason(reason: string | null | undefined): "stop" | "length" | "toolUse" {
	if (reason === "tool_use") return "toolUse";
	if (reason === "max_tokens") return "length";
	return "stop";
}

export function mapToolName(name: string): string {
	return mapSdkToolNameToPi(name);
}

export function asRecord(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

export function mapToolArguments(name: string, argumentsValue: Record<string, unknown>): Record<string, unknown> {
	return mapToolArgs(name, argumentsValue);
}

/** Token counts of the responses a query streamed before the current one (see `updateUsage`). */
export type UsageBase = { input: number; output: number; cacheRead: number; cacheWrite: number };

export function usageBaseOf(output: AssistantMessage): UsageBase {
	const { input, output: outputTokens, cacheRead, cacheWrite } = output.usage;
	return { input, output: outputTokens, cacheRead, cacheWrite };
}

/**
 * Applies one SDK usage report. The API counts every response from zero, so when a query streams a second
 * response (Claude Code's output-limit continuation) the caller passes the earlier responses' totals as
 * `base`; a field the report omits keeps its current value.
 */
export function updateUsage(model: Model<Api>, output: AssistantMessage, usage: SdkUsage, base?: UsageBase): void {
	if (usage.input_tokens != null) output.usage.input = usage.input_tokens + (base?.input ?? 0);
	if (usage.output_tokens != null) output.usage.output = usage.output_tokens + (base?.output ?? 0);
	if (usage.cache_read_input_tokens != null)
		output.usage.cacheRead = usage.cache_read_input_tokens + (base?.cacheRead ?? 0);
	if (usage.cache_creation_input_tokens != null)
		output.usage.cacheWrite = usage.cache_creation_input_tokens + (base?.cacheWrite ?? 0);
	output.usage.totalTokens =
		output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
	calculateCost(model, output.usage);
}

export function emptyOutput(model: Model<Api>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
