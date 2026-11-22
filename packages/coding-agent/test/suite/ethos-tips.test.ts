import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { describe, expect, it } from "vitest";
import { collectTips } from "../../src/cli/list-tips.ts";
import { TIP_DEFINITIONS } from "../../src/modes/interactive/tips/registry.ts";

// Each recommended family: its catalog release ids and every spelling a tip uses for a release.
const FAMILIES = [
	{
		provider: "anthropic",
		release: /^claude-fable-(\d+)(?:-(\d{1,2}))?$/,
		mention: /\b(?:claude-)?fable[- ](\d+)(?:[.-](\d{1,2}))?(?![\d.])/gi,
	},
	{
		provider: "openai",
		release: /^gpt-(\d+)(?:\.(\d+))?-sol$/,
		mention: /\bgpt-(\d+)(?:\.(\d+))?[- ]sol\b/gi,
	},
] as const;

function versionKey(major: string | undefined, minor: string | undefined): number {
	return Number(major) * 1000 + Number(minor ?? 0);
}

describe("ethos tips", () => {
	it("gates the ulw command tips on the tasks command", () => {
		const byId = new Map(TIP_DEFINITIONS.map((tip) => [tip.id, tip]));

		expect(byId.get("ethos.ulw-plan-sage")?.requiresCommand).toBe("tasks");
		expect(byId.get("ethos.ulw-loop-shallow")?.requiresCommand).toBe("tasks");
	});

	// senpi#6876: tips kept recommending fable-5.1 and gpt-6-sol after newer releases shipped.
	it("names only the newest catalog release of each model family a tip recommends", () => {
		const tips = collectTips();
		for (const family of FAMILIES) {
			const releases = getBuiltinModels(family.provider).flatMap((model) => {
				const match = family.release.exec(model.id);
				return match === null ? [] : [versionKey(match[1], match[2])];
			});
			expect(releases.length, family.provider).toBeGreaterThan(0);
			const newest = Math.max(...releases);
			let named = 0;
			for (const tip of tips) {
				for (const match of tip.text.matchAll(family.mention)) {
					const version = versionKey(match[1], match[2]);
					expect(releases, `${tip.id} names ${match[0]}, which the catalog does not ship`).toContain(version);
					expect(version, `${tip.id} names ${match[0]}, superseded in the catalog`).toBe(newest);
					named++;
				}
			}
			// The ulw tips recommend one release of each family; without a mention this check proves nothing.
			expect(named, family.provider).toBeGreaterThan(0);
		}
	});

	it("leaves the pure manifesto tips unbound and ungated", () => {
		const byId = new Map(TIP_DEFINITIONS.map((tip) => [tip.id, tip]));

		for (const id of [
			"ethos.tools-transparent",
			"ethos.spend-tokens",
			"ethos.deep-work",
			"ethos.monitor-subscribe",
			"ethos.cache-budget",
			"ethos.cache-hit-rate",
			"ethos.multimodal-vision",
			"ethos.oauth-multi-account",
			"ethos.agent-sdk-foundation",
			"ethos.tool-call-repair",
		] as const) {
			const tip = byId.get(id);
			expect(tip?.bindings, id).toEqual([]);
			expect(tip?.requiresCommand, id).toBeUndefined();
		}
	});
});
