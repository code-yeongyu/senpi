import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { reduceContextWithFrontier } from "../../src/core/extensions/builtin/compaction/context-reduction-frontier.ts";
import {
	createContextReductionState,
	readContextReductionState,
	snapshotReductionState,
} from "../../src/core/extensions/builtin/compaction/context-reduction-state.ts";
import { resultPair } from "../support/context-reduction-fixture.ts";

type Step = { previousCut: number; cut: number; firstChanged: number; marked: number[] };

function history(pairs: number): AgentMessage[] {
	const names = ["read", "bash", "write", "eval", "grep"];
	const all: AgentMessage[] = [{ role: "user", content: "context ".repeat(4_000), timestamp: 0 } as AgentMessage];
	for (let index = 0; index < pairs; index++) {
		all.push(...(resultPair(index + 1, names[index % names.length], 400 + ((index * 37) % 1_200)) as AgentMessage[]));
	}
	return all;
}

function options(messages: AgentMessage[]) {
	return {
		unreducedMessages: messages,
		contextWindow: 300_000,
		ceilingTokens: 300_000,
		overheadTokens: 0,
		force: false,
	};
}

function frontierSteps(): Step[] {
	const all = history(300);
	const state = createContextReductionState();
	const steps: Step[] = [];
	let previous: string[] | undefined;
	let previousCut = 0;
	for (let length = 50; length <= all.length; length += 2) {
		const history = all.slice(0, length);
		const out = reduceContextWithFrontier(history, state, {
			unreducedMessages: history,
			contextWindow: 300_000,
			ceilingTokens: 300_000,
			overheadTokens: 0,
			force: false,
		});
		const serialized = out.map((message) => {
			const { promptCacheBreakpoint: _hint, ...rest } = message as AgentMessage & { promptCacheBreakpoint?: true };
			return JSON.stringify(rest);
		});
		if (previous && previousCut > 0 && state.cutIndex !== previousCut) {
			let firstChanged = 0;
			while (firstChanged < previous.length && previous[firstChanged] === serialized[firstChanged]) firstChanged++;
			const marked = out.flatMap((message, index) => ("promptCacheBreakpoint" in message ? [index] : []));
			steps.push({ previousCut, cut: state.cutIndex, firstChanged, marked });
		}
		previous = serialized;
		previousCut = state.cutIndex;
	}
	return steps;
}

describe("context reduction frontier keeps the reduced prefix cacheable (senpi#3242)", () => {
	const steps = frontierSteps();

	it("leaves every message before the old cut byte-identical when the frontier advances", () => {
		expect(steps.length).toBeGreaterThan(1);
		for (const step of steps) expect(step.firstChanged).toBeGreaterThanOrEqual(step.previousCut);
	});

	it("forgets the previous checkpoint when a branched history resets the frontier", () => {
		const all = history(300);
		const state = createContextReductionState();
		for (let length = 50; length <= all.length && state.checkpointCut === undefined; length += 2) {
			const prefix = all.slice(0, length);
			reduceContextWithFrontier(prefix, state, options(prefix));
		}
		expect(state.checkpointCut).toBeGreaterThan(0);

		const branched = [{ role: "user", content: "another task", timestamp: 0 } as AgentMessage, ...all.slice(1, 30)];
		const out = reduceContextWithFrontier(branched, state, { ...options(branched), force: true });

		expect(state.cutIndex).toBe(0);
		expect(state.checkpointCut).toBeUndefined();
		expect(out.some((message) => "promptCacheBreakpoint" in message)).toBe(false);
		expect(readContextReductionState(snapshotReductionState(state))).toBeDefined();
	});

	it("marks the last assistant before the old cut and before the new cut on a step", () => {
		const lastAssistantBefore = (cut: number) => ((cut - 1) % 2 === 1 ? cut - 1 : cut - 2);
		for (const step of steps) {
			expect(step.marked).toEqual([lastAssistantBefore(step.previousCut), lastAssistantBefore(step.cut)]);
		}
	});
});
