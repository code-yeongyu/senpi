import type { Api, Model, OpenAICompletionsCompat } from "../types.js";
import type { ToolCallFormat } from "./types.js";

export { getProtocol, transformContext } from "./context-transformer.js";
export { wrapStreamWithToolCallMiddleware } from "./stream-wrapper.js";
export type {
	ParsedToolCall,
	StreamParser,
	StreamParserEvent,
	ToolCallFormat,
	ToolCallProtocol,
	ToolResultContent,
} from "./types.js";

/**
 * Extracts the tool call format from a model's compatibility settings.
 * Only applies to models using the "openai-completions" API with compat settings.
 * @param model - The model to check
 * @returns The tool call format ("hermes", "xml", "yaml-xml", or "gemma4-delimiter") or undefined if not set
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
	if (format === "hermes" || format === "xml" || format === "yaml-xml" || format === "gemma4-delimiter") {
		return format;
	}
	return undefined;
}
