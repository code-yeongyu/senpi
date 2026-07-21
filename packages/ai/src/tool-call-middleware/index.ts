import type { Api, Model, OpenAICompletionsCompat } from "../types.ts";
import type { ToolCallFormat } from "./types.ts";

export { getProtocol, transformContext } from "./context-transformer.ts";
export { wrapStreamWithToolCallMiddleware } from "./stream-wrapper.ts";
export type {
	ParsedToolCall,
	StreamParser,
	StreamParserEvent,
	ToolCallFormat,
	ToolCallProtocol,
	ToolResultContent,
} from "./types.ts";

/**
 * Extracts the tool call format from a model's compatibility settings.
 * Only applies to models using the "openai-completions" API with compat settings.
 * @param model - The model to check
 * @returns The configured supported tool call format, or undefined if not set. "morph-xml" is canonical; "xml" remains a deprecated alias.
 */
export function getToolCallFormat<TApi extends Api>(model: Model<TApi>): ToolCallFormat | undefined {
	if (model.api !== "openai-completions") {
		return undefined;
	}
	const compat = model.compat as OpenAICompletionsCompat | undefined;
	const format = compat?.toolCallFormat;
	if (!format) {
		return undefined;
	}
	if (
		format === "hermes" ||
		format === "xml" ||
		format === "morph-xml" ||
		format === "yaml-xml" ||
		format === "gemma4-delimiter" ||
		format === "anthropic-xml" ||
		format === "antml"
	) {
		return format;
	}
	return undefined;
}

export function shouldRecoverTextToolCalls<TApi extends Api>(model: Model<TApi>): boolean {
	if (getToolCallFormat(model) !== undefined) return false;
	if (model.recoverTextToolCalls !== undefined) {
		return typeof model.recoverTextToolCalls === "boolean" ? model.recoverTextToolCalls : false;
	}
	return /(^|[^a-z0-9])claude([^a-z0-9]|$)/i.test(model.id);
}
