import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getModels } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_COMPACTION_SETTINGS } from "../../../src/core/compaction/compaction-settings.ts";
import { plannedContextWindow } from "../../../src/core/extensions/builtin/anthropic-subscription/context-window.ts";
import {
	_resetLongContextForTesting,
	markLongContextRefused,
} from "../../../src/core/extensions/builtin/anthropic-subscription/long-context.ts";
import { buildAnthropicSubscriptionQueryOptions } from "../../../src/core/extensions/builtin/anthropic-subscription/options.ts";
import { resolveEffectiveReserveTokens } from "../../../src/core/extensions/builtin/compaction/policy.ts";

/**
 * Claude Code 2.1.321 refuses a request on its own, with a synthetic "Prompt is too long" and no API call,
 * once the conversation passes `window - min(maxOutputTokens, 20_000) - 3_000` (`But()` minus `Woo`), where
 * `window` is CLAUDE_CODE_MAX_CONTEXT_TOKENS while DISABLE_COMPACT is set. Spelled out here rather than
 * imported, so the test pins Claude Code's formula instead of senpi's copy of it.
 */
function claudeCodeRefusesAbove(maxContextTokens: number, maxOutputTokens: number): number {
	return maxContextTokens - Math.min(maxOutputTokens, 20_000) - 3_000;
}

function senpiCompactsAt(window: number): number {
	return window - resolveEffectiveReserveTokens(window, DEFAULT_COMPACTION_SETTINGS);
}

let directory: string;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "senpi-cc-refusal-"));
	_resetLongContextForTesting(join(directory, "long-context.json"));
});

afterEach(() => {
	_resetLongContextForTesting();
	rmSync(directory, { recursive: true, force: true });
});

function catalogModels(): Model<Api>[] {
	return getModels("anthropic") as Model<Api>[];
}

function maxContextTokensFor(model: Model<Api>): number {
	const value = buildAnthropicSubscriptionQueryOptions({
		model,
		context: { messages: [] },
		cwd: directory,
		providerSettings: {},
		authLane: "oauth-slots",
	}).env?.CLAUDE_CODE_MAX_CONTEXT_TOKENS;
	if (value === undefined) throw new Error(`${model.id}: senpi-owned compaction must pin Claude Code's window`);
	return Number(value);
}

function expectClaudeCodeToAcceptUpToTheWindow(model: Model<Api>): void {
	const window = plannedContextWindow(model);
	const refusesAbove = claudeCodeRefusesAbove(maxContextTokensFor(model), model.maxTokens);

	expect(refusesAbove, `${model.id} at ${window}`).toBeGreaterThanOrEqual(senpiCompactsAt(window));
	expect(refusesAbove, `${model.id} at ${window}`).toBe(window);
}

describe("Claude Code refuses a subscription request only past the window senpi compacts against", () => {
	it.each(catalogModels().map((model) => [model.id, model] as const))("%s", (_id, model) => {
		expectClaudeCodeToAcceptUpToTheWindow(model);
	});

	it("holds for a legacy long-context id planned at 200k after the account refused 1M", () => {
		markLongContextRefused();
		const legacy = catalogModels().find((model) => model.id === "claude-sonnet-4-6");
		if (!legacy) throw new Error("claude-sonnet-4-6 is not in the anthropic catalog");

		expect(plannedContextWindow(legacy)).toBe(200_000);
		expectClaudeCodeToAcceptUpToTheWindow(legacy);
	});

	it("holds for a models.json row that declares a 200k window", () => {
		const base = catalogModels().find((model) => model.id === "claude-fable-5");
		if (!base) throw new Error("claude-fable-5 is not in the anthropic catalog");

		expectClaudeCodeToAcceptUpToTheWindow({
			...base,
			id: "claude-fable-5-2",
			contextWindow: 200_000,
			maxTokens: 64_000,
		});
	});
});
