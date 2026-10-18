import { describe, expect, it } from "vitest";
import { TIP_DEFINITIONS } from "../../src/modes/interactive/tips/registry.ts";

describe("ethos tips", () => {
	it("gates the ulw command tips on the tasks command", () => {
		const byId = new Map(TIP_DEFINITIONS.map((tip) => [tip.id, tip]));

		expect(byId.get("ethos.ulw-plan-sage")?.requiresCommand).toBe("tasks");
		expect(byId.get("ethos.ulw-loop-shallow")?.requiresCommand).toBe("tasks");
	});

	it("leaves the pure manifesto tips unbound and ungated", () => {
		const byId = new Map(TIP_DEFINITIONS.map((tip) => [tip.id, tip]));

		for (const id of [
			"ethos.tuning-discipline",
			"ethos.tools-transparent",
			"ethos.only-harness",
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
