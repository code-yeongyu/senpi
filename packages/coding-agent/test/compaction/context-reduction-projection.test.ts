import { describe, expect, it } from "vitest";
import { reduceContextWithFrontier } from "../../src/core/extensions/builtin/compaction/context-reduction-frontier.ts";
import {
	createContextReductionState,
	readContextReductionState,
} from "../../src/core/extensions/builtin/compaction/context-reduction-state.ts";
import { estimateTotalTokens } from "../../src/core/extensions/builtin/compaction/overflow-retry.ts";
import { reductionBytes, resultPair } from "../support/context-reduction-fixture.ts";

const messages = Array.from({ length: 20 }, (_, index) => resultPair(index, "write", 900)).flat();
const options = {
	unreducedMessages: messages,
	contextWindow: 100_000,
	ceilingTokens: 100_000,
	overheadTokens: 0,
	force: true,
};

describe("frontier projection and hysteresis", () => {
	it("latches independently of window growth and reported usage", () => {
		const state = createContextReductionState();
		const first = reduceContextWithFrontier(messages, state, options);
		expect(estimateTotalTokens(messages)).toBeLessThan(50_000);
		expect(reductionBytes(first)).not.toBe(reductionBytes(messages));
		expect(reductionBytes(reduceContextWithFrontier(messages, state, { ...options, force: false }))).toBe(
			reductionBytes(first),
		);
	});

	it("persists a same-lineage usage anchor and uses it instead of an under-count", () => {
		const state = createContextReductionState();
		reduceContextWithFrontier(messages, state, options);
		const anchored = {
			...state,
			anchorCount: messages.length,
			anchorCut: state.cutIndex,
			anchorHash: state.prefixHash,
			anchorTokens: 99_000,
		};
		const restored = readContextReductionState(JSON.parse(JSON.stringify(anchored)));
		expect(restored).toEqual(anchored);
		if (!restored) throw new Error("Expected restored state");
		const before = restored.cutIndex;
		reduceContextWithFrontier(messages, restored, { ...options, force: false });
		expect(restored.cutIndex).toBe(before);
		expect(restored.compactionRequired).toBe(true);
	});

	it.each(["cut", "hash"])("ignores stale reported usage from another %s", (different) => {
		const state = createContextReductionState();
		reduceContextWithFrontier(messages, state, options);
		const anchored = {
			...state,
			anchorCount: messages.length,
			anchorCut: state.cutIndex + (different === "cut" ? 1 : 0),
			anchorHash: different === "hash" ? "another-prefix" : state.prefixHash,
			anchorTokens: 99_000,
		};
		reduceContextWithFrontier(messages, anchored, { ...options, force: false });
		expect(anchored.compactionRequired).not.toBe(true);
	});

	it("does not commit a ceiling cut without eighty-five-percent headroom", () => {
		const state = createContextReductionState();
		const before = reduceContextWithFrontier(messages, state, options);
		const cut = state.cutIndex;
		const growing = [
			...messages,
			...Array.from({ length: 20 }, (_, index) => ({
				role: "user" as const,
				content: "unreducible ".repeat(500),
				timestamp: 100 + index,
			})),
		];
		const projected = estimateTotalTokens([...before, ...growing.slice(messages.length)]);
		reduceContextWithFrontier(growing, state, {
			...options,
			unreducedMessages: growing,
			ceilingTokens: projected / 0.97,
			force: false,
		});
		expect(state.cutIndex).toBe(cut);
		expect(state.compactionRequired).toBe(true);
	});

	it("rejects a small ceiling gain even if it would reach the lower band", () => {
		const reads = Array.from({ length: 20 }, (_, index) => resultPair(index, "read", 900)).flat();
		const input = { ...options, unreducedMessages: reads, contextWindow: 200_000, ceilingTokens: 200_000 };
		const state = createContextReductionState();
		const before = reduceContextWithFrontier(reads, state, input);
		const cut = state.cutIndex;
		const additions = Array.from({ length: 40 }, (_, index) => ({
			role: "user" as const,
			content: "data ".repeat(400),
			timestamp: 100 + index,
		}));
		const growing = [...reads, ...additions];
		const projected = estimateTotalTokens([...before, ...additions]);
		const ceilingTokens = projected / 0.96;
		const candidateState = { ...state };
		const candidate = reduceContextWithFrontier(growing, candidateState, {
			...input,
			unreducedMessages: growing,
			contextWindow: 100_000,
			blockBudgetRatio: 0.01,
		});
		expect(estimateTotalTokens(growing.slice(cut, candidateState.cutIndex))).toBeGreaterThanOrEqual(20_000);
		expect(projected - estimateTotalTokens(candidate)).toBeLessThan(4_000);
		expect(estimateTotalTokens(candidate)).toBeLessThanOrEqual(ceilingTokens * 0.85);
		reduceContextWithFrontier(growing, state, {
			...input,
			unreducedMessages: growing,
			ceilingTokens,
			force: false,
		});
		expect(state.cutIndex).toBe(cut);
		expect(state.compactionRequired).toBe(true);
	});

	it("requires a full ten-percent block at the ceiling even when gain and headroom would pass", () => {
		const state = createContextReductionState();
		const before = reduceContextWithFrontier(messages, state, options);
		const cut = state.cutIndex;
		const additions = Array.from({ length: 3 }, (_, index) => ({
			role: "user" as const,
			content: "data ".repeat(1_600),
			timestamp: 100 + index,
		}));
		const growing = [...messages, ...additions];
		const projected = estimateTotalTokens([...before, ...additions]);
		const ceilingTokens = projected / 0.96;
		const candidateState = { ...state };
		const candidate = reduceContextWithFrontier(growing, candidateState, {
			...options,
			unreducedMessages: growing,
			blockBudgetRatio: 0.01,
		});
		expect(projected - estimateTotalTokens(candidate)).toBeGreaterThanOrEqual(2_000);
		expect(estimateTotalTokens(candidate)).toBeLessThanOrEqual(ceilingTokens * 0.85);
		expect(estimateTotalTokens(growing.slice(cut, candidateState.cutIndex))).toBeLessThan(10_000);
		reduceContextWithFrontier(growing, state, {
			...options,
			unreducedMessages: growing,
			ceilingTokens,
			force: false,
		});
		expect(state.cutIndex).toBe(cut);
		expect(state.compactionRequired).toBe(true);
	});
});
