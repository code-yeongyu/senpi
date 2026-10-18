import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { reduceContextWithFrontier } from "../../src/core/extensions/builtin/compaction/context-reduction-frontier.ts";
import { createContextReductionState } from "../../src/core/extensions/builtin/compaction/context-reduction-state.ts";
import { resultPair } from "../support/context-reduction-fixture.ts";

describe("frontier block budget", () => {
	it("defaults to a ten-percent block budget, distinct from five and twenty percent", () => {
		const messages: AgentMessage[] = [];
		for (let index = 0; index < 69; index++) {
			messages.push(...resultPair(index, "write", 1_000));
		}
		const cuts = (blockBudgetRatio?: number) => {
			const state = createContextReductionState();
			return [60, 63, 69].map((pairs) => {
				const history = messages.slice(0, pairs * 2);
				reduceContextWithFrontier(history, state, {
					unreducedMessages: history,
					contextWindow: 100_000,
					ceilingTokens: 100_000,
					overheadTokens: 0,
					force: false,
					blockBudgetRatio,
				});
				return state.cutIndex;
			});
		};
		const tenPercent = cuts(0.1);
		const fivePercent = cuts(0.05);
		const twentyPercent = cuts(0.2);
		expect(cuts()).toEqual(tenPercent);
		expect(tenPercent[1]).toBe(tenPercent[0]);
		expect(tenPercent[2]).toBeGreaterThan(tenPercent[1]);
		expect(fivePercent[1]).toBeGreaterThan(fivePercent[0]);
		expect(twentyPercent[2]).toBe(twentyPercent[0]);
	});
});
