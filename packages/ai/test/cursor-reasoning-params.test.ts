import { describe, expect, it } from "vitest";
import { resolveCursorSelectionDescriptor } from "../src/cursor/selection-descriptor.ts";
import type { CursorAgentCompat, Model } from "../src/model.ts";
import type { ThinkingSelection } from "../src/types.ts";

function cursorModel(id: string, compat?: CursorAgentCompat, upstreamModelId?: string): Model<"cursor-agent"> {
	return {
		id,
		name: id,
		api: "cursor-agent",
		provider: "cursor",
		baseUrl: "https://api2.cursor.sh",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 300000,
		maxTokens: 64000,
		...(upstreamModelId ? { upstreamModelId } : {}),
		...(compat ? { compat } : {}),
	};
}

const fableThinkingCompat: CursorAgentCompat = {
	cursorReasoning: {
		capabilityId: "claude-fable-5",
		thinkingMode: true,
		representativeVariantId: "claude-fable-5-thinking-medium",
	},
};

const gpt55Compat: CursorAgentCompat = {
	cursorReasoning: { capabilityId: "gpt-5.5", representativeVariantId: "gpt-5.5-medium" },
};

function explicit(level: ThinkingSelection["level"]): ThinkingSelection {
	return { level, source: "explicit" };
}

