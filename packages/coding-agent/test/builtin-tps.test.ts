import { describe, expect, it } from "vitest";
import { calculateTpsDelta, collectTpsTotals, formatTpsMessage } from "../src/core/extensions/builtin/tps.js";

const usageCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

function assistantUsage(input: number, output: number, totalTokens = input + output) {
	return {
		role: "assistant",
		usage: {
			input,
			output,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens,
			cost: usageCost,
		},
	};
}

describe("builtin TPS extension", () => {
	it("calculates TPS from the new cumulative token delta", () => {
		const previous = { messageCount: 1, totals: collectTpsTotals([assistantUsage(100, 20, 120)]) };
		const current = {
			messageCount: 2,
			totals: collectTpsTotals([assistantUsage(100, 20, 120), assistantUsage(50, 30, 80)]),
		};

		const delta = calculateTpsDelta(current, previous);

		expect(delta).toEqual({ input: 50, output: 30, cacheRead: 0, cacheWrite: 0, totalTokens: 80 });
		expect(formatTpsMessage(delta, 2)).toContain("TPS 15.0 tok/s. out 30");
	});

	it("uses current totals when event messages are already turn-local", () => {
		const previous = { messageCount: 2, totals: collectTpsTotals([assistantUsage(200, 100, 300)]) };
		const current = { messageCount: 1, totals: collectTpsTotals([assistantUsage(10, 40, 50)]) };

		expect(calculateTpsDelta(current, previous)).toEqual({
			input: 10,
			output: 40,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 50,
		});
	});
});
