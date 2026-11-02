import type { Api, AssistantMessageEventStream, Model, OpenAICompletionsCompat, Tool } from "../types.ts";
import { createXtmlRecoveryStreamParser } from "./protocols/kimi-xtml/recovery-stream.ts";
import { wrapStreamWithKimiThinkingRecovery } from "./protocols/kimi-xtml/thinking-recovery-stream.ts";
import { wrapStreamWithInvokeRecovery } from "./recovery-stream-wrapper.ts";
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
		format === "antml" ||
		format === "kimi-xtml"
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
	if (model.api === "cursor-agent") return false;
	return CLAUDE_MODEL_ID_PATTERN.test(model.id) || KIMI_MODEL_ID_PATTERN.test(model.id);
}

const CLAUDE_MODEL_ID_PATTERN = /(^|[^a-z0-9])claude([^a-z0-9]|$)/i;
const KIMI_MODEL_ID_PATTERN = /(^|[^a-z0-9])kimi([^a-z0-9]|$)/i;

/**
 * Whether the model leaks Kimi XTML channel markers when tool calling fails,
 * selecting the XTML recovery parser over the default invoke recovery parser.
 */
export function hasKimiTextToolCallRecovery<TApi extends Api>(model: Model<TApi>): boolean {
	return KIMI_MODEL_ID_PATTERN.test(model.id);
}

export function wrapStreamWithModelRecovery<TApi extends Api>(
	innerStream: AssistantMessageEventStream,
	model: Model<TApi>,
	tools: readonly Tool[],
): AssistantMessageEventStream {
	const recoveredStream = hasKimiTextToolCallRecovery(model)
		? wrapStreamWithKimiThinkingRecovery(innerStream)
		: innerStream;
	if (!shouldRecoverTextToolCalls(model) || tools.length === 0) return recoveredStream;
	return wrapStreamWithInvokeRecovery(
		recoveredStream,
		tools,
		hasKimiTextToolCallRecovery(model)
			? { createParser: createXtmlRecoveryStreamParser, protocol: "kimi-xtml" }
			: undefined,
	);
}