describe("resolveCursorSelectionDescriptor", () => {
	it("prefers the thinking suffix alias for anthropic explicit levels", () => {
		const out = resolveCursorSelectionDescriptor(
			cursorModel("claude-fable-5-thinking", fableThinkingCompat),
			explicit("low"),
		);
		expect(out).toEqual({ modelId: "claude-fable-5-thinking-low", parameters: [] });
	});

	it("prefers the plain suffix alias for the non-thinking Claude identity", () => {
		const compat: CursorAgentCompat = {
			cursorReasoning: {
				capabilityId: "claude-fable-5",
				thinkingMode: false,
				representativeVariantId: "claude-fable-5-medium",
			},
		};
		const out = resolveCursorSelectionDescriptor(cursorModel("claude-fable-5", compat), explicit("max"));
		expect(out).toEqual({ modelId: "claude-fable-5-max", parameters: [] });
	});

	it("translates xhigh to the extra-high suffix alias for gpt-5.5", () => {
		const out = resolveCursorSelectionDescriptor(cursorModel("gpt-5.5", gpt55Compat), explicit("xhigh"));
		expect(out).toEqual({ modelId: "gpt-5.5-extra-high", parameters: [] });
	});

	it("falls back to the level-token suffix alias when the value suffix is absent (codex xhigh)", () => {
		const compat: CursorAgentCompat = {
			cursorReasoning: { capabilityId: "gpt-5.3-codex", representativeVariantId: "gpt-5.3-codex-high" },
		};
		const out = resolveCursorSelectionDescriptor(cursorModel("gpt-5.3-codex", compat), explicit("xhigh"));
		expect(out).toEqual({ modelId: "gpt-5.3-codex-xhigh", parameters: [] });
	});

	it("renders gemini/grok/glm/kimi families as catalog suffix variant ids", () => {
		const gemini = resolveCursorSelectionDescriptor(
			cursorModel("gemini-3.7-flash", {
				cursorReasoning: { capabilityId: "gemini-3.7-flash", representativeVariantId: "gemini-3.7-flash-medium" },
			}),
			explicit("low"),
		);
		expect(gemini).toEqual({ modelId: "gemini-3.7-flash-low", parameters: [] });
		const grok = resolveCursorSelectionDescriptor(
			cursorModel("cursor-grok-4.6", {
				cursorReasoning: { capabilityId: "cursor-grok-4.6", representativeVariantId: "cursor-grok-4.6-medium" },
			}),
			explicit("xhigh"),
		);
		expect(grok).toEqual({ modelId: "cursor-grok-4.6-xhigh", parameters: [] });
		const glm = resolveCursorSelectionDescriptor(
			cursorModel("glm-5.2", {
				cursorReasoning: { capabilityId: "glm-5.2", representativeVariantId: "glm-5.2-high" },
			}),
			explicit("max"),
		);
		expect(glm).toEqual({ modelId: "glm-5.2-max", parameters: [] });
		const kimi = resolveCursorSelectionDescriptor(
			cursorModel("kimi-k3", {
				cursorReasoning: { capabilityId: "kimi-k3", representativeVariantId: "kimi-k3-high" },
			}),
			explicit("low"),
		);
		expect(kimi).toEqual({ modelId: "kimi-k3-low", parameters: [] });
	});

	it("falls back to bare base id plus ordered parameters when no suffix alias exists", () => {
		const out = resolveCursorSelectionDescriptor(
			cursorModel("claude-opus-5", {
				cursorReasoning: {
					capabilityId: "claude-opus-5",
					thinkingMode: false,
					representativeVariantId: "claude-opus-5-medium",
				},
			}),
			explicit("xhigh"),
		);
		expect(out).toEqual({
			modelId: "claude-opus-5",
			parameters: [
				{ id: "thinking", value: "false" },
				{ id: "context", value: "1m" },
				{ id: "effort", value: "xhigh" },
			],
		});
	});

	it("renders supported explicit off as the none suffix alias", () => {
		const out = resolveCursorSelectionDescriptor(cursorModel("gpt-5.5", gpt55Compat), explicit("off"));
		expect(out).toEqual({ modelId: "gpt-5.5-none", parameters: [] });
	});

	it("emits no parameters for off on descriptors without none", () => {
		const out = resolveCursorSelectionDescriptor(
			cursorModel("claude-fable-5-thinking", fableThinkingCompat),
			explicit("off"),
		);
		expect(out).toEqual({ modelId: "claude-fable-5-thinking-medium", parameters: [] });
	});

	it("emits no parameters and the representative variant when selection is absent", () => {
		expect(resolveCursorSelectionDescriptor(cursorModel("gpt-5.5", gpt55Compat), undefined)).toEqual({
			modelId: "gpt-5.5-medium",
			parameters: [],
		});
	});

	it("emits the exact legacy variant for legacy-variant selections", () => {
		const out = resolveCursorSelectionDescriptor(cursorModel("gpt-5.5", gpt55Compat), {
			level: "xhigh",
			source: "legacy-variant",
			legacyVariantId: "gpt-5.5-extra-high",
		});
		expect(out).toEqual({ modelId: "gpt-5.5-extra-high", parameters: [] });
	});

	it("emits the concrete suffix id for variant-id levels", () => {
		const grok45 = resolveCursorSelectionDescriptor(
			cursorModel("cursor-grok-4.5", {
				cursorReasoning: { capabilityId: "cursor-grok-4.5", representativeVariantId: "cursor-grok-4.5-medium" },
			}),
			explicit("high"),
		);
		expect(grok45).toEqual({ modelId: "cursor-grok-4.5-high", parameters: [] });
		const gpt52 = resolveCursorSelectionDescriptor(
			cursorModel("gpt-5.2", {
				cursorReasoning: { capabilityId: "gpt-5.2", representativeVariantId: "gpt-5.2-high" },
			}),
			explicit("xhigh"),
		);
		expect(gpt52).toEqual({ modelId: "gpt-5.2-xhigh", parameters: [] });
	});

	it("falls back to upstreamModelId ?? id with no parameters for unknown or unsupported models", () => {
		expect(resolveCursorSelectionDescriptor(cursorModel("composer-2.5"), undefined)).toEqual({
			modelId: "composer-2.5",
			parameters: [],
		});
		expect(
			resolveCursorSelectionDescriptor(
				cursorModel("custom-thing", undefined, "custom-thing-upstream"),
				explicit("high"),
			),
		).toEqual({
			modelId: "custom-thing-upstream",
			parameters: [],
		});
	});

	it("falls back safely for unsupported explicit levels on a capable model", () => {
		const out = resolveCursorSelectionDescriptor(
			cursorModel("glm-5.2", {
				cursorReasoning: { capabilityId: "glm-5.2", representativeVariantId: "glm-5.2-high" },
			}),
			explicit("minimal"),
		);
		expect(out).toEqual({ modelId: "glm-5.2-high", parameters: [] });
	});

	it("does not mutate inputs and is byte-order stable across calls", () => {
		const model = cursorModel("gpt-5.5", gpt55Compat);
		const selection = explicit("high");
		const first = resolveCursorSelectionDescriptor(model, selection);
		const second = resolveCursorSelectionDescriptor(model, selection);
		expect(first).toEqual(second);
		expect(JSON.stringify(first)).toBe(JSON.stringify(second));
		expect(gpt55Compat.cursorReasoning?.representativeVariantId).toBe("gpt-5.5-medium");
	});
});
