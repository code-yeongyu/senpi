import type { Model, ThinkingSelection } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { resolveCursorCliSpawnModel } from "../../src/core/extensions/builtin/cursor-cli-oauth/spawn-model.ts";

function cliModel(
	id: string,
	compat?: Model<"cursor-agent">["compat"],
	upstreamModelId?: string,
): Model<"cursor-agent"> {
	return {
		id,
		name: id,
		api: "cursor-agent",
		provider: "cursor-cli-oauth",
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

const explicit = (level: ThinkingSelection["level"]): ThinkingSelection => ({ level, source: "explicit" });

describe("resolveCursorCliSpawnModel", () => {
	it("renders the catalog suffix variant id for an explicit selection", () => {
		const model = cliModel("claude-fable-5-thinking", {
			cursorReasoning: {
				capabilityId: "claude-fable-5",
				thinkingMode: true,
				representativeVariantId: "claude-fable-5-thinking-medium",
			},
		});
		expect(resolveCursorCliSpawnModel(model, explicit("low"))).toBe("claude-fable-5-thinking-low");
	});

	it("translates gpt-5.5 xhigh to the extra-high suffix id", () => {
		const model = cliModel("gpt-5.5", {
			cursorReasoning: { capabilityId: "gpt-5.5", representativeVariantId: "gpt-5.5-medium" },
		});
		expect(resolveCursorCliSpawnModel(model, explicit("xhigh"))).toBe("gpt-5.5-extra-high");
	});

	it("renders a suffix id for variant-encoded levels", () => {
		const model = cliModel("cursor-grok-4.5", {
			cursorReasoning: { capabilityId: "cursor-grok-4.5", representativeVariantId: "cursor-grok-4.5-medium" },
		});
		expect(resolveCursorCliSpawnModel(model, explicit("high"))).toBe("cursor-grok-4.5-high");
	});

	it("uses the representative variant when no selection exists", () => {
		const model = cliModel("kimi-k3", {
			cursorReasoning: { capabilityId: "kimi-k3", representativeVariantId: "kimi-k3-high" },
		});
		expect(resolveCursorCliSpawnModel(model, undefined)).toBe("kimi-k3-high");
	});

	it("emits the exact legacy variant id for legacy-variant selections", () => {
		const model = cliModel("gpt-5.5", {
			cursorReasoning: { capabilityId: "gpt-5.5", representativeVariantId: "gpt-5.5-medium" },
		});
		expect(
			resolveCursorCliSpawnModel(model, {
				level: "xhigh",
				source: "legacy-variant",
				legacyVariantId: "gpt-5.5-extra-high",
			}),
		).toBe("gpt-5.5-extra-high");
	});

	it("falls back to upstreamModelId ?? id for models without reasoning capability", () => {
		expect(resolveCursorCliSpawnModel(cliModel("composer-2.5"), explicit("high"))).toBe("composer-2.5");
		expect(resolveCursorCliSpawnModel(cliModel("custom", undefined, "custom-upstream"), undefined)).toBe(
			"custom-upstream",
		);
	});
});
