/**
 * senpi#6699: Q's order (Slack C0C50M2NFU5, ts 1794719178.424289 and 1794719397.623049). A session on
 * Opus 5.5 falls back to Fable 5.2 at medium effort, then to Kimi K3.1 Pro at max effort, and nowhere
 * else. Each rung runs at its own effort, whatever effort the Opus 5.5 session was on.
 */
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { RetryFallbackController } from "../../../src/core/retry-fallback/controller.ts";
import { SelectorCooldowns } from "../../../src/core/retry-fallback/cooldown.ts";
import { DEFAULT_FALLBACK_CHAINS } from "../../../src/core/retry-fallback/settings.ts";

function served(provider: string, catalogProvider: "anthropic" | "kimi-coding" | "moonshotai", id: string): Model<Api> {
	return { ...getModel(catalogProvider, id as never), provider } as Model<Api>;
}

const opus55 = served("anthropic-subscription", "anthropic", "claude-opus-5-5");
const models: Model<Api>[] = [
	opus55,
	served("anthropic-subscription", "anthropic", "claude-fable-5-2"),
	served("anthropic-subscription", "anthropic", "claude-opus-5"),
	served("kimi-coding", "kimi-coding", "k3.1-pro"),
	served("moonshotai", "moonshotai", "kimi-k3.1-pro"),
];

async function walk(sessionLevel: ThinkingLevel, steps: number): Promise<string[]> {
	const switches: string[] = [];
	let current: { model: Model<Api>; thinkingLevel?: ThinkingLevel } = { model: opus55, thinkingLevel: sessionLevel };
	const controller = new RetryFallbackController({
		getSettings: () => ({ modelFallback: true, chains: DEFAULT_FALLBACK_CHAINS }),
		registry: {
			find: (provider, id) => models.find((model) => model.provider === provider && model.id === id),
			getAll: () => models,
		},
		cooldowns: new SelectorCooldowns(() => 0),
		logger: { debug: () => {}, info: () => {}, warn: () => {} },
		switchModel: async (model, thinking) => {
			switches.push(`${model.provider}/${model.id}:${thinking}`);
			current = { model, thinkingLevel: thinking };
		},
		emit: () => {},
		getCurrentSelector: () => current,
		isAuthAvailable: () => true,
	});
	for (let step = 0; step < steps; step++) {
		if (!(await controller.tryFallback("hard-error", {}))) break;
	}
	return switches;
}

describe("Opus 5.5 falls back to Fable 5.2 at medium, then Kimi K3.1 Pro at max (senpi#6699)", () => {
	it("ships exactly the two rungs, each with its own effort", () => {
		expect(DEFAULT_FALLBACK_CHAINS["claude-opus-5-5"]).toEqual(["claude-fable-5-2:medium", "kimi-k3.1-pro:max"]);
	});

	it.each<ThinkingLevel>(["low", "medium", "xhigh", "max"])(
		"applies each rung at its own effort from an Opus 5.5 session at %s",
		async (sessionLevel) => {
			const switches = await walk(sessionLevel, 2);

			expect(switches).toEqual(["anthropic-subscription/claude-fable-5-2:medium", "kimi-coding/k3.1-pro:max"]);
		},
	);

	it("never steps onto another Opus or any model outside the two rungs", async () => {
		const switches = await walk("xhigh", 10);

		expect(switches.length).toBeGreaterThanOrEqual(2);
		for (const selector of switches) {
			expect(selector).toMatch(
				/^(?:anthropic-subscription\/claude-fable-5-2:medium|[a-z-]+\/(?:kimi-)?k3\.1-pro:max)$/,
			);
		}
	});
});
