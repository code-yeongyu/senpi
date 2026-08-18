// Compatibility re-export. Native Anthropic tool-search ownership moved to the
// shared tool-search builtin; MCP now contributes only its setting gate.

export type {
	AnthropicNativeAdapterDeps,
	AnthropicNativeInjectionConfig,
	NativeToolDefinition,
} from "../../tool-search/native-search.ts";
export {
	ANTHROPIC_MAX_TOOLS,
	ANTHROPIC_TOOL_SEARCH_NAME,
	ANTHROPIC_TOOL_SEARCH_TYPE,
	AnthropicNativeToolSearchAdapter,
	addAnthropicNativeToolSearch,
	buildToolReferenceBlocks,
} from "../../tool-search/native-search.ts";
