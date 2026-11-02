import { fetchCursorUsableModels, stream, streamSimple } from "./api/cursor-agent.ts";

/**
 * Statically imported cursor-agent module for the Bun binary build, where the
 * lazy wrapper's variable-specifier import cannot be bundled.
 */
export const cursorAgentProviderModule = {
	stream,
	streamSimple,
	fetchCursorUsableModels,
};
