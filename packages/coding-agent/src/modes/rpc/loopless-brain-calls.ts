import type { PromptSurface } from "../../core/dynamic-prompt/build.ts";

/** What the session that issued a call says about itself, sent with the call (senpi#6921). */
export interface LooplessCallFacts {
	/** Its prompt surface: what its host does with the result, which the call's tool reports. */
	readonly promptSurface?: PromptSurface;
}

/**
 * The calls a loopless runtime runs for the brain, while they run, with what the brain sent with each. Every call its
 * `execute` runs was issued by the brain's model: the brain's remote tool host is its agent loop's toolHost, and nested
 * calls, pi.executeTool() and Cursor exec frames run on the brain's own hosts (senpi#6919).
 */
export function createBrainCalls() {
	const running = new Map<string, LooplessCallFacts>();
	return {
		isModelIssuedToolCall: (toolCallId: string): boolean => running.has(toolCallId),
		promptSurfaceOf: (toolCallId: string): PromptSurface | undefined => running.get(toolCallId)?.promptSurface,
		run<T>(toolCallId: string, facts: LooplessCallFacts | undefined, call: () => Promise<T>): Promise<T> {
			running.set(toolCallId, facts ?? {});
			return call().finally(() => running.delete(toolCallId));
		},
	};
}
