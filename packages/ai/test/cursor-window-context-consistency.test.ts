import { describe, expect, it } from "vitest";
import { CURSOR_MODEL_CAPABILITIES } from "../src/cursor/model-capabilities.ts";
import { resolveCursorSelectionDescriptor } from "../src/cursor/selection-descriptor.ts";

const CONTEXT_TOKENS: Record<string, number> = {
	"1m": 1_000_000,
	"300k": 300_000,
	"272k": 272_000,
	"256k": 256_000,
	"200k": 200_000,
};

function model(capabilityId: string) {
	return {
		id: capabilityId,
		provider: "cursor",
		api: "cursor-agent",
		name: capabilityId,
		contextWindow: CURSOR_MODEL_CAPABILITIES[capabilityId]?.window ?? 0,
		maxTokens: 64_000,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: { cursorReasoning: { capabilityId } },
	} as never;
}

describe("advertised window matches the context senpi actually requests", () => {
	it("never advertises more context than the request asks cursor for", () => {
		const drift: string[] = [];
		for (const [family, capability] of Object.entries(CURSOR_MODEL_CAPABILITIES)) {
			if (!capability.parameterOrder.includes("context")) continue;
			const descriptor = resolveCursorSelectionDescriptor(model(family), {
				level: "high",
				source: "explicit",
			});
			const sent = descriptor.parameters?.find((parameter) => parameter.id === "context")?.value;
			if (sent === undefined) continue;
			const requested = CONTEXT_TOKENS[sent];
			if (requested !== undefined && capability.window > requested) {
				drift.push(`${family}: advertises ${capability.window} but requests context=${sent}`);
			}
		}
		expect(drift).toEqual([]);
	});
});
