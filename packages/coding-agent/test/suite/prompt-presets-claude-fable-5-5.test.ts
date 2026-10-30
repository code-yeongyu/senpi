import type { Api, Model } from "@earendil-works/pi-ai";
import { FABLE55_LAUNCH } from "@earendil-works/pi-ai/utils/fable55-launch";
import { getAnthropicCompat, resolvePromptCacheTtlSeconds } from "@earendil-works/pi-ai/utils/prompt-cache-ttl";
import { describe, expect, it } from "vitest";
import { classifySdkError } from "../../src/core/extensions/builtin/anthropic-subscription/errors.ts";
import { buildAnthropicSubscriptionQueryOptions } from "../../src/core/extensions/builtin/anthropic-subscription/options.ts";
import { resolvePreset, resolvePresetName } from "../../src/core/extensions/builtin/prompt-preset/presets.ts";
import { parsePromptPreset } from "../../src/core/extensions/builtin/prompt-preset/settings.ts";
import { resolveRetryFallbackSettings } from "../../src/core/retry-fallback/settings.ts";

function model(id: string): Model<Api> {
	return {
		id,
		name: id,
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://example.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 123456,
		maxTokens: 12345,
	};
}

describe("Fable 5.5 provisional preset (senpi#3893)", () => {
	it.each([
		"claude-fable-5-5",
		"anthropic/claude-fable-5.5",
		"us.anthropic.claude-fable-5-5",
		"global.anthropic.claude-fable-5-5",
		"Claude Fable 5.5",
		"claude-mythos-5-5",
		"anthropic/claude-mythos-5.5",
		"us.anthropic.claude-mythos-5-5",
		"claude-mythos-5-5-thinking",
		"Claude Mythos 5.5",
	])("routes %s before the generic Fable 5 matcher", (id) => {
		expect(resolvePresetName(model(id), { promptPreset: "auto" })).toBe("claude-fable-5-5");
	});

	// Prompt-byte equality protects the complete tuned 5.1 core, including handoffs and eval routing.
	it.each(["terminal", "app", "chat"] as const)("carries the tuned 5.1 prompt on %s", (surface) => {
		for (const selectedTools of [[], ["eval", "read", "apply_patch"]]) {
			const options = { surface, selectedTools };
			const current = resolvePreset(model("claude-fable-5-1"), { promptPreset: "auto" }, options);
			const launch = resolvePreset(model("claude-fable-5-5"), { promptPreset: "auto" }, options);
			expect(launch?.name).toBe("claude-fable-5-5");
			expect(launch?.prompt).toBe(current?.prompt);
		}
	});

	it("accepts an explicit preset override on an unrelated model", () => {
		const promptPreset = parsePromptPreset("claude-fable-5-5");
		expect(promptPreset).toBe("claude-fable-5-5");
		expect(resolvePreset(model("custom"), { promptPreset: promptPreset ?? "auto" })?.name).toBe("claude-fable-5-5");
	});

	it.each(["claude-fable-5", "claude-fable-5-1"])("keeps the existing preset for %s", (id) => {
		expect(resolvePresetName(model(id), { promptPreset: "auto" })).toBe(id);
	});

	it("inherits the same Opus-only fallback ladder once released and honors an explicit tombstone", () => {
		expect(resolveRetryFallbackSettings(undefined).chains["claude-fable-5-5"]).toEqual(
			FABLE55_LAUNCH.released ? ["claude-opus-5-5:max", "claude-opus-5:max"] : undefined,
		);
		expect(
			resolveRetryFallbackSettings({ fallbackChains: { "claude-fable-5-5": [] } }).chains["claude-fable-5-5"],
		).toEqual([]);
	});

	it("classifies usage credits as model entitlement, not a retryable account limit", () => {
		expect(classifySdkError("Claude Fable 5.5 requires usage credits.")).toEqual({
			kind: "entitlement",
			retryable: false,
		});
	});

	it.each(["claude-fable-5-5", "claude-mythos-5-5"])(
		"carries adaptive effort and compaction ownership for %s",
		(id) => {
			const current = model(id);
			const options = buildAnthropicSubscriptionQueryOptions({
				cwd: process.cwd(),
				model: current,
				context: { messages: [] },
				providerSettings: {},
				streamOptions: { reasoning: "xhigh" },
			});
			expect(options.model).toBe(id);
			expect(options.thinking).toEqual({ type: "adaptive", display: "summarized" });
			expect(options.effort).toBe("xhigh");
			expect(options.settings).toEqual({ autoCompactEnabled: false });
			expect(options.env).toMatchObject({
				CLAUDE_CODE_TOTAL_TOKENS_REMINDER: "off",
				CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(current.contextWindow),
				DISABLE_COMPACT: "1",
			});
		},
	);

	it("inherits provider cache TTL and forced-tool-choice behavior without a new family override", () => {
		const current = model("claude-fable-5-5") as Model<"anthropic-messages">;
		const baseline = { ...current, id: "claude-fable-5-1" };
		expect(resolvePromptCacheTtlSeconds(current, {})).toBe(resolvePromptCacheTtlSeconds(baseline, {}));
		expect(getAnthropicCompat(current).supportsForcedToolChoice).toBe(false);
	});
});
