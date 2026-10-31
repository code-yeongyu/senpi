import { type Api, type AssistantMessage, calculateCost, type Model } from "@earendil-works/pi-ai";
import {
	BUILTIN_SDK_TOOLS,
	mapSdkToolNameToPi,
	mapToolArgs,
	TOOL_EXECUTION_DENIED_MESSAGE,
	translatesBuiltinArguments,
} from "./tools.ts";

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
	/** The name the model emitted, kept until the block closes to pick the argument translation. */
	sdkName?: string;
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

/**
 * A call emitted under a built-in name carries Claude Code's argument shape and is translated into the
 * senpi tool's contract; a call emitted under the MCP name was written against the senpi schema the model
 * saw and passes through verbatim, so a custom schema survives (senpi#4059).
 */
export function mapToolArguments(
	name: string,
	argumentsValue: Record<string, unknown>,
	sdkName: string,
): Record<string, unknown> {
	return translatesBuiltinArguments(sdkName) ? mapToolArgs(name, argumentsValue) : { ...argumentsValue };
}

export function updateUsage(
	model: Model<Api>,
	output: AssistantMessage,
	usage: SdkUsage,
	scope: "request-start" | "request-delta" | "query",
): void {
	if (scope === "request-start") {
		output.usage.input = 0;
		output.usage.output = 0;
		output.usage.cacheRead = 0;
		output.usage.cacheWrite = 0;
	}
	if (usage.input_tokens != null) output.usage.input = usage.input_tokens;
	if (usage.output_tokens != null) output.usage.output = usage.output_tokens;
	if (usage.cache_read_input_tokens != null) output.usage.cacheRead = usage.cache_read_input_tokens;
	if (usage.cache_creation_input_tokens != null) output.usage.cacheWrite = usage.cache_creation_input_tokens;
	output.usage.totalTokens =
		output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
	if (scope !== "query") {
		output.usage.contextUsage = {
			input: output.usage.input + output.usage.cacheRead + output.usage.cacheWrite,
			output: output.usage.output,
		};
	}
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
			contextUsage: null,
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
