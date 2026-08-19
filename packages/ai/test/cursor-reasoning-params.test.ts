import { describe, expect, it } from "vitest";
import {
	renderCursorCliModelString,
	resolveCursorSelectionDescriptor,
} from "../src/cursor/selection-descriptor.ts";
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
	it("renders the anthropic template in canonical order", () => {
		const out = resolveCursorSelectionDescriptor(
			cursorModel("claude-fable-5-thinking", fableThinkingCompat),
			explicit("low"),
		);
		expect(out).toEqual({
			modelId: "claude-fable-5-thinking-low",
			cliModelId: "claude-fable-5",
			parameters: [
				{ id: "thinking", value: "true" },
				{ id: "context", value: "1m" },
				{ id: "effort", value: "low" },
			],
		});
	});

	it("renders the Claude 4.6 thinking infix after the level", () => {
		const compat: CursorAgentCompat = {
			cursorReasoning: {
				capabilityId: "claude-4.6-opus",
				thinkingMode: true,
				representativeVariantId: "claude-4.6-opus-high-thinking",
			},
		};
		const out = resolveCursorSelectionDescriptor(
			cursorModel("claude-4.6-opus-thinking", compat),
			explicit("max"),
		);
		expect(out?.modelId).toBe("claude-4.6-opus-max-thinking");
		expect(out?.cliModelId).toBe("claude-4.6-opus");
	});

	it("fixes thinking=false for the non-thinking Claude identity", () => {
		const compat: CursorAgentCompat = {
			cursorReasoning: {
				capabilityId: "claude-fable-5",
				thinkingMode: false,
				representativeVariantId: "claude-fable-5-medium",
			},
		};
		const out = resolveCursorSelectionDescriptor(cursorModel("claude-fable-5", compat), explicit("max"));
		expect(out).toEqual({
			modelId: "claude-fable-5-max",
			cliModelId: "claude-fable-5",
			parameters: [
				{ id: "thinking", value: "false" },
				{ id: "context", value: "1m" },
				{ id: "effort", value: "max" },
			],
		});
	});

	it("renders the gpt template with context/reasoning/fast and translates xhigh to extra-high for gpt-5.5", () => {
		const out = resolveCursorSelectionDescriptor(cursorModel("gpt-5.5", gpt55Compat), explicit("xhigh"));
		expect(out).toEqual({
			modelId: "gpt-5.5-extra-high",
			cliModelId: "gpt-5.5",
			parameters: [
				{ id: "context", value: "1m" },
				{ id: "reasoning", value: "extra-high" },
				{ id: "fast", value: "false" },
			],
		});
	});

	it("renders codex without a context parameter", () => {
		const compat: CursorAgentCompat = {
			cursorReasoning: { capabilityId: "gpt-5.3-codex", representativeVariantId: "gpt-5.3-codex-high" },
		};
		const out = resolveCursorSelectionDescriptor(cursorModel("gpt-5.3-codex", compat), explicit("xhigh"));
		expect(out).toEqual({
			modelId: "gpt-5.3-codex-xhigh",
			cliModelId: "gpt-5.3-codex",
			parameters: [
				{ id: "reasoning", value: "extra-high" },
				{ id: "fast", value: "false" },
			],
		});
	});

	it("renders gemini/grok/glm/kimi families", () => {
		const gemini = resolveCursorSelectionDescriptor(
			cursorModel("gemini-3.7-flash", {
				cursorReasoning: { capabilityId: "gemini-3.7-flash", representativeVariantId: "gemini-3.7-flash-medium" },
			}),
			explicit("low"),
		);
		expect(gemini).toEqual({
			modelId: "gemini-3.7-flash-low",
			cliModelId: "gemini-3.7-flash",
			parameters: [{ id: "effort", value: "low" }],
		});
		const grok = resolveCursorSelectionDescriptor(
			cursorModel("cursor-grok-4.6", {
				cursorReasoning: { capabilityId: "cursor-grok-4.6", representativeVariantId: "cursor-grok-4.6-medium" },
			}),
			explicit("xhigh"),
		);
		expect(grok).toEqual({
			modelId: "cursor-grok-4.6-xhigh",
			cliModelId: "cursor-grok-4.6",
			parameters: [
				{ id: "effort", value: "xhigh" },
				{ id: "fast", value: "false" },
			],
		});
		const glm = resolveCursorSelectionDescriptor(
			cursorModel("glm-5.2", {
				cursorReasoning: { capabilityId: "glm-5.2", representativeVariantId: "glm-5.2-high" },
			}),
			explicit("max"),
		);
		expect(glm).toEqual({
			modelId: "glm-5.2-max",
			cliModelId: "glm-5.2",
			parameters: [{ id: "reasoning", value: "max" }],
		});
		const kimi = resolveCursorSelectionDescriptor(
			cursorModel("kimi-k3", {
				cursorReasoning: { capabilityId: "kimi-k3", representativeVariantId: "kimi-k3-high" },
			}),
			explicit("low"),
		);
		expect(kimi).toEqual({
			modelId: "kimi-k3-low",
			cliModelId: "kimi-k3",
			parameters: [{ id: "reasoning", value: "low" }],
		});
	});

	it("renders supported explicit off as reasoning=none", () => {
		const out = resolveCursorSelectionDescriptor(cursorModel("gpt-5.5", gpt55Compat), explicit("off"));
		expect(out).toEqual({
			modelId: "gpt-5.5-none",
			cliModelId: "gpt-5.5",
			parameters: [
				{ id: "context", value: "1m" },
				{ id: "reasoning", value: "none" },
				{ id: "fast", value: "false" },
			],
		});
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

	it("keeps the CLI bracket form on the bare capability id", () => {
		expect(
			renderCursorCliModelString(
				cursorModel("kimi-k3", {
					cursorReasoning: { capabilityId: "kimi-k3", representativeVariantId: "kimi-k3-high" },
				}),
				explicit("high"),
			),
		).toBe("kimi-k3[reasoning=high]");
		expect(
			renderCursorCliModelString(cursorModel("claude-fable-5-thinking", fableThinkingCompat), explicit("low")),
		).toBe("claude-fable-5[thinking=true,context=1m,effort=low]");
		expect(renderCursorCliModelString(cursorModel("gpt-5.5", gpt55Compat), undefined)).toBe("gpt-5.5-medium");
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
