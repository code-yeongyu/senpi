import { describe, expect, it } from "vitest";
import { resolveCursorSelectionDescriptor } from "../src/cursor/selection-descriptor.ts";
import type { Model } from "../src/types.ts";

describe("resolveCursorSelectionDescriptor suffix ids", () => {
	it("sends claude-fable-5-medium instead of the bare capability id", () => {
		const model = {
			id: "claude-fable-5",
			name: "fable",
			api: "cursor-agent",
			provider: "cursor",
			baseUrl: "https://api2.cursor.sh",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200000,
			maxTokens: 16,
			compat: {
				cursorReasoning: {
					capabilityId: "claude-fable-5",
					thinkingMode: true,
					representativeVariantId: "claude-fable-5-medium",
				},
			},
		} as Model<"cursor-agent">;
		const resolved = resolveCursorSelectionDescriptor(model, { source: "explicit", level: "medium" });
		expect(resolved.modelId).toBe("claude-fable-5-medium");
		expect(resolved.parameters).toEqual([]);
	});
});
